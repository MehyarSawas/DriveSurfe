import { Point } from './edge-detect';

// OpenCV-based document quad detection. Runs two strategies and keeps the best
// candidate quad:
//   A) Edge-based  — Canny → dilate → contours (good for documents on plain,
//      similar-brightness backgrounds where there's a crisp border).
//   B) Brightness  — Otsu threshold → contours (good for a bright document on a
//      darker/textured background, e.g. paper or tissue on a rug or table).
// Each candidate contour is reduced to 4 corners with an adaptive approxPolyDP,
// falling back to minAreaRect so frilly/soft edges don't disqualify it.
// `cv` is the initialized OpenCV.js module (see opencv-loader.ts).
export function detectQuadCv(cv: any, imageData: ImageData): [Point, Point, Point, Point] | null {
  let src: any, small: any, gray: any, blur: any;
  const scratch: any[] = [];
  try {
    src = cv.matFromImageData(imageData);

    const { width, height } = imageData;
    const scale = Math.min(1, 500 / Math.max(width, height));
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);

    small = new cv.Mat();
    cv.resize(src, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const frameArea = dw * dh;
    const minArea = frameArea * 0.04;
    const maxArea = frameArea * 0.95;
    let best: Point[] | null = null;
    let bestArea = 0;

    // Build two binary masks: edges (A) and bright-region (B).
    const masks: any[] = [];

    const edges = new cv.Mat(); scratch.push(edges);
    cv.Canny(blur, edges, 40, 120);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)); scratch.push(k);
    const edgesD = new cv.Mat(); scratch.push(edgesD);
    cv.dilate(edges, edgesD, k);
    masks.push(edgesD);

    const thr = new cv.Mat(); scratch.push(thr);
    cv.threshold(blur, thr, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const thrC = new cv.Mat(); scratch.push(thrC);
    cv.morphologyEx(thr, thrC, cv.MORPH_CLOSE, k);
    masks.push(thrC);

    for (const mask of masks) {
      const contours = new cv.MatVector(); scratch.push(contours);
      const hier = new cv.Mat(); scratch.push(hier);
      cv.findContours(mask, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area < minArea || area > maxArea) { cnt.delete(); continue; }

        const quad = contourToQuad(cv, cnt, scratch);
        cnt.delete();
        if (!quad) continue;

        const qArea = polyArea(quad);
        if (qArea < minArea || qArea > maxArea) continue;
        if (hugsAllBorders(quad, dw, dh) && qArea > frameArea * 0.6) continue;
        // Prefer the largest plausible quad.
        if (qArea > bestArea) { bestArea = qArea; best = quad; }
      }
    }

    if (!best) return null;
    const ordered = orderQuad(best as [Point, Point, Point, Point]);
    return ordered.map(p => ({ x: p.x / scale, y: p.y / scale })) as [Point, Point, Point, Point];
  } catch {
    return null;
  } finally {
    src?.delete(); small?.delete(); gray?.delete(); blur?.delete();
    for (const m of scratch) { try { m.delete(); } catch { /* already freed */ } }
  }
}

// Reduce a contour to 4 corners: adaptive approxPolyDP, else minAreaRect.
function contourToQuad(cv: any, cnt: any, scratch: any[]): Point[] | null {
  const peri = cv.arcLength(cnt, true);
  for (const f of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, f * peri, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const pts: Point[] = [];
      for (let r = 0; r < 4; r++) pts.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
      approx.delete();
      return pts;
    }
    approx.delete();
  }
  // Fallback: rotated bounding rect always yields 4 corners.
  const rect = cv.minAreaRect(cnt);
  const box = cv.RotatedRect.points(rect);
  return box.map((p: any) => ({ x: p.x, y: p.y }));
}

function polyArea(q: Point[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const j = (i + 1) % q.length;
    a += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return Math.abs(a) / 2;
}

function hugsAllBorders(q: Point[], w: number, h: number): boolean {
  const m = Math.min(w, h) * 0.02;
  return q.some(p => p.x <= m) && q.some(p => p.x >= w - m) &&
         q.some(p => p.y <= m) && q.some(p => p.y >= h - m);
}

function orderQuad(q: [Point, Point, Point, Point]): [Point, Point, Point, Point] {
  const byUp = [...q].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = byUp[0], br = byUp[3];
  const rest = [byUp[1], byUp[2]];
  const tr = rest[0].x > rest[1].x ? rest[0] : rest[1];
  const bl = rest[0].x > rest[1].x ? rest[1] : rest[0];
  return [tl, tr, br, bl];
}
