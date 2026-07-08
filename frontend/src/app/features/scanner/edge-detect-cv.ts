import { Point } from './edge-detect';

// OpenCV-based document quad detection, mirroring the classic scanner pipeline:
// grayscale → blur → Canny → dilate → findContours → approxPolyDP → largest quad.
// `cv` is the initialized OpenCV.js module (see opencv-loader.ts).
export function detectQuadCv(cv: any, imageData: ImageData): [Point, Point, Point, Point] | null {
  const { width, height } = imageData;
  let src: any, gray: any, blur: any, edges: any, dilated: any, contours: any, hierarchy: any, kernel: any;
  try {
    src = cv.matFromImageData(imageData);

    // Downscale for speed; scale corners back up at the end.
    const scale = Math.min(1, 500 / Math.max(width, height));
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);
    const small = new cv.Mat();
    cv.resize(src, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);

    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    small.delete();

    blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    edges = new cv.Mat();
    cv.Canny(blur, edges, 50, 150);

    // Close gaps so the document border is a single closed contour.
    dilated = new cv.Mat();
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, dilated, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const minArea = dw * dh * 0.15;
    let best: Point[] | null = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minArea || area <= bestArea) { cnt.delete(); continue; }

      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts: Point[] = [];
        for (let r = 0; r < 4; r++) {
          pts.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
        }
        best = pts;
        bestArea = area;
      }
      approx.delete();
      cnt.delete();
    }

    if (!best) return null;

    const ordered = orderQuad(best as [Point, Point, Point, Point]);
    return ordered.map(p => ({ x: p.x / scale, y: p.y / scale })) as [Point, Point, Point, Point];
  } catch {
    return null;
  } finally {
    src?.delete(); gray?.delete(); blur?.delete(); edges?.delete();
    dilated?.delete(); contours?.delete(); hierarchy?.delete(); kernel?.delete();
  }
}

function orderQuad(q: [Point, Point, Point, Point]): [Point, Point, Point, Point] {
  // Order as [top-left, top-right, bottom-right, bottom-left] using x±y extremes.
  const byUp = [...q].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = byUp[0], br = byUp[3];
  const rest = [byUp[1], byUp[2]];
  const tr = rest[0].x > rest[1].x ? rest[0] : rest[1];
  const bl = rest[0].x > rest[1].x ? rest[1] : rest[0];
  return [tl, tr, br, bl];
}
