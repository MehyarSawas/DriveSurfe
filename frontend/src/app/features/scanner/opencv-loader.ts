// Lazy loader for OpenCV.js. The script (~8 MB) is only fetched the first time
// the scanner needs it, and the resolved `cv` module is cached for reuse.
// Multiple CDNs are tried in order so a single blocked host doesn't break scanning.

const OPENCV_URLS = [
  'https://docs.opencv.org/5.0/opencv.js',
  'https://docs.opencv.org/4.x/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js',
];

let loadPromise: Promise<any> | null = null;

export function loadOpenCv(): Promise<any> {
  if (loadPromise) return loadPromise;
  loadPromise = tryLoad(0);
  return loadPromise;
}

function tryLoad(index: number): Promise<any> {
  return new Promise((resolve, reject) => {
    // Already present (e.g. loaded by a previous scanner instance)
    const existing = (window as any).cv;
    if (existing && existing.Mat) {
      resolve(existing);
      return;
    }
    if (index >= OPENCV_URLS.length) {
      reject(new Error('All OpenCV.js sources failed to load'));
      return;
    }

    const script = document.createElement('script');
    script.src = OPENCV_URLS[index];
    script.async = true;

    const next = () => {
      script.remove();
      resolve(tryLoad(index + 1));
    };

    script.onload = () => {
      const cv = (window as any).cv;
      if (!cv) { next(); return; }
      // OpenCV.js finishes async WASM init; it may expose a Promise or an
      // onRuntimeInitialized callback depending on the build.
      if (cv.Mat) {
        resolve(cv);
      } else if (typeof cv.then === 'function') {
        cv.then((real: any) => resolve(real)).catch(() => next());
      } else {
        cv.onRuntimeInitialized = () => resolve(cv);
      }
    };
    script.onerror = () => next();
    document.head.appendChild(script);
  });
}
