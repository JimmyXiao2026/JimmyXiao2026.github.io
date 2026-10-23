/* 文档与 PDF 互转（内容级）
   PDF → 图片 / 文本 / DOCX
   图片 / 文本 / DOCX → PDF
   DOCX → 文本 / HTML
   DOCX 的读写用 JSZip + OOXML 手工拼装，不走排版引擎。 */

import {
  $, appendMeta, bindDrop, clamp, clearNode, download, baseName, fmtBytes,
  loadJsZip, loadPdfJs, loadPdfLib, setBusy, showError, toast,
} from './ui.js';
import { renderDocxToPdf } from './docx-render.js';

const A4 = [595.28, 841.89];        // PDF 点
const CANVAS_W = 1240;              // A4 @150dpi
const CANVAS_H = 1754;
const MARGIN = 84;
const FONT_SIZE = 26;
const LINE_HEIGHT = 38;

const TARGETS = {
  pdf: [
    { id: 'png', label: 'PNG 图片（每页一张）' },
    { id: 'jpg', label: 'JPG 图片（每页一张）' },
    { id: 'txt', label: '纯文本（可复制）' },
    { id: 'docx', label: 'Word 文档 (.docx)' },
  ],
  docx: [
    { id: 'pdf', label: 'PDF' },
    { id: 'txt', label: '纯文本' },
    { id: 'html', label: 'HTML' },
  ],
  image: [{ id: 'pdf', label: 'PDF' }],
  text: [
    { id: 'pdf', label: 'PDF' },
    { id: 'docx', label: 'Word 文档 (.docx)' },
  ],
};

function detectType(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.doc')) return 'doc';           // 老格式，提示不支持
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/.test(name)) return 'image';
  if (/\.(txt|md|markdown|html?|csv|json|xml)$/.test(name) || file.type.startsWith('text/')) return 'text';
  return '';
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ------------------------------------------------------------ DOCX 生成 */

function buildDocx(paragraphs) {
  const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = paragraphs.map((line) => {
    const texts = String(line).split('\t');
    const runs = texts.map((t, i) => (i ? '<w:r><w:tab/></w:r>' : '') +
      `<w:r><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`).join('');
    return `<w:p>${runs || '<w:pPr/>'}</w:p>`;
  }).join('');

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${NS}"><w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  return { documentXml, contentTypes, rels };
}

export async function makeDocx(paragraphs) {
  const JSZip = await loadJsZip();
  const { documentXml, contentTypes, rels } = buildDocx(paragraphs);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export async function docxToText(file) {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(file);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('这个 .docx 里找不到 word/document.xml，可能文件已损坏');
  const xml = await entry.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const paragraphs = [];
  const nodes = doc.getElementsByTagNameNS('*', 'p');
  for (const p of nodes) {
    let line = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        const tag = child.localName;
        if (tag === 't') line += child.textContent;
        else if (tag === 'tab') line += '\t';
        else if (tag === 'br') line += '\n';
        else walk(child);
      }
    };
    walk(p);
    paragraphs.push(line);
  }
  return paragraphs;
}

/* ------------------------------------------------------------ 文本排版 */

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw) { lines.push(''); continue; }
    let line = '';
    for (const ch of raw) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function renderTextPages(text, title) {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${FONT_SIZE}px "Noto Sans SC", "Microsoft YaHei", sans-serif`;

  const paragraphs = String(text).replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  const maxWidth = CANVAS_W - MARGIN * 2;
  const usable = CANVAS_H - MARGIN * 2;
  const linesPerPage = Math.floor(usable / LINE_HEIGHT);

  for (const para of paragraphs) {
    const wrapped = wrapText(measure, para, maxWidth);
    lines.push(...(wrapped.length ? wrapped : ['']));
  }

  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#14161f';
    ctx.font = `${FONT_SIZE}px "Noto Sans SC", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'top';

    const slice = lines.slice(i, i + linesPerPage);
    slice.forEach((line, idx) => {
      ctx.fillText(line, MARGIN, MARGIN + idx * LINE_HEIGHT);
    });

    // 页脚
    ctx.fillStyle = '#9aa3bd';
    ctx.font = '18px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`${title} · ${pages.length + 1}`, MARGIN, CANVAS_H - MARGIN + 18);
    pages.push(canvas);
  }
  return pages;
}

async function canvasesToPdf(canvases) {
  const { PDFDocument } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  for (const canvas of canvases) {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('页面图片编码失败'))), 'image/jpeg', 0.9);
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = await pdf.embedJpg(bytes);
    const page = pdf.addPage(A4);
    const scale = Math.min((A4[0] - 0) / img.width, (A4[1]) / img.height);
    page.drawImage(img, {
      x: 0,
      y: 0,
      width: img.width * scale,
      height: img.height * scale,
    });
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

async function imageToPdf(file) {
  const { PDFDocument } = await loadPdfLib();
  const pdf = await PDFDocument.create();

  let bytes = new Uint8Array(await file.arrayBuffer());
  let embed;
  if (/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)) {
    embed = await pdf.embedJpg(bytes);
  } else if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
    embed = await pdf.embedPng(bytes);
  } else {
    // webp / gif / bmp / avif 等先过一遍 canvas 转 PNG
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    bytes = new Uint8Array(await blob.arrayBuffer());
    embed = await pdf.embedPng(bytes);
  }

  const page = pdf.addPage(A4);
  const margin = 36;
  const scale = Math.min((A4[0] - margin * 2) / embed.width, (A4[1] - margin * 2) / embed.height);
  page.drawImage(embed, {
    x: (A4[0] - embed.width * scale) / 2,
    y: (A4[1] - embed.height * scale) / 2,
    width: embed.width * scale,
    height: embed.height * scale,
  });
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

/* ------------------------------------------------------------ PDF 读取 */

async function openPdf(file) {
  const pdfjsLib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  return doc;
}

async function pdfToText(doc, onProgress) {
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    let line = '';
    const lines = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.trimEnd());
        line = '';
      }
      line += item.str;
      if (item.hasEOL) { lines.push(line.trimEnd()); line = ''; lastY = null; }
      else lastY = y;
    }
    if (line) lines.push(line.trimEnd());
    parts.push(lines.join('\n'));
    if (onProgress) onProgress(i / doc.numPages);
  }
  return parts.join('\n\n');
}

async function pdfToCanvases(doc, scale, onProgress) {
  const canvases = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
    if (onProgress) onProgress(i / doc.numPages);
  }
  return canvases;
}

/* ---------------------------------------------------------------- 模块 */

export function initDoc() {
  const root = document.getElementById('panel-doc');
  if (!root) return;

  const ui = {
    drop: $('#drop-doc', root),
    input: $('#file-doc', root),
    fileinfo: $('#fileinfo-doc', root),
    name: $('[data-name]', root),
    meta: $('[data-meta]', root),
    clear: $('[data-clear]', root),
    settings: $('#settings-doc', root),
    target: $('#doc-target', root),
    dpiField: $('#doc-dpi-field', root),
    dpi: $('#doc-dpi', root),
    run: $('#run-doc', root),
    status: $('#status-doc', root),
    progress: $('#progress-doc', root),
    bar: $('#progress-doc > i', root),
    notice: $('#notice-doc', root),
    result: $('#result-doc', root),
    title: $('#result-doc-title', root),
    metaList: $('#result-doc-meta', root),
    download: $('#download-doc', root),
  };

  let file = null;
  let type = '';
  let output = null;

  function setProgress(p, label) {
    ui.progress.hidden = false;
    ui.bar.style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
    if (label) ui.status.textContent = label;
  }

  function populateTargets() {
    const list = TARGETS[type] || [];
    ui.target.innerHTML = '';
    for (const item of list) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label;
      ui.target.appendChild(opt);
    }
    syncTargetUI();
  }

  // 只更新联动状态，不重建选项（重建会把用户刚选的项重置掉）
  function syncTargetUI() {
    const isPdf = type === 'pdf';
    const isDocx = type === 'docx';
    const isPdfImages = isPdf && /png|jpg/.test(ui.target.value);
    const isDocxPdf = isDocx && ui.target.value === 'pdf';
    ui.dpiField.style.display = (isPdfImages || isDocxPdf) ? '' : 'none';

    const label = ui.dpiField.querySelector('label');
    if (label) {
      label.textContent = isDocxPdf ? 'PDF 渲染精度' : 'PDF 转图片的分辨率';
    }
    const texts = isDocxPdf
      ? ['150 dpi（标准，体积小）', '200 dpi（清晰，推荐）', '300 dpi（打印用，体积大）']
      : ['1×（约 96 dpi，预览用）', '2×（约 144 dpi，推荐）', '3×（约 216 dpi，打印用）'];
    Array.from(ui.dpi.options).forEach((opt, i) => {
      if (texts[i]) opt.textContent = texts[i];
    });
    ui.run.disabled = !file || !ui.target.options.length;
  }

  async function loadFile(f) {
    const detected = detectType(f);
    if (!detected) { toast('暂不支持这个文件类型', 'error'); return; }
    if (detected === 'doc') {
      showError(ui.notice, new Error('老版 .doc 不支持，请先在 Word/WPS 里另存为 .docx'));
      return;
    }
    clearNode(ui.notice);
    file = f;
    type = detected;
    output = null;
    ui.result.hidden = true;
    ui.name.textContent = f.name;
    const label = { pdf: 'PDF 文档', docx: 'Word 文档', image: '图片', text: '文本' }[detected];
    ui.meta.textContent = `${label} · ${fmtBytes(f.size)}`;
    ui.fileinfo.hidden = false;
    ui.settings.hidden = false;
    ui.drop.hidden = true;
    populateTargets();
    ui.status.textContent = '';
  }

  function resetAll() {
    file = null;
    type = '';
    output = null;
    ui.fileinfo.hidden = true;
    ui.settings.hidden = true;
    ui.result.hidden = true;
    ui.drop.hidden = false;
    ui.run.disabled = true;
    ui.status.textContent = '';
    ui.progress.hidden = true;
    ui.bar.style.width = '0%';
    clearNode(ui.notice);
  }

  bindDrop(ui.input, ui.drop, loadFile);
  ui.clear.addEventListener('click', resetAll);
  ui.target.addEventListener('change', syncTargetUI);

  ui.run.addEventListener('click', async () => {
    if (!file) return;
    const target = ui.target.value;
    setBusy(ui.run, true, '转换中…');
    clearNode(ui.notice);
    ui.result.hidden = true;
    setProgress(0.02, '准备中…');

    try {
      let blob;
      let ext = target;
      let note = '';

      if (type === 'image' && target === 'pdf') {
        setProgress(0.4, '正在生成 PDF…');
        blob = await imageToPdf(file);
        ext = 'pdf';
      } else if (type === 'text' && target === 'pdf') {
        setProgress(0.15, '正在排版…');
        const text = await file.text();
        const canvases = renderTextPages(text, baseName(file.name));
        blob = await canvasesToPdf(canvases);
        ext = 'pdf';
        note = `共 ${canvases.length} 页`;
      } else if (type === 'text' && target === 'docx') {
        setProgress(0.3, '正在生成 DOCX…');
        const text = await file.text();
        blob = await makeDocx(text.split(/\r?\n/));
        ext = 'docx';
      } else if (type === 'docx') {
        setProgress(0.2, '正在解析 DOCX…');
        const paragraphs = await docxToText(file);
        if (target === 'txt') {
          blob = new Blob([paragraphs.join('\n')], { type: 'text/plain;charset=utf-8' });
          ext = 'txt';
        } else if (target === 'html') {
          const html = '<!DOCTYPE html><meta charset="utf-8"><title>' + escapeXml(baseName(file.name)) + '</title>' +
            '<style>body{max-width:820px;margin:40px auto;padding:0 20px;font:16px/1.8 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#222}' +
            'p{margin:0 0 .7em}</style>' +
            paragraphs.map((p) => `<p>${escapeXml(p) || '&nbsp;'}</p>`).join('');
          blob = new Blob([html], { type: 'text/html;charset=utf-8' });
          ext = 'html';
        } else {
          setProgress(0.1, '正在解析 DOCX 并排版…');
          const dpi = [150, 200, 300][clamp(Number(ui.dpi.value) - 1, 0, 2)] || 150;
          const result = await renderDocxToPdf(file, {
            dpi,
            onProgress: (p) => setProgress(0.1 + p * 0.85, '正在渲染页面…'),
          });
          blob = result.blob;
          ext = 'pdf';
          note = `共 ${result.pages} 页 · ${dpi} dpi`;
        }
      } else if (type === 'pdf') {
        setProgress(0.08, '正在打开 PDF…');
        const doc = await openPdf(file);

        if (target === 'txt') {
          const text = await pdfToText(doc, (p) => setProgress(0.1 + p * 0.85, '正在抽取文字…'));
          blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          ext = 'txt';
        } else if (target === 'docx') {
          const text = await pdfToText(doc, (p) => setProgress(0.1 + p * 0.6, '正在抽取文字…'));
          setProgress(0.8, '正在生成 DOCX…');
          blob = await makeDocx(text.split(/\r?\n/));
          ext = 'docx';
          note = '只保留文字，版式与图片会丢失';
        } else {
          const scale = Number(ui.dpi.value) || 2;
          const canvases = await pdfToCanvases(doc, scale, (p) => setProgress(0.1 + p * 0.8, '正在渲染页面…'));
          const mime = target === 'jpg' ? 'image/jpeg' : 'image/png';
          const quality = target === 'jpg' ? 0.9 : undefined;
          const blobs = [];
          for (const canvas of canvases) {
            blobs.push(await new Promise((resolve, reject) => {
              canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('页面导出失败'))), mime, quality);
            }));
          }
          if (blobs.length === 1) {
            blob = blobs[0];
            ext = target;
          } else {
            setProgress(0.94, '正在打包 ZIP…');
            const JSZip = await loadJsZip();
            const zip = new JSZip();
            blobs.forEach((b, i) => {
              zip.file(`${baseName(file.name)}-${String(i + 1).padStart(2, '0')}.${target}`, b);
            });
            blob = await zip.generateAsync({ type: 'blob' });
            ext = 'zip';
            note = `${blobs.length} 页，已打包成 ZIP`;
          }
        }
      } else {
        throw new Error('这个组合目前还不支持');
      }

      setProgress(1, '完成');
      output = {
        blob,
        filename: `${baseName(file.name)}.${ext}`,
      };
      appendMeta(ui.metaList, [
        ['输出', output.filename],
        ['格式', ext.toUpperCase()],
        ['体积', fmtBytes(blob.size)],
        ...(note ? [['说明', note]] : []),
      ]);
      ui.title.textContent = output.filename;
      ui.result.hidden = false;
      ui.status.textContent = '完成';
      toast('转换完成 · ' + fmtBytes(blob.size), 'ok');
    } catch (err) {
      console.error(err);
      showError(ui.notice, err);
      ui.status.textContent = '';
      ui.progress.hidden = true;
    } finally {
      setBusy(ui.run, false);
    }
  });

  ui.download.addEventListener('click', () => {
    if (output) download(output.blob, output.filename);
  });
}
