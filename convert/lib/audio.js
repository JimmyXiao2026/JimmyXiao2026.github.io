/* 音频转换 / 波形裁剪
   解码：浏览器自带解码器（mp3 / flac / wav / ogg / m4a / aac / opus …）
   导出：WAV（无损 PCM）或 MP3（lamejs，按码率压缩） */

import {
  $, appendMeta, bindDrop, clamp, clearNode, download, fmtBytes, fmtTime,
  loadScript, LIBS, setBusy, setFieldVisible, showError, toast, baseName,
} from './ui.js';

const WAVE_H = 240;

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
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
  view.setUint16(20, 1, true);                       // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);  // byte rate
  view.setUint16(32, numCh * 2, true);               // block align
  view.setUint16(34, 16, true);                      // bits
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = clamp(channels[c][i], -1, 1);
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
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
    for (let i = 0; i < n; i++) {
      const v = clamp(l[start + i], -1, 1);
      left[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    if (numCh === 2) {
      const r = channels[1];
      for (let i = 0; i < n; i++) {
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
  return new Blob(chunks, { type: 'audio/mpeg' });
}

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
    waveWrap: $('#wave-wrap', root),
    canvas: $('#wave', root),
    selLabel: $('#audio-sel', root),
    play: $('#audio-play', root),
    all: $('#audio-all', root),
    reset: $('#audio-reset', root),
    settings: $('#settings-audio', root),
    format: $('#audio-format', root),
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
    title: $('#result-audio-title', root),
    metaList: $('#result-audio-meta', root),
    download: $('#download-audio', root),
  };

  let ctx = null;
  let buffer = null;        // AudioBuffer（完整文件）
  let file = null;
  let peaks = null;
  let sel = null;           // { start, end } 秒
  let drag = null;          // 'start' | 'end' | 'move'
  let playhead = null;
  let source = null;
  let output = null;

  const duration = () => (buffer ? buffer.duration : 0);

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ---------------- 波形 ---------------- */

  function computePeaks(width) {
    const chCount = buffer.numberOfChannels;
    const data = [];
    for (let c = 0; c < Math.min(2, chCount); c++) data.push(buffer.getChannelData(c));
    const step = buffer.length / width;
    const out = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const from = Math.floor(x * step);
      const to = Math.min(buffer.length, Math.floor((x + 1) * step));
      let max = 0;
      for (let i = from; i < to; i++) {
        for (let c = 0; c < data.length; c++) {
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

    // 选中区域背景
    g.fillStyle = 'rgba(139,124,248,.10)';
    g.fillRect(x0, 0, Math.max(0, x1 - x0), h);

    // 波形
    const barW = Math.max(1, w / peaks.length);
    for (let x = 0; x < peaks.length; x++) {
      const px = (x / peaks.length) * w;
      const amp = Math.max(1, peaks[x] * (h / 2 - 6));
      const inside = px >= x0 && px <= x1;
      g.fillStyle = inside ? 'rgba(56,189,248,.9)' : 'rgba(154,163,189,.45)';
      g.fillRect(px, mid - amp, Math.max(1, barW * 0.8), amp * 2);
    }

    // 中线
    g.fillStyle = 'rgba(255,255,255,.08)';
    g.fillRect(0, mid, w, 1);

    // 手柄
    if (sel) {
      for (const x of [x0, x1]) {
        g.fillStyle = '#8b7cf8';
        g.fillRect(x - 1, 0, 2, h);
        g.fillStyle = 'rgba(139,124,248,.95)';
        g.fillRect(x - 5, mid - 12, 10, 24);
      }
    }

    // 播放头
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
      let s = clamp(t - len / 2, 0, duration() - len);
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
      try { source.stop(); } catch { /* already stopped */ }
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
    const len = sel.end - sel.start;
    source.start(0, offset, len);
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

  ui.all.addEventListener('click', () => {
    if (!buffer) return;
    sel = { start: 0, end: duration() };
    updateSelLabel();
    draw();
  });

  ui.reset.addEventListener('click', () => {
    if (!buffer) return;
    sel = { start: 0, end: duration() };
    updateSelLabel();
    draw();
  });

  /* ---------------- 解码 ---------------- */

  async function loadFile(f) {
    ui.status.textContent = '正在解码…';
    clearNode(ui.notice);
    stopPlayback();
    try {
      const ac = ensureCtx();
      const data = await f.arrayBuffer();
      const decoded = await ac.decodeAudioData(data);
      buffer = decoded;
      file = f;
      peaks = computePeaks(1200);
      sel = { start: 0, end: decoded.duration };

      // 解码会把音频重采样到音频上下文的采样率，这里把真实值写进选项
      if (ui.rate.options.length) {
        ui.rate.options[0].textContent = `保持解码采样率（${decoded.sampleRate} Hz）`;
      }

      ui.name.textContent = f.name;
      ui.meta.textContent = `${fmtTime(decoded.duration)} · ${decoded.sampleRate} Hz · ${decoded.numberOfChannels} ch · ${fmtBytes(f.size)}`;
      ui.fileinfo.hidden = false;
      ui.waveWrap.hidden = false;
      ui.settings.hidden = false;
      ui.drop.hidden = true;
      ui.run.disabled = false;
      ui.status.textContent = '';
      updateSelLabel();
      requestAnimationFrame(draw);
    } catch (err) {
      ui.status.textContent = '';
      showError(ui.notice, new Error('解码失败：浏览器打不开这个音频（' + (err.message || err) + '）'));
    }
  }

  function resetAll() {
    stopPlayback();
    buffer = null;
    file = null;
    peaks = null;
    sel = null;
    output = null;
    ui.fileinfo.hidden = true;
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

  ui.format.addEventListener('change', () => {
    setFieldVisible(ui.bitrateField, ui.format.value === 'mp3');
  });
  setFieldVisible(ui.bitrateField, false);

  /* ---------------- 导出 ---------------- */

  async function renderSelection() {
    const ac = ensureCtx();
    const startSample = Math.floor(sel.start * buffer.sampleRate);
    const endSample = Math.min(buffer.length, Math.ceil(sel.end * buffer.sampleRate));
    const frameCount = Math.max(1, endSample - startSample);
    const srcChannels = buffer.numberOfChannels;
    const targetCh = Number(ui.channels.value) || srcChannels;
    const targetRate = Number(ui.rate.value) || buffer.sampleRate;

    if (targetCh === srcChannels && targetRate === buffer.sampleRate) {
      const out = [];
      for (let c = 0; c < srcChannels; c++) {
        out.push(buffer.getChannelData(c).slice(startSample, endSample));
      }
      return { channels: out, sampleRate: targetRate };
    }

    // 需要改采样率或声道：交给 OfflineAudioContext 重采样 / 混音
    const length = Math.max(1, Math.ceil((frameCount / buffer.sampleRate) * targetRate));
    const offline = new OfflineAudioContext(targetCh, length, targetRate);
    const tmp = offline.createBuffer(srcChannels, frameCount, buffer.sampleRate);
    for (let c = 0; c < srcChannels; c++) {
      tmp.copyToChannel(buffer.getChannelData(c).subarray(startSample, endSample), c);
    }
    const node = offline.createBufferSource();
    node.buffer = tmp;
    node.connect(offline.destination);
    node.start();
    const rendered = await offline.startRendering();
    const out = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c));
    return { channels: out, sampleRate: rendered.sampleRate };
  }

  ui.run.addEventListener('click', async () => {
    if (!buffer || !sel) return;
    const format = ui.format.value;
    const durationSec = sel.end - sel.start;
    if (durationSec < 0.01) { showError(ui.notice, new Error('选中的片段太短了')); return; }

    setBusy(ui.run, true, format === 'mp3' ? '编码 MP3…' : '导出 WAV…');
    clearNode(ui.notice);
    ui.progress.hidden = false;
    ui.bar.style.width = '2%';
    ui.status.textContent = '处理中…';

    try {
      const { channels, sampleRate } = await renderSelection();
      let blob;
      if (format === 'mp3') {
        const kbps = Number(ui.bitrate.value) || 192;
        blob = await encodeMp3(channels, sampleRate, kbps, (p) => {
          ui.bar.style.width = Math.round(p * 100) + '%';
        });
      } else {
        ui.bar.style.width = '40%';
        blob = encodeWav(channels, sampleRate);
        ui.bar.style.width = '100%';
      }

      const ext = format === 'mp3' ? 'mp3' : 'wav';
      const filename = `${baseName(file.name)}-${fmtTime(sel.start).replace(/[:.]/g, '')}-${fmtTime(sel.end).replace(/[:.]/g, '')}.${ext}`;
      output = { blob, filename };

      appendMeta(ui.metaList, [
        ['片段', `${fmtTime(sel.start)} → ${fmtTime(sel.end)}（${fmtTime(durationSec)}）`],
        ['格式', format === 'mp3' ? `MP3 ${ui.bitrate.value} kbps` : 'WAV 16-bit PCM（无损）'],
        ['参数', `${sampleRate} Hz · ${channels.length} ch`],
        ['体积', fmtBytes(blob.size)],
      ]);
      ui.title.textContent = filename;
      ui.result.hidden = false;
      ui.status.textContent = '完成';
      toast('导出完成 · ' + fmtBytes(blob.size), 'ok');
    } catch (err) {
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
