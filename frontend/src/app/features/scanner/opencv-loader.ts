// Lazy loader for OpenCV.js. The script (~8 MB) is only fetched the first time
// the scanner needs it, and the resolved `cv` module is cached for reuse.

const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';

let loadPromise: Promise<any> | null = null;

export function loadOpenCv(): Promise<any> {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    // Already present (e.g. loaded by a previous scanner instance)
    const existing = (window as any).cv;
    if (existing && existing.Mat) {
      resolve(existing);
      return;
    }

    const script = document.createElement('script');
    script.src = OPENCV_URL;
    script.async = true;
    script.onload = () => {
      const cv = (window as any).cv;
      if (!cv) {
        reject(new Error('OpenCV.js loaded but cv is undefined'));
        return;
      }
      // OpenCV.js finishes async WASM init; it may expose a Promise or
      // an onRuntimeInitialized callback depending on the build.
      if (typeof cv.then === 'function') {
        cv.then((real: any) => resolve(real)).catch(reject);
      } else if (cv.Mat) {
        resolve(cv);
      } else {
        cv.onRuntimeInitialized = () => resolve(cv);
      }
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    document.head.appendChild(script);
  });

  return loadPromise;
}
