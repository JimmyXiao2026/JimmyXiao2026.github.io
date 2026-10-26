/* 音频标签读写：FLAC / MP3(ID3v2) / OGG(Vorbis comment) / WAV(ID3 块)
 *
 * 只做音频转换用得上的字段：标题、艺术家、专辑、封面。
 * 写 FLAC 时会保留原有 STREAMINFO 与音频帧，只替换注释块和图片块。
 */

const utf8 = new TextEncoder();
const utf8d = new TextDecoder('utf-8');

/* ------------------------------------------------------------------ 工具 */

function readU32BE(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function readU24BE(b, o) {
  return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
}
function readU32LE(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function writeU32BE(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}
function writeU32LE(b, o, v) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function ascii(b, o, n) {
  return String.fromCharCode(...b.subarray(o, o + n));
}
function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ------------------------------------------------------------------ 指纹 */

export function sniffFormat(bytes, name = '') {
  if (!bytes || bytes.length < 12) return '';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  if (ascii(bytes, 4, 4) === 'ftyp') return 'm4a';
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['flac', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac'].includes(ext)) return ext;
  return '';
}

/* ------------------------------------------------------------------ 读标签 */

function decodeText(b) {
  // 去掉结尾的 NUL
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end -= 1;
  return utf8d.decode(b.subarray(0, end)).trim();
}

function readFlacPictureBlock(data) {
  const view = data;
  let o = 0;
  const type = readU32BE(view, o); o += 4;
  const mimeLen = readU32BE(view, o); o += 4;
  const mime = ascii(view, o, mimeLen); o += mimeLen;
  const descLen = readU32BE(view, o); o += 4 + descLen;
  const width = readU32BE(view, o); o += 4;
  const height = readU32BE(view, o); o += 4;
  const depth = readU32BE(view, o); o += 4;
  o += 4; // colors
  const dataLen = readU32BE(view, o); o += 4;
  if (!dataLen || o + dataLen > view.length) return null;
  return { type, mime: mime || 'image/jpeg', width, height, depth, bytes: view.slice(o, o + dataLen) };
}

function parseVorbisComments(data) {
  const out = {};
  const all = {};
  let o = 0;
  if (o + 4 > data.length) return { tags: out, comments: [], all };
  const vendorLen = readU32LE(data, o); o += 4 + vendorLen;
  if (o + 4 > data.length) return { tags: out, comments: [], all };
  const count = readU32LE(data, o); o += 4;
  const comments = [];
  for (let i = 0; i < count && o + 4 <= data.length; i += 1) {
    const len = readU32LE(data, o); o += 4;
    if (o + len > data.length) break;
    const text = utf8d.decode(data.subarray(o, o + len));
    o += len;
    comments.push(text);
    const eq = text.indexOf('=');
    if (eq > 0) {
      const key = text.slice(0, eq).toUpperCase();
      const value = text.slice(eq + 1);
      if (!out[key]) out[key] = value;
      (all[key] = all[key] || []).push(value);
    }
  }
  return { tags: out, comments, all };
}

function readFlacTags(bytes) {
  let o = 4;
  const result = { tags: {}, picture: null, pictures: [], sampleRate: 0, channels: 0, bits: 0, lossless: true };
  while (o + 4 <= bytes.length) {
    const header = bytes[o];
    const type = header & 0x7f;
    const last = (header & 0x80) !== 0;
    const len = readU24BE(bytes, o + 1);
    const data = bytes.subarray(o + 4, o + 4 + len);
    if (type === 0 && data.length >= 18) {
      const b = data;
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      result.sampleRate = rate;
      result.channels = ((b[12] >> 1) & 0x07) + 1;
      result.bits = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
    } else if (type === 4) {
      const parsed = parseVorbisComments(data);
      result.tags = parsed.tags || {};
    } else if (type === 6) {
      const pic = readFlacPictureBlock(data);
      if (pic) result.pictures.push(pic);
    }
    o += 4 + len;
    if (last) break;
  }
  result.picture = result.pictures.find((p) => p.type === 3) || result.pictures[0] || null;
  return result;
}

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function readId3FrameText(data) {
  if (!data.length) return '';
  const enc = data[0];
  const body = data.subarray(1);
  if (enc === 0) return decodeText(body).replace(/\0/g, ' ').trim();
  if (enc === 1 || enc === 2) {
    // UTF-16 with BOM
    try {
      return new TextDecoder(enc === 1 ? 'utf-16' : 'utf-16le').decode(body).replace(/\0/g, ' ').trim();
    } catch {
      return '';
    }
  }
  return decodeText(body).replace(/\0/g, ' ').trim();
}

function readId3(bytes) {
  const out = { tags: {}, picture: null, pictures: [] };
  if (ascii(bytes, 0, 3) !== 'ID3') return out;
  const version = bytes[3];
  const size = syncsafe(bytes, 6);
  let o = 10;
  if (bytes[5] & 0x40) {
    // 扩展头
    const extSize = version === 4 ? syncsafe(bytes, o) : readU32BE(bytes, o);
    o += extSize;
  }
  const end = Math.min(bytes.length, 10 + size);
  while (o + 10 <= end) {
    const id = ascii(bytes, o, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = version === 4 ? syncsafe(bytes, o + 4) : readU32BE(bytes, o + 4);
    const data = bytes.subarray(o + 10, o + 10 + frameSize);
    if (data.length < frameSize) break;
    if (id === 'TIT2') out.tags.TITLE = readId3FrameText(data);
    else if (id === 'TPE1') out.tags.ARTIST = readId3FrameText(data);
    else if (id === 'TALB') out.tags.ALBUM = readId3FrameText(data);
    else if (id === 'APIC') {
      const enc = data[0];
      let p = 1;
      let mimeEnd = p;
      while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd += 1;
      const mime = ascii(data, p, mimeEnd - p);
      p = mimeEnd + 1;
      const picType = data[p];
      p += 1;
      // 跳过描述（按编码不同，双字节结束符）
      if (enc === 1 || enc === 2) {
        while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < data.length && data[p] !== 0) p += 1;
        p += 1;
      }
      const picBytes = data.slice(p);
      if (picBytes.length > 8) {
        out.pictures.push({ mime: mime || 'image/jpeg', bytes: picBytes, type: picType });
      }
    }
    o += 10 + frameSize;
  }
  out.picture = out.pictures.find((pic) => pic.type === 3) || out.pictures[0] || null;
  return out;
}

function iterOggPackets(bytes, maxPackets) {
  const packets = [];
  let o = 0;
  let parts = [];
  let total = 0;

  while (o + 27 <= bytes.length && packets.length < maxPackets) {
    if (ascii(bytes, o, 4) !== 'OggS') break;
    const segCount = bytes[o + 26];
    const table = bytes.subarray(o + 27, o + 27 + segCount);
    let dataOff = o + 27 + segCount;

    for (let s = 0; s < segCount; s += 1) {
      const lace = table[s];
      if (dataOff + lace > bytes.length) return packets;
      parts.push(bytes.subarray(dataOff, dataOff + lace));
      total += lace;
      dataOff += lace;
      if (lace < 255) {
        const packet = new Uint8Array(total);
        let off = 0;
        for (const part of parts) { packet.set(part, off); off += part.length; }
        packets.push(packet);
        parts = [];
        total = 0;
        if (packets.length >= maxPackets) break;
      }
    }
    o = dataOff;
  }
  return packets;
}

function readOggTags(bytes) {
  const out = { tags: {}, picture: null, pictures: [], sampleRate: 48000, channels: 2 };
  const packets = iterOggPackets(bytes, 3);

  if (packets[0] && ascii(packets[0], 0, 8) === 'OpusHead') {
    out.channels = packets[0][9] || 2;
  }

  let all = {};
  const comment = packets[1];
  if (comment) {
    let parsed = null;
    if (ascii(comment, 0, 8) === 'OpusTags') {
      parsed = parseVorbisComments(comment.subarray(8));
    } else if (ascii(comment, 0, 7) === '\x03vorbis') {
      parsed = parseVorbisComments(comment.subarray(7));
    }
    if (parsed) {
      out.tags = parsed.tags || {};
      out.comments = parsed.comments || [];
      all = parsed.all || {};
    }
  }

  const picList = all.METADATA_BLOCK_PICTURE || (out.tags.METADATA_BLOCK_PICTURE ? [out.tags.METADATA_BLOCK_PICTURE] : []);
  for (const picB64 of picList) {
    try {
      const bin = atob(picB64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const pic = readFlacPictureBlock(arr);
      if (pic) out.pictures.push(pic);
    } catch { /* ignore */ }
  }
  out.picture = out.pictures.find((p) => p.type === 3) || out.pictures[0] || null;
  return out;
}

function readWavTags(bytes) {
  const out = { tags: {}, picture: null, sampleRate: 0, channels: 0, bits: 0 };
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = ascii(bytes, o, 4);
    const size = readU32LE(bytes, o + 4);
    const data = bytes.subarray(o + 8, o + 8 + size);
    if (id === 'fmt ' && data.length >= 16) {
      out.channels = data[2] | (data[3] << 8);
      out.sampleRate = readU32LE(data, 4);
      out.bits = data[14] | (data[15] << 8);
    } else if (id === 'id3 ' || id === 'ID3 ') {
      const id3 = readId3(data);
      out.tags = id3.tags;
      out.picture = id3.picture;
    } else if (id === 'LIST' && ascii(data, 0, 4) === 'INFO') {
      let p = 4;
      while (p + 8 <= data.length) {
        const key = ascii(data, p, 4);
        const len = readU32LE(data, p + 4);
        const value = decodeText(data.subarray(p + 8, p + 8 + len));
        p += 8 + len + (len % 2);
        if (key === 'INAM') out.tags.TITLE = value;
        else if (key === 'IART') out.tags.ARTIST = value;
        else if (key === 'IPRD') out.tags.ALBUM = value;
      }
    }
    o += 8 + size + (size % 2);
  }
  return out;
}

function readMp4Tags(bytes) {
  const out = { tags: {}, picture: null, pictures: [], sampleRate: 0, channels: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function atoms(start, end) {
    const list = [];
    let o = start;
    while (o + 8 <= end) {
      let size = view.getUint32(o);
      const type = ascii(bytes, o + 4, 4);
      let header = 8;
      if (size === 1) {
        // 64 位长度
        size = Number(view.getBigUint64(o + 8));
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) break;
      list.push({ type, start: o + header, end: o + size });
      o += size;
    }
    return list;
  }

  function find(path, start, end) {
    let current = [{ start, end, type: '' }];
    for (const name of path) {
      const next = [];
      for (const box of current) {
        // meta 是 full box，前面多 4 字节 version/flags
        const offset = box.type === 'meta' ? 4 : 0;
        for (const atom of atoms(box.start + offset, box.end)) {
          if (atom.type === name) next.push(atom);
        }
      }
      if (!next.length) return [];
      current = next;
    }
    return current;
  }

  const moov = find(['moov'], 0, bytes.length)[0];
  if (!moov) return out;

  // 采样率：从 mdhd 里读
  const mdhd = find(['trak', 'mdia', 'mdhd'], moov.start, moov.end)[0];
  if (mdhd) {
    const version = bytes[mdhd.start];
    const rateOff = mdhd.start + (version === 1 ? 20 : 12);
    if (rateOff + 4 <= mdhd.end) {
      out.sampleRate = view.getUint32(rateOff) >>> 16;
    }
  }
  const hdlr = find(['trak', 'mdia', 'hdlr'], moov.start, moov.end)[0];
  if (hdlr && ascii(bytes, hdlr.start + 8, 4) === 'soun') out.isAudio = true;

  // 元数据：udta/meta/ilst（meta 前面有 4 字节 version/flags）
  const ilst = find(['udta', 'meta', 'ilst'], moov.start, moov.end)[0];
  if (!ilst) return out;

  for (const item of atoms(ilst.start, ilst.end)) {
    if (item.type === 'covr') {
      // covr 里可以塞多张图，每个 data 子块一张
      for (const data of atoms(item.start, item.end).filter((a) => a.type === 'data')) {
        const payload = bytes.subarray(data.start + 8, data.end);
        const dataType = view.getUint32(data.start);
        if (payload.length > 8) {
          out.pictures.push({
            type: 3,
            mime: dataType === 14 ? 'image/png' : 'image/jpeg',
            bytes: payload.slice(),
            width: 0,
            height: 0,
          });
        }
      }
      continue;
    }
    const data = atoms(item.start, item.end).find((a) => a.type === 'data');
    if (!data) continue;
    const payload = bytes.subarray(data.start + 8, data.end);
    if (item.type === '\u00a9nam') out.tags.TITLE = decodeText(payload);
    else if (item.type === '\u00a9ART') out.tags.ARTIST = decodeText(payload);
    else if (item.type === '\u00a9alb') out.tags.ALBUM = decodeText(payload);
  }
  out.picture = out.pictures[0] || null;
  return out;
}

/**
 * 读取音频标签与基本参数。
 * @returns {{title:string, artist:string, album:string, cover:object|null,
 *            sampleRate:number, channels:number, bits:number, lossless:boolean, format:string}}
 */
export function readAudioTags(bytes, name = '') {
  const format = sniffFormat(bytes, name);
  let info = { tags: {}, picture: null, sampleRate: 0, channels: 0, bits: 0 };
  try {
    if (format === 'flac') info = readFlacTags(bytes);
    else if (format === 'mp3') info = readId3(bytes);
    else if (format === 'ogg') info = readOggTags(bytes);
    else if (format === 'wav') info = readWavTags(bytes);
    else if (format === 'm4a' || format === 'aac') info = readMp4Tags(bytes);
  } catch { /* 读不出来就当没有标签 */ }

  const tags = info.tags || {};
  const pictures = (info.pictures || (info.picture ? [info.picture] : []))
    .filter((pic) => pic && pic.bytes && pic.bytes.length)
    .map((pic) => ({
      type: typeof pic.type === 'number' ? pic.type : 3,
      bytes: pic.bytes,
      mime: pic.mime || 'image/jpeg',
      width: pic.width || 0,
      height: pic.height || 0,
    }));
  return {
    format,
    title: tags.TITLE || tags.title || '',
    artist: tags.ARTIST || tags.artist || '',
    album: tags.ALBUM || tags.album || '',
    pictures,
    cover: pictures.find((p) => p.type === 3) || pictures[0] || null,
    sampleRate: info.sampleRate || 0,
    channels: info.channels || 0,
    bits: info.bits || 0,
    lossless: format === 'flac' || format === 'wav',
  };
}

/* ------------------------------------------------------------------ 写标签 */

export function makeFlacPicture(cover) {
  const mime = utf8.encode(cover.mime || 'image/jpeg');
  const desc = utf8.encode(cover.description || '');
  const data = cover.bytes;
  const head = new Uint8Array(32 + mime.length + desc.length);
  let o = 0;
  writeU32BE(head, o, cover.type || 3); o += 4;
  writeU32BE(head, o, mime.length); o += 4;
  head.set(mime, o); o += mime.length;
  writeU32BE(head, o, desc.length); o += 4;
  head.set(desc, o); o += desc.length;
  writeU32BE(head, o, cover.width || 0); o += 4;
  writeU32BE(head, o, cover.height || 0); o += 4;
  writeU32BE(head, o, cover.depth || 24); o += 4;
  writeU32BE(head, o, 0); o += 4;
  writeU32BE(head, o, data.length); o += 4;
  return concat([head, data]);
}

function makeVorbisComment(tags, extraComments = []) {
  const vendor = utf8.encode('JimmyXiao Format Converter');
  const comments = [];
  if (tags.title) comments.push('TITLE=' + tags.title);
  if (tags.artist) comments.push('ARTIST=' + tags.artist);
  if (tags.album) comments.push('ALBUM=' + tags.album);
  for (const c of extraComments) comments.push(c);

  const parts = [new Uint8Array(4)];
  writeU32LE(parts[0], 0, vendor.length);
  parts.push(vendor);
  const countBuf = new Uint8Array(4);
  writeU32LE(countBuf, 0, comments.length);
  parts.push(countBuf);
  for (const c of comments) {
    const bytes = utf8.encode(c);
    const len = new Uint8Array(4);
    writeU32LE(len, 0, bytes.length);
    parts.push(len, bytes);
  }
  return concat(parts);
}

/** 重写 FLAC 的注释块与图片块，音频帧原样保留（无损透传） */
export function writeFlacTags(flacBytes, tags) {
  if (ascii(flacBytes, 0, 4) !== 'fLaC') throw new Error('不是 FLAC 文件');

  const kept = [];
  let o = 4;
  while (o + 4 <= flacBytes.length) {
    const header = flacBytes[o];
    const type = header & 0x7f;
    const len = readU24BE(flacBytes, o + 1);
    const block = flacBytes.subarray(o + 4, o + 4 + len);
    if (type !== 4 && type !== 6) kept.push({ type, data: block });
    o += 4 + len;
    if (header & 0x80) break;
  }
  const audio = flacBytes.subarray(o);

  const blocks = kept.slice();
  blocks.push({ type: 4, data: makeVorbisComment(tags) });
  for (const pic of picturesOf(tags)) {
    blocks.push({ type: 6, data: makeFlacPicture(pic) });
  }

  const parts = [utf8.encode('fLaC')];
  blocks.forEach((block, index) => {
    const header = new Uint8Array(4);
    header[0] = (index === blocks.length - 1 ? 0x80 : 0) | (block.type & 0x7f);
    const len = block.data.length;
    header[1] = (len >>> 16) & 0xff;
    header[2] = (len >>> 8) & 0xff;
    header[3] = len & 0xff;
    parts.push(header, block.data);
  });
  parts.push(audio);
  return concat(parts);
}

/** 统一取图片列表：优先 pictures，其次旧的单张 cover */
export function picturesOf(tags) {
  if (!tags) return [];
  if (Array.isArray(tags.pictures)) {
    return tags.pictures.filter((p) => p && p.bytes && p.bytes.length);
  }
  return tags.cover && tags.cover.bytes ? [tags.cover] : [];
}

/** 构造 ID3v2.3 标签（文本用 UTF-16 + BOM，兼容性最好） */
export function buildId3v23(tags) {
  const frames = [];
  const textFrame = (id, text) => {
    if (!text) return;
    const body = new Uint8Array(1 + 2 + text.length * 2);
    body[0] = 0x01;
    body[1] = 0xff;
    body[2] = 0xfe;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      body[3 + i * 2] = code & 0xff;
      body[4 + i * 2] = (code >>> 8) & 0xff;
    }
    const head = new Uint8Array(10);
    for (let i = 0; i < 4; i += 1) head[i] = id.charCodeAt(i);
    writeU32BE(head, 4, body.length);
    frames.push(head, body);
  };

  textFrame('TIT2', tags.title || '');
  textFrame('TPE1', tags.artist || '');
  textFrame('TALB', tags.album || '');

  for (const pic of picturesOf(tags)) {
    const mime = utf8.encode(pic.mime || 'image/jpeg');
    const body = new Uint8Array(1 + mime.length + 1 + 1 + 1 + pic.bytes.length);
    let o = 0;
    body[o] = 0x00; o += 1;
    body.set(mime, o); o += mime.length;
    body[o] = 0x00; o += 1;
    body[o] = pic.type || 3; o += 1; // 3 正面 / 4 封底 / 8 艺人 / 18 插图
    body[o] = 0x00; o += 1; // empty description
    body.set(pic.bytes, o);
    const head = new Uint8Array(10);
    head.set([0x41, 0x50, 0x49, 0x43], 0); // APIC
    writeU32BE(head, 4, body.length);
    frames.push(head, body);
  }

  const bodyBytes = concat(frames);
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0);
  const size = bodyBytes.length;
  header[6] = (size >>> 21) & 0x7f;
  header[7] = (size >>> 14) & 0x7f;
  header[8] = (size >>> 7) & 0x7f;
  header[9] = size & 0x7f;
  return concat([header, bodyBytes]);
}

/** 去掉文件开头已有的 ID3v2 标签 */
export function stripId3(bytes) {
  if (ascii(bytes, 0, 3) !== 'ID3') return bytes;
  const size = syncsafe(bytes, 6);
  const hasFooter = (bytes[5] & 0x10) !== 0;
  return bytes.subarray(10 + size + (hasFooter ? 10 : 0));
}

/** MP3：去掉旧标签，写入新标签 */
export function writeMp3Tags(mp3Bytes, tags) {
  return concat([buildId3v23(tags), stripId3(mp3Bytes)]);
}

/** WAV：在末尾追加 id3 块并更新 RIFF 长度 */
export function writeWavTags(wavBytes, tags) {
  const id3 = buildId3v23(tags);
  const chunk = new Uint8Array(8 + id3.length + (id3.length % 2));
  chunk.set([0x69, 0x64, 0x33, 0x20], 0); // 'id3 '
  writeU32LE(chunk, 4, id3.length);
  chunk.set(id3, 8);
  const out = concat([wavBytes, chunk]);
  // 更新 RIFF 总长度
  writeU32LE(out, 4, out.length - 8);
  return out;
}

/* ------------------------------------------------------------------ MP4 / M4A */

function u32be(n) {
  const b = new Uint8Array(4);
  writeU32BE(b, 0, n);
  return b;
}

function mp4Box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  writeU32BE(out, 0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function mp4DataAtom(typeCode, payload) {
  return mp4Box('data', concat([u32be(typeCode), u32be(0), payload]));
}

function mp4Boxes(bytes, start, end) {
  const list = [];
  let o = start;
  while (o + 8 <= end) {
    let size = readU32BE(bytes, o);
    const type = ascii(bytes, o + 4, 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = Number((BigInt(readU32BE(bytes, o + 8)) << 32n) | BigInt(readU32BE(bytes, o + 12)));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    list.push({ type, start: o, end: o + size, headerLen: header });
    o += size;
  }
  return list;
}

/**
 * 往 M4A 里写 iTunes 元数据（title / artist / album / 封面）。
 * 只在 moov 位于文件末尾时使用（mp4-muxer 的 fastStart:false），
 * 这样改动只影响 mdat 之后的字节，不会破坏 stco 里的采样偏移。
 */
export function writeMp4Tags(mp4Bytes, tags) {
  const boxes = mp4Boxes(mp4Bytes, 0, mp4Bytes.length);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return mp4Bytes;

  const items = [];
  const text = (type, value) => {
    if (value) items.push(mp4Box(type, mp4DataAtom(1, utf8.encode(value))));
  };
  text('\u00a9nam', tags.title);
  text('\u00a9ART', tags.artist);
  text('\u00a9alb', tags.album);

  const pics = picturesOf(tags);
  if (pics.length) {
    const parts = pics.map((pic) => mp4DataAtom(pic.mime === 'image/png' ? 14 : 13, pic.bytes));
    items.push(mp4Box('covr', concat(parts)));
  }
  if (!items.length) return mp4Bytes;

  const hdlr = mp4Box('hdlr', concat([
    u32be(0),
    utf8.encode('mdir'),
    new Uint8Array(12),
    new Uint8Array(1),
  ]));
  const ilst = mp4Box('ilst', concat(items));
  const meta = mp4Box('meta', concat([u32be(0), hdlr, ilst]));
  const udta = mp4Box('udta', meta);

  const children = mp4Boxes(mp4Bytes, moov.start + moov.headerLen, moov.end)
    .filter((b) => b.type !== 'udta');
  const newMoov = mp4Box('moov', concat([
    ...children.map((b) => mp4Bytes.subarray(b.start, b.end)),
    udta,
  ]));

  return concat([
    mp4Bytes.subarray(0, moov.start),
    newMoov,
    mp4Bytes.subarray(moov.end),
  ]);
}

export { makeVorbisComment, parseVorbisComments };
