// Lazy loader for OpenCV.js. The script (~11 MB) is only fetched the first time
// the scanner needs it, and the resolved `cv` module is cached for reuse.
// Handles the three OpenCV.js build shapes:
//   1. MODULARIZE factory   — window.cv is a function returning a Promise (5.0+)
//   2. Emscripten thenable  — window.cv is a Promise (self-hosted UMD build)
//   3. Classic global       — window.cv object, ready via onRuntimeInitialized
// with polling + a timeout so a stalled init fails cleanly instead of hanging.
//
// Self-hosted only — deliberately no remote CDN fallback. A CDN script loaded
// without SRI would run with full same-origin privilege (session cookie is
// HttpOnly so it can't be read directly, but injected JS could still call the
// API as the logged-in user). The CSP's script-src is locked to 'self' to
// match; if you ever need a remote fallback, add SRI (integrity+crossorigin)
// and widen the CSP script-src for that exact host at the same time.
const OPENCV_URLS = [
  'assets/opencv/opencv.js',
];

const PER_URL_TIMEOUT = 40000; // allow slow 11 MB download + WASM init

let loadPromise: Promise<any> | null = null;

// Human-readable progress, surfaced in the scanner UI for diagnosis.
export type StatusFn = (msg: string) => void;
let statusFn: StatusFn = () => {};
export function onOpenCvStatus(fn: StatusFn): void { statusFn = fn; }

export function loadOpenCv(): Promise<any> {
  if (loadPromise) return loadPromise;
  loadPromise = tryLoad(0);
  return loadPromise;
}

function ready(cv: any): boolean {
  return !!cv && typeof cv === 'object' && typeof cv.Mat === 'function';
}

function shortSrc(url: string): string {
  return url.startsWith('http') ? new URL(url).host : url;
}

function tryLoad(index: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const existing = (window as any).cv;
    if (ready(existing)) { statusFn('ready'); resolve(existing); return; }
    if (index >= OPENCV_URLS.length) {
      statusFn('all sources failed');
      reject(new Error('All OpenCV.js sources failed to load'));
      return;
    }

    const url = OPENCV_URLS[index];
    statusFn(`downloading (${shortSrc(url)})`);

    let settled = false;
    const finish = (cv: any) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      (window as any).cv = cv;
      statusFn('ready');
      resolve(cv);
    };
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      script.remove();
      statusFn(`${shortSrc(url)} ${why}; trying next`);
      resolve(tryLoad(index + 1)); // move to next source
    };

    const script = document.createElement('script');
    script.src = url;
    script.async = true;

    // Poll for readiness — the ultimate fallback that works regardless of
    // whether onRuntimeInitialized fired before we could attach it.
    const started = Date.now();
    const poll = setInterval(() => {
      if (settled) { clearInterval(poll); return; }
      if (ready((window as any).cv)) {
        finish((window as any).cv);
      } else if (Date.now() - started > PER_URL_TIMEOUT) {
        fail('timed out');
      }
    }, 150);

    script.onload = async () => {
      let cv = (window as any).cv;
      if (!cv) return; // poll/timeout will handle
      statusFn('initializing WASM…');
      try {
        if (typeof cv === 'function') {
          cv = await cv();               // MODULARIZE factory → Promise
        } else if (typeof cv.then === 'function') {
          cv = await cv;                 // Emscripten thenable
        } else if (!ready(cv)) {
          cv.onRuntimeInitialized = () => finish(cv); // classic global
        }
        if (ready(cv)) finish(cv);
      } catch (e) {
        fail('init error');
      }
    };
    script.onerror = () => fail('load error');

    document.head.appendChild(script);
  });
}
