/* 视频 ⇄ 动图
   视频 → GIF / APNG（逐帧 seek 抓帧，再编码）
   动图 → GIF / APNG / 视频（ImageDecoder 取帧；视频用 MediaRecorder 按原速录制） */

import {
  $, RATIOS, appendMeta, bindDrop, clamp, clearNode, computeGeometry,
  detectVideoFps, download, fillSelect, fmtBytes, fmtTime,
  importAny, LIBS, mimeExt, pickMime, setFieldVisible, showError, toast,
} from './ui.js';
import { makeApng } from './apng.js';

const MAX_FRAMES = 400;
const ANIM_EXT = /\.(gif|apng|webp|avif|png)$/i;

const VIDEO_FORMATS = [
  { mime: 'video/webm;codecs=vp9,opus', label: '视频 · WebM (VP9)' },
  { mime: 'video/webm;codecs=vp8,opus', label: '视频 · WebM (VP8)' },
  { mime: 'video/webm;codecs=av01', label: '视频 · WebM (AV1)' },
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: '视频 · MP4 (H.264)' },
  { mime: 'video/mp4', label: '视频 · MP4' },
];

const ANIM_OUTPUTS = [
  { id: 'gif', label: 'GIF（兼容性最好）' },
  { id: 'apng', label: 'APNG（无损，体积大）' },
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function seekTo(video, time) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    try {
      video.currentTime = clamp(time, 0, Math.max(0, (video.duration || 0) - 0.001));
    } catch {
      done();
    }
    setTimeout(done, 2000);
  });
}

export function initAnim() {
  const root = document.getElementById('panel-anim');
  if (!root) return;

  const ui = {
    drop: $('#drop-anim', root),
    input: $('#file-anim', root),
    fileinfo: $('#fileinfo-anim', root),
    name: $('[data-name]', root),
    meta: $('[data-meta]', root),
    clear: $('[data-clear]', root),
    previewWrap: $('#anim-preview-wrap', root),
    preview: $('#anim-preview', root),
    video: $('#anim-video', root),
    settings: $('#settings-anim', root),
    format: $('#anim-format', root),
    ratio: $('#anim-ratio', root),
    mode: $('#anim-mode', root),
    w: $('#anim-w', root),
    h: $('#anim-h', root),
    dimsHint: $('#anim-dims-hint', root),
    fps: $('#anim-fps', root),
    fpsHint: $('#anim-fps-hint', root),
    colorsField: $('#anim-colors-field', root),
    colors: $('#anim-colors', root),
    upscale: $('#anim-upscale', root),
    run: $('#run-anim', root),
    status: $('#status-anim', root),
    progress: $('#progress-anim', root),
    bar: $('#progress-anim > i', root),
    notice: $('#notice-anim', root),
    result: $('#result-anim', root),
    resultImg: $('#anim-result-img', root),
    resultVideo: $('#anim-result-video', root),
    title: $('#result-anim-title', root),
    metaList: $('#result-anim-meta', root),
    download: $('#download-anim', root),
  };

  let kind = '';            // 'video' | 'anim'
  let file = null;
  let objectUrl = null;
  let decoder = null;       // anim: ImageDecoder
  let sourceW = 0;
  let sourceH = 0;
  let duration = 0;         // 秒
  let frameCount = 0;
  let sourceFps = 0;
  let busy = false;
  let output = null;
  let resultUrl = '';

  fillSelect(ui.ratio, RATIOS.map((r) => ({ id: r.id, label: r.label })));

  const ratioValue = () => {
    const found = RATIOS.find((r) => r.id === ui.ratio.value);
    if (found && found.value) return found.value;
    return sourceW && sourceH ? sourceW / sourceH : 1;
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
    if (!sourceW || ui.mode.value === 'stretch') return;
    const r = ratioValue();
    const w = Number(ui.w.value) || 0;
    const h = Number(ui.h.value) || 0;
    if (keep === 'h' && h) ui.w.value = String(even(h * r));
    else if (w) ui.h.value = String(even(w / r));
    updateHints();
  }

  function updateHints() {
    const g = geometry();
    if (!g) { ui.dimsHint.textContent = ''; return; }
    const outAnim = formatKind(ui.format.value) === 'anim';
    if (kind === 'anim' && outAnim) {
      ui.dimsHint.textContent = `输出 ${g.cw} × ${g.ch} px · 保留原帧时长（${frameCount} 帧）`;
      return;
    }
    const fps = effectiveFps();
    ui.dimsHint.textContent = `输出 ${g.cw} × ${g.ch} px · ${fps} fps · 约 ${Math.min(MAX_FRAMES, Math.round(duration * fps))} 帧`;
  }

  function effectiveFps() {
    if (kind === 'anim') return Number(ui.fps.value) || 30;
    return Number(ui.fps.value) || sourceFps || 30;
  }

  function formatKind(value) {
    return value.startsWith('video/') ? 'video' : 'anim';
  }

  function rebuildFormats() {
    const list = [];
    if (kind === 'video') {
      list.push(...ANIM_OUTPUTS);
    } else {
      list.push(...ANIM_OUTPUTS);
      for (const f of VIDEO_FORMATS) {
        if (pickMime([f.mime]) === f.mime) list.push({ id: f.mime, label: f.label });
      }
    }
    fillSelect(ui.format, list.map((x) => ({ id: x.id, label: x.label })));
    syncFormatUI();
  }

  function syncFormatUI() {
    const isGif = ui.format.value === 'gif';
    const isVideoOut = formatKind(ui.format.value) === 'video';
    setFieldVisible(ui.colorsField, isGif);
    ui.fps.disabled = kind === 'anim' && !isVideoOut;
    if (kind === 'anim' && !isVideoOut) {
      ui.fpsHint.textContent = '动图转 GIF/APNG 会保留原帧时长（fps 不生效）';
    } else if (kind === 'video') {
      ui.fpsHint.textContent = sourceFps
        ? `原视频约 ${sourceFps} fps`
        : '原视频帧率未测出，默认 30 fps';
    } else {
      ui.fpsHint.textContent = '';
    }
    updateHints();
  }

  /* ---------------- 载入 ---------------- */

  function cleanup() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    ui.previewWrap.classList.remove('compact');
    if (decoder && decoder.close) { try { decoder.close(); } catch { /* ignore */ } }
    decoder = null;
    const v = ui.video;
    v.onloadedmetadata = null;
    v.removeAttribute('src');
    try { v.load(); } catch { /* ignore */ }
    kind = '';
    file = null;
    sourceW = sourceH = duration = frameCount = sourceFps = 0;
  }

  async function loadFile(f) {
    if (busy) { toast('正在转换，请稍等', 'error'); return; }
    const isVideo = (f.type || '').startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|ogv|3gp)$/i.test(f.name);
    const isAnim = !isVideo && ((f.type || '').startsWith('image/') || ANIM_EXT.test(f.name));
    if (!isVideo && !isAnim) { toast('请选择视频或动图文件', 'error'); return; }

    cleanup();
    clearNode(ui.notice);
    ui.result.hidden = true;
    ui.status.textContent = '正在读取…';
    file = f;

    if (isVideo) {
      kind = 'video';
      ui.previewWrap.classList.remove('compact');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(f);
      const v = ui.video;
      v.hidden = false;
      ui.preview.hidden = true;
      ui.previewWrap.hidden = false;
      v.src = objectUrl;
      v.load();

      try {
        await new Promise((resolve, reject) => {
          const ok = () => { v.onloadedmetadata = null; v.onerror = null; resolve(); };
          const bad = () => reject(new Error('浏览器无法解码这个视频'));
          v.onloadedmetadata = ok;
          v.onerror = bad;
          setTimeout(() => reject(new Error('读取超时')), 15000);
        });
        sourceW = v.videoWidth;
        sourceH = v.videoHeight;
        duration = Number.isFinite(v.duration) ? v.duration : 0;
        frameCount = 0;

        ui.status.textContent = '正在检测原始帧率…';
        sourceFps = await detectVideoFps(v);
        ui.status.textContent = '';
        v.currentTime = 0;
      } catch (err) {
        ui.status.textContent = '';
        showError(ui.notice, err);
        return;
      }
    } else {
      kind = 'anim';
      ui.previewWrap.classList.add('compact');
      ui.video.hidden = true;
      ui.video.removeAttribute('src');
      ui.preview.hidden = false;
      ui.previewWrap.hidden = false;

      try {
        const data = new Uint8Array(await f.arrayBuffer());
        const type = f.type || (f.name.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/png');
        decoder = new ImageDecoder({ data, type });
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        frameCount = track ? track.frameCount : 0;
        if (!frameCount) throw new Error('这个动图没有可用的帧');

        const first = await decoder.decode({ frameIndex: 0 });
        sourceW = first.image.displayWidth || first.image.codedWidth;
        sourceH = first.image.displayHeight || first.image.codedHeight;

        // 预览 + 统计总时长
        const canvas = ui.preview;
        canvas.width = sourceW;
        canvas.height = sourceH;
        canvas.getContext('2d').drawImage(first.image, 0, 0);
        const firstDelay = (first.image.duration || 100000) / 1e6;
        first.image.close();

        duration = firstDelay * frameCount;
        ui.status.textContent = '';
      } catch (err) {
        ui.status.textContent = '';
        showError(ui.notice, err);
        return;
      }
    }

    ui.name.textContent = f.name;
    ui.meta.textContent = `${sourceW}×${sourceH} · ${fmtTime(duration)}`
      + (kind === 'anim' ? ` · ${frameCount} 帧` : (sourceFps ? ` · ${sourceFps} fps` : ''))
      + ` · ${fmtBytes(f.size)}`;
    ui.fileinfo.hidden = false;
    ui.settings.hidden = false;
    ui.drop.hidden = true;
    ui.w.value = String(sourceW);
    ui.h.value = String(sourceH);
    ui.ratio.value = 'origin';
    ui.format.value = 'gif';
    rebuildFormats();
    syncSize('w');
    ui.run.disabled = false;
  }

  function resetAll() {
    if (busy) return;
    cleanup();
    output = null;
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = ''; }
    ui.fileinfo.hidden = true;
    ui.settings.hidden = true;
    ui.previewWrap.hidden = true;
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

  ui.ratio.addEventListener('change', () => syncSize('w'));
  ui.mode.addEventListener('change', () => syncSize('w'));
  ui.w.addEventListener('input', () => syncSize('w'));
  ui.h.addEventListener('input', () => syncSize('h'));
  ui.upscale.addEventListener('change', updateHints);
  ui.fps.addEventListener('change', updateHints);
  ui.format.addEventListener('change', syncFormatUI);

  /* ---------------- 编码 ---------------- */

  async function encodeGifFrames(frames, w, h, colors, delays, onProgress) {
    const mod = await importAny(LIBS.gifenc);
    const { GIFEncoder, quantize, applyPalette } = mod;
    const gif = GIFEncoder();
    const delayOf = (i) => {
      const value = Array.isArray(delays) ? delays[i] : delays;
      return clamp(Math.round(value), 20, 10000);
    };

    for (let i = 0; i < frames.length; i++) {
      const rgba = frames[i];
      const palette = quantize(rgba, colors, { format: 'rgb565' });
      const index = applyPalette(rgba, palette, 'rgb565');
      gif.writeFrame(index, w, h, { palette, delay: delayOf(i) });
      if (onProgress && i % 5 === 0) {
        onProgress(i / frames.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: 'image/gif' });
  }

  async function encodeApngFrames(pngFrames, delays) {
    const frames = pngFrames.map((png, i) => ({
      png,
      delayMs: Array.isArray(delays) ? delays[i] : delays,
    }));
    return new Blob([makeApng(frames)], { type: 'image/apng' });
  }

  /* ---------------- 视频 → 动图 ---------------- */

  async function videoToAnim(g, format, fps) {
    let frameTotal = Math.round(duration * fps);
    if (frameTotal < 2) throw new Error('视频太短，至少需要 2 帧');
    if (frameTotal > MAX_FRAMES) {
      fps = MAX_FRAMES / duration;
      frameTotal = MAX_FRAMES;
      toast(`帧数过多，已自动降到 ${fps.toFixed(1)} fps（最多 ${MAX_FRAMES} 帧）`, 'info');
    }

    const canvas = document.createElement('canvas');
    canvas.width = g.cw;
    canvas.height = g.ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: format === 'gif' });
    const colors = Number(ui.colors.value) || 128;
    const delayMs = 1000 / fps;

    const rgbaFrames = [];
    const pngFrames = [];
    const v = ui.video;

    for (let i = 0; i < frameTotal; i++) {
      const t = Math.min(duration - 0.001, (i + 0.5) / fps);
      await seekTo(v, t);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (ui.mode.value === 'fit') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(v, g.sx, g.sy, g.sw, g.sh, g.dx || 0, g.dy || 0, g.dw, g.dh);

      if (format === 'gif') {
        rgbaFrames.push(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      } else {
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('帧编码失败'))), 'image/png');
        });
        pngFrames.push(new Uint8Array(await blob.arrayBuffer()));
      }

      ui.bar.style.width = Math.round(((i + 1) / frameTotal) * 80) + '%';
      ui.status.textContent = `抓帧 ${i + 1}/${frameTotal}`;
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    ui.status.textContent = format === 'gif' ? '正在编码 GIF…' : '正在封装 APNG…';
    let blob;
    if (format === 'gif') {
      blob = await encodeGifFrames(rgbaFrames, canvas.width, canvas.height, colors, delayMs, (p) => {
        ui.bar.style.width = Math.round(80 + p * 20) + '%';
      });
    } else {
      blob = await encodeApngFrames(pngFrames, delayMs);
    }
    return { blob, frames: frameTotal, fps, width: canvas.width, height: canvas.height };
  }

  /* ---------------- 动图 → (GIF / APNG / 视频) ---------------- */

  async function readAnimFrame(index) {
    const { image } = await decoder.decode({ frameIndex: index });
    return image;
  }

  async function animToAnim(g, format) {
    const step = Math.max(1, Math.ceil(frameCount / MAX_FRAMES));
    const outputs = Math.ceil(frameCount / step);
    const delayMs = clamp((duration * 1000) / outputs, 20, 10000);

    const canvas = document.createElement('canvas');
    canvas.width = g.cw;
    canvas.height = g.ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: format === 'gif' });
    const colors = Number(ui.colors.value) || 128;

    const rgbaFrames = [];
    const pngFrames = [];
    let done = 0;

    for (let i = 0; i < frameCount; i += step) {
      const image = await readAnimFrame(i);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (ui.mode.value === 'fit') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, g.sx, g.sy, g.sw, g.sh, g.dx || 0, g.dy || 0, g.dw, g.dh);
      image.close();
      done += 1;

      if (format === 'gif') {
        rgbaFrames.push(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      } else {
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('帧编码失败'))), 'image/png');
        });
        pngFrames.push(new Uint8Array(await blob.arrayBuffer()));
      }

      ui.bar.style.width = Math.round((done / outputs) * 80) + '%';
      ui.status.textContent = `处理帧 ${done}/${outputs}`;
      if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    ui.status.textContent = format === 'gif' ? '正在编码 GIF…' : '正在封装 APNG…';
    const fps = 1000 / delayMs;
    const blob = format === 'gif'
      ? await encodeGifFrames(rgbaFrames, canvas.width, canvas.height, colors, delayMs, (p) => {
        ui.bar.style.width = Math.round(80 + p * 20) + '%';
      })
      : await encodeApngFrames(pngFrames, delayMs);

    return { blob, frames: outputs, fps, width: canvas.width, height: canvas.height };
  }

  async function animToVideo(g, mime) {
    const canvas = document.createElement('canvas');
    canvas.width = g.cw;
    canvas.height = g.ch;
    const ctx = canvas.getContext('2d', { alpha: false });
    const captureFps = Number(ui.fps.value) || 30;

    // 用 captureStream(0) + requestFrame 精确控制每一帧的时间点，
    // 否则静止画面不会有新帧，结尾会被截短。
    const stream = canvas.captureStream(0);
    const videoTrack = stream.getVideoTracks()[0];
    const videoBitsPerSecond = clamp(g.cw * g.ch * captureFps * 0.1, 400000, 20000000);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

    recorder.start(500);
    const started = performance.now();
    let planned = 0;
    let lastHold = 100;

    for (let i = 0; i < frameCount; i++) {
      const image = await readAnimFrame(i);
      const hold = clamp((image.duration || 100000) / 1000, 10, 10000);
      lastHold = hold;
      ctx.fillStyle = '#000';
      if (ui.mode.value === 'fit') ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, g.sx, g.sy, g.sw, g.sh, g.dx || 0, g.dy || 0, g.dw, g.dh);
      image.close();
      if (videoTrack.requestFrame) videoTrack.requestFrame();

      // 按真实时间停留
      planned += hold;
      const wait = planned - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      ui.bar.style.width = Math.round(((i + 1) / frameCount) * 95) + '%';
      ui.status.textContent = `录制 ${i + 1}/${frameCount}（按原速）`;
    }

    // 最后一帧也要占满它该有的时长
    await new Promise((r) => setTimeout(r, lastHold));
    if (videoTrack.requestFrame) videoTrack.requestFrame();
    await new Promise((r) => setTimeout(r, 120));
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    return {
      blob: new Blob(chunks, { type: mime.split(';')[0] }),
      frames: frameCount,
      fps: captureFps,
      width: canvas.width,
      height: canvas.height,
    };
  }

  /* ---------------- 主流程 ---------------- */

  ui.run.addEventListener('click', async () => {
    if (!file || busy) return;
    const g = geometry();
    if (!g) { showError(ui.notice, new Error('请填写有效的宽高')); return; }
    const format = ui.format.value;
    const outKind = formatKind(format);

    busy = true;
    ui.run.disabled = true;
    clearNode(ui.notice);
    ui.result.hidden = true;
    ui.progress.hidden = false;
    ui.bar.style.width = '2%';
    ui.status.textContent = '准备中…';

    try {
      let result;
      if (kind === 'video') {
        result = await videoToAnim(g, format, effectiveFps());
      } else if (outKind === 'anim') {
        result = await animToAnim(g, format);
      } else {
        result = await animToVideo(g, format);
      }

      if (!result.blob || !result.blob.size) throw new Error('没有生成有效的文件');

      const ext = outKind === 'video' ? mimeExt(format) : format;
      const filename = `${(ui.name.textContent || 'anim').replace(/\.[^.]+$/, '')}-${result.width}x${result.height}.${ext}`;
      output = { blob: result.blob, filename };

      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(result.blob);
      if (outKind === 'video') {
        ui.resultVideo.src = resultUrl;
        ui.resultVideo.hidden = false;
        ui.resultImg.hidden = true;
      } else {
        ui.resultImg.src = resultUrl;
        ui.resultImg.hidden = false;
        ui.resultVideo.hidden = true;
      }

      appendMeta(ui.metaList, [
        ['尺寸', `${result.width} × ${result.height}`],
        ['帧数', `${result.frames} 帧`],
        ['时长', fmtTime(duration)],
        ['格式', outKind === 'video' ? format.split(';')[0] : ext.toUpperCase()],
        ['体积', fmtBytes(result.blob.size)],
      ]);
      ui.title.textContent = filename;
      ui.result.hidden = false;
      ui.bar.style.width = '100%';
      ui.status.textContent = '完成';
      toast('转换完成 · ' + fmtBytes(result.blob.size), 'ok');
    } catch (err) {
      console.error(err);
      showError(ui.notice, err);
      ui.status.textContent = '';
      ui.progress.hidden = true;
    } finally {
      busy = false;
      ui.run.disabled = false;
      setTimeout(() => { if (!busy) ui.progress.hidden = true; }, 900);
    }
  });

  ui.download.addEventListener('click', () => {
    if (output) download(output.blob, output.filename);
  });
}
