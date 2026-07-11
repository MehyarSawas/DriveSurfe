/**
 * Generates PWA icons and favicon using only Node.js built-ins (no canvas).
 * Produces minimal valid PNGs with the DriveSurfe brand colour.
 * Run: node generate-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST = join(__dirname, 'src/assets/icons');
mkdirSync(DEST, { recursive: true });

// --- Minimal PNG encoder (pure JS, no deps) ---
function crc32(buf) {
  let c = 0xffffffff;
  const table = crc32.table ??= (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i;
      for (let j = 0; j < 8; j++) v = (v & 1) ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      t[i] = v;
    }
    return t;
  })();
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  const len = u32be(data.length);
  const body = new Uint8Array([...t, ...data]);
  const crc = u32be(crc32(body));
  return new Uint8Array([...len, ...body, ...crc]);
}

function deflateStore(data) {
  // zlib store (no compression) — always valid
  const out = [0x78, 0x01]; // zlib header: deflate, default compression
  let pos = 0;
  while (pos < data.length) {
    const slice = data.slice(pos, pos + 65535);
    const last = pos + slice.length >= data.length ? 1 : 0;
    out.push(last, slice.length & 0xff, (slice.length >> 8) & 0xff,
             (~slice.length) & 0xff, ((~slice.length) >> 8) & 0xff);
    out.push(...slice);
    pos += slice.length;
  }
  // Adler-32
  let s1 = 1, s2 = 0;
  for (const b of data) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521; }
  const adler = (s2 << 16) | s1;
  out.push((adler >> 24) & 0xff, (adler >> 16) & 0xff, (adler >> 8) & 0xff, adler & 0xff);
  return new Uint8Array(out);
}

function makePng(size, bgR, bgG, bgB, draw) {
  // RGBA pixels
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4 + 0] = bgR;
    pixels[i * 4 + 1] = bgG;
    pixels[i * 4 + 2] = bgB;
    pixels[i * 4 + 3] = 255;
  }
  if (draw) draw(pixels, size);

  // Build IDAT raw data (filter byte 0 per scanline + RGBA pixels)
  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0); // filter none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
    }
  }

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk('IHDR', [...u32be(size), ...u32be(size), 8, 2, 0, 0, 0]); // 8-bit RGB+A→use 2=RGB
  // Use colour type 2 (RGB) since all pixels are opaque
  const ihdr2 = new Uint8Array([...u32be(size), ...u32be(size), 8, 2, 0, 0, 0]);
  const rawRgb = [];
  for (let y = 0; y < size; y++) {
    rawRgb.push(0);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      rawRgb.push(pixels[i], pixels[i+1], pixels[i+2]);
    }
  }

  const idat = chunk('IDAT', [...deflateStore(new Uint8Array(rawRgb))]);
  const iend = chunk('IEND', []);

  const ihdrChunk = (() => {
    const data = [...u32be(size), ...u32be(size), 8, 2, 0, 0, 0];
    return chunk('IHDR', data);
  })();

  return Buffer.from([...sig, ...ihdrChunk, ...idat, ...iend]);
}

function drawIcon(pixels, size) {
  // Draw a simple mountain/wave shape (white) on blue bg
  const cx = size / 2, cy = size / 2;
  const r = size * 0.38;

  function setPixel(x, y, r2, g2, b2) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = r2; pixels[i+1] = g2; pixels[i+2] = b2;
  }

  // Draw mountain peaks (white triangles)
  const peakY = cy - r * 0.15;
  const baseY = cy + r * 0.45;
  const left  = cx - r * 0.75;
  const right = cx + r * 0.75;

  // Fill mountain shape using scanline
  for (let y = Math.floor(peakY - r * 0.5); y <= Math.ceil(baseY); y++) {
    const t = (y - peakY) / (baseY - peakY);
    if (t < 0) continue;
    // left mountain peak at cx-r*0.25, smaller right peak at cx+r*0.3
    const lx1 = left + (cx - r * 0.25 - left) * Math.max(0, 1 - Math.abs(t - 0) / 1);
    const rx1 = right - (right - (cx + r * 0.3)) * Math.max(0, 1 - Math.abs(t - 0) / 1);
    const xL = left + (right - left) * Math.max(0, (t - 0));
    const xR = right - (right - left) * Math.max(0, (t - 0));
    // Simple: just two triangles
    // Left triangle: peak at cx-r*0.2, base left..cx+r*0.1
    const lPeakX = cx - r * 0.2;
    const lBaseL = left, lBaseR = cx + r * 0.1;
    const rPeakX = cx + r * 0.35;
    const rBaseL = cx - r * 0.05, rBaseR = right;

    // Left mountain
    const tL = Math.min(1, (y - (peakY - r * 0.4)) / (baseY - (peakY - r * 0.4)));
    if (tL >= 0) {
      const wL = Math.abs(lPeakX - lBaseL) * tL;
      const wR = Math.abs(lPeakX - lBaseR) * tL;
      for (let x = Math.floor(lPeakX - wL); x <= Math.ceil(lPeakX + wR); x++) {
        setPixel(x, y, 255, 255, 255);
      }
    }
    // Right mountain (smaller, starts higher)
    const tR = Math.min(1, (y - (peakY + r * 0.05)) / (baseY - (peakY + r * 0.05)));
    if (tR >= 0) {
      const wL2 = Math.abs(rPeakX - rBaseL) * tR;
      const wR2 = Math.abs(rPeakX - rBaseR) * tR;
      for (let x = Math.floor(rPeakX - wL2); x <= Math.ceil(rPeakX + wR2); x++) {
        setPixel(x, y, 255, 255, 255);
      }
    }
  }

  // Horizon line
  const horizY = cy + r * 0.5;
  for (let x = Math.floor(left); x <= Math.ceil(right); x++) {
    for (let dy = 0; dy < Math.max(2, size * 0.04); dy++) {
      setPixel(x, Math.round(horizY) + dy, 255, 255, 255);
    }
  }
}

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
for (const size of SIZES) {
  const png = makePng(size, 26, 115, 232, drawIcon); // #1a73e8
  writeFileSync(join(DEST, `icon-${size}x${size}.png`), png);
  console.log(`✓ icon-${size}x${size}.png`);
}

// favicon.ico = 32x32 PNG renamed (browsers accept PNG as favicon)
const fav = makePng(32, 26, 115, 232, drawIcon);
writeFileSync(join(__dirname, 'src/favicon.ico'), fav);
console.log('✓ favicon.ico');
