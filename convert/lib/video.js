/* 视频转码：Canvas 重绘 + MediaRecorder 录制
   输入取决于浏览器解码能力；输出 WebM(VP9/VP8) 或 MP4(H.264，若浏览器支持录制) */

import {
  $, RATIOS, appendMeta, bindDrop, clamp, clearNode, computeGeometry, detectVideoFps,
  download, fillSelect, fmtBytes, fmtTime, mimeExt, pickMime, showError, toast,
} from './ui.js';

const FORMATS = [
  { mime: 'video/webm;codecs=vp9,opus', label: 'WebM · VP9（推荐）' },
  { mime: 'video/webm;codecs=av01', label: 'WebM · AV1（体积最小，编码较慢）' },
  { mime: 'video/webm;codecs=vp8,opus', label: 'WebM · VP8（兼容好）' },
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 · H.264 + AAC' },
  { mime: 'video/mp4', label: 'MP4' },
  { mime: 'video/webm', label: 'WebM' },
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function initVideo() {
  const root = document.getElementById('panel-video');
  if (!root) return;

  const ui = {
    drop: $('#drop-video', root),
    input: $('#file-video', root),
    fileinfo: $('#fileinfo-video', root),
    name: $('[data-name]', root),
    meta: $('[data-meta]', root),
    clear: $('[data-clear]', root),
    previewWrap: $('#video-preview', root),
    video: $('#video-el', root),
    settings: $('#settings-video', root),
    format: $('#vid-format', root),
    ratio: $('#vid-ratio', root),
    mode: $('#vid-mode', root),
    w: $('#vid-w', root),
    h: $('#vid-h', root),
    dimsHint: $('#vid-dims-hint', root),
    fps: $('#vid-fps', root),
    fpsHint: $('#vid-fps-hint', root),
    quality: $('#vid-quality', root),
    qualityVal: $('#vid-quality-val', root),
    bitrateHint: $('#vid-bitrate-hint', root),
    upscale: $('#vid-upscale', root),
    run: $('#run-video', root),
    stop: $('#stop-video', root),
    status: $('#status-video', root),
    progress: $('#progress-video', root),
    bar: $('#progress-video > i', root),
    notice: $('#notice-video', root),
    result: $('#result-video', root),
    title: $('#result-video-title', root),
    metaList: $('#result-video-meta', root),
    download: $('#download-video', root),
  };

  let objectUrl = null;
  let sourceW = 0;
  let sourceH = 0;
  let sourceFps = 0;
  let duration = 0;
  let output = null;
  let recording = null;   // { recorder, canvas, stream, raf, chunks, mime }

  // 音频转接：把视频声音从 WebAudio 送进录制流，同时静音扬声器
  let ac = null;
  let audioDest = null;

  /* ---------------- 输出格式 ---------------- */
  const supported = FORMATS.filter((f) => pickMime([f.mime]) === f.mime);
  if (!supported.length) {
    showError(ui.notice, new Error('当前浏览器不支持 MediaRecorder 视频录制，换 Chrome / Edge 试试'));
    ui.run.disabled = true;
  } else {
    fillSelect(ui.format, supported.map((f) => ({ id: f.mime, label: f.label })));
  }

  fillSelect(ui.ratio, RATIOS.map((r) => ({ id: r.id, label: r.label })));

  const ratioValue = () => {
    const found = RATIOS.find((r) => r.id === ui.ratio.value);
    if (found && found.value) return found.value;
    return sourceW && sourceH ? sourceW / sourceH : 16 / 9;
  };

  function geometry() {
    if (!sourceW || !sourceH) return null;
    const w = Number(ui.w.value) || 0;
    const h = Number(ui.h.value) || 0;
    if (!w || !h) return null;
    return computeGeometry(sourceW, sourceH, {
      ratio: ratioValue(),
      mode: ui.mode.value,
      width: even(w),
      height: even(h),
      allowUpscale: ui.upscale.checked,
    });
  }

  function syncSize(keep) {
    if (!sourceW) return;
    if (ui.mode.value === 'stretch') return;
    const r = ratioValue();
    const w = Number(ui.w.value) || 0;
    const h = Number(ui.h.value) || 0;
    if (keep === 'h' && h) ui.w.value = String(even(h * r));
    else if (w) ui.h.value = String(even(w / r));
    updateHints();
  }

  function updateHints() {
    const g = geometry();
    if (!g || !sourceW) {
      ui.dimsHint.textContent = '';
      ui.bitrateHint.textContent = '';
      return;
    }
    ui.dimsHint.textContent = `输出 ${g.cw} × ${g.ch} px`
      + (!ui.upscale.checked && (Number(ui.w.value) > g.cw + 1 || Number(ui.h.value) > g.ch + 1)
        ? '（未勾选放大，已按原分辨率收紧）' : '');
    const fps = effectiveFps();
    const bits = bitrateFor(g.cw, g.ch, fps);
    ui.bitrateHint.textContent = `视频约 ${(bits / 1e6).toFixed(1)} Mbps（${fps} fps）+ 音频 128 kbps`;
  }

  function effectiveFps() {
    return Number(ui.fps.value) || sourceFps || 30;
  }

  function bitrateFor(w, h, fps) {
    const q = Number(ui.quality.value) / 100;
    const bpp = 0.008 + q * 0.12;                  // 每像素每帧的比特数
    return clamp(Math.round(w * h * fps * bpp), 300000, 40000000);
  }

  /* ---------------- 载入 ---------------- */

  async function loadFile(file) {
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv|ogv|avi|m4v|3gp)$/i.test(file.name)) {
      toast('这不是视频文件', 'error');
      return;
    }
    cleanup();
    clearNode(ui.notice);
    ui.status.textContent = '正在读取…';

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    const v = ui.video;
    v.src = objectUrl;
    v.load();

    try {
      await new Promise((resolve, reject) => {
        const ok = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); resolve(); };
        const bad = () => {
          v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad);
          reject(new Error('浏览器无法解码这个视频（格式或编码不被支持）'));
        };
        v.addEventListener('loadedmetadata', ok);
        v.addEventListener('error', bad);
        setTimeout(() => reject(new Error('读取超时，可能是格式不支持')), 15000);
      });

      if (!v.videoWidth || !v.videoHeight) throw new Error('视频没有画面轨道');
      sourceW = v.videoWidth;
      sourceH = v.videoHeight;
      duration = Number.isFinite(v.duration) ? v.duration : 0;

      ui.status.textContent = '正在检测原始帧率…';
      sourceFps = await detectVideoFps(v);
      ui.status.textContent = '';
      ui.fpsHint.textContent = sourceFps
        ? `原视频约 ${sourceFps} fps`
        : '原视频帧率未测出，将按 30 fps';

      ui.name.textContent = file.name;
      ui.meta.textContent = `${sourceW}×${sourceH} · ${fmtTime(duration)} · ${fmtBytes(file.size)}`;
      ui.fileinfo.hidden = false;
      ui.previewWrap.hidden = false;
      ui.settings.hidden = false;
      ui.drop.hidden = true;
      ui.w.value = String(sourceW);
      ui.h.value = String(sourceH);
      ui.ratio.value = 'origin';
      syncSize('w');
      ui.run.disabled = !supported.length;
      ui.status.textContent = '';
      toast('已读取，注意转码是实时进行的', 'info');
    } catch (err) {
      ui.status.textContent = '';
      showError(ui.notice, err);
    }
  }

  function cleanup() {
    if (recording) stopRecording(true);
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    ui.video.removeAttribute('src');
    ui.video.load();
    sourceW = sourceH = duration = sourceFps = 0;
    ui.fpsHint.textContent = '';
    ui.bar.style.width = '0%';
    ui.progress.hidden = true;
  }

  function resetAll() {
    cleanup();
    output = null;
    ui.fileinfo.hidden = true;
    ui.settings.hidden = true;
    ui.previewWrap.hidden = true;
    ui.result.hidden = true;
    ui.drop.hidden = false;
    ui.run.hidden = false;
    ui.stop.hidden = true;
    ui.run.disabled = true;
    ui.status.textContent = '';
    clearNode(ui.notice);
  }

  bindDrop(ui.input, ui.drop, loadFile);
  ui.clear.addEventListener('click', resetAll);

  ui.ratio.addEventListener('change', () => syncSize('w'));
  ui.mode.addEventListener('change', () => syncSize('w'));
  ui.w.addEventListener('input', () => syncSize('w'));
  ui.h.addEventListener('input', () => syncSize('h'));
  ui.fps.addEventListener('change', updateHints);
  ui.upscale.addEventListener('change', updateHints);
  ui.quality.addEventListener('input', () => {
    ui.qualityVal.textContent = ui.quality.value;
    updateHints();
  });

  /* ---------------- 录制 ---------------- */

  function ensureAudio() {
    if (ac) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      ac = new AudioCtx();
      const src = ac.createMediaElementSource(ui.video);
      audioDest = ac.createMediaStreamDestination();
      const silent = ac.createGain();
      silent.gain.value = 0;
      src.connect(audioDest);
      src.connect(silent);
      silent.connect(ac.destination);
    } catch {
      ac = null;
      audioDest = null;
    }
  }

  function stopRecording(discard = false) {
    if (!recording) return;
    const rec = recording;
    recording = null;
    cancelAnimationFrame(rec.raf);
    try { ui.video.pause(); } catch { /* ignore */ }
    rec.stream.getTracks().forEach((t) => t.stop());
    if (discard) {
      rec.recorder.onstop = null;
      try { rec.recorder.stop(); } catch { /* ignore */ }
      return;
    }
    try { rec.recorder.stop(); } catch { /* ignore */ }
    ui.stop.hidden = true;
    ui.run.hidden = false;
    ui.run.disabled = false;
  }

  ui.stop.addEventListener('click', () => {
    if (!recording) return;
    ui.status.textContent = '正在收尾…';
    stopRecording(false);
  });

  ui.run.addEventListener('click', async () => {
    if (!sourceW || recording) return;
    const g = geometry();
    if (!g) { showError(ui.notice, new Error('请填写有效的宽高')); return; }
    const mime = ui.format.value;
    if (!mime) { showError(ui.notice, new Error('没有可用的输出格式')); return; }

    clearNode(ui.notice);
    ui.result.hidden = true;
    const canvas = document.createElement('canvas');
    canvas.width = even(g.cw);
    canvas.height = even(g.ch);
    const ctx = canvas.getContext('2d', { alpha: false });

    const fps = effectiveFps();
    const videoBitsPerSecond = bitrateFor(canvas.width, canvas.height, fps);

    ensureAudio();
    if (ac && ac.state === 'suspended') await ac.resume();

    const stream = canvas.captureStream(fps);
    if (audioDest && audioDest.stream.getAudioTracks().length) {
      stream.addTrack(audioDest.stream.getAudioTracks()[0]);
    }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond,
        audioBitsPerSecond: 128000,
      });
    } catch (err) {
      showError(ui.notice, new Error('这个格式录制失败：' + err.message));
      return;
    }

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    recording = {
      recorder, canvas, stream, chunks, mime,
      raf: 0,
    };

    recorder.onstop = () => {
      const type = mime.split(';')[0];
      const blob = new Blob(chunks, { type });
      if (!blob.size) {
        showError(ui.notice, new Error('没有录到内容，可能是视频无法播放'));
        return;
      }
      output = {
        blob,
        filename: (ui.name.textContent || 'video').replace(/\.[^.]+$/, '') + '-converted.' + mimeExt(type),
      };
      appendMeta(ui.metaList, [
        ['尺寸', `${canvas.width} × ${canvas.height}`],
        ['时长', fmtTime(duration)],
        ['码率', `${(videoBitsPerSecond / 1e6).toFixed(1)} Mbps`],
        ['格式', type],
        ['体积', fmtBytes(blob.size)],
      ]);
      ui.title.textContent = output.filename;
      ui.result.hidden = false;
      ui.status.textContent = '完成';
      ui.bar.style.width = '100%';
      toast('转码完成 · ' + fmtBytes(blob.size), 'ok');
      setTimeout(() => { ui.progress.hidden = true; }, 800);
    };

    const v = ui.video;
    v.pause();
    try { v.currentTime = 0; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 120));

    const drawFrame = () => {
      if (!recording) return;
      const gg = computeGeometry(sourceW, sourceH, {
        ratio: canvas.width / canvas.height,
        mode: ui.mode.value,
        width: canvas.width,
        height: canvas.height,
        allowUpscale: true,
      });
      if (ui.mode.value === 'fit') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(v, gg.sx, gg.sy, gg.sw, gg.sh, gg.dx || 0, gg.dy || 0, gg.dw, gg.dh);
      recording.raf = requestAnimationFrame(drawFrame);
    };

    try {
      recorder.start(1000);
      await v.play();
    } catch (err) {
      stopRecording(true);
      ui.status.textContent = '';
      showError(ui.notice, new Error('播放失败，无法转码：' + err.message));
      return;
    }

    ui.run.hidden = true;
    ui.run.disabled = true;
    ui.stop.hidden = false;
    ui.progress.hidden = false;
    ui.bar.style.width = '0%';
    ui.status.textContent = `录制中 0% · 实时，请勿切走标签页`;

    drawFrame();

    const tick = () => {
      if (!recording) return;
      if (v.ended) {
        ui.status.textContent = '正在收尾…';
        stopRecording(false);
        return;
      }
      const p = duration ? clamp(v.currentTime / duration, 0, 1) : 0;
      ui.bar.style.width = Math.round(p * 100) + '%';
      ui.status.textContent = `录制中 ${Math.round(p * 100)}% · 实时，请勿切走标签页`;
      setTimeout(tick, 250);
    };
    tick();

    v.onended = () => {
      if (recording) stopRecording(false);
    };
  });

  ui.download.addEventListener('click', () => {
    if (output) download(output.blob, output.filename);
  });

  // 预览时不要发出声音，但录制需要保持未静音（音频走 WebAudio 的静音支路）
  ui.video.volume = 1;
}
