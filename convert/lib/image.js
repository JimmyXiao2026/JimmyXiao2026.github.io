/* 图片转换 / 压缩 / 裁切 */

import {
  $, RATIOS, appendMeta, bindDrop, canvasToBlob, clearNode, computeGeometry, decodeImage,
  download, drawGeometry, baseName, fillSelect, fmtBytes, setBusy, setFieldVisible,
  showError, supportsType, toast,
} from './ui.js';

const FORMAT_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_SIDE = 10000;

export function initImage() {
  const root = document.getElementById('panel-image');
  if (!root) return;

  const ui = {
    drop: $('#drop-image', root),
    input: $('#file-image', root),
    fileinfo: $('#fileinfo-image', root),
    name: $('[data-name]', root),
    meta: $('[data-meta]', root),
    clear: $('[data-clear]', root),
    settings: $('#settings-image', root),
    format: $('#img-format', root),
    qualityField: $('#img-quality-field', root),
    quality: $('#img-quality', root),
    qualityVal: $('#img-quality-val', root),
    ratio: $('#img-ratio', root),
    mode: $('#img-mode', root),
    w: $('#img-w', root),
    h: $('#img-h', root),
    dimsHint: $('#img-dims-hint', root),
    upscale: $('#img-upscale', root),
    run: $('#run-image', root),
    status: $('#status-image', root),
    notice: $('#notice-image', root),
    result: $('#result-image', root),
    canvas: $('#result-image-canvas', root),
    title: $('#result-image-title', root),
    metaList: $('#result-image-meta', root),
    download: $('#download-image', root),
  };

  let state = null;   // { file, source, width, height, close }
  let output = null;  // { blob, filename, width, height }

  fillSelect(ui.ratio, RATIOS.map((r) => ({ id: r.id, label: r.label })));

  const ratioValue = () => {
    const id = ui.ratio.value;
    const found = RATIOS.find((r) => r.id === id);
    if (found && found.value) return found.value;
    return state ? state.width / state.height : 1;
  };

  const isLinked = () => ui.mode.value !== 'stretch';

  function syncHint() {
    const g = safeGeometry();
    if (!g) { ui.dimsHint.textContent = ''; return; }
    const reqW = Number(ui.w.value) || 0;
    const reqH = Number(ui.h.value) || 0;
    const clamped = !ui.upscale.checked && (reqW > g.cw + 0.5 || reqH > g.ch + 0.5);
    ui.dimsHint.textContent = `输出 ${g.cw} × ${g.ch} px`
      + (clamped ? '（未勾选放大，已按原图上限收紧）' : (state && g.cw > state.width ? '（放大）' : ''));
  }

  function safeGeometry() {
    if (!state) return null;
    const w = Number(ui.w.value) || 0;
    const h = Number(ui.h.value) || 0;
    if (!w || !h) return null;
    try {
      return computeGeometry(state.width, state.height, {
        ratio: ratioValue(),
        mode: ui.mode.value,
        width: w,
        height: h,
        allowUpscale: ui.upscale.checked,
      });
    } catch {
      return null;
    }
  }

  function applyRatio(keep = 'w') {
    if (!state) return;
    if (!isLinked()) { syncHint(); return; }
    const r = ratioValue();
    const w = Number(ui.w.value) || 0;
    const h = Number(ui.h.value) || 0;
    if (keep === 'w' && w) {
      ui.h.value = String(Math.max(1, Math.round(w / r)));
    } else if (keep === 'h' && h) {
      ui.w.value = String(Math.max(1, Math.round(h * r)));
    }
    syncHint();
  }

  function reset() {
    if (state && state.close) state.close();
    state = null;
    output = null;
    ui.fileinfo.hidden = true;
    ui.settings.hidden = true;
    ui.result.hidden = true;
    ui.run.disabled = true;
    ui.status.textContent = '';
    clearNode(ui.notice);
    ui.drop.hidden = false;
    ui.input.value = '';
  }

  async function loadFile(file) {
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i.test(file.name)) {
      toast('这不是图片文件', 'error');
      return;
    }
    reset();
    ui.status.textContent = '正在解码…';
    try {
      const img = await decodeImage(file);
      if (!img.width || !img.height) throw new Error('图片尺寸为 0，可能已损坏');
      state = {
        file,
        source: img.source,
        width: img.width,
        height: img.height,
        close: img.close,
      };

      ui.name.textContent = file.name;
      ui.meta.textContent = `${img.width}×${img.height} · ${fmtBytes(file.size)}`;
      ui.fileinfo.hidden = false;
      ui.settings.hidden = false;
      ui.drop.hidden = true;
      ui.w.value = String(img.width);
      ui.h.value = String(img.height);
      ui.ratio.value = 'origin';
      applyRatio('w');
      updateFormatUI();
      ui.run.disabled = false;
      ui.status.textContent = '';
    } catch (err) {
      showError(ui.notice, err);
      ui.status.textContent = '';
    }
  }

  function updateFormatUI() {
    const lossy = ui.format.value !== 'image/png';
    setFieldVisible(ui.qualityField, lossy);
    const supported = supportsType(ui.format.value);
    ui.run.disabled = !state || !supported;
    if (!supported) {
      showError(ui.notice, new Error('当前浏览器不支持导出 ' + ui.format.value));
    } else {
      clearNode(ui.notice);
    }
  }

  bindDrop(ui.input, ui.drop, loadFile);
  ui.clear.addEventListener('click', () => { reset(); ui.drop.hidden = false; });

  ui.quality.addEventListener('input', () => { ui.qualityVal.textContent = ui.quality.value; });
  ui.format.addEventListener('change', updateFormatUI);
  ui.ratio.addEventListener('change', () => applyRatio('w'));
  ui.mode.addEventListener('change', () => {
    ui.w.disabled = false;
    ui.h.disabled = false;
    if (isLinked()) applyRatio('w');
    syncHint();
  });
  ui.w.addEventListener('input', () => applyRatio('w'));
  ui.h.addEventListener('input', () => applyRatio('h'));
  ui.upscale.addEventListener('change', syncHint);

  ui.run.addEventListener('click', async () => {
    if (!state) return;
    const fmt = ui.format.value;
    if (!supportsType(fmt)) { showError(ui.notice, new Error('浏览器不支持该格式')); return; }
    const g = safeGeometry();
    if (!g) { showError(ui.notice, new Error('请填写有效的宽高')); return; }
    if (g.cw > MAX_SIDE || g.ch > MAX_SIDE) {
      showError(ui.notice, new Error(`尺寸太大（上限 ${MAX_SIDE}px），请调小一点`));
      return;
    }

    setBusy(ui.run, true, '转换中…');
    clearNode(ui.notice);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = g.cw;
      canvas.height = g.ch;
      const ctx = canvas.getContext('2d', { alpha: fmt !== 'image/jpeg' });
      const bg = fmt === 'image/jpeg' ? '#ffffff' : null;
      drawGeometry(ctx, state.source, g, bg);

      const blob = await canvasToBlob(canvas, fmt, Number(ui.quality.value) / 100);
      const filename = `${baseName(state.file.name)}.${FORMAT_EXT[fmt] || 'img'}`;
      output = { blob, filename, width: g.cw, height: g.ch };

      // 结果预览（缩到合适大小显示）
      ui.canvas.width = g.cw;
      ui.canvas.height = g.ch;
      const pctx = ui.canvas.getContext('2d');
      pctx.drawImage(canvas, 0, 0);

      const delta = blob.size - state.file.size;
      const pct = state.file.size ? (delta / state.file.size) * 100 : 0;
      ui.title.textContent = filename;
      appendMeta(ui.metaList, [
        ['尺寸', `${g.cw} × ${g.ch}`],
        ['格式', fmt.replace('image/', '').toUpperCase()],
        ['体积', `${fmtBytes(state.file.size)} → ${fmtBytes(blob.size)}（${delta <= 0 ? '−' : '+'}${Math.abs(pct).toFixed(1)}%）`],
      ]);
      ui.result.hidden = false;
      ui.status.textContent = '完成';
      toast('转换完成，' + fmtBytes(blob.size), 'ok');
    } catch (err) {
      showError(ui.notice, err);
      ui.status.textContent = '';
    } finally {
      setBusy(ui.run, false);
    }
  });

  ui.download.addEventListener('click', () => {
    if (output) download(output.blob, output.filename);
  });
}
