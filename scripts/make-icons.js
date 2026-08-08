/**
 * Generates the extension icons (icons/icon{16,32,48,128}.png) without any
 * dependencies: pixels are computed in-process and written as PNG using
 * node's zlib for the IDAT stream.
 *
 * Design: Microsoft-blue rounded square with a white filter funnel —
 * "query/filter your Graph results".
 *
 * Usage: node scripts/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- png write

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** rgba: Uint8Array of size*size*4 */
function writePng(filePath, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
      : raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(filePath, png);
}

// ------------------------------------------------------------------ drawing

const BG_TOP = [0x2b, 0x88, 0xd8];
const BG_BOTTOM = [0x0f, 0x6c, 0xbd];
const WHITE = [0xff, 0xff, 0xff];

/**
 * Coverage of the rounded-square background at normalized point (u, v).
 * Returns 0..1.
 */
function backgroundCoverage(u, v) {
  const radius = 0.18;
  const min = 0.02;
  const max = 0.98;
  const cx = Math.min(Math.max(u, min + radius), max - radius);
  const cy = Math.min(Math.max(v, min + radius), max - radius);
  const dx = u - cx;
  const dy = v - cy;
  return Math.sqrt(dx * dx + dy * dy) <= radius ? 1 : 0;
}

/** Is normalized point (u, v) inside the white funnel glyph? */
function insideFunnel(u, v) {
  const du = Math.abs(u - 0.5);
  if (v >= 0.24 && v < 0.55) {
    const t = (v - 0.24) / (0.55 - 0.24);
    const halfWidth = 0.27 + (0.06 - 0.27) * t;
    return du <= halfWidth;
  }
  if (v >= 0.55 && v <= 0.78) {
    return du <= 0.06;
  }
  return false;
}

function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4; // 4x4 supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          if (backgroundCoverage(u, v) > 0) {
            bgHits++;
            if (insideFunnel(u, v)) {
              fgHits++;
            }
          }
        }
      }
      const total = samples * samples;
      const alpha = bgHits / total;
      const fg = fgHits / total;
      const bg = alpha - fg;
      const offset = (y * size + x) * 4;
      if (alpha === 0) {
        continue; // transparent
      }
      const t = y / size;
      const base = [
        BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
        BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
        BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t
      ];
      for (let c = 0; c < 3; c++) {
        rgba[offset + c] = Math.round((base[c] * bg + WHITE[c] * fg) / alpha);
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  writePng(file, size, makeIcon(size));
  console.log(`wrote ${file}`);
}
