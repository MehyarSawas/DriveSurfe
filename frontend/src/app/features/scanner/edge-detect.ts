export interface Point { x: number; y: number; }

export function detectQuad(imageData: ImageData): [Point, Point, Point, Point] {
  const { data, width, height } = imageData;
  const def = makeDefault(width, height);
  try {
    // Work at 480 px
    const scale = Math.min(1, 480 / Math.max(width, height));
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);

    const gray    = downsampleGray(data, width, height, dw, dh);
    const blurred = gaussianBlur(gray, dw, dh);
    const mag     = sobelMagnitude(blurred, dw, dh);

    // Threshold gradient: keep pixels above 15% of max magnitude
    let maxMag = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];
    if (maxMag === 0) return def;

    const thresh = maxMag * 0.15;
    const binary = new Uint8Array(dw * dh);
    for (let i = 0; i < mag.length; i++) binary[i] = mag[i] >= thresh ? 1 : 0;

    // Dilate 3px to connect nearby edge pixels
    const dilated = dilate(binary, dw, dh, 3);

    // Find connected components; pick the one whose convex hull best fits a quad
    const quad = findDocumentQuad(dilated, dw, dh, scale, width, height);
    return quad ?? def;
  } catch {
    return def;
  }
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
  const K = [1,4,7,4,1, 4,16,26,16,4, 7,26,41,26,7, 4,16,26,16,4, 1,4,7,4,1];
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
      const bl = gray[(y+1)*w+(x-1)], bc = gray[(y+1)*w+x],  br = gray[(y+1)*w+(x+1)];
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      out[y * w + x] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return out;
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      outer: for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (src[(y+dy)*w+(x+dx)]) { out[y*w+x] = 1; break outer; }
    }
  }
  return out;
}

// ── Connected components → quad ───────────────────────────────────────────────

function findDocumentQuad(
  binary: Uint8Array, dw: number, dh: number,
  scale: number, origW: number, origH: number
): [Point, Point, Point, Point] | null {
  const visited = new Uint8Array(dw * dh);
  const stack   = new Int32Array(dw * dh);
  let bestQuad: [Point, Point, Point, Point] | null = null;
  let bestArea = dw * dh * 0.04; // minimum 4% of image area

  for (let start = 0; start < dw * dh; start++) {
    if (!binary[start] || visited[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    const pts: Point[] = [];

    while (sp > 0) {
      const idx = stack[--sp];
      if (visited[idx]) continue;
      visited[idx] = 1;
      const x = idx % dw, y = (idx / dw) | 0;
      pts.push({ x, y });
      if (x > 0      && binary[idx-1]  && !visited[idx-1])  stack[sp++] = idx-1;
      if (x < dw-1   && binary[idx+1]  && !visited[idx+1])  stack[sp++] = idx+1;
      if (y > 0      && binary[idx-dw] && !visited[idx-dw]) stack[sp++] = idx-dw;
      if (y < dh-1   && binary[idx+dw] && !visited[idx+dw]) stack[sp++] = idx+dw;
    }

    if (pts.length < 50) continue;

    const hull = convexHull(pts);
    if (hull.length < 4) continue;

    const quad = reduceToQuad(hull);
    if (!quad) continue;

    const area = quadArea(quad);
    if (area > bestArea && area < dw * dh * 0.98) {
      bestArea = area;
      bestQuad = quad;
    }
  }

  if (!bestQuad) return null;

  const ordered  = orderQuad(bestQuad);
  const upscaled = ordered.map(p => ({ x: p.x / scale, y: p.y / scale })) as [Point, Point, Point, Point];
  return clampAndInset(upscaled, 16, origW, origH);
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function makeDefault(w: number, h: number): [Point, Point, Point, Point] {
  const i = Math.round(Math.min(w, h) * 0.06);
  return [{ x: i, y: i }, { x: w-i, y: i }, { x: w-i, y: h-i }, { x: i, y: h-i }];
}

function clampAndInset(
  q: [Point, Point, Point, Point], inset: number, w: number, h: number
): [Point, Point, Point, Point] {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  // inset slightly toward centre, then clamp to image bounds with margin for handle radius
  const margin = Math.round(Math.min(w, h) * 0.05);
  return q.map(p => ({
    x: Math.max(margin, Math.min(w - margin, Math.round(p.x + (p.x < cx ? inset : -inset)))),
    y: Math.max(margin, Math.min(h - margin, Math.round(p.y + (p.y < cy ? inset : -inset)))),
  })) as [Point, Point, Point, Point];
}

function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x-o.x)*(b.y-o.y) - (a.y-o.y)*(b.x-o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length-1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

function reduceToQuad(hull: Point[]): [Point, Point, Point, Point] | null {
  if (hull.length < 4) return null;
  const diag = Math.sqrt(
    (hull[0].x - hull[hull.length>>1].x)**2 +
    (hull[0].y - hull[hull.length>>1].y)**2
  );
  let eps = diag * 0.02;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = rdp(hull, eps);
    if (r.length === 4) return r as [Point, Point, Point, Point];
    eps = r.length > 4 ? eps * 1.4 : eps * 0.7;
  }
  // fallback: pick 4 extreme corners
  const tl = hull.reduce((a,b) => a.x+a.y < b.x+b.y ? a : b);
  const br = hull.reduce((a,b) => a.x+a.y > b.x+b.y ? a : b);
  const tr = hull.reduce((a,b) => a.x-a.y > b.x-b.y ? a : b);
  const bl = hull.reduce((a,b) => a.x-a.y < b.x-b.y ? a : b);
  return [tl, tr, br, bl];
}

function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let maxDist = 0, maxIdx = 0;
  const a = points[0], b = points[points.length-1];
  for (let i = 1; i < points.length-1; i++) {
    const d = ptLineDist(points[i], a, b);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const L = rdp(points.slice(0, maxIdx+1), epsilon);
    const R = rdp(points.slice(maxIdx), epsilon);
    return [...L.slice(0,-1), ...R];
  }
  return [a, b];
}

function ptLineDist(p: Point, a: Point, b: Point): number {
  const dx = b.x-a.x, dy = b.y-a.y;
  const len = Math.sqrt(dx*dx+dy*dy);
  if (len === 0) return Math.sqrt((p.x-a.x)**2+(p.y-a.y)**2);
  return Math.abs(dx*(a.y-p.y)-(a.x-p.x)*dy)/len;
}

function orderQuad(q: [Point,Point,Point,Point]): [Point,Point,Point,Point] {
  const cx = (q[0].x+q[1].x+q[2].x+q[3].x)/4;
  const cy = (q[0].y+q[1].y+q[2].y+q[3].y)/4;
  const sorted = [...q].sort(
    (a,b) => Math.atan2(a.y-cy, a.x-cx) - Math.atan2(b.y-cy, b.x-cx)
  ) as [Point,Point,Point,Point];
  let minIdx = 0;
  for (let i = 1; i < 4; i++)
    if (sorted[i].x+sorted[i].y < sorted[minIdx].x+sorted[minIdx].y) minIdx = i;
  return [sorted[minIdx], sorted[(minIdx+1)%4], sorted[(minIdx+2)%4], sorted[(minIdx+3)%4]];
}

function quadArea(q: [Point,Point,Point,Point]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i+1)%4;
    area += q[i].x*q[j].y - q[j].x*q[i].y;
  }
  return Math.abs(area)/2;
}
