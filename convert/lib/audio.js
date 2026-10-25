/* 音频转换 / 波形裁剪 / 标签编辑
 *
 * 输入：MP3 / FLAC / WAV / OGG / M4A / AAC / OPUS，以及网易云 .ncm
 * 导出：WAV（无损）、FLAC（源文件是 FLAC 时原样保留）、MP3（lamejs）、OGG（Opus）
 * 封面与标题/艺术家/专辑会写进导出文件。
 */

import {
  $, appendMeta, bindDrop, clamp, clearNode, download, fmtBytes, fmtTime,
  loadScript, LIBS, setBusy, setFieldVisible, showError, toast, baseName,
} from './ui.js';
import { readAudioTags, writeFlacTags, writeMp3Tags, writeWavTags, sniffFormat, stripId3 } from './audio-meta.js';
import { isNcm, parseNcm } from './ncm.js';
import { encodeOggOpus } from './ogg-opus.js';

const WAVE_H = 240;

/* ------------------------------------------------------------------ 编码器 */

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(channels, sampleRate) {
  const numCh = channels.length;
  const length = channels[0].length;
  const dataBytes = length * numCh * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const s = clamp(channels[c][i], -1, 1);
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

export async function encodeMp3(channels, sampleRate, kbps, onProgress) {
  if (!window.lamejs) await loadScript(LIBS.lame);
  if (!window.lamejs) throw new Error('MP3 编码器加载失败');

  const numCh = Math.min(2, channels.length);
  const encoder = new window.lamejs.Mp3Encoder(numCh, sampleRate, kbps);
  const length = channels[0].length;
  const block = 1152;
  const chunks = [];
  const left = new Int16Array(block);
  const right = new Int16Array(block);
  const total = Math.ceil(length / block);

  for (let start = 0; start < length; start += block) {
    const n = Math.min(block, length - start);
    left.fill(0);
    right.fill(0);
    const l = channels[0];
    for (let i = 0; i < n; i += 1) {
      const v = clamp(l[start + i], -1, 1);
      left[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    if (numCh === 2) {
      const r = channels[1];
      for (let i = 0; i < n; i += 1) {
        const v = clamp(r[start + i], -1, 1);
        right[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    const out = numCh === 2
      ? encoder.encodeBuffer(left.subarray(0, n), right.subarray(0, n))
      : encoder.encodeBuffer(left.subarray(0, n));
    if (out.length) chunks.push(new Uint8Array(out));

    const done = Math.floor(start / block);
    if (onProgress && done % 120 === 0) {
      onProgress(done / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const tail = encoder.flush();
  if (tail && tail.length) chunks.push(new Uint8Array(tail));
  if (onProgress) onProgress(1);

  const blob = new Blob(chunks, { type: 'audio/mpeg' });
  return new Uint8Array(await blob.arrayBuffer());
}

/* ------------------------------------------------------------------ 小工具 */

function fmtKhz(rate) {
  if (!rate) return '—';
  const khz = rate / 1000;
  const text = Number.isInteger(khz) ? String(khz) : String(Math.round(khz * 100) / 100);
  return text + ' kHz';
}

function fmtDuration(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
}

function fmtBitrate(bps) {
  if (!bps || !Number.isFinite(bps)) return '—';
  return Math.round(bps / 1000) + ' kbps';
}

/* ------------------------------------------------------------------ 模块 */

export function initAudio() {
  const root = document.getElementById('panel-audio');
  if (!root) return;

  const ui = {
    drop: $('#drop-audio', root),
    input: $('#file-audio', root),
    fileinfo: $('#fileinfo-audio', root),
    name: $('[data-name]', root),
    meta: $('[data-meta]', root),
    clear: $('[data-clear]', root),
    tagsEditor: $('#audio-tags', root),
    cover: $('#audio-cover', root),
    coverEmpty: $('#audio-cover-empty', root),
    coverPick: $('#audio-cover-pick', root),
    coverClear: $('#audio-cover-clear', root),
    coverFile: $('#audio-cover-file', root),
    title: $('#audio-title', root),
    artist: $('#audio-artist', root),
    album: $('#audio-album', root),
    tech: $('#audio-tech', root),
    waveWrap: $('#wave-wrap', root),
    canvas: $('#wave', root),
    selLabel: $('#audio-sel', root),
    play: $('#audio-play', root),
    all: $('#audio-all', root),
    reset: $('#audio-reset', root),
    settings: $('#settings-audio', root),
    format: $('#audio-format', root),
    formatHint: $('#audio-format-hint', root),
    bitrateField: $('#audio-bitrate-field', root),
    bitrate: $('#audio-bitrate', root),
    rate: $('#audio-rate', root),
    channels: $('#audio-channels', root),
    run: $('#run-audio', root),
    status: $('#status-audio', root),
    notice: $('#notice-audio', root),
    progress: $('#progress-audio', root),
    bar: $('#progress-audio > i', root),
    result: $('#result-audio', root),
    titleOut: $('#result-audio-title', root),
    metaList: $('#result-audio-meta', root),
    download: $('#download-audio', root),
  };

  let ctx = null;
  let buffer = null;
  let file = null;
  let peaks = null;
  let sel = null;
  let drag = null;
  let playhead = null;
  let source = null;
  let output = null;

  let sourceBytes = null;        // 原始字节（FLAC 原样导出时要用）
  let sourceFormat = '';
  let sourceRate = 0;
  let sourceChannels = 0;
  let tags = { title: '', artist: '', album: '', cover: null };
  let coverUrl = '';
  let oggSupported = false;

  const duration = () => (buffer ? buffer.duration : 0);

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ---------------- 编码器能力 ---------------- */
  (async () => {
    try {
      if (typeof AudioEncoder !== 'undefined') {
        const res = await AudioEncoder.isConfigSupported({
          codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000,
        });
        oggSupported = !!res.supported;
      }
    } catch {
      oggSupported = false;
    }
    const option = ui.format.querySelector('option[value="ogg"]');
    if (option) option.disabled = !oggSupported;
  })();

  /* ---------------- 波形 ---------------- */

  function computePeaks(width) {
    const chCount = buffer.numberOfChannels;
    const data = [];
    for (let c = 0; c < Math.min(2, chCount); c += 1) data.push(buffer.getChannelData(c));
    const step = buffer.length / width;
    const out = new Float32Array(width);
    for (let x = 0; x < width; x += 1) {
      const from = Math.floor(x * step);
      const to = Math.min(buffer.length, Math.floor((x + 1) * step));
      let max = 0;
      for (let i = from; i < to; i += 1) {
        for (let c = 0; c < data.length; c += 1) {
          const v = Math.abs(data[c][i]);
          if (v > max) max = v;
        }
      }
      out[x] = max;
    }
    return out;
  }

  function draw() {
    const canvas = ui.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 800;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(WAVE_H * dpr);
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const w = cssW;
    const h = WAVE_H;

    g.clearRect(0, 0, w, h);
    if (!peaks || !peaks.length) return;

    const mid = h / 2;
    const byX = (t) => (t / duration()) * w;
    const x0 = sel ? byX(sel.start) : 0;
    const x1 = sel ? byX(sel.end) : w;

    g.fillStyle = 'rgba(139,124,248,.10)';
    g.fillRect(x0, 0, Math.max(0, x1 - x0), h);

    const barW = Math.max(1, w / peaks.length);
    for (let x = 0; x < peaks.length; x += 1) {
      const px = (x / peaks.length) * w;
      const amp = Math.max(1, peaks[x] * (h / 2 - 6));
      const inside = px >= x0 && px <= x1;
      g.fillStyle = inside ? 'rgba(56,189,248,.9)' : 'rgba(154,163,189,.45)';
      g.fillRect(px, mid - amp, Math.max(1, barW * 0.8), amp * 2);
    }

    g.fillStyle = 'rgba(255,255,255,.08)';
    g.fillRect(0, mid, w, 1);

    if (sel) {
      for (const x of [x0, x1]) {
        g.fillStyle = '#8b7cf8';
        g.fillRect(x - 1, 0, 2, h);
        g.fillStyle = 'rgba(139,124,248,.95)';
        g.fillRect(x - 5, mid - 12, 10, 24);
      }
    }

    if (playhead !== null) {
      const px = byX(playhead);
      g.fillStyle = 'rgba(255,255,255,.75)';
      g.fillRect(px, 0, 1, h);
    }
  }

  function updateSelLabel() {
    if (!sel || !buffer) return;
    ui.selLabel.textContent = `${fmtTime(sel.start)} — ${fmtTime(sel.end)}（${fmtTime(sel.end - sel.start)}）`;
  }

  /* ---------------- 交互 ---------------- */

  function posToTime(clientX) {
    const rect = ui.canvas.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * duration();
  }

  ui.canvas.addEventListener('pointerdown', (e) => {
    if (!buffer) return;
    ui.canvas.setPointerCapture(e.pointerId);
    const t = posToTime(e.clientX);
    const d = duration();
    const near = (v) => Math.abs(v - t) < d * 0.01;
    if (near(sel.start)) drag = 'start';
    else if (near(sel.end)) drag = 'end';
    else if (t > sel.start && t < sel.end) drag = 'move';
    else {
      sel = { start: t, end: Math.min(d, t + d * 0.05) };
      drag = 'end';
    }
    updateSelLabel();
    draw();
  });

  ui.canvas.addEventListener('pointermove', (e) => {
    if (!buffer) return;
    const t = posToTime(e.clientX);
    if (!drag) {
      const d = duration();
      const near = Math.abs(t - sel.start) < d * 0.01 || Math.abs(t - sel.end) < d * 0.01;
      ui.canvas.style.cursor = near ? 'ew-resize' : 'crosshair';
      return;
    }
    const minGap = Math.min(0.02, duration() / 1000);
    if (drag === 'start') {
      sel.start = clamp(t, 0, sel.end - minGap);
    } else if (drag === 'end') {
      sel.end = clamp(t, sel.start + minGap, duration());
    } else {
      const len = sel.end - sel.start;
      const s = clamp(t - len / 2, 0, duration() - len);
      sel.start = s;
      sel.end = s + len;
    }
    updateSelLabel();
    draw();
  });

  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { ui.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  ui.canvas.addEventListener('pointerup', endDrag);
  ui.canvas.addEventListener('pointercancel', endDrag);

  /* ---------------- 试听 ---------------- */

  function stopPlayback() {
    if (source) {
      try { source.stop(); } catch { /* ignore */ }
      source.disconnect();
      source = null;
    }
    playhead = null;
    draw();
    ui.play.textContent = '试听选中';
  }

  ui.play.addEventListener('click', () => {
    if (!buffer || !sel) return;
    if (source) { stopPlayback(); return; }
    const ac = ensureCtx();
    source = ac.createBufferSource();
    source.buffer = buffer;
    source.connect(ac.destination);
    const startAt = ac.currentTime;
    const offset = sel.start;
    source.start(0, offset, sel.end - sel.start);
    ui.play.textContent = '停止';
    const tick = () => {
      if (!source) return;
      const t = offset + (ac.currentTime - startAt);
      playhead = Math.min(sel.end, t);
      draw();
      if (t < sel.end) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    source.onended = () => stopPlayback();
  });

  const selectAll = () => {
    if (!buffer) return;
    sel = { start: 0, end: duration() };
    updateSelLabel();
    draw();
  };
  ui.all.addEventListener('click', selectAll);
  ui.reset.addEventListener('click', selectAll);

  /* ---------------- 标签编辑 ---------------- */

  function renderCover() {
    if (coverUrl) { URL.revokeObjectURL(coverUrl); coverUrl = ''; }
    const cover = tags.cover;
    if (cover && cover.bytes) {
      coverUrl = URL.createObjectURL(new Blob([cover.bytes], { type: cover.mime || 'image/jpeg' }));
      ui.cover.src = coverUrl;
      ui.cover.hidden = false;
      ui.coverEmpty.hidden = true;
    } else {
      ui.cover.removeAttribute('src');
      ui.cover.hidden = true;
      ui.coverEmpty.hidden = false;
    }
  }

  function setTags(next) {
    tags = {
      title: next.title || '',
      artist: next.artist || '',
      album: next.album || '',
      cover: next.cover || null,
    };
    ui.title.value = tags.title;
    ui.artist.value = tags.artist;
    ui.album.value = tags.album;
    renderCover();
  }

  ui.title.addEventListener('input', () => { tags.title = ui.title.value; });
  ui.artist.addEventListener('input', () => { tags.artist = ui.artist.value; });
  ui.album.addEventListener('input', () => { tags.album = ui.album.value; });

  ui.coverPick.addEventListener('click', () => ui.coverFile.click());
  ui.coverClear.addEventListener('click', () => {
    tags.cover = null;
    renderCover();
  });
  ui.coverFile.addEventListener('change', async () => {
    const f = ui.coverFile.files && ui.coverFile.files[0];
    ui.coverFile.value = '';
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let width = 0;
      let height = 0;
      try {
        const bmp = await createImageBitmap(new Blob([bytes], { type: f.type || 'image/jpeg' }));
        width = bmp.width;
        height = bmp.height;
        bmp.close && bmp.close();
      } catch { /* 尺寸拿不到也不影响写标签 */ }
      tags.cover = { bytes, mime: f.type || 'image/jpeg', width, height };
      renderCover();
      toast('封面已更新', 'ok');
    } catch (err) {
      showError(ui.notice, err);
    }
  });

  /* ---------------- 格式 ---------------- */

  function syncFormatUI() {
    const value = ui.format.value;
    const lossy = value === 'mp3' || value === 'ogg';
    setFieldVisible(ui.bitrateField, lossy);
    if (lossy) {
      ui.bitrateField.querySelector('label').textContent = value === 'mp3' ? 'MP3 码率' : 'OGG 码率';
    }

    const flacOption = ui.format.querySelector('option[value="flac"]');
    if (flacOption) flacOption.disabled = sourceFormat !== 'flac';

    if (value === 'flac') {
      ui.formatHint.textContent = '源文件本身就是 FLAC，直接原样保留，不重新编码（无损）。';
    } else if (sourceFormat === 'flac') {
      ui.formatHint.textContent = '源文件是 FLAC；选 FLAC 可无损原样保留，选其它格式会重新编码。';
    } else if (!oggSupported && value === 'ogg') {
      ui.formatHint.textContent = '当前浏览器不支持 Opus 编码，换 Chrome / Edge 试试。';
    } else {
      ui.formatHint.textContent = '浏览器不能编码 FLAC，无损导出仅在源文件是 FLAC 时可用。';
    }
  }

  function chooseDefaultFormat() {
    const flacOption = ui.format.querySelector('option[value="flac"]');
    if (flacOption) flacOption.disabled = sourceFormat !== 'flac';
    if (sourceFormat === 'flac') ui.format.value = 'flac';
    else if (sourceFormat === 'wav') ui.format.value = 'wav';
    else ui.format.value = 'mp3';
    syncFormatUI();
  }

  ui.format.addEventListener('change', syncFormatUI);

  /* ---------------- 载入 ---------------- */

  async function loadFile(f) {
    ui.status.textContent = '正在读取…';
    clearNode(ui.notice);
    stopPlayback();
    output = null;
    ui.result.hidden = true;

    try {
      let raw = new Uint8Array(await f.arrayBuffer());
      let byteSource = 'file';
      let extra = null;

      if (isNcm(raw)) {
        ui.status.textContent = '正在解密 .ncm…';
        const ncm = parseNcm(raw);
        raw = null;
        sourceBytes = ncm.audio;
        sourceFormat = ncm.format;
        extra = { metadata: ncm.metadata, cover: ncm.cover };
        byteSource = 'ncm';
      } else {
        sourceBytes = raw;
        sourceFormat = sniffFormat(raw, f.name);
      }

      if (!sourceFormat) throw new Error('无法识别这个音频格式');

      const ac = ensureCtx();
      ui.status.textContent = '正在解码…';
      const decoded = await ac.decodeAudioData(sourceBytes.slice().buffer);
      buffer = decoded;
      file = f;
      peaks = computePeaks(1200);
      sel = { start: 0, end: decoded.duration };

      // 标签：NCM 用自带的；其它格式从文件里读
      if (byteSource === 'ncm') {
        setTags({
          title: extra.metadata.title,
          artist: extra.metadata.artist,
          album: extra.metadata.album,
          cover: extra.cover ? { ...extra.cover, width: 0, height: 0 } : null,
        });
        if (extra.cover) {
          try {
            const bmp = await createImageBitmap(new Blob([extra.cover.bytes], { type: extra.cover.mime }));
            tags.cover.width = bmp.width;
            tags.cover.height = bmp.height;
            bmp.close && bmp.close();
          } catch { /* ignore */ }
        }
      } else {
        const info = readAudioTags(sourceBytes, f.name);
        setTags({ title: info.title, artist: info.artist, album: info.album, cover: info.cover });
      }

      // 源采样率从文件头读（解码会被 AudioContext 重采样，12k/96k 文件会变成 48k）
      const probe = readAudioTags(sourceBytes, f.name);
      const srcRate = probe.sampleRate || decoded.sampleRate;
      const srcChannels = probe.channels || decoded.numberOfChannels;
      const rateNote = srcRate === decoded.sampleRate ? fmtKhz(srcRate) : `${fmtKhz(srcRate)}（解码 ${fmtKhz(decoded.sampleRate)}）`;
      sourceRate = srcRate;
      sourceChannels = srcChannels;

      ui.name.textContent = f.name;
      const bits = sourceFormat === 'flac' ? ' · 无损' : '';
      const audioBytes = sourceFormat === 'mp3' ? stripId3(sourceBytes).length : sourceBytes.length;
      const bitrate = fmtBitrate((audioBytes * 8) / Math.max(0.001, decoded.duration));
      ui.meta.textContent = `${sourceFormat.toUpperCase()} · ${fmtDuration(decoded.duration)} · ${fmtKhz(srcRate)} · ${srcChannels} 声道${bits} · ${bitrate} · ${fmtBytes(f.size)}`;
      ui.fileinfo.hidden = false;
      ui.tagsEditor.hidden = false;
      ui.waveWrap.hidden = false;
      ui.settings.hidden = false;
      ui.drop.hidden = true;
      ui.run.disabled = false;
      ui.status.textContent = '';

      ui.tech.textContent = [
        `时长 ${fmtDuration(decoded.duration)}`,
        `采样率 ${rateNote}`,
        `${srcChannels} 声道`,
        `源格式 ${sourceFormat.toUpperCase()}`,
        sourceFormat === 'flac' || sourceFormat === 'wav' ? '无损源' : '有损源',
      ].join(' · ');

      if (ui.rate.options.length) {
        ui.rate.options[0].textContent = `保持原始（${fmtKhz(decoded.sampleRate)}）`;
      }

      chooseDefaultFormat();
      updateSelLabel();
      requestAnimationFrame(draw);
    } catch (err) {
      ui.status.textContent = '';
      showError(ui.notice, new Error('无法读取这个音频：' + (err.message || err)));
    }
  }

  function resetAll() {
    stopPlayback();
    buffer = null;
    file = null;
    peaks = null;
    sel = null;
    output = null;
    sourceBytes = null;
    sourceFormat = '';
    sourceRate = 0;
    sourceChannels = 0;
    if (coverUrl) { URL.revokeObjectURL(coverUrl); coverUrl = ''; }
    setTags({});
    ui.fileinfo.hidden = true;
    ui.tagsEditor.hidden = true;
    ui.waveWrap.hidden = true;
    ui.settings.hidden = true;
    ui.result.hidden = true;
    ui.drop.hidden = false;
    ui.run.disabled = true;
    ui.status.textContent = '';
    ui.bar.style.width = '0%';
    ui.progress.hidden = true;
    clearNode(ui.notice);
  }

  bindDrop(ui.input, ui.drop, loadFile);
  ui.clear.addEventListener('click', resetAll);

  /* ---------------- 导出 ---------------- */

  async function renderSelection() {
    const startSample = Math.floor(sel.start * buffer.sampleRate);
    const endSample = Math.min(buffer.length, Math.ceil(sel.end * buffer.sampleRate));
    const frameCount = Math.max(1, endSample - startSample);
    const srcChannels = buffer.numberOfChannels;
    const targetCh = Number(ui.channels.value) || srcChannels;
    const targetRate = Number(ui.rate.value) || buffer.sampleRate;

    if (targetCh === srcChannels && targetRate === buffer.sampleRate) {
      const out = [];
      for (let c = 0; c < srcChannels; c += 1) {
        out.push(buffer.getChannelData(c).slice(startSample, endSample));
      }
      return { channels: out, sampleRate: targetRate };
    }

    const length = Math.max(1, Math.ceil((frameCount / buffer.sampleRate) * targetRate));
    const offline = new OfflineAudioContext(targetCh, length, targetRate);
    const tmp = offline.createBuffer(srcChannels, frameCount, buffer.sampleRate);
    for (let c = 0; c < srcChannels; c += 1) {
      tmp.copyToChannel(buffer.getChannelData(c).subarray(startSample, endSample), c);
    }
    const node = offline.createBufferSource();
    node.buffer = tmp;
    node.connect(offline.destination);
    node.start();
    const rendered = await offline.startRendering();
    const out = [];
    for (let c = 0; c < rendered.numberOfChannels; c += 1) out.push(rendered.getChannelData(c));
    return { channels: out, sampleRate: rendered.sampleRate };
  }

  function tagsForWrite() {
    return {
      title: tags.title.trim(),
      artist: tags.artist.trim(),
      album: tags.album.trim(),
      cover: tags.cover,
    };
  }

  ui.run.addEventListener('click', async () => {
    if (!buffer || !sel) return;
    const format = ui.format.value;
    const durationSec = sel.end - sel.start;
    if (durationSec < 0.01) { showError(ui.notice, new Error('选中的片段太短了')); return; }

    const isFullSelection = sel.start < 0.01 && sel.end > buffer.duration - 0.01;
    const channelsUnchanged = !Number(ui.channels.value) || Number(ui.channels.value) === buffer.numberOfChannels;
    const rateUnchanged = !Number(ui.rate.value) || Number(ui.rate.value) === buffer.sampleRate;

    if (format === 'flac' && (!isFullSelection || !channelsUnchanged || !rateUnchanged)) {
      showError(ui.notice, new Error('FLAC 原样导出要求：不裁剪、不改采样率、不改声道。其它情况请选 WAV / MP3 / OGG。'));
      return;
    }

    setBusy(ui.run, true, format === 'flac' ? '正在写入 FLAC…' : '正在编码…');
    clearNode(ui.notice);
    ui.progress.hidden = false;
    ui.bar.style.width = '2%';
    ui.status.textContent = '处理中…';

    try {
      const writeTags = tagsForWrite();
      let bytes;
      let ext = format;

      if (format === 'flac') {
        bytes = writeFlacTags(sourceBytes, writeTags);
        ui.bar.style.width = '100%';
      } else {
        const { channels, sampleRate } = await renderSelection();
        if (format === 'wav') {
          bytes = writeWavTags(encodeWav(channels, sampleRate), writeTags);
          ui.bar.style.width = '100%';
        } else if (format === 'mp3') {
          const kbps = Number(ui.bitrate.value) || 192;
          const mp3 = await encodeMp3(channels, sampleRate, kbps, (p) => {
            ui.bar.style.width = Math.round(p * 100) + '%';
          });
          bytes = writeMp3Tags(mp3, writeTags);
        } else if (format === 'ogg') {
          const ab = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
          channels.forEach((data, c) => ab.copyToChannel(data, c));
          bytes = await encodeOggOpus(ab, {
            bitrate: (Number(ui.bitrate.value) || 192) * 1000,
            tags: writeTags,
            cover: writeTags.cover,
            onProgress: (p) => { ui.bar.style.width = Math.round(p * 100) + '%'; },
          });
        } else {
          throw new Error('不支持的导出格式');
        }
      }

      const filename = `${baseName(file.name)}-${fmtTime(sel.start).replace(/[:.]/g, '')}-${fmtTime(sel.end).replace(/[:.]/g, '')}.${ext}`;
      const blob = new Blob([bytes], { type: format === 'mp3' ? 'audio/mpeg' : format === 'ogg' ? 'audio/ogg' : format === 'flac' ? 'audio/flac' : 'audio/wav' });
      output = { blob, filename };

      appendMeta(ui.metaList, [
        ['片段', `${fmtTime(sel.start)} → ${fmtTime(sel.end)}（${fmtTime(durationSec)}）`],
        ['格式', format === 'mp3' ? `MP3 ${ui.bitrate.value} kbps`
          : format === 'ogg' ? `OGG · Opus ${ui.bitrate.value} kbps`
            : format === 'flac' ? 'FLAC（原样保留）' : 'WAV 16-bit PCM（无损）'],
        ['参数', `${fmtKhz(format === 'flac' ? sourceRate : buffer.sampleRate)} · ${format === 'flac' ? sourceChannels : buffer.numberOfChannels} 声道`],
        ['标签', [writeTags.title, writeTags.artist, writeTags.album].filter(Boolean).join(' / ') || '无'],
        ['封面', writeTags.cover ? '已写入' : '无'],
        ['体积', fmtBytes(bytes.length)],
      ]);
      ui.titleOut.textContent = filename;
      ui.result.hidden = false;
      ui.status.textContent = '完成';
      toast('导出完成 · ' + fmtBytes(bytes.length), 'ok');
    } catch (err) {
      console.error(err);
      showError(ui.notice, err);
      ui.status.textContent = '';
    } finally {
      setBusy(ui.run, false);
      ui.progress.hidden = true;
    }
  });

  ui.download.addEventListener('click', () => {
    if (output) download(output.blob, output.filename);
  });

  window.addEventListener('resize', () => {
    if (peaks) requestAnimationFrame(draw);
  });
}
