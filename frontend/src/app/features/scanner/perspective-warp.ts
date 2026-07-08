import { Point } from './edge-detect';

// OpenCV-based perspective warp. Uses getPerspectiveTransform + warpPerspective,
// the same primitives every professional scanner relies on. `cv` is the
// initialized OpenCV.js module.
export function perspectiveWarpCv(
  cv: any,
  src: HTMLCanvasElement,
  corners: [Point, Point, Point, Point]
): HTMLCanvasElement {
  const [tl, tr, br, bl] = corners;
  const w = Math.round(Math.max(
    Math.hypot(tr.x - tl.x, tr.y - tl.y),
    Math.hypot(br.x - bl.x, br.y - bl.y)
  ));
  const h = Math.round(Math.max(
    Math.hypot(bl.x - tl.x, bl.y - tl.y),
    Math.hypot(br.x - tr.x, br.y - tr.y)
  ));

  let srcMat: any, dstMat: any, M: any, srcTri: any, dstTri: any;
  try {
    srcMat = cv.imread(src);
    dstMat = new cv.Mat();
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(srcMat, dstMat, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    cv.imshow(out, dstMat);
    return out;
  } finally {
    srcMat?.delete(); dstMat?.delete(); M?.delete(); srcTri?.delete(); dstTri?.delete();
  }
}

export function perspectiveWarp(
  src: HTMLCanvasElement,
  corners: [Point, Point, Point, Point]
): HTMLCanvasElement {
  const [tl, tr, br, bl] = corners;
  const w = Math.round(Math.max(
    Math.hypot(tr.x - tl.x, tr.y - tl.y),
    Math.hypot(br.x - bl.x, br.y - bl.y)
  ));
  const h = Math.round(Math.max(
    Math.hypot(bl.x - tl.x, bl.y - tl.y),
    Math.hypot(br.x - tr.x, br.y - tr.y)
  ));

  const dst: [Point, Point, Point, Point] = [
    { x: 0, y: 0 }, { x: w, y: 0 },
    { x: w, y: h }, { x: 0, y: h },
  ];

  const H = computeHomography(dst, corners); // inverse: dst → src

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  const srcCtx = src.getContext('2d')!;
  const srcData = srcCtx.getImageData(0, 0, src.width, src.height);
  const outData = ctx.createImageData(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyHomography(H, x, y);
      const px = Math.round(sx), py = Math.round(sy);
      if (px >= 0 && px < src.width && py >= 0 && py < src.height) {
        const si = (py * src.width + px) * 4;
        const di = (y * w + x) * 4;
        outData.data[di]     = srcData.data[si];
        outData.data[di + 1] = srcData.data[si + 1];
        outData.data[di + 2] = srcData.data[si + 2];
        outData.data[di + 3] = 255;
      }
    }
  }
  ctx.putImageData(outData, 0, 0);
  return out;
}

function computeHomography(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point]
): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x: x1, y: y1 } = src[i];
    const { x: x2, y: y2 } = dst[i];
    A.push([x1, y1, 1, 0, 0, 0, -x2 * x1, -x2 * y1, x2]);
    A.push([0, 0, 0, x1, y1, 1, -y2 * x1, -y2 * y1, y2]);
  }
  const h = gaussianElim(A);
  return [...h, 1];
}

function gaussianElim(A: number[][]): number[] {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-10) continue;
    for (let j = col; j <= n; j++) A[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = A[row][col];
      for (let j = col; j <= n; j++) A[row][j] -= factor * A[col][j];
    }
  }
  return A.map(row => row[n]);
}

function applyHomography(H: number[], x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
