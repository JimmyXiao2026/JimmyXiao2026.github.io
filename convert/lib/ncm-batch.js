/* 网易云 NCM 批量解包
 *
 * 支持：多选文件、选择文件夹、直接拖文件夹进来
 * 输出：按每首歌自己的声道/采样率处理，最后打成一个 ZIP
 *   - 原始：源是 FLAC 就 FLAC（原样透传），否则 MP3
 *   - 强制 FLAC：源是 FLAC 才转，源本身是 MP3 时保留原格式并标注
 *   - 强制 MP3：源是 MP3 原样保留；源是 FLAC 则解码后按 320 kbps 编码
 */

import {
  $, clearNode, download, fmtBytes, loadScript, LIBS, setBusy, showError, toast,
} from './ui.js';
import { isNcm, parseNcm } from './ncm.js';
import { writeFlacTags, writeMp3Tags, readAudioTags } from './audio-meta.js';
import { encodeMp3 } from './audio.js';

const MP3_KBPS = 320;

const contexts = new Map();
function contextFor(rate) {
  const key = rate || 0;
  if (!contexts.has(key)) {
    let ctx;
    try {
      ctx = key ? new (window.AudioContext || window.webkitAudioContext)({ sampleRate: key })
        : new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    contexts.set(key, ctx);
  }
  return contexts.get(key);
}

function safeName(raw) {
  const cleaned = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || '未命名';
}

async function coverSize(cover) {
  try {
    const bitmap = await createImageBitmap(new Blob([cover.bytes], { type: cover.mime || 'image/jpeg' }));
    const size = { width: bitmap.width, height: bitmap.height };
    if (bitmap.close) bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

function readDir(entry) {
  return new Promise((resolve) => {
    const reader = entry.createReader();
    const all = [];
    const next = () => {
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, () => resolve(all));
    };
    next();
  });
}

async function filesFromDrop(dataTransfer) {
  const out = [];
  const entries = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }

  async function walk(entry) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push(file);
    } else if (entry.isDirectory) {
      const children = await readDir(entry);
      for (const child of children) await walk(child);
    }
  }

  if (entries.length) {
    for (const entry of entries) await walk(entry);
    return out;
  }
  return Array.from(dataTransfer.files || []);
}

export function initNcmBatch() {
  const panel = document.getElementById('panel-audio');
  if (!panel) return;

  const ui = {
    drop: $('#drop-ncm', panel),
    input: $('#file-ncm', panel),
    dirInput: $('#ncm-dir', panel),
    pickFiles: $('#ncm-pick-files', panel),
    pickDir: $('#ncm-pick-dir', panel),
    count: $('#ncm-count', panel),
    format: $('#ncm-format', panel),
    hint: $('#ncm-hint', panel),
    rows: $('#ncm-rows', panel),
    run: $('#run-ncm', panel),
    clear: $('#clear-ncm', panel),
    status: $('#status-ncm', panel),
    progress: $('#progress-ncm', panel),
    bar: $('#progress-ncm > i', panel),
    notice: $('#notice-ncm', panel),
  };
  if (!ui.drop || !ui.rows) return;

  let items = [];

  /* ---------------- 列表 ---------------- */

  function renderCount() {
    const total = items.reduce((s, it) => s + it.file.size, 0);
    ui.count.textContent = items.length ? `共 ${items.length} 个文件 · ${fmtBytes(total)}` : '';
    ui.run.disabled = !items.length;
    ui.clear.hidden = !items.length;
  }

  function renderRows() {
    clearNode(ui.rows);
    ui.rows.hidden = !items.length;
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'ncm-row';
      li.dataset.index = String(index);

      const name = document.createElement('span');
      name.className = 'ncm-name';
      name.textContent = item.file.name;
      name.title = item.file.name;

      const size = document.createElement('span');
      size.className = 'ncm-size';
      size.textContent = fmtBytes(item.file.size);

      const state = document.createElement('span');
      state.className = 'ncm-state';
      state.textContent = '等待';
      item.stateEl = state;

      li.append(name, size, state);
      ui.rows.append(li);
    });
  }

  function setState(item, kind, text) {
    if (!item.stateEl) return;
    item.stateEl.className = 'ncm-state' + (kind ? ' ' + kind : '');
    item.stateEl.textContent = text;
  }

  function addFiles(list) {
    const incoming = Array.from(list || []);
    let added = 0;
    let ignored = 0;
    const seen = new Set(items.map((it) => it.file.name + ':' + it.file.size));
    for (const file of incoming) {
      const isNcmName = /\.ncm$/i.test(file.name);
      if (!isNcmName) { ignored += 1; continue; }
      const key = file.name + ':' + file.size;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ file, stateEl: null });
      added += 1;
    }
    if (added) {
      renderRows();
      renderCount();
      ui.rows.hidden = false;
    }
    if (!added && !ignored) toast('没有可处理的文件', 'warn');
    else if (!added && ignored) toast(`已忽略 ${ignored} 个非 .ncm 文件`, 'warn');
    else if (ignored) toast(`已加入 ${added} 个，忽略 ${ignored} 个非 .ncm 文件`, 'ok');
  }

  /* ---------------- 事件 ---------------- */

  ui.input.addEventListener('change', () => {
    addFiles(ui.input.files);
    ui.input.value = '';
  });
  ui.dirInput.addEventListener('change', () => {
    addFiles(ui.dirInput.files);
    ui.dirInput.value = '';
  });
  ui.pickFiles.addEventListener('click', () => ui.input.click());
  ui.pickDir.addEventListener('click', () => ui.dirInput.click());

  ['dragenter', 'dragover'].forEach((type) => {
    ui.drop.addEventListener(type, (e) => {
      e.preventDefault();
      ui.drop.classList.add('over');
    });
  });
  ['dragleave', 'dragend'].forEach((type) => {
    ui.drop.addEventListener(type, () => ui.drop.classList.remove('over'));
  });
  ui.drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    ui.drop.classList.remove('over');
    const files = await filesFromDrop(e.dataTransfer);
    addFiles(files);
  });
  ui.drop.setAttribute('tabindex', '0');
  ui.drop.setAttribute('role', 'button');
  ui.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ui.input.click();
    }
  });

  ui.clear.addEventListener('click', () => {
    items = [];
    renderRows();
    renderCount();
    ui.status.textContent = '';
    ui.progress.hidden = true;
    ui.bar.style.width = '0%';
    clearNode(ui.notice);
  });

  ui.format.addEventListener('change', () => {
    const hint = {
      auto: '源文件是 FLAC 就无损原样导出，是 MP3 就保留 MP3。',
      flac: '源是 FLAC 直接原样导出；源本身是 MP3 时无法转成 FLAC，会保留原 MP3 并标注。',
      mp3: '源是 MP3 原样保留；源是 FLAC 会解码后按 320 kbps 重新编码。',
    };
    ui.hint.textContent = hint[ui.format.value] || '';
  });
  ui.format.dispatchEvent(new Event('change'));

  /* ---------------- 处理 ---------------- */

  async function run() {
    if (!items.length) return;
    setBusy(ui.run, true, '处理中…');
    clearNode(ui.notice);
    ui.progress.hidden = false;
    ui.bar.style.width = '0%';

    const format = ui.format.value;
    const total = items.length;
    let ok = 0;
    let failed = 0;

    try {
      if (!window.JSZip) await loadScript(LIBS.jszip);
      if (!window.JSZip) throw new Error('ZIP 组件加载失败（首次需要联网加载一次）');
      const zip = new window.JSZip();
      const used = new Set();

      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        setState(item, 'run', '处理中…');
        ui.status.textContent = `${i + 1} / ${total}`;
        try {
          const bytes = new Uint8Array(await item.file.arrayBuffer());
          if (!isNcm(bytes)) throw new Error('不是网易云 .ncm 文件');
          const ncm = parseNcm(bytes);

          const meta = ncm.metadata || {};
          const tags = {
            title: meta.title || '',
            artist: meta.artist || '',
            album: meta.album || '',
            cover: null,
          };
          if (ncm.cover) {
            const size = await coverSize(ncm.cover);
            tags.cover = { bytes: ncm.cover.bytes, mime: ncm.cover.mime, width: size.width, height: size.height };
          }

          const target = format === 'auto' ? ncm.format : format;
          let out = null;
          let ext = 'flac';
          let note = '';

          if (target === 'flac') {
            if (ncm.format === 'flac') {
              out = writeFlacTags(ncm.audio, tags);
              ext = 'flac';
            } else {
              out = writeMp3Tags(ncm.audio, tags);
              ext = 'mp3';
              note = '源为 MP3，无法转 FLAC，已保留原格式';
            }
          } else {
            if (ncm.format === 'mp3') {
              out = writeMp3Tags(ncm.audio, tags);
              ext = 'mp3';
            } else {
              const probe = readAudioTags(ncm.audio);
              const encRate = !probe.sampleRate || probe.sampleRate > 48000 ? 48000 : probe.sampleRate;
              const ac = contextFor(encRate);
              const decoded = await ac.decodeAudioData(ncm.audio.buffer);
              const channels = [];
              for (let c = 0; c < decoded.numberOfChannels; c += 1) {
                channels.push(decoded.getChannelData(c));
              }
              const audioBytes = await encodeMp3(channels, decoded.sampleRate, MP3_KBPS);
              out = writeMp3Tags(audioBytes, tags);
              ext = 'mp3';
              note = `从 FLAC 转码 ${MP3_KBPS} kbps`;
            }
          }

          const artistText = String(meta.artist || '').replace(/\s*\/\s*/g, ', ');
          const base = safeName([artistText, meta.title].filter(Boolean).join(' - ')
            || item.file.name.replace(/\.ncm$/i, ''));
          let name = `${base}.${ext}`;
          let seq = 2;
          while (used.has(name)) name = `${base} (${seq++}).${ext}`;
          used.add(name);

          zip.file(name, out);
          setState(item, 'ok', `✓ ${name} · ${fmtBytes(out.length)}`);
          ok += 1;
        } catch (err) {
          console.error(err);
          setState(item, 'err', '✗ ' + (err && err.message ? err.message : String(err)));
          failed += 1;
        }
        ui.bar.style.width = Math.round(((i + 1) / total) * 70) + '%';
      }

      if (!ok) throw new Error(`全部 ${failed} 个文件都处理失败了`);

      ui.status.textContent = '正在打包 ZIP…';
      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' },
        (meta) => { ui.bar.style.width = Math.round(70 + meta.percent * 0.3) + '%'; },
      );
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      download(blob, `ncm-${stamp}.zip`);
      ui.status.textContent = `完成：${ok} 个成功${failed ? `，${failed} 个失败` : ''} · ${fmtBytes(blob.size)}`;
      toast(`已导出 ${ok} 个文件`, 'ok');
    } catch (err) {
      console.error(err);
      showError(ui.notice, err);
      ui.status.textContent = '';
    } finally {
      setBusy(ui.run, false);
      setBusy(ui.clear, false);
      ui.progress.hidden = true;
    }
  }

  ui.run.addEventListener('click', run);
}
