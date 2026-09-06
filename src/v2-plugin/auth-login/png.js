// png.js — minimal PNG encoder (truecolor RGB, no zlib dependency).
//
// Produces valid PNG bytes for a boolean module matrix. Uses a very small,
// self-contained DEFLATE (stored blocks) implementation so there are zero
// external dependencies.
//
// PNG layout: signature + IHDR + IDAT (zlib-wrapped deflate stored blocks) + IEND.
// CRC-32 handled manually.

// ---- CRC32 ------------------------------------------------------------------
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

// ---- Adler-32 ---------------------------------------------------------------
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- Stored-block deflate (deflate() with stored, non-compressed blocks) ----
// Produces a zlib stream: 2-byte header + deflate stored blocks + 4-byte adler.
function zlibStored(data) {
  const out = [];
  // zlib header: CMF 0x78, FLG 0x01 (FCHECK such that (CMF*256+FLG)%31==0)
  out.push(0x78, 0x01);
  const len = data.length;
  let pos = 0;
  let blockIdx = 0;
  while (pos < len) {
    const chunk = Math.min(65535, len - pos);
    const last = pos + chunk >= len ? 1 : 0;
    out.push(last); // BFINAL (1 bit) + BTYPE=00 (stored)
    // LEN and NLEN little-endian
    out.push(chunk & 0xff, (chunk >>> 8) & 0xff);
    out.push((~chunk) & 0xff, ((~chunk) >>> 8) & 0xff);
    for (let i = 0; i < chunk; i++) out.push(data[pos + i]);
    pos += chunk;
    blockIdx++;
  }
  // adler32 of uncompressed data
  const ad = adler32(data);
  out.push((ad >>> 24) & 0xff, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff);
  return out;
}

// ---- PNG assembly -----------------------------------------------------------
function pngChunk(type, data) {
  const len = data.length;
  const buf = new Uint8Array(4 + 4 + len + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, len, false);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(data, 8);
  const crc = crc32(buf.subarray(4, 8 + len));
  dv.setUint32(8 + len, crc, false);
  return buf;
}

/**
 * Encode a boolean matrix (moduleCount x moduleCount) to PNG bytes.
 * @param {Array<Array<boolean>>} matrix
 * @param {number} scale  pixels per module (e.g. 8)
 * @param {number} margin quiet-zone modules (e.g. 4)
 * @returns {Uint8Array} PNG bytes
 */
function matrixToPng(matrix, scale = 8, margin = 4) {
  const m = matrix.length;
  const dim = m + margin * 2;
  const px = dim * scale;
  // raw image data: each row prefixed with filter byte 0
  const rawLength = (px * 3 + 1) * px;
  const raw = new Uint8Array(rawLength);
  let idx = 0;
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  for (let yPx = 0; yPx < px; yPx++) {
    raw[idx++] = 0; // filter: None
    const modRow = Math.floor(yPx / scale) - margin;
    for (let xPx = 0; xPx < px; xPx++) {
      const modCol = Math.floor(xPx / scale) - margin;
      let dark = false;
      if (modRow >= 0 && modRow < m && modCol >= 0 && modCol < m) {
        dark = !!matrix[modRow][modCol];
      }
      const rgb = dark ? black : white;
      raw[idx++] = rgb[0];
      raw[idx++] = rgb[1];
      raw[idx++] = rgb[2];
    }
  }
  const idat = zlibStored(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, px, false);
  dv.setUint32(4, px, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idatBytes = new Uint8Array(idat);
  const parts = [
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idatBytes),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function base64(data) {
  // data: Uint8Array
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return Buffer.from(bin, "binary").toString("base64");
}

export { matrixToPng, base64, zlibStored, crc32, adler32 };
