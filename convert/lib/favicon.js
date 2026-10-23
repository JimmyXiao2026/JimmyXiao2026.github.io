/* 图片 → favicon.ico（PNG 编码的 ICO 容器，浏览器与 Windows Vista+ 都认） */

import {
  $, bindDrop, clamp, clearNode, computeGeometry, decodeImage, download,
  drawGeometry, toast, showError, fmtBytes,
} from './ui.js';

const MAX_ICON = 256;

export function buildIco(entries) {
  const headerSize = 6 + 16 * entries.length;
  const total = headerSize + entries.reduce((sum, e) => sum + e.png.byteLength, 0);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint16(0, 0, true);                  // reserved
  view.setUint16(2, 1, true);                  // 1 = icon
  view.setUint16(4, entries.length, true);     // 图像数量

  let offset = headerSize;
  entries.forEach((entry, i) => {
    const p = 6 + i * 16;
    bytes[p] = entry.width >= 256 ? 0 : entry.width;        // 0 表示 256
    bytes[p + 1] = entry.height >= 256 ? 0 : entry.height;
    bytes[p + 2] = 0;                                        // 调色板数量
    bytes[p + 3] = 0;                                        // reserved
    view.setUint16(p + 4, 1, true);                          // color planes
    view.setUint16(p + 6, 32, true);                         // bits per pixel
    view.setUint32(p + 8, entry.png.byteLength, true);       // 图像数据大小
    view.setUint32(p + 12, offset, true);                    // 数据偏移
    bytes.set(new Uint8Array(entry.png), offset);
    offset += entry.png.byteLength;
  });

  return new Blob([buffer], { type: 'image/x-icon' });
}

export function initFavicon() {
  const root = document.getElementById('panel-favicon');
  if (!root) return;

  const ui = {
    drop: $('#drop-favicon', root),
    input: $('#file-favicon', root),
    fileinfo: $('#fileinfo-favicon', root),
    name: $('[data-name]', root),
    meta: $('[data-meta]', root),
    clear: $('[data-clear]', root),
    settings: $('#settings-favicon', root),
    sizes: $('#fav-sizes', root),
    w: $('#fav-w', root),
    h: $('#fav-h', root),
    wRange: $('#fav-w-range', root),
    hRange: $('#fav-h-range', root),
    wVal: $('#fav-w-val', root),
    hVal: $('#fav-h-val', root),
    mode: $('#fav-mode', root),
    multi: $('#fav-multi', root),
    preview: $('#fav-preview', root),
    previewBig: $('#fav-preview-img', root),
    preview16: $('#fav-preview-16', root),
    preview32: $('#fav-preview-32', root),
    previewSize: $('#fav-preview-size', root),
    run: $('#run-favicon', root),
    status: $('#status-favicon', root),
    notice: $('#notice-favicon', root),
  };

  let state = null;
  let frame = 0;

  // 只读取，不回写输入框（避免打字打到一半被截断）
  function sizeOf() {
    return {
      w: clamp(Math.round(Number(ui.w.value) || 1), 1, MAX_ICON),
      h: clamp(Math.round(Number(ui.h.value) || 1), 1, MAX_ICON),
    };
  }

  // 提交 / 失焦时才把越界值写回输入框
  function readSize() {
    const { w, h } = sizeOf();
    if (ui.w.value !== String(w)) ui.w.value = String(w);
    if (ui.h.value !== String(h)) ui.h.value = String(h);
    return { w, h };
  }

  function markChip() {
    const { w, h } = sizeOf();
    ui.sizes.querySelectorAll('.chip').forEach((chip) => {
      const size = Number(chip.dataset.size);
      chip.setAttribute('aria-pressed', String(size === w && size === h));
    });
  }

  // 数字输入、滑块、数值标签三者同步
  function syncControls() {
    const w = clamp(Math.round(Number(ui.w.value) || 1), 1, MAX_ICON);
    const h = clamp(Math.round(Number(ui.h.value) || 1), 1, MAX_ICON);
    ui.wRange.value = String(w);
    ui.hRange.value = String(h);
    ui.wVal.textContent = String(w);
    ui.hVal.textContent = String(h);
  }

  function renderPreview() {
    frame = 0;
    if (!state) return;
    const { w, h } = sizeOf();
    const big = Math.min(128, Math.max(w, h));
    const draw = (size) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(size * (w / Math.max(w, h))));
      canvas.height = Math.max(1, Math.round(size * (h / Math.max(w, h))));
      const g = computeGeometry(state.width, state.height, {
        ratio: w / h,
        mode: ui.mode.value,
        width: canvas.width,
        height: canvas.height,
        allowUpscale: true,
      });
      const ctx = canvas.getContext('2d');
      drawGeometry(ctx, state.source, g, null);
      return canvas.toDataURL('image/png');
    };
    ui.previewBig.src = draw(big);
    ui.preview16.src = draw(16);
    ui.preview32.src = draw(32);
    ui.previewSize.textContent = `${w} × ${h}`;
    ui.preview.hidden = false;
  }

  function schedulePreview() {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(renderPreview);
  }

  async function loadFile(file) {
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件', 'error');
      return;
    }
    ui.status.textContent = '正在解码…';
    clearNode(ui.notice);
    try {
      const img = await decodeImage(file);
      state = { file, source: img.source, width: img.width, height: img.height, close: img.close };
      ui.name.textContent = file.name;
      ui.meta.textContent = `${img.width}×${img.height} · ${fmtBytes(file.size)}`;
      ui.fileinfo.hidden = false;
      ui.settings.hidden = false;
      ui.drop.hidden = true;
      ui.run.disabled = false;
      ui.status.textContent = '';
      syncControls();
      markChip();
      schedulePreview();
    } catch (err) {
      ui.status.textContent = '';
      showError(ui.notice, err);
    }
  }

  function reset() {
    if (state && state.close) state.close();
    state = null;
    ui.fileinfo.hidden = true;
    ui.settings.hidden = true;
    ui.preview.hidden = true;
    ui.drop.hidden = false;
    ui.run.disabled = true;
    ui.status.textContent = '';
    clearNode(ui.notice);
  }

  bindDrop(ui.input, ui.drop, loadFile);
  ui.clear.addEventListener('click', reset);

  ui.sizes.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    ui.w.value = chip.dataset.size;
    ui.h.value = chip.dataset.size;
    syncControls();
    markChip();
    schedulePreview();
  });

  [ui.w, ui.h].forEach((input) => {
    input.addEventListener('input', () => {
      syncControls();
      markChip();
      schedulePreview();
    });
    input.addEventListener('blur', () => {
      readSize();
      syncControls();
      markChip();
      schedulePreview();
    });
  });

  [ui.wRange, ui.hRange].forEach((range) => {
    range.addEventListener('input', () => {
      if (range === ui.wRange) ui.w.value = range.value;
      else ui.h.value = range.value;
      syncControls();
      markChip();
      schedulePreview();
    });
  });
  ui.mode.addEventListener('change', schedulePreview);
  ui.multi.addEventListener('change', () => {
    ui.status.textContent = ui.multi.checked ? '将额外打包 16 / 32 / 48 尺寸' : '';
  });

  ui.run.addEventListener('click', async () => {
    if (!state) return;
    const { w, h } = readSize();
    if (w > MAX_ICON || h > MAX_ICON) {
      showError(ui.notice, new Error('最大 256 × 256'));
      return;
    }
    ui.run.disabled = true;
    ui.status.textContent = '正在生成…';
    clearNode(ui.notice);

    try {
      const targets = [{ width: w, height: h }];
      if (ui.multi.checked) {
        for (const s of [48, 32, 16]) {
          if (!targets.some((t) => t.width === s && t.height === s)) targets.push({ width: s, height: s });
        }
      }

      const entries = [];
      for (const t of targets) {
        const canvas = document.createElement('canvas');
        canvas.width = t.width;
        canvas.height = t.height;
        const g = computeGeometry(state.width, state.height, {
          ratio: t.width / t.height,
          mode: ui.mode.value,
          width: t.width,
          height: t.height,
          allowUpscale: true,
        });
        drawGeometry(canvas.getContext('2d'), state.source, g, null);
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
        });
        entries.push({ width: t.width, height: t.height, png: await blob.arrayBuffer() });
      }

      const ico = buildIco(entries);
      const filename = 'favicon.ico';
      download(ico, filename);
      ui.status.textContent = `已生成 ${entries.length} 个尺寸 · ${fmtBytes(ico.size)}`;
      toast(`favicon.ico 已下载（${entries.length} 个尺寸，${fmtBytes(ico.size)}）`, 'ok');
    } catch (err) {
      showError(ui.notice, err);
      ui.status.textContent = '';
    } finally {
      ui.run.disabled = false;
    }
  });
}
