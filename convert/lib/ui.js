/* 格式转换工具 —— 公共工具
   DOM 辅助、格式化、CDN 脚本加载、几何计算、Canvas / 媒体小工具。 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
}

export function baseName(name) {
  return String(name || 'file').replace(/\.[^.]+$/, '') || 'file';
}

/* ---------------------------------------------------------------- 下载 */

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ------------------------------------------------------------- 提示条 */

let toastTimer = null;
export function toast(msg, kind = 'info') {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    document.body.appendChild(node);
  }
  node.className = 'toast show ' + kind;
  node.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = 'toast ' + kind; }, 3800);
}

/* --------------------------------------------------- 按需加载 UMD 脚本 */

const scriptCache = new Map();

function loadOne(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error('脚本加载失败：' + url));
    };
    document.head.appendChild(s);
  });
}

/** 传数组时按顺序回退（国内网络下 jsDelivr 偶尔会抽风） */
export function loadScript(urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  const key = list[0];
  if (scriptCache.has(key)) return scriptCache.get(key);
  const task = (async () => {
    let lastErr = null;
    for (const url of list) {
      try {
        await loadOne(url);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    scriptCache.delete(key);
    throw lastErr || new Error('脚本加载失败');
  })();
  scriptCache.set(key, task);
  return task;
}

const CDN_BASES = [
  'https://cdn.jsdelivr.net/npm',
  'https://fastly.jsdelivr.net/npm',
  'https://unpkg.com',
];

const cdn = (pkgPath) => CDN_BASES.map((base) => `${base}/${pkgPath}`);

export const LIBS = {
  pdfLib: cdn('pdf-lib@1.17.1/dist/pdf-lib.min.js'),
  pdfJs: cdn('pdfjs-dist@3.11.174/build/pdf.min.js'),
  pdfJsWorker: cdn('pdfjs-dist@3.11.174/build/pdf.worker.min.js'),
  jszip: cdn('jszip@3.10.2/dist/jszip.min.js'),
  lame: cdn('lamejs@1.2.1/lame.min.js'),
  heic: cdn('heic2any@0.0.4/dist/heic2any.min.js'),
  gifenc: [
    'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js',
    'https://fastly.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js',
    'https://unpkg.com/gifenc@1.0.3/dist/gifenc.esm.js',
  ],
};

export async function loadHeic2any() {
  if (window.heic2any) return window.heic2any;
  await loadScript(LIBS.heic);
  const fn = window.heic2any;
  if (typeof fn !== 'function') throw new Error('HEIF 解码器加载失败');
  return fn;
}

/** 动态 import 多个候选地址（ESM 库用） */
export async function importAny(urls) {
  let lastErr = null;
  for (const url of urls) {
    try {
      return await import(/* @vite-ignore */ url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('模块加载失败');
}

export async function loadPdfLib() {
  if (!window.PDFLib) await loadScript(LIBS.pdfLib);
  return window.PDFLib;
}

let pdfjsReady = null;
export async function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = (async () => {
    if (!window.pdfjsLib) await loadScript(LIBS.pdfJs);
    // 跨域 worker 不能直接用，取回内容改成 blob URL（同样多 CDN 回退）
    let workerUrl = '';
    let lastErr = null;
    for (const url of LIBS.pdfJsWorker) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        workerUrl = URL.createObjectURL(await res.blob());
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!workerUrl) {
      pdfjsReady = null;
      throw lastErr || new Error('pdf.js worker 下载失败');
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    return window.pdfjsLib;
  })();
  return pdfjsReady;
}

export async function loadJsZip() {
  if (!window.JSZip) await loadScript(LIBS.jszip);
  return window.JSZip;
}

/* --------------------------------------------------------- 比例与几何 */

export const RATIOS = [
  { id: 'origin', label: '原始比例', value: 0 },
  { id: '1:1', label: '1 : 1', value: 1 },
  { id: '4:5', label: '4 : 5', value: 4 / 5 },
  { id: '3:4', label: '3 : 4', value: 3 / 4 },
  { id: '2:3', label: '2 : 3', value: 2 / 3 },
  { id: '3:2', label: '3 : 2', value: 3 / 2 },
  { id: '4:3', label: '4 : 3', value: 4 / 3 },
  { id: '16:9', label: '16 : 9', value: 16 / 9 },
  { id: '9:16', label: '9 : 16', value: 9 / 16 },
  { id: '16:10', label: '16 : 10', value: 16 / 10 },
  { id: '1.91:1', label: '1.91 : 1', value: 1.91 },
];

/**
 * 计算「源裁剪区」和「目标画布」。
 * @param {number} srcW 源宽
 * @param {number} srcH 源高
 * @param {object} o
 *   ratio       目标宽高比（0 = 跟随源）
 *   mode        'cover' 裁切填满 | 'fit' 完整缩放留白 | 'stretch' 拉伸
 *   width       目标宽（px，可为 0，表示按 height 推）
 *   height      目标高
 *   allowUpscale 是否允许放大到超过源
 * @returns {{sx:number,sy:number,sw:number,sh:number,dw:number,dh:number,cw:number,ch:number,scale:number}}
 */
export function computeGeometry(srcW, srcH, o) {
  const ratio = o.ratio || srcW / srcH;
  const mode = o.mode || 'cover';

  let cw = Math.round(o.width || 0);
  let ch = Math.round(o.height || 0);
  if (!cw && !ch) cw = srcW;
  if (!cw) cw = Math.round(ch * ratio);
  if (!ch) ch = Math.round(cw / ratio);

  // 不允许放大时，目标宽高不超过源图（按裁切区算）
  if (!o.allowUpscale && mode !== 'stretch') {
    const cropW = mode === 'fit' ? srcW : Math.min(srcW, srcH * ratio);
    const cropH = mode === 'fit' ? srcH : Math.min(srcH, srcW / ratio);
    const maxScale = Math.min(cropW / cw, cropH / ch);
    if (maxScale < 1) {
      cw = Math.max(1, Math.round(cw * maxScale));
      ch = Math.max(1, Math.round(ch * maxScale));
    }
  }
  cw = Math.max(1, cw);
  ch = Math.max(1, ch);

  if (mode === 'cover') {
    let sw = srcW;
    let sh = srcH;
    if (srcW / srcH > ratio) {
      sw = srcH * ratio;
      sh = srcH;
    } else {
      sw = srcW;
      sh = srcW / ratio;
    }
    const sx = (srcW - sw) / 2;
    const sy = (srcH - sh) / 2;
    return { sx, sy, sw, sh, dw: cw, dh: ch, cw, ch, scale: cw / sw };
  }

  if (mode === 'stretch') {
    return { sx: 0, sy: 0, sw: srcW, sh: srcH, dw: cw, dh: ch, cw, ch, scale: 1 };
  }

  // fit：整张图缩放到画布内，居中留白
  const s = Math.min(cw / srcW, ch / srcH);
  const dw = srcW * s;
  const dh = srcH * s;
  return {
    sx: 0, sy: 0, sw: srcW, sh: srcH,
    dw, dh, cw, ch, scale: s,
    dx: (cw - dw) / 2, dy: (ch - dh) / 2,
  };
}

/* --------------------------------------------------------------- Canvas */

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('导出失败：浏览器不支持 ' + type));
    }, type, quality);
  });
}

export function supportsType(type) {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  try {
    return c.toDataURL(type).startsWith('data:' + type);
  } catch {
    return false;
  }
}

export function drawGeometry(ctx, source, g, background) {
  ctx.clearRect(0, 0, g.cw, g.ch);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, g.cw, g.ch);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const dx = g.dx === undefined ? 0 : g.dx;
  const dy = g.dy === undefined ? 0 : g.dy;
  ctx.drawImage(source, g.sx, g.sy, g.sw, g.sh, dx, dy, g.dw, g.dh);
}

/* ------------------------------------------------------------ 图片解码 */

export function isHeif(file) {
  return /^image\/(heic|heif)$/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
}

async function blobToBitmap(blob) {
  if (window.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
    } catch { /* 走 img 兜底 */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode failed'));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * 解码图片：先是浏览器原生能力（PNG/JPEG/WebP/GIF/BMP/AVIF/SVG…），
 * 原生不行且是 HEIC/HEIF 时，按需加载 heic2any 的 wasm 解码器。
 */
export async function decodeImage(file) {
  const native = await blobToBitmap(file).catch(() => null);
  if (native && native.width && native.height) return native;

  if (isHeif(file)) {
    const heic2any = await loadHeic2any();
    const converted = await heic2any({ blob: file, toType: 'image/png' });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    if (!blob) throw new Error('HEIF 解码失败');
    const result = await blobToBitmap(blob);
    if (!result.width || !result.height) throw new Error('HEIF 解码失败');
    return result;
  }

  throw new Error('无法解码这张图片（浏览器不支持这个格式）');
}

/* -------------------------------------------------------- 媒体能力探测 */

export function pickMime(candidates) {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* ignore */ }
  }
  return '';
}

export function mimeExt(mime) {
  if (/mp4/.test(mime)) return 'mp4';
  if (/webm/.test(mime)) return 'webm';
  if (/ogg/.test(mime)) return 'ogg';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return 'bin';
}

/**
 * 估原始帧率：静音播放一小段，取 requestVideoFrameCallback 帧间隔的 10 分位。
 * 用低分位而不是中位数，是因为渲染掉帧时会出现 2×、3× 的间隔，
 * 而真正的基础帧间隔仍然是最小的那一档（同时避开偶发的重复时间戳）。
 */
export async function detectVideoFps(video) {
  if (!video) return 0;
  const wasMuted = video.muted;
  const startTime = video.currentTime || 0;
  const stamps = [];

  const snap = (fps) => {
    if (!fps || !Number.isFinite(fps) || fps < 1) return 0;
    for (const known of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120, 144]) {
      if (Math.abs(fps - known) < known * 0.06) return known;
    }
    return Math.round(fps * 100) / 100;
  };

  const estimate = () => {
    const deltas = [];
    for (let i = 1; i < stamps.length; i++) {
      const d = stamps[i] - stamps[i - 1];
      if (d > 0.004 && d < 1) deltas.push(d);
    }
    if (deltas.length < 3) return 0;
    deltas.sort((a, b) => a - b);
    const base = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.1))];
    return 1 / base;
  };

  video.muted = true;
  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    const points = [];   // [mediaTime, 解码帧数]

    const decodedFps = () => {
      if (points.length < 4) return 0;
      // 最小二乘拟合斜率：解码帧数 / 媒体秒。
      // 解码会跑在显示前面，但那是个大致恒定的偏移，不影响斜率。
      let n = points.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const [t, q] of points) { sx += t; sy += q; sxx += t * t; sxy += t * q; }
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) < 1e-9) return 0;
      return (n * sxy - sx * sy) / denom;
    };

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let fps = decodedFps();
      if (fps < 2) fps = estimate();
      try { video.pause(); } catch { /* ignore */ }
      try { video.currentTime = startTime; } catch { /* ignore */ }
      video.muted = wasMuted;
      resolve(snap(fps));
    };

    const sample = () => {
      if (done) return;
      let frames = 0;
      try {
        const q = video.getVideoPlaybackQuality && video.getVideoPlaybackQuality();
        frames = q ? q.totalVideoFrames : 0;
      } catch { frames = 0; }
      points.push([video.currentTime, frames]);
      const span = video.currentTime - points[0][0];
      if (span >= 1.0 || points.length >= 20) finish();
      else timer = setTimeout(sample, 100);
    };

    const onFrame = (now, meta) => {
      if (done) return;
      stamps.push(meta.mediaTime);
      if (stamps.length < 40 && !video.ended) video.requestVideoFrameCallback(onFrame);
    };

    timer = setTimeout(finish, 2600);
    video.play().then(() => {
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
      sample();
    }).catch(() => finish());
  });
}

/* ------------------------------------------------------------ 进度 / 状态 */

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.classList.add('busy');
    button.textContent = label || '处理中…';
  } else {
    button.disabled = false;
    button.classList.remove('busy');
    button.textContent = button.dataset.label || button.textContent;
  }
}

export function showError(node, err) {
  if (!node) return;
  node.hidden = false;
  node.className = 'notice error';
  node.textContent = (err && err.message) ? err.message : String(err);
}

export function clearNode(node) {
  if (node) {
    node.hidden = true;
    node.textContent = '';
  }
}

/* ------------------------------------------------------------ 拖放选择 */

export function bindDrop(input, dropEl, onFile) {
  dropEl.setAttribute('tabindex', '0');
  dropEl.setAttribute('role', 'button');

  dropEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) onFile(file);
    input.value = '';
  });

  let depth = 0;
  ['dragenter', 'dragover'].forEach((ev) => {
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      depth += 1;
      dropEl.classList.add('over');
    });
  });
  ['dragleave', 'dragend'].forEach((ev) => {
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (!depth) dropEl.classList.remove('over');
    });
  });
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dropEl.classList.remove('over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

export function fillSelect(select, items, format = (x) => x.label) {
  select.innerHTML = '';
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = String(item.value !== undefined ? item.value : item.id);
    opt.textContent = format(item);
    select.appendChild(opt);
  }
}

export function setFieldVisible(field, visible) {
  if (field) field.style.display = visible ? '' : 'none';
}

export function appendMeta(dl, rows) {
  if (!dl) return;
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}


