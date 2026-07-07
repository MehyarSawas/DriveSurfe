export interface Point { x: number; y: number; }

export function detectQuad(imageData: ImageData): [Point, Point, Point, Point] {
  const { data, width, height } = imageData;
  const def = makeDefault(width, height);
  try {
    // Work at 480 px — larger than before for better contour accuracy
    const scale = Math.min(1, 480 / Math.max(width, height));
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);

    const gray = downsampleGray(data, width, height, dw, dh);
    const blurred = gaussianBlur(gray, dw, dh);

    // Canny: Sobel → NMS → hysteresis
    const { mag, ang } = sobelGradient(blurred, dw, dh);
    const nms = nonMaxSuppress(mag, ang, dw, dh);
    const edges = hysteresisCanny(nms, dw, dh);

    // Find the edge component whose convex hull is the best quad
    const quad = findDocumentQuad(edges, dw, dh, scale, width, height);
    return quad ?? def;
  } catch {
    return def;
  }
}

// ── Canny pipeline ────────────────────────────────────────────────────────────

function sobelGradient(
  gray: Float32Array, w: number, h: number
): { mag: Float32Array; ang: Float32Array } {
  const mag = new Float32Array(w * h);
  const ang = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = gray[(y-1)*w+(x-1)], tc = gray[(y-1)*w+x], tr = gray[(y-1)*w+(x+1)];
      const ml = gray[y*w+(x-1)],                             mr = gray[y*w+(x+1)];
      const bl = gray[(y+1)*w+(x-1)], bc = gray[(y+1)*w+x],  br = gray[(y+1)*w+(x+1)];
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      const idx = y * w + x;
      mag[idx] = Math.sqrt(gx*gx + gy*gy);
      ang[idx] = Math.atan2(gy, gx);
    }
  }
  return { mag, ang };
}

function nonMaxSuppress(mag: Float32Array, ang: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const m = mag[idx];
      if (m === 0) continue;

      // Quantize angle to 4 directions (0°/45°/90°/135°)
      const deg = (((ang[idx] * 180 / Math.PI) % 180) + 180) % 180;
      let n1: number, n2: number;
      if (deg < 22.5 || deg >= 157.5) {
        n1 = mag[idx - 1]; n2 = mag[idx + 1];
      } else if (deg < 67.5) {
        n1 = mag[(y-1)*w+(x+1)]; n2 = mag[(y+1)*w+(x-1)];
      } else if (deg < 112.5) {
        n1 = mag[(y-1)*w+x];    n2 = mag[(y+1)*w+x];
      } else {
        n1 = mag[(y-1)*w+(x-1)]; n2 = mag[(y+1)*w+(x+1)];
      }

      if (m >= n1 && m >= n2) out[idx] = m;
    }
  }
  return out;
}

function hysteresisCanny(nms: Float32Array, w: number, h: number): Uint8Array {
  // Auto-threshold: bucket the non-zero magnitudes, use 75th percentile as high
  let maxG = 0, nonZeroCount = 0;
  for (let i = 0; i < nms.length; i++) {
    if (nms[i] > 0) { nonZeroCount++; if (nms[i] > maxG) maxG = nms[i]; }
  }
  if (maxG === 0) return new Uint8Array(w * h);

  const bins = 200;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < nms.length; i++) {
    if (nms[i] > 0) hist[Math.min(bins - 1, Math.floor(nms[i] / maxG * bins))]++;
  }
  let cumul = 0;
  const target = nonZeroCount * 0.75;
  let highBin = bins - 1;
  for (let b = 0; b < bins; b++) {
    cumul += hist[b];
    if (cumul >= target) { highBin = b; break; }
  }
  const highThresh = (highBin / bins) * maxG;
  const lowThresh  = highThresh * 0.35;

  // Mark strong (2) and weak (1) candidates
  const mark = new Uint8Array(w * h);
  for (let i = 0; i < nms.length; i++) {
    if      (nms[i] >= highThresh) mark[i] = 2;
    else if (nms[i] >= lowThresh)  mark[i] = 1;
  }

  // BFS from strong pixels — accept weak neighbours
  const result = new Uint8Array(w * h);
  const stack  = new Int32Array(w * h);
  let sp = 0;
  for (let i = 0; i < mark.length; i++) {
    if (mark[i] === 2) { result[i] = 1; stack[sp++] = i; }
  }
  while (sp > 0) {
    const idx = stack[--sp];
    const px = idx % w, py = (idx / w) | 0;
    const nbrs = [idx-1, idx+1, idx-w, idx+w, idx-w-1, idx-w+1, idx+w-1, idx+w+1];
    for (const n of nbrs) {
      if (n < 0 || n >= w * h) continue;
      const nx = n % w;
      // skip wrap-around pixels
      if (Math.abs(nx - px) > 1) continue;
      if (mark[n] >= 1 && !result[n]) { result[n] = 1; stack[sp++] = n; }
    }
  }
  return result;
}

// ── Contour → quad ────────────────────────────────────────────────────────────

function findDocumentQuad(
  edges: Uint8Array, dw: number, dh: number,
  scale: number, origW: number, origH: number
): [Point, Point, Point, Point] | null {
  const visited = new Uint8Array(dw * dh);
  const stack   = new Int32Array(dw * dh);
  let bestQuad: [Point, Point, Point, Point] | null = null;
  let bestArea = dw * dh * 0.04; // minimum 4 % of image area

  for (let start = 0; start < dw * dh; start++) {
    if (!edges[start] || visited[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    const pts: Point[] = [];

    while (sp > 0) {
      const idx = stack[--sp];
      if (visited[idx]) continue;
      visited[idx] = 1;
      const x = idx % dw, y = (idx / dw) | 0;
      pts.push({ x, y });
      if (x > 0      && edges[idx - 1]  && !visited[idx - 1])  stack[sp++] = idx - 1;
      if (x < dw - 1 && edges[idx + 1]  && !visited[idx + 1])  stack[sp++] = idx + 1;
      if (y > 0      && edges[idx - dw] && !visited[idx - dw]) stack[sp++] = idx - dw;
      if (y < dh - 1 && edges[idx + dw] && !visited[idx + dw]) stack[sp++] = idx + dw;
    }

    if (pts.length < 20) continue;

    const hull = convexHull(pts);
    if (hull.length < 4) continue;

    const quad = reduceToQuad(hull);
    if (!quad) continue;

    const area = quadArea(quad);
    // Accept quads that cover 4%–93% of the image
    if (area > bestArea && area < dw * dh * 0.93) {
      bestArea = area;
      bestQuad = quad;
    }
  }

  if (!bestQuad) return null;

  const ordered  = orderQuad(bestQuad);
  // Scale corners from downsampled → original pixel space
  const upscaled = ordered.map(p => ({ x: p.x / scale, y: p.y / scale })) as [Point, Point, Point, Point];
  return clampAndInset(upscaled, 4, origW, origH);
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

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
      const i  = (sy * sw + sx) * 4;
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
  for (let attempt = 0; attempt < 6; attempt++) {
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
