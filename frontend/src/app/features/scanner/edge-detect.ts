export interface Point { x: number; y: number; }

export function detectQuad(imageData: ImageData): [Point, Point, Point, Point] {
  const { data, width, height } = imageData;
  const defaultQuad = makeDefault(width, height);

  try {
    // Downsample to max 640px for speed and noise reduction
    const scale = Math.min(1, 640 / Math.max(width, height));
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);

    const gray = downsampleGray(data, width, height, dw, dh);
    const blurred = gaussianBlur(gray, dw, dh);
    const edges = sobel(blurred, dw, dh);

    // Otsu's method on edge magnitudes for adaptive threshold
    const t = otsuThreshold(edges);
    const binary = new Uint8Array(dw * dh);
    for (let i = 0; i < edges.length; i++) binary[i] = edges[i] > t ? 1 : 0;

    // Dilate to connect nearby edge pixels
    const dilated = dilate(binary, dw, dh, 2);

    // Find largest connected region
    const region = findLargestContour(dilated, dw, dh);
    if (!region || region.length < 50) return defaultQuad;

    const hull = convexHull(region);
    if (hull.length < 4) return defaultQuad;

    const quad = reduceToQuad(hull);
    if (!quad) return defaultQuad;

    const ordered = orderQuad(quad);

    // Reject if quad area < 5% of image (too small to be a document)
    if (quadArea(ordered) < dw * dh * 0.05) return defaultQuad;

    // Scale back to original image coordinates
    return ordered.map(p => ({
      x: Math.round(p.x / scale),
      y: Math.round(p.y / scale),
    })) as [Point, Point, Point, Point];
  } catch {
    return defaultQuad;
  }
}

function makeDefault(w: number, h: number): [Point, Point, Point, Point] {
  const i = 10;
  return [{ x: i, y: i }, { x: w - i, y: i }, { x: w - i, y: h - i }, { x: i, y: h - i }];
}

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
  const kernel = [1, 4, 7, 4, 1, 4, 16, 26, 16, 4, 7, 26, 41, 26, 7, 4, 16, 26, 16, 4, 1, 4, 7, 4, 1];
  const ksum = 273;
  const out = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let v = 0;
      for (let ky = -2; ky <= 2; ky++)
        for (let kx = -2; kx <= 2; kx++)
          v += src[(y + ky) * w + (x + kx)] * kernel[(ky + 2) * 5 + (kx + 2)];
      out[y * w + x] = v / ksum;
    }
  }
  return out;
}

function sobel(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -src[(y - 1) * w + (x - 1)] + src[(y - 1) * w + (x + 1)] +
        -2 * src[y * w + (x - 1)] + 2 * src[y * w + (x + 1)] +
        -src[(y + 1) * w + (x - 1)] + src[(y + 1) * w + (x + 1)];
      const gy =
        -src[(y - 1) * w + (x - 1)] - 2 * src[(y - 1) * w + x] - src[(y - 1) * w + (x + 1)] +
        src[(y + 1) * w + (x - 1)] + 2 * src[(y + 1) * w + x] + src[(y + 1) * w + (x + 1)];
      out[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

function otsuThreshold(edges: Float32Array): number {
  let max = 0;
  for (let i = 0; i < edges.length; i++) if (edges[i] > max) max = edges[i];
  if (max < 1) return 1;

  const bins = 256;
  const n = edges.length;
  const hist = new Float64Array(bins);
  for (let i = 0; i < n; i++) hist[Math.min(bins - 1, (edges[i] / max * bins) | 0)]++;

  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, bestVar = 0, bestT = 0;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > bestVar) { bestVar = v; bestT = t; }
  }

  // At least 20% of max to avoid very low thresholds on low-contrast images
  return Math.max(max * 0.2, (bestT / bins) * max);
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      outer:
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && src[ny * w + nx]) {
            out[y * w + x] = 1;
            break outer;
          }
        }
      }
    }
  }
  return out;
}

function findLargestContour(thresh: Uint8Array, w: number, h: number): Point[] | null {
  const visited = new Uint8Array(w * h);
  let best: Point[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!thresh[i] || visited[i]) continue;
      const pts: Point[] = [];
      const stack = [i];
      while (stack.length) {
        const idx = stack.pop()!;
        if (visited[idx]) continue;
        visited[idx] = 1;
        const px = idx % w, py = (idx / w) | 0;
        pts.push({ x: px, y: py });
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const ni = ny * w + nx;
            if (thresh[ni] && !visited[ni]) stack.push(ni);
          }
        }
      }
      if (pts.length > best.length) best = pts;
    }
  }
  return best.length > 50 ? best : null;
}

function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

function reduceToQuad(hull: Point[]): [Point, Point, Point, Point] | null {
  if (hull.length < 4) return null;
  // Try RDP first
  const diag = Math.sqrt(
    (hull[0].x - hull[hull.length >> 1].x) ** 2 +
    (hull[0].y - hull[hull.length >> 1].y) ** 2
  );
  const eps = diag * 0.03;
  const reduced = rdp(hull, eps);
  if (reduced.length === 4) return reduced as [Point, Point, Point, Point];
  // Fall back to 4 extreme corners
  const pts = reduced.length >= 4 ? reduced : hull;
  const tl = pts.reduce((a, b) => a.x + a.y < b.x + b.y ? a : b);
  const br = pts.reduce((a, b) => a.x + a.y > b.x + b.y ? a : b);
  const tr = pts.reduce((a, b) => a.x - a.y > b.x - b.y ? a : b);
  const bl = pts.reduce((a, b) => a.x - a.y < b.x - b.y ? a : b);
  return [tl, tr, br, bl];
}

function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let maxDist = 0, maxIdx = 0;
  const start = points[0], end = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDistance(points[i], start, end);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, maxIdx + 1), epsilon);
    const right = rdp(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

function pointToLineDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

function orderQuad(q: [Point, Point, Point, Point]): [Point, Point, Point, Point] {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const sorted = [...q].sort((a, b) =>
    Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  ) as [Point, Point, Point, Point];
  let minIdx = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[minIdx].x + sorted[minIdx].y) minIdx = i;
  }
  return [sorted[minIdx], sorted[(minIdx + 1) % 4], sorted[(minIdx + 2) % 4], sorted[(minIdx + 3) % 4]];
}

function quadArea(q: [Point, Point, Point, Point]): number {
  // Shoelace formula
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return Math.abs(area) / 2;
}
