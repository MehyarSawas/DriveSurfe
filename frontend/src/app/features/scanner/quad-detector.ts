export interface Point { x: number; y: number; }
export type Quad = [Point, Point, Point, Point];

export interface Detection {
  quad: Quad;
  score: number;
  source: string;
}

// Last error thrown inside detectDocument, surfaced in the scanner UI.
let _lastError: string | null = null;
export function lastDetectError(): string | null { return _lastError; }

/**
 * Document quad detector (jscanify-style concept), verified against real
 * photos. Pipeline:
 *   1. Downscale to ≤500px, grayscale, Gaussian blur.
 *   2. Build three candidate masks: Otsu bright-on-dark, Otsu dark-on-bright,
 *      and Canny+close (for same-brightness documents with crisp borders).
 *   3. For every contour in every mask: convex hull → corners = farthest hull
 *      point from the centroid in each quadrant. No approxPolyDP == 4
 *      requirement, so frilly/soft document edges still yield corners.
 *   4. Gate on solidity (≥0.75) and rectangularity (≥0.65) to reject spidery
 *      texture blobs, and on area (2–95%) plus frame-hugging to reject the
 *      vignette/border.
 *   5. Best score wins: rectangularity × solidity × √areaFraction.
 */
export function detectDocument(cv: any, imageData: ImageData): Detection | null {
  const scratch: any[] = [];
  const track = (m: any) => { scratch.push(m); return m; };
  try {
    const { width, height } = imageData;
    const src = track(cv.matFromImageData(imageData));
    const scale = Math.min(1, 500 / Math.max(width, height));
    const dw = Math.round(width * scale), dh = Math.round(height * scale);
    const small = track(new cv.Mat());
    cv.resize(src, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
    const gray = track(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const blur = track(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const frameArea = dw * dh;
    const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)));

    const masks: Array<[string, any]> = [];

    const otsu = track(new cv.Mat());
    cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const otsuC = track(new cv.Mat());
    cv.morphologyEx(otsu, otsuC, cv.MORPH_OPEN, kernel);
    masks.push(['otsu-bright', otsuC]);

    const otsuInv = track(new cv.Mat());
    cv.threshold(blur, otsuInv, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const otsuInvC = track(new cv.Mat());
    cv.morphologyEx(otsuInv, otsuInvC, cv.MORPH_OPEN, kernel);
    masks.push(['otsu-dark', otsuInvC]);

    const edges = track(new cv.Mat());
    cv.Canny(blur, edges, 75, 200);
    const edgesC = track(new cv.Mat());
    cv.morphologyEx(edges, edgesC, cv.MORPH_CLOSE, kernel);
    masks.push(['canny', edgesC]);

    let best: { quad: Point[]; score: number; source: string } | null = null;
    for (const [name, mask] of masks) {
      const contours = track(new cv.MatVector());
      const hier = track(new cv.Mat());
      cv.findContours(mask, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const cand = scoreContour(cv, cnt, dw, dh, frameArea);
        cnt.delete();
        if (cand && (!best || cand.score > best.score)) {
          best = { ...cand, source: name };
        }
      }
    }

    _lastError = null;
    if (!best) return null;
    const upscaled = orderQuad(best.quad).map(
      p => ({ x: p.x / scale, y: p.y / scale })
    ) as Quad;
    // Corners must always stay inside the visible frame so handles are reachable.
    const quad = clampQuad(upscaled, width, height);
    return { quad, score: best.score, source: best.source };
  } catch (e) {
    _lastError = e instanceof Error ? e.message : String(e);
    return null;
  } finally {
    for (const m of scratch) { try { m.delete(); } catch { /* freed */ } }
  }
}

function scoreContour(
  cv: any, cnt: any, dw: number, dh: number, frameArea: number
): { quad: Point[]; score: number } | null {
  const area = cv.contourArea(cnt);
  const frac = area / frameArea;
  if (frac < 0.02 || frac > 0.95) return null;

  const hull = new cv.Mat();
  cv.convexHull(cnt, hull);
  const hullArea = cv.contourArea(hull);
  const solidity = hullArea > 0 ? area / hullArea : 0;

  const rect = cv.minAreaRect(cnt);
  const rectArea = rect.size.width * rect.size.height;
  const rectangularity = rectArea > 0 ? area / rectArea : 0;

  // Corners: farthest hull point from centroid in each quadrant.
  const n = hull.rows;
  let cx = 0, cy = 0;
  const pts: Point[] = [];
  for (let r = 0; r < n; r++) {
    const x = hull.data32S[r * 2], y = hull.data32S[r * 2 + 1];
    pts.push({ x, y }); cx += x; cy += y;
  }
  hull.delete();
  cx /= n; cy /= n;
  const q: (Point | null)[] = [null, null, null, null]; // TL TR BR BL
  const d = [0, 0, 0, 0];
  for (const p of pts) {
    const dist = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    const idx = p.x < cx ? (p.y < cy ? 0 : 3) : (p.y < cy ? 1 : 2);
    if (dist > d[idx]) { d[idx] = dist; q[idx] = p; }
  }
  if (q.some(p => !p)) return null;

  // Reject anything that isn't clearly rectangle-like: furniture edges, rug
  // texture and edge spaghetti are spidery (low solidity) or skewed (low
  // rectangularity); real documents score ~0.9+ on both.
  if (solidity < 0.8 || rectangularity < 0.72) return null;

  // Reject implausible document proportions (e.g. a table edge strip).
  const [rw, rh] = [rect.size.width, rect.size.height];
  const aspect = Math.max(rw, rh) / Math.max(1, Math.min(rw, rh));
  if (aspect > 4.5) return null;

  // Reject frame-hugging quads (vignette / lighting border).
  const m = Math.min(dw, dh) * 0.02;
  const hugs =
    q.some(p => p!.x <= m) && q.some(p => p!.x >= dw - m) &&
    q.some(p => p!.y <= m) && q.some(p => p!.y >= dh - m);
  if (hugs && frac > 0.6) return null;

  const score = rectangularity * solidity * Math.sqrt(frac);
  return { quad: q as Point[], score };
}

function orderQuad(q: Point[]): Quad {
  const s = [...q].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = s[0], br = s[3];
  const [m1, m2] = [s[1], s[2]];
  const tr = m1.x > m2.x ? m1 : m2;
  const bl = m1.x > m2.x ? m2 : m1;
  return [tl, tr, br, bl];
}

/** Clamp all corners into the frame with a 3% margin so they remain visible/reachable. */
export function clampQuad(q: Quad, w: number, h: number): Quad {
  const mx = Math.round(w * 0.03), my = Math.round(h * 0.03);
  return q.map(p => ({
    x: Math.max(mx, Math.min(w - mx, Math.round(p.x))),
    y: Math.max(my, Math.min(h - my, Math.round(p.y))),
  })) as Quad;
}

/**
 * True when two quads are approximately the same (each corner within
 * `tolFrac` of the frame diagonal). Used for temporal stability in the
 * live preview.
 */
export function quadsSimilar(a: Quad, b: Quad, w: number, h: number, tolFrac = 0.05): boolean {
  const tol = Math.hypot(w, h) * tolFrac;
  return a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) <= tol);
}

/** Centered default quad (12% inset) for manual adjustment when nothing is detected. */
export function defaultQuad(w: number, h: number): Quad {
  const ix = Math.round(w * 0.12), iy = Math.round(h * 0.12);
  return [
    { x: ix, y: iy }, { x: w - ix, y: iy },
    { x: w - ix, y: h - iy }, { x: ix, y: h - iy },
  ];
}
