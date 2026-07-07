export interface Point { x: number; y: number; }

export function detectQuad(imageData: ImageData): [Point, Point, Point, Point] {
  const { data, width, height } = imageData;
  const def = makeDefault(width, height);
  try {
    const scale = Math.min(1, 400 / Math.max(width, height));
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);

    const gray = downsampleGray(data, width, height, dw, dh);
    const blurred = gaussianBlur(gaussianBlur(gray, dw, dh), dw, dh);

    // Primary: find document as the largest interior region enclosed by edges
    const byGrad = detectByGradient(blurred, dw, dh, scale, width, height);
    if (byGrad) return byGrad;

    // Fallback: brightness-blob (bright doc on dark bg, or vice-versa)
    return detectByBrightness(blurred, dw, dh, scale, width, height) ?? def;
  } catch {
    return def;
  }
}

// ── Primary algorithm: gradient-edge → flood-fill exterior → interior region ──

function detectByGradient(
  blurred: Float32Array, dw: number, dh: number,
  scale: number, origW: number, origH: number
): [Point, Point, Point, Point] | null {
  const grad = sobelMagnitude(blurred, dw, dh);

  let maxG = 0;
  for (let i = 0; i < grad.length; i++) if (grad[i] > maxG) maxG = grad[i];
  if (maxG < 5) return null;

  // Threshold at 12 % of max gradient to mark document boundary edges
  const thresh = maxG * 0.12;
  const edges = new Uint8Array(dw * dh);
  for (let i = 0; i < grad.length; i++) edges[i] = grad[i] > thresh ? 1 : 0;

  // Dilate edges 3 px to close small gaps in the document outline
  const dilated = dilate(edges, dw, dh, 3);

  // Flood-fill from every border pixel through non-edge pixels → exterior
  const exterior = floodFillFromBorder(dilated, dw, dh);

  // Interior = pixels not reached by the exterior fill AND not an edge
  const interior = new Uint8Array(dw * dh);
  for (let i = 0; i < dw * dh; i++) {
    interior[i] = !exterior[i] && !dilated[i] ? 1 : 0;
  }

  return extractQuad(interior, dw, dh, scale, origW, origH);
}

// ── Fallback: Otsu threshold on blurred gray, try bright-on-dark then dark-on-bright ──

function detectByBrightness(
  blurred: Float32Array, dw: number, dh: number,
  scale: number, origW: number, origH: number
): [Point, Point, Point, Point] | null {
  const t = otsuThreshold(blurred);
  for (const bright of [true, false]) {
    const bin = new Uint8Array(dw * dh);
    for (let i = 0; i < blurred.length; i++) bin[i] = (blurred[i] > t) === bright ? 1 : 0;
    const closed = morphClose(bin, dw, dh, 10);
    const q = extractQuad(closed, dw, dh, scale, origW, origH);
    if (q) return q;
  }
  return null;
}

// ── Shared: find largest connected region → hull → quad ──────────────────────

function extractQuad(
  binary: Uint8Array, dw: number, dh: number,
  scale: number, origW: number, origH: number
): [Point, Point, Point, Point] | null {
  const region = findLargestRegion(binary, dw, dh);
  if (!region) return null;
  const ratio = region.length / (dw * dh);
  if (ratio < 0.05 || ratio > 0.90) return null;
  const hull = convexHull(region);
  if (hull.length < 4) return null;
  const quad = reduceToQuad(hull);
  if (!quad) return null;
  if (quadArea(quad) < dw * dh * 0.05) return null;
  const ordered = orderQuad(quad);
  // Scale corners from downsampled pixel space back to original image pixel space
  const upscaled = ordered.map(p => ({ x: p.x / scale, y: p.y / scale })) as [Point, Point, Point, Point];
  return clampAndInset(upscaled, 4, origW, origH);
}

function makeDefault(w: number, h: number): [Point, Point, Point, Point] {
  const i = 12;
  return [{ x: i, y: i }, { x: w - i, y: i }, { x: w - i, y: h - i }, { x: i, y: h - i }];
}

function clampAndInset(
  q: [Point, Point, Point, Point], inset: number, w: number, h: number
): [Point, Point, Point, Point] {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map(p => ({
    x: Math.max(0, Math.min(w - 1, Math.round(p.x + (p.x < cx ? inset : -inset)))),
    y: Math.max(0, Math.min(h - 1, Math.round(p.y + (p.y < cy ? inset : -inset)))),
  })) as [Point, Point, Point, Point];
}

// ── Image processing ──────────────────────────────────────────────────────────

function downsampleGray(
  data: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number
): Float32Array {
  const out = new Float32Array(dw * dh);
  const xr = sw / dw, yr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(sw - 1, Math.round((dx + 0.5) * xr));
      const sy = Math.min(sh - 1, Math.round((dy + 0.5) * yr));
      const i = (sy * sw + sx) * 4;
      out[dy * dw + dx] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return out;
}

function gaussianBlur(src: Float32Array, w: number, h: number): Float32Array {
  const K = [1, 4, 7, 4, 1, 4, 16, 26, 16, 4, 7, 26, 41, 26, 7, 4, 16, 26, 16, 4, 1, 4, 7, 4, 1];
  const S = 273;
  const out = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let v = 0;
      for (let ky = -2; ky <= 2; ky++)
        for (let kx = -2; kx <= 2; kx++)
          v += src[(y + ky) * w + (x + kx)] * K[(ky + 2) * 5 + (kx + 2)];
      out[y * w + x] = v / S;
    }
  }
  return out;
}

function sobelMagnitude(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = gray[(y-1)*w+(x-1)], tc = gray[(y-1)*w+x], tr = gray[(y-1)*w+(x+1)];
      const ml = gray[y*w+(x-1)],                             mr = gray[y*w+(x+1)];
      const bl = gray[(y+1)*w+(x-1)], bc = gray[(y+1)*w+x],  brv = gray[(y+1)*w+(x+1)];
      const gx = -tl - 2*ml - bl + tr + 2*mr + brv;
      const gy = -tl - 2*tc - tr + bl + 2*bc + brv;
      out[y*w+x] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return out;
}

function floodFillFromBorder(dilated: Uint8Array, dw: number, dh: number): Uint8Array {
  const exterior = new Uint8Array(dw * dh);
  const stack = new Int32Array(dw * dh);
  let sp = 0;

  const seed = (idx: number) => {
    if (!dilated[idx] && !exterior[idx]) { exterior[idx] = 1; stack[sp++] = idx; }
  };

  for (let x = 0; x < dw; x++) { seed(x); seed((dh - 1) * dw + x); }
  for (let y = 1; y < dh - 1; y++) { seed(y * dw); seed(y * dw + dw - 1); }

  while (sp > 0) {
    const idx = stack[--sp];
    const px = idx % dw, py = (idx / dw) | 0;
    if (px > 0)    seed(idx - 1);
    if (px < dw-1) seed(idx + 1);
    if (py > 0)    seed(idx - dw);
    if (py < dh-1) seed(idx + dw);
  }
  return exterior;
}

function otsuThreshold(gray: Float32Array): number {
  let max = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] > max) max = gray[i];
  if (max < 1) return 128;
  const n = gray.length, bins = 256;
  const hist = new Float64Array(bins);
  for (let i = 0; i < n; i++) hist[Math.min(bins - 1, (gray[i] / max * bins) | 0)]++;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = bins >> 1;
  for (let t = 0; t < bins; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const v = wB * wF * ((sumB / wB) - ((sum - sumB) / wF)) ** 2;
    if (v > best) { best = v; bestT = t; }
  }
  return (bestT / bins) * max;
}

// ── Morphological operations ──────────────────────────────────────────────────

function morphClose(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(src, w, h, r), w, h, r);
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return dilateV(dilateH(src, w, h, r), w, h, r);
}

function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erodeV(erodeH(src, w, h, r), w, h, r);
}

function dilateH(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const b = y * w;
    let cnt = 0;
    for (let k = 0; k <= Math.min(r, w - 1); k++) if (src[b + k]) cnt++;
    out[b] = cnt > 0 ? 1 : 0;
    for (let x = 1; x < w; x++) {
      if (x + r < w && src[b + x + r]) cnt++;
      if (x - r - 1 >= 0 && src[b + x - r - 1]) cnt--;
      out[b + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

function dilateV(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let k = 0; k <= Math.min(r, h - 1); k++) if (src[k * w + x]) cnt++;
    out[x] = cnt > 0 ? 1 : 0;
    for (let y = 1; y < h; y++) {
      if (y + r < h && src[(y + r) * w + x]) cnt++;
      if (y - r - 1 >= 0 && src[(y - r - 1) * w + x]) cnt--;
      out[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

function erodeH(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const ps = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const b = y * w;
    ps[0] = 0;
    for (let x = 0; x < w; x++) ps[x + 1] = ps[x] + (src[b + x] ? 1 : 0);
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w, x + r + 1);
      out[b + x] = ps[hi] - ps[lo] === hi - lo ? 1 : 0;
    }
  }
  return out;
}

function erodeV(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const ps = new Int32Array(h + 1);
  for (let x = 0; x < w; x++) {
    ps[0] = 0;
    for (let y = 0; y < h; y++) ps[y + 1] = ps[y] + (src[y * w + x] ? 1 : 0);
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h, y + r + 1);
      out[y * w + x] = ps[hi] - ps[lo] === hi - lo ? 1 : 0;
    }
  }
  return out;
}

// ── Connected components ──────────────────────────────────────────────────────

function findLargestRegion(binary: Uint8Array, w: number, h: number): Point[] | null {
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best: Point[] = [];

  for (let start = 0; start < w * h; start++) {
    if (!binary[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    const pts: Point[] = [];
    while (sp > 0) {
      const idx = stack[--sp];
      if (visited[idx]) continue;
      visited[idx] = 1;
      const px = idx % w, py = (idx / w) | 0;
      pts.push({ x: px, y: py });
      if (px > 0     && binary[idx - 1] && !visited[idx - 1]) stack[sp++] = idx - 1;
      if (px < w - 1 && binary[idx + 1] && !visited[idx + 1]) stack[sp++] = idx + 1;
      if (py > 0     && binary[idx - w] && !visited[idx - w]) stack[sp++] = idx - w;
      if (py < h - 1 && binary[idx + w] && !visited[idx + w]) stack[sp++] = idx + w;
    }
    if (pts.length > best.length) best = pts;
  }
  return best.length > 10 ? best : null;
}

// ── Geometry ──────────────────────────────────────────────────────────────────

function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

function reduceToQuad(hull: Point[]): [Point, Point, Point, Point] | null {
  if (hull.length < 4) return null;
  const diag = Math.sqrt(
    (hull[0].x - hull[hull.length >> 1].x) ** 2 +
    (hull[0].y - hull[hull.length >> 1].y) ** 2
  );
  let eps = diag * 0.02;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = rdp(hull, eps);
    if (r.length === 4) return r as [Point, Point, Point, Point];
    eps = r.length > 4 ? eps * 1.5 : eps * 0.6;
  }
  const tl = hull.reduce((a, b) => a.x + a.y < b.x + b.y ? a : b);
  const br = hull.reduce((a, b) => a.x + a.y > b.x + b.y ? a : b);
  const tr = hull.reduce((a, b) => a.x - a.y > b.x - b.y ? a : b);
  const bl = hull.reduce((a, b) => a.x - a.y < b.x - b.y ? a : b);
  return [tl, tr, br, bl];
}

function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let maxDist = 0, maxIdx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = ptLineDist(points[i], a, b);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const L = rdp(points.slice(0, maxIdx + 1), epsilon);
    const R = rdp(points.slice(maxIdx), epsilon);
    return [...L.slice(0, -1), ...R];
  }
  return [a, b];
}

function ptLineDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

function orderQuad(q: [Point, Point, Point, Point]): [Point, Point, Point, Point] {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const sorted = [...q].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  ) as [Point, Point, Point, Point];
  let minIdx = 0;
  for (let i = 1; i < 4; i++)
    if (sorted[i].x + sorted[i].y < sorted[minIdx].x + sorted[minIdx].y) minIdx = i;
  return [sorted[minIdx], sorted[(minIdx+1)%4], sorted[(minIdx+2)%4], sorted[(minIdx+3)%4]];
}

function quadArea(q: [Point, Point, Point, Point]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return Math.abs(area) / 2;
}
