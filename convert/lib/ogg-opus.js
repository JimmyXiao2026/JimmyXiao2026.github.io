/* Ogg 封装 + Opus 编码（WebCodecs AudioEncoder）
 *
 * 浏览器目前只能编码 Opus（FLAC/AAC/Vorbis 都不支持），
 * 所以 OGG 导出走 Opus in Ogg，并写入 Vorbis comment 与封面。
 */

import { makeFlacPicture, makeVorbisComment } from './audio-meta.js';

const utf8 = new TextEncoder();

/* ---------------- Ogg CRC ---------------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) {
      r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function writeU32LE(b, o, v) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

function writeU64LE(b, o, value) {
  const v = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    b[o + i] = Number((v >> BigInt(8 * i)) & 0xffffffffn & 0xffn);
  }
}

/** 把一个包拆成若干 Ogg 页（包大于 255 段时要跨页续包） */
function buildPacketPages(packet, { serial, sequence, granule, eos = false, bos = false }) {
  const laces = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    laces.push(255);
    remaining -= 255;
  }
  laces.push(remaining);

  const pages = [];
  let segIndex = 0;
  let offset = 0;
  let seq = sequence;

  while (segIndex < laces.length) {
    const count = Math.min(255, laces.length - segIndex);
    const chunk = laces.slice(segIndex, segIndex + count);
    const payloadLen = chunk.reduce((s, n) => s + n, 0);
    const isFirst = segIndex === 0;
    const isLast = segIndex + count >= laces.length;

    const page = new Uint8Array(27 + count + payloadLen);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
    page[4] = 0;
    page[5] = (isFirst && bos ? 0x02 : 0)
      | (isFirst ? 0 : 0x01)
      | (isLast && eos ? 0x04 : 0);
    writeU64LE(page, 6, isLast ? BigInt(granule) : -1n);
    writeU32LE(page, 14, serial);
    writeU32LE(page, 18, seq);
    page[26] = count;
    page.set(chunk, 27);
    page.set(packet.subarray(offset, offset + payloadLen), 27 + count);
    writeU32LE(page, 22, oggCrc(page));

    pages.push(page);
    offset += payloadLen;
    segIndex += count;
    seq += 1;
  }
  return { pages, nextSequence: seq };
}

function buildOpusHead(channels, sampleRate, preSkip = 312) {
  const head = new Uint8Array(19);
  head.set(utf8.encode('OpusHead'), 0);
  head[8] = 1;                 // version
  head[9] = channels;
  head[10] = preSkip & 0xff;   // pre-skip LE16
  head[11] = (preSkip >> 8) & 0xff;
  writeU32LE(head, 12, sampleRate);
  head[16] = 0;
  head[17] = 0;                // output gain
  head[18] = 0;                // mapping family
  return head;
}

function buildOpusTags(tags, pictures) {
  const vendor = utf8.encode('JimmyXiao Format Converter');
  const comments = [];
  if (tags.title) comments.push('TITLE=' + tags.title);
  if (tags.artist) comments.push('ARTIST=' + tags.artist);
  if (tags.album) comments.push('ALBUM=' + tags.album);
  for (const pic of pictures || []) {
    if (!pic || !pic.bytes) continue;
    const block = makeFlacPicture(pic);
    let bin = '';
    for (let i = 0; i < block.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, block.subarray(i, i + 0x8000));
    }
    comments.push('METADATA_BLOCK_PICTURE=' + btoa(bin));
  }

  const parts = [utf8.encode('OpusTags')];
  const vendorHead = new Uint8Array(4);
  writeU32LE(vendorHead, 0, vendor.length);
  parts.push(vendorHead, vendor);
  const count = new Uint8Array(4);
  writeU32LE(count, 0, comments.length);
  parts.push(count);
  for (const comment of comments) {
    const bytes = utf8.encode(comment);
    const len = new Uint8Array(4);
    writeU32LE(len, 0, bytes.length);
    parts.push(len, bytes);
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * 把 AudioBuffer 编码成 Ogg Opus。
 * @param {AudioBuffer} audio 已经处理好的音频（本函数只做编码）
 * @param {object} options {bitrate, tags, cover, onProgress}
 * @returns {Promise<Uint8Array>}
 */
export async function encodeOggOpus(audio, options = {}) {
  if (typeof AudioEncoder === 'undefined') throw new Error('当前浏览器不支持 Opus 编码');

  const sampleRate = 48000;
  const channels = Math.min(2, audio.numberOfChannels);
  const bitrate = options.bitrate || 160000;
  const onProgress = options.onProgress || (() => {});

  // 统一重采样到 48k（Opus 只接受固定几档采样率）
  const targetFrames = Math.ceil(audio.duration * sampleRate);
  let pcm;
  if (audio.sampleRate === sampleRate && audio.numberOfChannels === channels) {
    pcm = [];
    for (let c = 0; c < channels; c += 1) pcm.push(audio.getChannelData(c));
  } else {
    const offline = new OfflineAudioContext(channels, Math.max(1, targetFrames), sampleRate);
    const src = offline.createBufferSource();
    src.buffer = audio;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    pcm = [];
    for (let c = 0; c < channels; c += 1) pcm.push(rendered.getChannelData(c));
  }

  const totalFrames = pcm[0].length;
  const packets = [];
  let description = null;

  const supported = await AudioEncoder.isConfigSupported({
    codec: 'opus', sampleRate, numberOfChannels: channels, bitrate,
  }).catch(() => ({ supported: false }));
  if (!supported.supported) throw new Error('当前浏览器不支持 Opus 编码');

  await new Promise((resolve, reject) => {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !description) {
          const d = meta.decoderConfig.description;
          description = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        packets.push({ bytes: buf, timestamp: chunk.timestamp, duration: chunk.duration });
      },
      error: (e) => reject(e),
    });
    encoder.configure({ codec: 'opus', sampleRate, numberOfChannels: channels, bitrate });

    const blockSize = 960; // 20ms
    for (let offset = 0; offset < totalFrames; offset += blockSize) {
      const frames = Math.min(blockSize, totalFrames - offset);
      const data = new Float32Array(frames * channels);
      for (let c = 0; c < channels; c += 1) {
        data.set(pcm[c].subarray(offset, offset + frames), c * frames);
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((offset / sampleRate) * 1e6),
        data,
      });
      encoder.encode(audioData);
      audioData.close();
      if (offset % (blockSize * 20) === 0) onProgress(offset / totalFrames);
    }
    encoder.flush().then(() => {
      encoder.close();
      resolve();
    }).catch(reject);
  });

  onProgress(0.85);

  const head = description && description.length >= 19 ? description : buildOpusHead(channels, sampleRate);
  const preSkip = head.length >= 12 ? (head[10] | (head[11] << 8)) : 312;
  const tags = buildOpusTags(options.tags || {}, options.pictures || (options.cover ? [options.cover] : []));

  const serial = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const pages = [];
  let sequence = 0;

  const headPages = buildPacketPages(head, { serial, sequence, granule: 0n, bos: true });
  pages.push(...headPages.pages);
  sequence = headPages.nextSequence;

  const tagPages = buildPacketPages(tags, { serial, sequence, granule: 0n });
  pages.push(...tagPages.pages);
  sequence = tagPages.nextSequence;

  let samples = 0;
  if (!packets.length) throw new Error('没有编码出音频数据');
  let lastGranule = 0n;
  packets.forEach((packet, index) => {
    samples += Math.round(((packet.duration || 20000) / 1e6) * sampleRate);
    lastGranule = BigInt(samples);
    const built = buildPacketPages(packet.bytes, {
      serial,
      sequence,
      granule: lastGranule,
      eos: index === packets.length - 1,
    });
    pages.push(...built.pages);
    sequence = built.nextSequence;
  });
  onProgress(0.95);

  const total = pages.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pages) { out.set(p, off); off += p.length; }
  onProgress(1);
  return out;
}

export { buildOpusHead, buildOpusTags, oggCrc };
