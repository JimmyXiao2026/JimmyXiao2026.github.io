/* 批量转换（音频 / 网易云 NCM）
 *
 * 支持：多选文件、选择文件夹、直接拖文件夹进来；NCM 会先解密再处理
 * 输出：按每首歌自己的声道/采样率处理，最后打成一个 ZIP
 *   - 原始：保持源格式（FLAC / MP3 / WAV 会顺带重写标签，其余原样复制）
 *   - 强制 FLAC：源是 FLAC 原样；有损源保留原格式（浏览器没有 FLAC 编码器）
 *   - 强制 MP3：源是 MP3 原样；其余解码后按 320 kbps 编码
 *   - 统一 OGG：全部解码后编码成 Ogg Opus
 */

import {
  $, clearNode, download, fmtBytes, loadScript, LIBS, setBusy, showError, toast,
} from './ui.js';
import { isNcm, parseNcm } from './ncm.js';
import {
  writeFlacTags, writeMp3Tags, writeWavTags, readAudioTags, sniffFormat,
} from './audio-meta.js';
import { encodeMp3 } from './audio.js';
import { encodeOggOpus } from './ogg-opus.js';

const MP3_KBPS = 320;
const AUDIO_EXT = ['ncm', 'flac', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac'];

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

async function pictureSize(pic) {
  try {
    const bitmap = await createImageBitmap(new Blob([pic.bytes], { type: pic.mime || 'image/jpeg' }));
    const size = { width: bitmap.width, height: bitmap.height };
    if (bitmap.close) bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

async function normalizePictures(pictures) {
  const out = [];
  for (const pic of pictures || []) {
    if (!pic || !pic.bytes) continue;
    const size = await pictureSize(pic);
    out.push({
      type: pic.type || 3,
      bytes: pic.bytes,
      mime: pic.mime || 'image/jpeg',
      width: size.width,
      height: size.height,
    });
  }
  return out;
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

function decodeBytes(bytes, rate) {
  const ctx = contextFor(rate);
  const copy = bytes.slice();
  return ctx.decodeAudioData(copy.buffer);
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

  function renderCount() {
    const total = items.reduce((sum, item) => sum + item.file.size, 0);
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
    const seen = new Set(items.map((item) => item.file.name + ':' + item.file.size));
    for (const file of incoming) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!AUDIO_EXT.includes(ext)) { ignored += 1; continue; }
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
    else if (!added && ignored) toast(`已忽略 ${ignored} 个不支持的文件`, 'warn');
    else if (ignored) toast(`已加入 ${added} 个，忽略 ${ignored} 个不支持的文件`, 'ok');
  }

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
    const hints = {
      auto: '保持源格式：FLAC / MP3 / WAV 会顺带写入标签，其它格式原样复制。',
      flac: '源是 FLAC 直接原样导出；有损源（MP3 / OGG / M4A…）会保留原格式并标注原因。',
      mp3: '源是 MP3 原样保留；其它格式会解码后按 320 kbps 重新编码。',
      ogg: '全部解码后编码成 Ogg Opus（160 kbps），并写入标签与封面。',
    };
    ui.hint.textContent = hints[ui.format.value] || '';
  });
  ui.format.dispatchEvent(new Event('change'));

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
      const zipCtx = contextFor(0);

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        setState(item, 'run', '处理中…');
        ui.status.textContent = `${index + 1} / ${total}`;
        try {
          const bytes = new Uint8Array(await item.file.arrayBuffer());
          let sourceFormat = '';
          let audioBytes = bytes;
          let title = '';
          let artist = '';
          let album = '';
          let pictures = [];

          if (isNcm(bytes)) {
            const ncm = parseNcm(bytes);
            sourceFormat = ncm.format;
            audioBytes = ncm.audio;
            title = ncm.metadata.title || '';
            artist = ncm.metadata.artist || '';
            album = ncm.metadata.album || '';
            if (ncm.cover) pictures = [{ type: 3, bytes: ncm.cover.bytes, mime: ncm.cover.mime }];
          } else {
            sourceFormat = sniffFormat(bytes, item.file.name);
            if (!sourceFormat) throw new Error('无法识别音频格式');
            const info = readAudioTags(bytes, item.file.name);
            title = info.title;
            artist = info.artist;
            album = info.album;
            pictures = info.pictures || [];
          }

          const tags = { title, artist, album, pictures: await normalizePictures(pictures) };
          let out = null;
          let ext = sourceFormat;
          let note = '';

          if (format === 'auto') {
            if (sourceFormat === 'flac') { out = writeFlacTags(audioBytes, tags); ext = 'flac'; }
            else if (sourceFormat === 'mp3') { out = writeMp3Tags(audioBytes, tags); ext = 'mp3'; }
            else if (sourceFormat === 'wav') { out = writeWavTags(audioBytes, tags); ext = 'wav'; }
            else { out = audioBytes; ext = sourceFormat; note = '原样复制（该格式暂不改写标签）'; }
          } else if (format === 'flac') {
            if (sourceFormat === 'flac') { out = writeFlacTags(audioBytes, tags); ext = 'flac'; }
            else if (sourceFormat === 'wav') { out = writeWavTags(audioBytes, tags); ext = 'wav'; note = '无损源，保留 WAV'; }
            else {
              out = sourceFormat === 'mp3' ? writeMp3Tags(audioBytes, tags) : audioBytes;
              ext = sourceFormat;
              note = '源为有损格式，无法转 FLAC，已保留原格式';
            }
          } else if (format === 'mp3') {
            if (sourceFormat === 'mp3') { out = writeMp3Tags(audioBytes, tags); ext = 'mp3'; }
            else {
              const probe = sourceFormat === 'flac' ? readAudioTags(audioBytes, item.file.name) : null;
              const rate = (probe && probe.sampleRate) || 0;
              const encRate = !rate || rate > 48000 ? 48000 : rate;
              const decoded = await decodeBytes(audioBytes, encRate);
              const channels = [];
              for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));
              out = writeMp3Tags(await encodeMp3(channels, decoded.sampleRate, MP3_KBPS), tags);
              ext = 'mp3';
              note = `转码 ${MP3_KBPS} kbps`;
            }
          } else if (format === 'ogg') {
            const decoded = await decodeBytes(audioBytes, 0);
            const channels = [];
            for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));
            const audioBuffer = zipCtx.createBuffer(channels.length, channels[0].length, decoded.sampleRate);
            channels.forEach((data, c) => audioBuffer.copyToChannel(data, c));
            out = await encodeOggOpus(audioBuffer, {
              bitrate: 160000,
              tags,
              pictures: tags.pictures,
            });
            ext = 'ogg';
            note = 'Ogg Opus 160 kbps';
          } else {
            throw new Error('不支持的导出格式');
          }

          const artistText = String(artist || '').replace(/\s*\/\s*/g, ', ');
          const base = safeName([artistText, title].filter(Boolean).join(' - ')
            || item.file.name.replace(/\.[^.]+$/, ''));
          let name = `${base}.${ext}`;
          let seq = 2;
          while (used.has(name)) name = `${base} (${seq++}).${ext}`;
          used.add(name);

          zip.file(name, out);
          setState(item, 'ok', `✓ ${name} · ${fmtBytes(out.length)}${note ? ' · ' + note : ''}`);
          ok += 1;
        } catch (err) {
          console.error(err);
          setState(item, 'err', '✗ ' + (err && err.message ? err.message : String(err)));
          failed += 1;
        }
        ui.bar.style.width = Math.round(((index + 1) / total) * 70) + '%';
      }

      if (!ok) throw new Error(`全部 ${failed} 个文件都处理失败了`);

      ui.status.textContent = '正在打包 ZIP…';
      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' },
        (meta) => { ui.bar.style.width = Math.round(70 + meta.percent * 0.3) + '%'; },
      );
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      download(blob, `convert-${stamp}.zip`);
      ui.status.textContent = `完成：${ok} 个成功${failed ? `，${failed} 个失败` : ''} · ${fmtBytes(blob.size)}`;
      toast(`已导出 ${ok} 个文件`, 'ok');
    } catch (err) {
      console.error(err);
      showError(ui.notice, err);
      ui.status.textContent = '';
    } finally {
      setBusy(ui.run, false);
      ui.progress.hidden = true;
    }
  }

  ui.run.addEventListener('click', run);
}
