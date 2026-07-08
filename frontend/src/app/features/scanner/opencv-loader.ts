// Lazy loader for OpenCV.js. The script (~8 MB) is only fetched the first time
// the scanner needs it, and the resolved `cv` module is cached for reuse.
// Handles the three OpenCV.js build shapes:
//   1. MODULARIZE factory   — window.cv is a function returning a Promise (5.0+)
//   2. Emscripten thenable  — window.cv is a Promise
//   3. Classic global       — window.cv object, ready via onRuntimeInitialized
// with polling + per-URL timeout so a stalled init moves on instead of hanging.

const OPENCV_URLS = [
  // Self-hosted (same origin) — no CDN dependency, cached by the service worker
  'assets/opencv/opencv.js',
  // Remote fallbacks in case the local asset is missing
  'https://docs.opencv.org/5.0/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js',
];

const PER_URL_TIMEOUT = 30000; // allow slow 8 MB download + WASM init

let loadPromise: Promise<any> | null = null;

export function loadOpenCv(): Promise<any> {
  if (loadPromise) return loadPromise;
  loadPromise = tryLoad(0);
  return loadPromise;
}

function ready(cv: any): boolean {
  return !!cv && typeof cv === 'object' && typeof cv.Mat === 'function';
}

function tryLoad(index: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const existing = (window as any).cv;
    if (ready(existing)) { resolve(existing); return; }
    if (index >= OPENCV_URLS.length) {
      reject(new Error('All OpenCV.js sources failed to load'));
      return;
    }

    let settled = false;
    const finish = (cv: any) => {
      if (settled) return;
      settled = true;
      (window as any).cv = cv;
      resolve(cv);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      script.remove();
      resolve(tryLoad(index + 1)); // move to next source
    };

    const script = document.createElement('script');
    script.src = OPENCV_URLS[index];
    script.async = true;

    // Poll for readiness — the ultimate fallback that works regardless of
    // whether onRuntimeInitialized fired before we could attach it.
    const started = Date.now();
    const poll = setInterval(() => {
      if (settled) { clearInterval(poll); return; }
      if (ready((window as any).cv)) {
        clearInterval(poll);
        finish((window as any).cv);
      } else if (Date.now() - started > PER_URL_TIMEOUT) {
        clearInterval(poll);
        fail();
      }
    }, 150);

    script.onload = async () => {
      let cv = (window as any).cv;
      if (!cv) return; // poll/timeout will handle
      try {
        if (typeof cv === 'function') {
          // MODULARIZE factory: calling it returns a Promise for the module
          cv = await cv();
        } else if (typeof cv.then === 'function') {
          cv = await cv;
        } else if (!ready(cv) && typeof cv === 'object') {
          // Classic build: resolve when the WASM runtime initializes
          cv.onRuntimeInitialized = () => finish(cv);
        }
        if (ready(cv)) finish(cv);
      } catch {
        // leave it to the poll/timeout, which will advance to the next source
      }
    };
    script.onerror = () => { clearInterval(poll); fail(); };

    document.head.appendChild(script);
  });
}
