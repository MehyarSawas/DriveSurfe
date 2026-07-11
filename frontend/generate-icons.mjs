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
  // Dual-tone surf waves on the sky-blue bg (matches the in-app SVG mark):
  // a 40%-white back crest, a solid-white front crest, both filled to the
  // bottom. PWA icons stay full-bleed squares — the OS applies its own mask.
  function setPixel(x, y, r2, g2, b2) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = r2; pixels[i+1] = g2; pixels[i+2] = b2;
  }

  // Back tone = white at 40% over #0284c7 (icons are opaque RGB)
  const BACK = [154, 206, 233];

  // Crest curves as smooth cosines, ~1.5 periods across the icon —
  // approximates the SVG cubic curves closely enough at icon sizes.
  const yBack  = x => size * (0.51 + 0.085 * Math.cos((x / size) * Math.PI * 3 + 0.6));
  const yFront = x => size * (0.67 + 0.09  * Math.cos((x / size) * Math.PI * 3 + 1.1));

  for (let x = 0; x < size; x++) {
    const yb = Math.round(yBack(x));
    const yf = Math.round(yFront(x));
    for (let y = yb; y < size; y++) setPixel(x, y, BACK[0], BACK[1], BACK[2]);
    for (let y = yf; y < size; y++) setPixel(x, y, 255, 255, 255);
  }
}

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
for (const size of SIZES) {
  const png = makePng(size, 2, 132, 199, drawIcon); // #0284c7
  writeFileSync(join(DEST, `icon-${size}x${size}.png`), png);
  console.log(`✓ icon-${size}x${size}.png`);
}

// favicon.ico = 32x32 PNG renamed (browsers accept PNG as favicon)
const fav = makePng(32, 2, 132, 199, drawIcon);
writeFileSync(join(__dirname, 'src/favicon.ico'), fav);
console.log('✓ favicon.ico');
