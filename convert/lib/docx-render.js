/* DOCX → PDF 渲染器
 *
 * 纯前端把 .docx 解析成「块 + 行内运行」的结构，自己排版成 A4 页面，
 * 用 Canvas 逐页光栅化，最后交给 pdf-lib 嵌入成 PDF。
 *
 * 覆盖范围：段落样式继承、行内格式（粗体/斜体/下划线/删除线/颜色/字号/字体/
 * 上下标/高亮）、对齐与缩进、行距与段间距、项目符号与编号（多级）、表格（含
 * 表头底纹、边框、横向合并）、图片（内嵌/浮动按行内处理）、分页符、页眉页脚。
 *
 * 不支持：浮动文本框、公式、图表、SmartArt、脚注尾注、修订、EMF/WMF 图片、
 * 纵向合并单元格、分栏。文字会光栅化，不可选中（换取版式还原度）。
 */

import { loadJsZip, loadPdfLib } from './ui.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const TWIP = 1 / 15;      // twip → CSS px（96dpi）
const HALF_PT = 2 / 3;    // 半磅 → px
const EMU = 1 / 9525;     // EMU → px
const PT = 4 / 3;         // 磅 → px

const DEFAULT_TAB = 48;   // 默认制表位（720 twip）
const LINE_FACTOR = 1.25; // 单倍行高 ≈ 字号 × 1.25（Calibri 约 1.22，微软雅黑约 1.3）

/* ------------------------------------------------------------------ DOM 小工具 */

const childrenOf = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const firstOf = (el, name) => (el ? Array.from(el.children).find((c) => c.localName === name) || null : null);
const attrW = (el, name) => {
  if (!el) return null;
  const v = el.getAttributeNS(W_NS, name);
  return v !== null && v !== undefined ? v : el.getAttribute('w:' + name);
};
const attrR = (el, name) => {
  if (!el) return null;
  const v = el.getAttributeNS(R_NS, name);
  return v !== null && v !== undefined ? v : el.getAttribute('r:' + name);
};
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ------------------------------------------------------------------ 解析 */

const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
  blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

function hexColor(value) {
  if (!value || value === 'auto') return null;
  return '#' + String(value).replace(/^#/, '').slice(0, 6);
}

function parseRunProps(rPr) {
  const out = {};
  if (!rPr) return out;

  const rFonts = firstOf(rPr, 'rFonts');
  if (rFonts) {
    out.font = rFonts.getAttributeNS(W_NS, 'ascii') || rFonts.getAttribute('w:ascii') || null;
    out.eastAsia = rFonts.getAttributeNS(W_NS, 'eastAsia') || null;
  }
  const b = firstOf(rPr, 'b');
  if (b) out.bold = attrW(b, 'val') !== '0' && attrW(b, 'val') !== 'false';
  const i = firstOf(rPr, 'i');
  if (i) out.italic = attrW(i, 'val') !== '0' && attrW(i, 'val') !== 'false';
  const u = firstOf(rPr, 'u');
  if (u) {
    const val = attrW(u, 'val') || 'single';
    out.underline = val !== 'none';
  }
  const strike = firstOf(rPr, 'strike') || firstOf(rPr, 'dstrike');
  if (strike) out.strike = attrW(strike, 'val') !== '0' && attrW(strike, 'val') !== 'false';
  const color = firstOf(rPr, 'color');
  if (color) out.color = hexColor(attrW(color, 'val'));
  const sz = firstOf(rPr, 'sz');
  if (sz) out.size = num(attrW(sz, 'val'), 22) * HALF_PT;
  const hl = firstOf(rPr, 'highlight');
  if (hl) out.highlight = HIGHLIGHT[attrW(hl, 'val')] || null;
  const shd = firstOf(rPr, 'shd');
  if (shd) {
    const fill = hexColor(attrW(shd, 'fill'));
    if (fill) out.highlight = fill;
  }
  const va = firstOf(rPr, 'vertAlign');
  if (va) out.vertAlign = attrW(va, 'val');
  const caps = firstOf(rPr, 'caps');
  if (caps) out.caps = attrW(caps, 'val') !== '0';
  const rStyle = firstOf(rPr, 'rStyle');
  if (rStyle) out.rStyle = attrW(rStyle, 'val');
  return out;
}

const ZERO_IND = { left: 0, right: 0, firstLine: 0, hanging: 0 };
const DEFAULT_SPACING = { before: 0, after: 0, line: 240, rule: 'auto' };

function parseInd(el) {
  if (!el) return null;
  const ind = { left: 0, right: 0, firstLine: 0, hanging: 0 };
  ind.left = num(attrW(el, 'left') ?? attrW(el, 'start')) * TWIP;
  ind.right = num(attrW(el, 'right') ?? attrW(el, 'end')) * TWIP;
  const fl = num(attrW(el, 'firstLine'));
  const hg = num(attrW(el, 'hanging'));
  if (hg) ind.hanging = hg * TWIP;
  else if (fl) ind.firstLine = fl * TWIP;
  return ind;
}

function parseSpacing(el) {
  if (!el) return null;
  const sp = { before: 0, after: 0, line: 240, rule: 'auto' };
  sp.before = num(attrW(el, 'before')) * TWIP;
  sp.after = num(attrW(el, 'after')) * TWIP;
  const line = attrW(el, 'line');
  if (line) sp.line = num(line, 240);
  sp.rule = attrW(el, 'lineRule') || 'auto';
  return sp;
}

function parseBorder(el) {
  if (!el) return null;
  const val = attrW(el, 'val');
  if (!val || val === 'nil' || val === 'none') return null;
  return {
    width: Math.max(1, num(attrW(el, 'sz'), 4) / 6),
    color: hexColor(attrW(el, 'color')) || '#000000',
    style: val,
  };
}

function parseBorders(el) {
  if (!el) return null;
  const out = {};
  for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
    const b = parseBorder(firstOf(el, side));
    if (b) out[side] = b;
  }
  return Object.keys(out).length ? out : null;
}

function parseCellMar(el) {
  if (!el) return null;
  const out = {};
  for (const side of ['top', 'left', 'bottom', 'right']) {
    const s = firstOf(el, side);
    if (s) out[side] = num(attrW(s, 'w')) * TWIP;
  }
  return Object.keys(out).length ? out : null;
}

function parseParaProps(pPr) {
  const out = {};
  if (!pPr) return out;

  const jc = firstOf(pPr, 'jc');
  if (jc) out.jc = attrW(jc, 'val') || null;

  const ind = parseInd(firstOf(pPr, 'ind'));
  if (ind) out.ind = ind;
  const spacing = parseSpacing(firstOf(pPr, 'spacing'));
  if (spacing) out.spacing = spacing;

  const numPr = firstOf(pPr, 'numPr');
  if (numPr) {
    const numId = firstOf(numPr, 'numId');
    const ilvl = firstOf(numPr, 'ilvl');
    if (numId) out.numPr = { numId: attrW(numId, 'val'), ilvl: num(attrW(ilvl, 'val'), 0) };
  }

  const pBdr = parseBorders(firstOf(pPr, 'pBdr'));
  if (pBdr) out.borders = pBdr;

  const shd = firstOf(pPr, 'shd');
  if (shd) {
    const fill = hexColor(attrW(shd, 'fill'));
    if (fill) out.shading = fill;
  }

  const keep = firstOf(pPr, 'keepNext');
  if (keep) out.keepNext = true;
  const pbb = firstOf(pPr, 'pageBreakBefore');
  if (pbb) out.pageBreakBefore = true;
  const ol = firstOf(pPr, 'outlineLvl');
  if (ol) out.outlineLvl = num(attrW(ol, 'val'));
  const pStyle = firstOf(pPr, 'pStyle');
  if (pStyle) out.styleId = attrW(pStyle, 'val');
  return out;
}

function mergeRun(base, extra) {
  return Object.assign({}, base, extra);
}

function mergePara(base, extra) {
  const out = Object.assign({}, base, extra);
  out.ind = Object.assign({}, ZERO_IND, base.ind || {}, extra.ind || {});
  out.spacing = Object.assign({}, DEFAULT_SPACING, base.spacing || {}, extra.spacing || {});
  if (!extra.borders) out.borders = base.borders;
  if (!extra.shading) out.shading = base.shading;
  if (!extra.jc) out.jc = base.jc;
  if (!extra.numPr) out.numPr = base.numPr;
  return out;
}

/* ------------------------------------------------------------------ 主渲染器 */

export async function renderDocxToPdf(file, options = {}) {
  const dpi = options.dpi || 150;
  const onProgress = options.onProgress || (() => {});
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(file);

  const read = async (path) => {
    const entry = zip.file(path);
    return entry ? entry.async('string') : null;
  };
  const readBin = async (path) => {
    const entry = zip.file(path);
    return entry ? entry.async('uint8array') : null;
  };

  const docXml = await read('word/document.xml');
  if (!docXml) throw new Error('这个 .docx 里找不到 word/document.xml');

  const stylesXml = await read('word/styles.xml');
  const numberingXml = await read('word/numbering.xml');
  const relsXml = await read('word/_rels/document.xml.rels');

  const parser = new DOMParser();
  const docDom = parser.parseFromString(docXml, 'application/xml');
  if (docDom.getElementsByTagName('parsererror').length) throw new Error('document.xml 解析失败');

  /* ---- 样式表 ---- */
  const styles = new Map();
  let docDefaultsRun = {};
  let docDefaultsPara = {};

  if (stylesXml) {
    const sDom = parser.parseFromString(stylesXml, 'application/xml');
    const defaults = firstOf(sDom.documentElement, 'docDefaults');
    if (defaults) {
      const rPrDefault = firstOf(defaults, 'rPrDefault');
      const rPr = firstOf(rPrDefault, 'rPr');
      if (rPr) docDefaultsRun = parseRunProps(rPr);
      const pPrDefault = firstOf(defaults, 'pPrDefault');
      const pPr = firstOf(pPrDefault, 'pPr');
      if (pPr) docDefaultsPara = parseParaProps(pPr);
    }
    for (const st of childrenOf(sDom.documentElement, 'style')) {
      const id = attrW(st, 'styleId');
      if (!id) continue;
      const basedOn = firstOf(st, 'basedOn');
      const tblPrEl = firstOf(st, 'tblPr');
      styles.set(id, {
        type: attrW(st, 'type'),
        basedOn: basedOn ? attrW(basedOn, 'val') : null,
        pPr: parseParaProps(firstOf(st, 'pPr')),
        rPr: parseRunProps(firstOf(st, 'rPr')),
        tblPr: tblPrEl ? {
          borders: parseBorders(firstOf(tblPrEl, 'tblBorders')),
          cellMar: parseCellMar(firstOf(tblPrEl, 'tblCellMar')),
        } : null,
      });
    }
  }

  const styleChain = (id) => {
    const chain = [];
    let cur = id;
    let guard = 0;
    while (cur && styles.has(cur) && guard < 20) {
      const style = styles.get(cur);
      chain.unshift(style);
      cur = style.basedOn;
      guard += 1;
    }
    return chain;
  };

  const paraStyleProps = (id) => {
    let p = docDefaultsPara;
    let r = {};
    for (const st of styleChain(id || 'Normal')) {
      p = mergePara(p, st.pPr);
      r = mergeRun(r, st.rPr);
    }
    return { pPr: p, rPr: r };
  };

  // 表格样式（Table Grid 等）里的边框、单元格边距、单元格段落默认值
  const tableStyleProps = (id) => {
    const out = { borders: null, cellMar: null, pPr: null };
    for (const st of styleChain(id || 'TableNormal')) {
      if (st.tblPr) {
        if (st.tblPr.borders) out.borders = st.tblPr.borders;
        if (st.tblPr.cellMar) out.cellMar = Object.assign({}, out.cellMar, st.tblPr.cellMar);
      }
      if (st.pPr && Object.keys(st.pPr).length) {
        out.pPr = mergePara(out.pPr || {}, st.pPr);
      }
    }
    return out;
  };

  /* ---- 编号 ---- */
  const nums = new Map();       // numId -> abstractNumId
  const abstracts = new Map();  // abstractNumId -> levels[]
  if (numberingXml) {
    const nDom = parser.parseFromString(numberingXml, 'application/xml');
    for (const abs of childrenOf(nDom.documentElement, 'abstractNum')) {
      const id = attrW(abs, 'abstractNumId');
      const levels = [];
      for (const lvl of childrenOf(abs, 'lvl')) {
        const ilvl = num(attrW(lvl, 'ilvl'));
        levels[ilvl] = {
          start: num(attrW(firstOf(lvl, 'start'), 'val'), 1),
          format: attrW(firstOf(lvl, 'numFmt'), 'val') || 'decimal',
          text: attrW(firstOf(lvl, 'lvlText'), 'val') || '',
          justify: attrW(firstOf(lvl, 'lvlJc'), 'val') || 'left',
          pPr: parseParaProps(firstOf(lvl, 'pPr')),
          rPr: parseRunProps(firstOf(lvl, 'rPr')),
        };
      }
      abstracts.set(id, levels);
    }
    for (const n of childrenOf(nDom.documentElement, 'num')) {
      const numId = attrW(n, 'numId');
      const abs = firstOf(n, 'abstractNumId');
      if (numId && abs) nums.set(numId, attrW(abs, 'val'));
    }
  }

  const counters = new Map();   // numId -> 各级计数
  const bulletChar = (raw) => {
    const map = { '\uF0B7': '•', '\uF0A7': '▪', '\uF0D8': '➢', '\uF076': '▪', '\uF0FC': '✓' };
    if (map[raw]) return map[raw];
    if (raw && raw.codePointAt(0) >= 0xf000) return '•';
    return raw || '•';
  };

  function listMarker(numPr, rPr) {
    const abstractId = nums.get(String(numPr.numId));
    const levels = abstracts.get(abstractId);
    if (!levels) return null;
    const lvl = levels[numPr.ilvl] || levels[0];
    if (!lvl) return null;

    if (lvl.format === 'bullet' || lvl.format === 'none') {
      if (lvl.format === 'none') return null;
      return { text: bulletChar(lvl.text), lvl };
    }

    const counts = counters.get(numPr.numId) || [];
    if (!counts[numPr.ilvl]) counts[numPr.ilvl] = (lvl.start || 1) - 1;
    counts[numPr.ilvl] += 1;
    for (let i = numPr.ilvl + 1; i < counts.length; i++) counts[i] = 0;
    counters.set(numPr.numId, counts);

    const value = counts[numPr.ilvl];
    const formatted = formatNumber(value, lvl.format);
    const text = (lvl.text || '%1.').replace(/%(\d)/g, (m, d) => {
      const idx = Number(d) - 1;
      const l = levels[idx];
      if (!l) return '';
      const v = counts[idx] === undefined ? (l.start || 1) : counts[idx];
      return formatNumber(v, l.format);
    });
    return { text, lvl, value: formatted };
  }

  function formatNumber(value, format) {
    switch (format) {
      case 'lowerLetter': return toLetters(value).toLowerCase();
      case 'upperLetter': return toLetters(value);
      case 'lowerRoman': return toRoman(value).toLowerCase();
      case 'upperRoman': return toRoman(value);
      case 'decimalZero': return String(value).padStart(2, '0');
      case 'chineseCounting':
      case 'chineseCountingThousand':
        return toChineseNumber(value);
      default: return String(value);
    }
  }
  const toLetters = (n) => {
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s || 'A';
  };
  const toRoman = (n) => {
    const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
      [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    let v = n;
    for (const [val, sym] of map) {
      while (v >= val) { out += sym; v -= val; }
    }
    return out || 'I';
  };
  const toChineseNumber = (n) => {
    const digits = '零一二三四五六七八九';
    if (n <= 10) return n === 10 ? '十' : digits[n];
    if (n < 20) return '十' + digits[n - 10];
    if (n < 100) {
      const t = Math.floor(n / 10);
      const o = n % 10;
      return digits[t] + '十' + (o ? digits[o] : '');
    }
    return String(n);
  };

  /* ---- 关系与媒体 ---- */
  const rels = new Map();
  if (relsXml) {
    const rDom = parser.parseFromString(relsXml, 'application/xml');
    for (const rel of Array.from(rDom.documentElement.children)) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      const type = rel.getAttribute('Type') || '';
      if (id && target) rels.set(id, { target, type });
    }
  }

  const resolveTarget = (target) => {
    const clean = target.replace(/^\.\//, '');
    return clean.startsWith('/') ? clean.slice(1) : 'word/' + clean;
  };

  const imageCache = new Map();
  async function loadImage(relId) {
    const rel = rels.get(relId);
    if (!rel) return null;
    const path = resolveTarget(rel.target);
    if (imageCache.has(path)) return imageCache.get(path);
    const task = (async () => {
      try {
        const bytes = await readBin(path);
        if (!bytes) return null;
        const ext = path.split('.').pop().toLowerCase();
        if (ext === 'emf' || ext === 'wmf') return null;   // 浏览器画不了
        let blob = new Blob([bytes]);
        if (ext === 'tif' || ext === 'tiff') return null;
        const bmp = await createImageBitmap(blob);
        return bmp;
      } catch {
        return null;
      }
    })();
    imageCache.set(path, task);
    return task;
  }

  /* ---- 解析正文 ---- */
  const body = firstOf(docDom.documentElement, 'body');

  function parseParagraph(p) {
    const directPPr = parseParaProps(firstOf(p, 'pPr'));
    const styleId = directPPr.styleId;
    const base = paraStyleProps(styleId);
    const pPr = mergePara(base.pPr, directPPr);
    const paraRunProps = mergeRun(docDefaultsRun, base.rPr);

    const runs = [];
    for (const node of Array.from(p.children)) {
      if (node.localName === 'r') {
        const rPr = mergeRun(paraRunProps, parseRunProps(firstOf(node, 'rPr')));
        if (rPr.rStyle) {
          for (const st of styleChain(rPr.rStyle)) Object.assign(rPr, st.rPr);
        }
        for (const child of Array.from(node.children)) {
          const name = child.localName;
          if (name === 't') {
            const text = child.textContent || '';
            if (text) runs.push({ text: normalizeText(text), props: rPr });
          } else if (name === 'tab') {
            runs.push({ tab: true, props: rPr });
          } else if (name === 'br') {
            const type = attrW(child, 'type');
            runs.push(type === 'page' ? { pageBreak: true, props: rPr } : { br: true, props: rPr });
          } else if (name === 'drawing') {
            const info = parseDrawing(child);
            if (info) runs.push({ image: info, props: rPr });
          } else if (name === 'sym') {
            const ch = attrW(child, 'char');
            if (ch) runs.push({ text: String.fromCharCode(parseInt(ch, 16)), props: rPr });
          } else if (name === 'noBreakHyphen') {
            runs.push({ text: '‑', props: rPr });
          }
        }
      } else if (node.localName === 'hyperlink') {
        for (const r of childrenOf(node, 'r')) {
          const rPr = mergeRun(paraRunProps, parseRunProps(firstOf(r, 'rPr')));
          const t = firstOf(r, 't');
          if (t && t.textContent) runs.push({ text: normalizeText(t.textContent), link: true, props: rPr });
        }
      }
    }
    return { type: 'p', pPr, runs };
  }

  function parseDrawing(drawing) {
    // wp:inline / wp:anchor → a:graphic → pic:pic → blip
    let extent = null;
    for (const wp of Array.from(drawing.children)) {
      const ext = firstOf(wp, 'extent');
      if (ext) {
        extent = {
          cx: num(ext.getAttribute('cx')),
          cy: num(ext.getAttribute('cy')),
        };
      }
    }
    const blip = drawing.getElementsByTagNameNS('*', 'blip')[0];
    if (!blip) return null;
    const relId = blip.getAttributeNS(R_NS, 'embed') || blip.getAttribute('r:embed');
    if (!relId) return null;
    return {
      relId,
      width: extent ? extent.cx * EMU : 0,
      height: extent ? extent.cy * EMU : 0,
    };
  }

  function normalizeText(text) {
    return text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  }

  function parseTable(tbl) {
    const tblPr = firstOf(tbl, 'tblPr');
    const jcEl = firstOf(tblPr, 'jc');
    const jc = jcEl ? attrW(jcEl, 'val') : null;
    const styleEl = firstOf(tblPr, 'tblStyle');
    const tableStyle = tableStyleProps(styleEl ? attrW(styleEl, 'val') : null);
    const borders = parseBorders(firstOf(tblPr, 'tblBorders')) || tableStyle.borders || {};
    const margins = Object.assign(
      { left: 108 * TWIP, right: 108 * TWIP, top: 0, bottom: 0 },
      tableStyle.cellMar || {},
      parseCellMar(firstOf(tblPr, 'tblCellMar')) || {},
    );

    const gridEl = firstOf(tbl, 'tblGrid');
    const grid = childrenOf(gridEl, 'gridCol').map((g) => num(attrW(g, 'w')) * TWIP);

    const rows = [];
    for (const tr of childrenOf(tbl, 'tr')) {
      const trPr = firstOf(tr, 'trPr');
      const heightEl = firstOf(trPr, 'trHeight');
      const minHeight = heightEl ? num(attrW(heightEl, 'val')) * TWIP : 0;
      const cells = [];
      for (const tc of childrenOf(tr, 'tc')) {
        const tcPr = firstOf(tc, 'tcPr');
        const spanEl = firstOf(tcPr, 'gridSpan');
        const span = spanEl ? num(attrW(spanEl, 'val'), 1) : 1;
        const shd = firstOf(tcPr, 'shd');
        const fill = shd ? hexColor(attrW(shd, 'fill')) : null;
        const vMerge = firstOf(tcPr, 'vMerge');
        const cellBorders = parseBorders(firstOf(tcPr, 'tcBorders'));
        const tcW = firstOf(tcPr, 'tcW');
        const width = tcW ? num(attrW(tcW, 'w')) * TWIP : 0;
        const blocks = [];
        for (const child of Array.from(tc.children)) {
          if (child.localName === 'p') blocks.push(parseParagraph(child));
          else if (child.localName === 'tbl') blocks.push(parseTable(child));
        }
        // 表格样式里的段落默认值（比如 spacing after=0）也要作用到单元格
        if (tableStyle.pPr) {
          for (const b of blocks) {
            if (b.type === 'p') b.pPr = mergePara(b.pPr, tableStyle.pPr);
          }
        }
        cells.push({
          span,
          fill,
          width,
          borders: cellBorders,
          vMerge: vMerge ? (attrW(vMerge, 'val') || 'continue') : null,
          blocks,
        });
      }
      rows.push({ cells, minHeight });
    }
    return { type: 'tbl', jc, borders, margins, grid, rows };
  }

  const blocks = [];
  for (const node of Array.from(body.children)) {
    if (node.localName === 'p') blocks.push(parseParagraph(node));
    else if (node.localName === 'tbl') blocks.push(parseTable(node));
  }

  /* ---- 页面尺寸 ---- */
  const sectPr = firstOf(body, 'sectPr');
  const pgSz = firstOf(sectPr, 'pgSz');
  const pgMar = firstOf(sectPr, 'pgMar');
  const pageW = pgSz ? num(attrW(pgSz, 'w'), 11906) * TWIP : 11906 * TWIP;
  const pageH = pgSz ? num(attrW(pgSz, 'h'), 16838) * TWIP : 16838 * TWIP;
  const margin = {
    top: pgMar ? num(attrW(pgMar, 'top'), 1440) * TWIP : 96,
    right: pgMar ? num(attrW(pgMar, 'right'), 1440) * TWIP : 96,
    bottom: pgMar ? num(attrW(pgMar, 'bottom'), 1440) * TWIP : 96,
    left: pgMar ? num(attrW(pgMar, 'left'), 1440) * TWIP : 96,
    header: pgMar ? num(attrW(pgMar, 'header'), 720) * TWIP : 48,
    footer: pgMar ? num(attrW(pgMar, 'footer'), 720) * TWIP : 48,
  };
  const contentW = pageW - margin.left - margin.right;

  // 页脚 / 页眉
  const footerRef = firstOf(sectPr, 'footerReference');
  const headerRef = firstOf(sectPr, 'headerReference');
  async function loadPartBlocks(ref) {
    if (!ref) return null;
    const relId = attrR(ref, 'id');
    const rel = rels.get(relId);
    if (!rel) return null;
    const xml = await read(resolveTarget(rel.target));
    if (!xml) return null;
    const dom = parser.parseFromString(xml, 'application/xml');
    return { blocks: childrenOf(dom.documentElement, 'p').map(parseParagraph) };
  }
  const footerPart = await loadPartBlocks(footerRef);
  const headerPart = await loadPartBlocks(headerRef);

  /* ---- 字体与测量 ---- */
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const widthCache = new Map();

  const FALLBACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
  function fontFamily(run) {
    const name = run.eastAsia || run.font;
    if (!name) return FALLBACK;
    const mono = /consolas|courier|mono|menlo/i.test(name);
    return `"${name}", ${mono ? 'monospace' : FALLBACK}`;
  }
  function fontString(run) {
    const size = run.size || 11 * PT;
    return `${run.italic ? 'italic ' : ''}${run.bold ? '700 ' : ''}${size}px ${fontFamily(run)}`;
  }
  function textWidth(text, run) {
    const font = fontString(run);
    const key = font + '|' + text;
    if (widthCache.has(key)) return widthCache.get(key);
    measureCtx.font = font;
    const w = measureCtx.measureText(text).width;
    widthCache.set(key, w);
    return w;
  }

  const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

  function tokenize(runs) {
    const tokens = [];
    for (const run of runs) {
      if (run.pageBreak) { tokens.push({ pageBreak: true }); continue; }
      if (run.br) { tokens.push({ br: true }); continue; }
      if (run.tab) { tokens.push({ tab: true, props: run.props }); continue; }
      if (run.image) { tokens.push({ image: run.image, props: run.props }); continue; }
      if (!run.text) continue;
      let buf = '';
      const flush = () => { if (buf) { tokens.push({ text: buf, props: run.props, width: textWidth(buf, run.props) }); buf = ''; } };
      for (const ch of run.text) {
        if (CJK.test(ch) || ch === ' ') {
          flush();
          tokens.push({ text: ch, props: run.props, width: textWidth(ch, run.props), space: ch === ' ' });
        } else {
          buf += ch;
        }
      }
      flush();
    }
    return tokens;
  }

  /* ---- 段落排版（测量） ---- */
  function layoutParagraph(block, width, extraIndent = null) {
    const pPr = block.pPr;
    const ind = pPr.ind;
    const indentLeft = ind.left + (extraIndent || 0);
    const avail = Math.max(24, width - indentLeft - ind.right);
    const firstIndent = ind.firstLine - ind.hanging;
    const spacing = pPr.spacing;
    const mult = spacing.rule === 'auto' ? Math.max(0.5, spacing.line / 240) : 1;

    const tokens = tokenize(block.runs);
    const lines = [];
    let line = { tokens: [], width: 0, height: 0, maxSize: 0 };
    let isFirst = true;
    const lineLimit = () => (isFirst ? avail - firstIndent : avail);

    const pushLine = (hard) => {
      line.height = Math.max(line.height, line.maxSize * LINE_FACTOR * mult, 14);
      line.hard = hard;
      lines.push(line);
      line = { tokens: [], width: 0, height: 0, maxSize: 0 };
      isFirst = false;
    };

    for (const token of tokens) {
      if (token.pageBreak) {
        pushLine(true);
        lines.push({ pageBreak: true });
        continue;
      }
      if (token.br) { pushLine(true); continue; }

      if (token.image) {
        let w = token.image.width || 200;
        let h = token.image.height || 150;
        const maxW = Math.max(24, avail);
        if (w > maxW) { h = h * (maxW / w); w = maxW; }
        token.width = w;
        token.height = h;
      }

      if (token.tab) {
        const stop = Math.ceil((line.width + 1) / DEFAULT_TAB) * DEFAULT_TAB;
        token.width = Math.max(4, stop - line.width);
      }

      const limit = lineLimit();
      if (line.width + token.width > limit && line.tokens.length) {
        if (token.space) continue;
        pushLine(false);
      }
      line.tokens.push(token);
      line.width += token.width;
      const size = (token.props && token.props.size) || 11 * PT;
      line.maxSize = Math.max(line.maxSize, size);
      if (token.height) line.height = Math.max(line.height, token.height);
    }
    if (line.tokens.length) pushLine(false);

    if (!lines.length) {
      lines.push({ tokens: [], width: 0, height: 11 * PT * LINE_FACTOR * mult, hard: false });
    }

    const totalHeight = lines.reduce((sum, l) => (l.pageBreak ? sum : sum + l.height), 0)
      + spacing.before + spacing.after;

    return {
      kind: 'p',
      block,
      lines,
      indentLeft,
      firstIndent,
      avail,
      mult,
      before: spacing.before,
      after: spacing.after,
      height: totalHeight,
      align: pPr.jc || 'left',
      border: pPr.borders,
      shading: pPr.shading,
    };
  }

  /* ---- 表格排版 ---- */
  function layoutTable(tbl, width) {
    let cols = tbl.grid.length ? tbl.grid.slice() : [];
    if (!cols.length) {
      const first = tbl.rows[0];
      cols = first ? first.cells.map((c) => c.width || width / first.cells.length) : [width];
    }
    let total = cols.reduce((a, b) => a + b, 0);
    if (!total) { cols = [width]; total = width; }
    if (total > width) {
      const k = width / total;
      cols = cols.map((c) => c * (k));
    }

    const colX = [];
    let acc = 0;
    for (const c of cols) { colX.push(acc); acc += c; }

    const margin = tbl.margins;
    const rows = tbl.rows.map((row) => {
      const cells = [];
      let col = 0;
      for (const cell of row.cells) {
        let span = cell.span || 1;
        let cellW = 0;
        for (let i = 0; i < span && col + i < cols.length; i++) cellW += cols[col + i];
        if (!cellW) cellW = width / row.cells.length;
        const innerW = Math.max(10, cellW - margin.left - margin.right);
        const laid = [];
        for (const block of cell.blocks) {
          if (block.type === 'p') laid.push(layoutParagraph(block, innerW));
          else if (block.type === 'tbl') laid.push(layoutTable(block, innerW));
        }
        // Word 会忽略单元格首段的段前距、末段的段后距
        laid.forEach((b, i) => {
          if (!b || b.kind !== 'p') return;
          let height = b.height;
          let before = b.before;
          let after = b.after;
          if (i === 0 && before) { height -= before; before = 0; }
          if (i === laid.length - 1 && after) { height -= after; after = 0; }
          if (height !== b.height) laid[i] = { ...b, before, after, height };
        });
        const contentH = laid.reduce((s, b) => s + b.height, 0);
        cells.push({
          x: colX[col] || 0,
          width: cellW,
          span,
          fill: cell.fill,
          borders: cell.borders,
          blocks: laid,
          height: contentH + margin.top + margin.bottom,
        });
        col += span;
      }
      const height = Math.max(row.minHeight || 0, ...cells.map((c) => c.height));
      return { cells, height };
    });

    const totalH = rows.reduce((s, r) => s + r.height, 0);
    return {
      kind: 'tbl',
      block: tbl,
      cols,
      rows,
      width: cols.reduce((a, b) => a + b, 0),
      height: totalH,
    };
  }

  /* ---- 绘制 ---- */
  const scale = dpi / 96;
  const pageBlobs = [];
  let canvas = null;
  let ctx = null;
  let y = 0;

  function startPage() {
    canvas = document.createElement('canvas');
    canvas.width = Math.round(pageW * scale);
    canvas.height = Math.round(pageH * scale);
    ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageW, pageH);
    ctx.textBaseline = 'alphabetic';
    y = margin.top;
    if (headerPart) drawPart(headerPart, margin.top - margin.header - 8, 'header');
  }

  async function finishPage() {
    if (!canvas) return;
    if (footerPart) drawFooter(canvas);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('页面编码失败'))), 'image/jpeg', 0.92);
    });
    pageBlobs.push(blob);
    canvas = null;
    ctx = null;
  }

  async function newPage() {
    await finishPage();
    startPage();
  }

  function drawFooter(pageCanvas) {
    const saved = ctx;
    ctx = pageCanvas.getContext('2d');
    let fy = pageH - margin.footer + 12;
    for (const block of footerPart.blocks) {
      const layout = layoutParagraph(block, contentW);
      drawParagraph(layout, margin.left, fy - layout.before, contentW);
      fy += layout.height;
    }
    ctx = saved;
  }

  function pageBottom() {
    return pageH - margin.bottom;
  }

  function drawPart(part, yPos, kind) {
    let cursor = yPos;
    for (const block of part.blocks) {
      const layout = layoutParagraph(block, contentW);
      drawParagraph(layout, margin.left, cursor, contentW);
      cursor += layout.height;
      if (kind === 'header' && cursor > margin.top) break;
    }
  }

  function drawParagraph(layout, x, top, width) {
    const p = layout.block;
    const innerLeft = x + layout.indentLeft;
    const indentForLine = (idx) => (idx === 0 ? layout.firstIndent : 0);

    let cursorY = top + layout.before;

    // 段落底纹 / 边框
    if (layout.shading || layout.border) {
      const boxH = layout.height - layout.before - layout.after;
      if (layout.shading) {
        ctx.fillStyle = layout.shading;
        ctx.fillRect(x, cursorY, width, boxH);
      }
      if (layout.border) {
        drawBoxBorders(layout.border, x, cursorY, width, boxH);
      }
    }

    // 列表标记
    const marker = p.marker;
    if (marker) {
      ctx.fillStyle = '#000000';
      ctx.font = fontString({ ...marker.props });
      ctx.textAlign = 'right';
      ctx.fillText(marker.text, innerLeft - 6, cursorY + marker.ascent);
      ctx.textAlign = 'left';
    }

    let lineTop = cursorY;
    layout.lines.forEach((line, index) => {
      if (line.pageBreak) {
        lineTop += 0;
        return;
      }
      const offset = indentForLine(index);
      const startX = innerLeft + offset;
      const lineWidth = Math.min(layout.avail - offset, width - layout.indentLeft - offset);

      let extra = 0;
      if (layout.align === 'both' || layout.align === 'distribute') {
        const isLast = index === layout.lines.length - 1 || layout.lines[index + 1]?.pageBreak;
        const spaces = line.tokens.filter((t) => t.space).length;
        if (!isLast && spaces > 0) {
          extra = Math.max(0, lineWidth - line.width) / spaces;
        }
      }
      let alignShift = 0;
      if (layout.align === 'center') alignShift = (lineWidth - line.width) / 2;
      else if (layout.align === 'right' || layout.align === 'end') alignShift = lineWidth - line.width;

      let tx = startX + alignShift;
      const baseline = lineTop + (line.height - (line.maxSize * LINE_FACTOR - line.maxSize) / 2) - line.maxSize * 0.18;

      for (const token of line.tokens) {
        if (token.image) {
          const img = token.image.bitmap;
          const h = token.height || line.height;
          const topImg = lineTop + (line.height - h) / 2;
          if (img) ctx.drawImage(img, tx, topImg, token.width, h);
          else {
            ctx.strokeStyle = 'rgba(0,0,0,.25)';
            ctx.strokeRect(tx, topImg, token.width, h);
            ctx.fillStyle = 'rgba(0,0,0,.45)';
            ctx.font = '12px sans-serif';
            ctx.fillText('[图片]', tx + 6, topImg + 16);
          }
          tx += token.width;
          continue;
        }

        if (token.space && extra) {
          tx += extra;
        }

        const props = token.props || {};
        const isSuper = props.vertAlign === 'superscript';
        const isSub = props.vertAlign === 'subscript';
        const size = props.size || 11 * PT;

        if (props.highlight) {
          ctx.fillStyle = props.highlight;
          ctx.fillRect(tx, lineTop + 2, token.width, line.height - 3);
        }

        ctx.font = fontString(props);
        ctx.fillStyle = props.color || (null) || '#1a1a1a';
        if (isSuper) ctx.fillStyle = props.color || '#1a1a1a';
        const dy = isSuper ? -size * 0.42 : isSub ? size * 0.22 : 0;
        ctx.fillText(token.text, tx, baseline + dy);

        if (props.underline) {
          ctx.strokeStyle = props.color || '#1a1a1a';
          ctx.lineWidth = Math.max(0.8, size * 0.06);
          ctx.beginPath();
          ctx.moveTo(tx, baseline + dy + size * 0.13);
          ctx.lineTo(tx + token.width, baseline + dy + size * 0.13);
          ctx.stroke();
        }
        if (props.strike) {
          ctx.strokeStyle = props.color || '#1a1a1a';
          ctx.lineWidth = Math.max(0.8, size * 0.06);
          ctx.beginPath();
          ctx.moveTo(tx, baseline + dy - size * 0.3);
          ctx.lineTo(tx + token.width, baseline + dy - size * 0.3);
          ctx.stroke();
        }
        tx += token.width;
      }
      lineTop += line.height;
    });

    return layout.height;
  }

  function drawBoxBorders(borders, x, top, w, h) {
    const map = { top: [x, top, x + w, top], bottom: [x, top + h, x + w, top + h],
      left: [x, top, x, top + h], right: [x + w, top, x + w, top + h] };
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const b = borders[side];
      if (!b) continue;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width;
      const [x1, y1, x2, y2] = map[side];
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  function drawTable(layout, x, top, from = 0, to = layout.rows.length) {
    const tbl = layout.block;
    let rowTop = top;
    for (let r = from; r < to; r += 1) {
      const row = layout.rows[r];
      // 底纹
      for (const cell of row.cells) {
        if (cell.fill) {
          ctx.fillStyle = cell.fill;
          ctx.fillRect(x + cell.x, rowTop, cell.width, row.height);
        }
      }
      // 内容
      for (const cell of row.cells) {
        let cy = rowTop + tbl.margins.top;
        for (const block of cell.blocks) {
          if (block.kind === 'p') {
            drawParagraph(block, x + cell.x + tbl.margins.left, cy, cell.width - tbl.margins.left - tbl.margins.right);
          } else if (block.kind === 'tbl') {
            drawTable(block, x + cell.x + tbl.margins.left, cy);
          }
          cy += block.height;
        }
      }
      // 边框
      for (const cell of row.cells) {
        const borders = cell.borders || tbl.borders || {};
        const cw = cell.width;
        const map = {
          top: [x + cell.x, rowTop, x + cell.x + cw, rowTop],
          bottom: [x + cell.x, rowTop + row.height, x + cell.x + cw, rowTop + row.height],
          left: [x + cell.x, rowTop, x + cell.x, rowTop + row.height],
          right: [x + cell.x + cw, rowTop, x + cell.x + cw, rowTop + row.height],
        };
        for (const side of ['top', 'bottom', 'left', 'right']) {
          const b = borders[side];
          if (!b) continue;
          ctx.strokeStyle = b.color;
          ctx.lineWidth = b.width;
          const [x1, y1, x2, y2] = map[side];
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }
      rowTop += row.height;
    }
    return rowTop - top;
  }

  /* ---- 预排版：给列表加编号、解析图片 ---- */

  async function prepare(blockList) {
    for (const block of blockList) {
      if (block.type === 'tbl') {
        for (const row of block.rows) {
          for (const cell of row.cells) await prepare(cell.blocks);
        }
        continue;
      }
      if (block.pPr.numPr) {
        const marker = listMarker(block.pPr.numPr, {});
        if (marker) {
          block.marker = {
            text: marker.text,
            props: Object.assign({}, marker.lvl.rPr, { size: (marker.lvl.rPr.size || 11 * PT) }),
            ascent: (marker.lvl.rPr.size || 11 * PT) * 1.1,
          };
          // 列表缩进：段落自身的 ind 优先，缺的字段用编号定义里的补
          const lvlInd = marker.lvl.pPr && marker.lvl.pPr.ind;
          if (lvlInd) {
            const own = block.pPr.ind || ZERO_IND;
            block.pPr.ind = {
              left: own.left || lvlInd.left || 0,
              right: own.right || lvlInd.right || 0,
              firstLine: own.firstLine || lvlInd.firstLine || 0,
              hanging: own.hanging || lvlInd.hanging || 0,
            };
          }
        }
      }
      for (const run of block.runs) {
        if (run.image && !run.image.bitmap) {
          run.image.bitmap = await loadImage(run.image.relId);
          if (run.image.bitmap && (!run.image.width || !run.image.height)) {
            run.image.width = run.image.bitmap.width;
            run.image.height = run.image.bitmap.height;
          }
        }
      }
    }
  }

  await prepare(blocks);

  /* ---- 主流程 ---- */
  startPage();
  onProgress(0.1);

  const total = blocks.length;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.type === 'p' && block.pPr.pageBreakBefore && y > margin.top) await newPage();

    if (block.type === 'p') {
      const layout = layoutParagraph(block, contentW);
      // 分页符：拆成两段
      const breakIndex = layout.lines.findIndex((l) => l.pageBreak);
      if (breakIndex >= 0) {
        const before = { ...layout, lines: layout.lines.slice(0, breakIndex) };
        const after = { ...layout, lines: layout.lines.slice(breakIndex + 1) };
        before.height = before.lines.filter((l) => !l.pageBreak).reduce((s, l) => s + l.height, 0) + layout.before;
        if (before.lines.length) {
          drawParagraph(before, margin.left, y, contentW);
          y += before.height;
        }
        await newPage();
        after.height = after.lines.reduce((s, l) => s + l.height, 0) + layout.after;
        if (after.lines.length) {
          drawParagraph(after, margin.left, y, contentW);
          y += after.height;
        }
      } else {
        let need = layout.height;
        // keepNext：标题不要孤零零留在页底
        if (block.pPr.keepNext && blocks[i + 1]) {
          const next = blocks[i + 1];
          const nextH = next.type === 'p'
            ? layoutParagraph(next, contentW).height
            : layoutTable(next, contentW).height;
          need += Math.min(nextH, 140);
        }
        if (y + need > pageBottom() && y > margin.top) await newPage();
        drawParagraph(layout, margin.left, y, contentW);
        y += layout.height;
      }
    } else if (block.type === 'tbl') {
      const layout = layoutTable(block, contentW);
      const tableX = margin.left + (block.jc === 'center' ? Math.max(0, (contentW - layout.width) / 2) : 0);

      // 表格跨页：一行一行地填，填不下就换页继续（Word 的行为）
      let idx = 0;
      let guard = 0;
      while (idx < layout.rows.length && guard < 500) {
        guard += 1;
        let used = 0;
        let fit = idx;
        while (fit < layout.rows.length && y + used + layout.rows[fit].height <= pageBottom()) {
          used += layout.rows[fit].height;
          fit += 1;
        }
        if (fit === idx) {
          if (y > margin.top) { await newPage(); continue; }
          // 页面是空的还放不下：硬画一行，避免死循环
          fit = idx + 1;
          used = layout.rows[idx].height;
        }
        drawTable(layout, tableX, y, idx, fit);
        y += used;
        idx = fit;
        if (idx < layout.rows.length) await newPage();
      }
    }
    onProgress(0.1 + 0.6 * ((i + 1) / total));
  }

  // 收尾：把最后一页（含页脚）压成图片
  await finishPage();
  onProgress(0.75);

  /* ---- 打包 PDF ---- */
  const { PDFDocument } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const pageWpt = pageW * 0.75;
  const pageHpt = pageH * 0.75;

  for (let i = 0; i < pageBlobs.length; i += 1) {
    const bytes = new Uint8Array(await pageBlobs[i].arrayBuffer());
    const img = await pdf.embedJpg(bytes);
    const page = pdf.addPage([pageWpt, pageHpt]);
    page.drawImage(img, { x: 0, y: 0, width: pageWpt, height: pageHpt });
    onProgress(0.75 + 0.24 * ((i + 1) / pageBlobs.length));
  }

  const out = await pdf.save();
  onProgress(1);
  return {
    blob: new Blob([out], { type: 'application/pdf' }),
    pages: pageBlobs.length,
    width: pageWpt,
    height: pageHpt,
  };
}
