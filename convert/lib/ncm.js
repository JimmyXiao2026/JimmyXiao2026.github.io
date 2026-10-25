/* 网易云音乐 .ncm 解密
 *
 * 结构：magic(8) + 2 字节 + keyLen + AES 加密过的 RC4 密钥 + metaLen + 加密元数据
 *      + 5 字节 + 封面区长度 + 封面长度 + 封面 + 音频（RC4 变体流加密）
 *
 * 全程在本地完成，不联网。AES-128-ECB 用纯 JS 实现（WebCrypto 不支持 ECB）。
 */

const MAGIC = 'CTENFDAM';
const CORE_KEY = Uint8Array.from([104, 122, 72, 82, 65, 109, 115, 111, 53, 107, 73, 110, 98, 97, 120, 87]);
const MODIFY_KEY = Uint8Array.from([35, 49, 52, 108, 106, 107, 95, 33, 92, 93, 38, 48, 85, 60, 39, 40]);

/* ------------------------------------------------------------------ AES-128 解密 */

function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}
const rotl8 = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;

const { SBOX, INV_SBOX } = (() => {
  const sbox = new Uint8Array(256);
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let x = 0;
    if (i) {
      // GF(2^8) 乘法逆元：x^254
      x = 1;
      let base = i;
      let exp = 254;
      while (exp > 0) {
        if (exp & 1) x = gmul(x, base);
        base = gmul(base, base);
        exp >>= 1;
      }
    }
    const s = (x ^ rotl8(x, 1) ^ rotl8(x, 2) ^ rotl8(x, 3) ^ rotl8(x, 4) ^ 0x63) & 0xff;
    sbox[i] = s;
  }
  for (let i = 0; i < 256; i += 1) inv[sbox[i]] = i;
  return { SBOX: sbox, INV_SBOX: inv };
})();

function expandKey128(key) {
  const w = new Uint8Array(176);
  w.set(key, 0);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 16 === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
      rcon = gmul(rcon, 2);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function addRoundKey(s, w, round) {
  const off = round * 16;
  for (let i = 0; i < 16; i += 1) s[i] ^= w[off + i];
}

function invShiftRows(s) {
  // 状态按列存放：s[c*4 + r]
  for (let r = 1; r < 4; r += 1) {
    const row = [s[r], s[4 + r], s[8 + r], s[12 + r]];
    for (let c = 0; c < 4; c += 1) {
      s[c * 4 + r] = row[(c - r + 4) % 4];
    }
  }
}

function invSubBytes(s) {
  for (let i = 0; i < 16; i += 1) s[i] = INV_SBOX[s[i]];
}

function invMixColumns(s) {
  for (let c = 0; c < 4; c += 1) {
    const i = c * 4;
    const a0 = s[i];
    const a1 = s[i + 1];
    const a2 = s[i + 2];
    const a3 = s[i + 3];
    s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

/** AES-128-ECB 解密（不做填充处理，由调用方裁剪） */
function aes128EcbDecryptRaw(keyBytes, data) {
  const w = expandKey128(keyBytes);
  const blocks = data.length >> 4;
  const out = new Uint8Array(blocks << 4);
  const s = new Uint8Array(16);

  for (let b = 0; b < blocks; b += 1) {
    s.set(data.subarray(b * 16, b * 16 + 16));
    addRoundKey(s, w, 10);
    for (let round = 9; round >= 1; round -= 1) {
      invShiftRows(s);
      invSubBytes(s);
      addRoundKey(s, w, round);
      invMixColumns(s);
    }
    invShiftRows(s);
    invSubBytes(s);
    addRoundKey(s, w, 0);
    out.set(s, b * 16);
  }
  return out;
}

/** 按网盘实现的方式解密并去掉 PKCS#7 填充 */
function aesEcbDecrypt(keyBytes, data) {
  const blocks = data.length >> 4;
  if (blocks <= 0) return new Uint8Array(0);
  const out = aes128EcbDecryptRaw(keyBytes, data.subarray(0, blocks << 4));
  let pad = out[out.length - 1];
  if (pad > 16) pad = 0;
  return out.subarray(0, out.length - pad);
}

/* ------------------------------------------------------------------ NCM */

function readU32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function buildKeyBox(key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) box[i] = i;
  let last = 0;
  let ko = 0;
  for (let i = 0; i < 256; i += 1) {
    const swap = box[i];
    const c = (swap + last + key[ko]) & 0xff;
    ko += 1;
    if (ko >= key.length) ko = 0;
    box[i] = box[c];
    box[c] = swap;
    last = c;
  }
  return box;
}

function decryptAudio(box, data) {
  for (let i = 0; i < data.length; i += 1) {
    const b = (i + 1) & 0xff;
    data[i] ^= box[(box[b] + box[(box[b] + b) & 0xff]) & 0xff];
  }
}

export function isNcm(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function artistsOf(meta) {
  if (Array.isArray(meta.artist)) {
    const names = meta.artist
      .filter((x) => Array.isArray(x) && typeof x[0] === 'string' && x[0])
      .map((x) => x[0]);
    if (names.length) return names.join(' / ');
  }
  return meta.artistName || '';
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{audio: Uint8Array, format: 'flac'|'mp3', metadata: object, cover: {bytes: Uint8Array, mime: string}|null}}
 */
export function parseNcm(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bytes = new Uint8Array(src.length);
  bytes.set(src);
  if (!isNcm(bytes)) throw new Error('不是网易云音乐 .ncm 文件');

  let off = 10; // magic(8) + 2 字节
  const keyLen = readU32(bytes, off);
  off += 4;
  if (!keyLen || off + keyLen > bytes.length) throw new Error('NCM 文件已损坏');
  const keyData = bytes.slice(off, off + keyLen);
  off += keyLen;
  for (let i = 0; i < keyData.length; i += 1) keyData[i] ^= 0x64;

  // 密钥本身也是 AES 加密的，解密后前 17 字节是固定前缀
  const keyPlain = aesEcbDecrypt(CORE_KEY, keyData).subarray(17);
  const box = buildKeyBox(keyPlain);

  let meta = null;
  const metaLen = readU32(bytes, off);
  off += 4;
  if (metaLen > 0) {
    const raw = bytes.slice(off, off + metaLen);
    off += metaLen;
    for (let i = 0; i < raw.length; i += 1) raw[i] ^= 0x63;
    try {
      let b64 = '';
      const body = raw.subarray(22); // 去掉 "163 key(Don't modify):"
      for (let i = 0; i < body.length; i += 1) b64 += String.fromCharCode(body[i]);
      const bin = atob(b64);
      const enc = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) enc[i] = bin.charCodeAt(i);
      const json = new TextDecoder('utf-8').decode(aesEcbDecrypt(MODIFY_KEY, enc).subarray(6));
      meta = JSON.parse(json);
    } catch {
      meta = null;
    }
  }

  off += 5;
  const imageArea = readU32(bytes, off);
  off += 4;
  const imageSize = readU32(bytes, off);
  off += 4;

  let cover = null;
  if (imageSize > 0 && off + imageSize <= bytes.length) {
    const img = bytes.slice(off, off + imageSize);
    const isPng = img[0] === 0x89 && img[1] === 0x50;
    const isJpg = img[0] === 0xff && img[1] === 0xd8;
    if (isPng || isJpg) cover = { bytes: img, mime: isPng ? 'image/png' : 'image/jpeg' };
  }
  off += imageSize + Math.max(0, imageArea - imageSize);

  const audio = bytes.slice(off);
  decryptAudio(box, audio);

  const format = audio.length >= 3 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33
    ? 'mp3'
    : 'flac';

  return {
    audio,
    format,
    cover,
    metadata: {
      title: (meta && meta.musicName) || '',
      artist: meta ? artistsOf(meta) : '',
      album: (meta && meta.album) || '',
      coverUrl: (meta && meta.albumPic) || '',
      durationMs: (meta && meta.duration) || 0,
    },
  };
}
