/* APNG 编码：自己拼容器，帧用 Canvas 的 PNG 编码，不依赖第三方库。
   APNG 就是在普通 PNG 上加了 acTL / fcTL / fdAT 三个块。 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function parsePng(bytes) {
  let offset = 8; // 跳过 PNG 签名
  const chunks = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    chunks.push({ type, data: bytes.slice(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/**
 * @param {{png: Uint8Array, delayMs: number}[]} frames 每帧都是同尺寸的完整 PNG
 * @returns {Uint8Array} APNG 字节
 */
export function makeApng(frames) {
  if (!frames.length) throw new Error('没有可写入的帧');

  const ihdr = parsePng(frames[0].png).find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('帧不是有效的 PNG');
  const head = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = head.getUint32(0);
  const height = head.getUint32(4);

  const acTL = new Uint8Array(8);
  const acView = new DataView(acTL.buffer);
  acView.setUint32(0, frames.length);  // 帧数
  acView.setUint32(4, 0);              // 0 = 无限循环

  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr.data),
    makeChunk('acTL', acTL),
  ];

  let sequence = 0;
  frames.forEach((frame, index) => {
    const fctl = new Uint8Array(26);
    const view = new DataView(fctl.buffer);
    view.setUint32(0, sequence++);
    view.setUint32(4, width);
    view.setUint32(8, height);
    view.setUint32(12, 0);
    view.setUint32(16, 0);
    view.setUint16(20, Math.max(1, Math.round(frame.delayMs)));
    view.setUint16(22, 1000);   // 单位：千分之一秒
    fctl[24] = 0;               // dispose: none
    fctl[25] = 0;               // blend: source
    parts.push(makeChunk('fcTL', fctl));

    const idat = parsePng(frame.png).filter((c) => c.type === 'IDAT');
    if (index === 0) {
      idat.forEach((c) => parts.push(makeChunk('IDAT', c.data)));
    } else {
      const size = idat.reduce((sum, c) => sum + c.data.length, 0);
      const data = new Uint8Array(4 + size);
      new DataView(data.buffer).setUint32(0, sequence++);
      let offset = 4;
      idat.forEach((c) => { data.set(c.data, offset); offset += c.data.length; });
      parts.push(makeChunk('fdAT', data));
    }
  });

  parts.push(makeChunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((p) => { out.set(p, offset); offset += p.length; });
  return out;
}
