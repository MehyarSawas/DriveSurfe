import {
  Component, input, output, signal, computed,
  ElementRef, ViewChild, NgZone, OnDestroy, AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../core/services/file.service';
import { DriveFile } from '../../core/models/drive-file.model';
import { Point, Quad, detectDocument, defaultQuad, lastDetectError } from './quad-detector';
import { perspectiveWarp, perspectiveWarpCv } from './perspective-warp';
import { loadOpenCv, onOpenCvStatus } from './opencv-loader';
import { PDFDocument } from 'pdf-lib';

type Phase = 'camera' | 'review' | 'crop' | 'format' | 'uploading';
type Enhance = 'original' | 'color' | 'grayscale' | 'bw';

/** Separable box blur (2 passes ≈ Gaussian), used to estimate the illumination map. */
function boxBlur2(src: Float32Array, w: number, h: number, r: number): Float32Array {
  let a = src.slice();
  const tmp = new Float32Array(a.length);
  const win = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / win;
        sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

/**
 * Google-Drive-style document enhancement via ILLUMINATION FLATTENING:
 * estimate the lighting map (heavy blur of luminance) and divide it out, so
 * shadows/gradients disappear and the paper reads as uniform white while ink
 * and colors survive (all channels of a pixel are scaled equally → hue and
 * saturation are preserved; a simple global histogram stretch cannot do this
 * under uneven lighting). User brightness/contrast apply on top (identity at
 * 100/100). Used for BOTH the review preview (downscaled) and the final bake.
 */
function enhanceImageData(img: ImageData, brightness: number, contrast: number, enhance: Enhance): void {
  const { data, width: w, height: h } = img;
  const n = w * h;

  // 'original': no illumination flattening, no saturation/grayscale — only
  // the user's brightness/contrast sliders apply (identity at 100/100).
  if (enhance === 'original') {
    if (brightness === 100 && contrast === 100) return;
    const b0 = brightness / 100, c0 = contrast / 100;
    for (let p = 0; p < data.length; p += 4) {
      for (let k = 0; k < 3; k++) {
        const v = (data[p + k] * b0 - 128) * c0 + 128;
        data[p + k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return;
  }

  // LOCAL per-channel illumination maps: each channel is flattened by its own
  // blurred background, which white-balances locally — the paper becomes
  // neutral white even when the cast varies across the page or the crop
  // includes non-paper margins (a global white-point estimate fails there).
  // The cast ratio is clamped so genuinely colored documents (ID cards,
  // colored paper) are not washed out to white.
  const chR = new Float32Array(n), chG = new Float32Array(n), chB = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    chR[i] = data[p]; chG[i] = data[p + 1]; chB[i] = data[p + 2];
  }
  const radius = Math.max(8, Math.round(Math.max(w, h) / 16));
  const bgR = boxBlur2(chR, w, h, radius);
  const bgG = boxBlur2(chG, w, h, radius);
  const bgB = boxBlur2(chB, w, h, radius);

  const b = brightness / 100;
  const c = (enhance === 'bw' ? Math.max(contrast, 160) : contrast) / 100;
  const sat = enhance === 'color' ? 1.15 : 0;
  const CAST_MAX = 1.4, CAST_MIN = 1 / 1.4;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Local illumination per channel; paper maps to ~245 neutral.
    const bgLuma = Math.max(40, 0.299 * bgR[i] + 0.587 * bgG[i] + 0.114 * bgB[i]);
    const castR = Math.min(CAST_MAX, Math.max(CAST_MIN, bgR[i] / bgLuma));
    const castG = Math.min(CAST_MAX, Math.max(CAST_MIN, bgG[i] / bgLuma));
    const castB = Math.min(CAST_MAX, Math.max(CAST_MIN, bgB[i] / bgLuma));
    let r  = (data[p]     * 245) / (bgLuma * castR);
    let g  = (data[p + 1] * 245) / (bgLuma * castG);
    let bl = (data[p + 2] * 245) / (bgLuma * castB);

    const luma = 0.299 * r + 0.587 * g + 0.114 * bl;
    if (enhance === 'grayscale' || enhance === 'bw') {
      r = g = bl = luma;
    } else {
      r  = luma + (r  - luma) * sat;
      g  = luma + (g  - luma) * sat;
      bl = luma + (bl - luma) * sat;
    }

    r  = (r  * b - 128) * c + 128;
    g  = (g  * b - 128) * c + 128;
    bl = (bl * b - 128) * c + 128;
    data[p]     = r  < 0 ? 0 : r  > 255 ? 255 : r;
    data[p + 1] = g  < 0 ? 0 : g  > 255 ? 255 : g;
    data[p + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl;
  }
}

/**
 * A captured page keeps its ORIGINAL photo, crop corners, and filter settings
 * so everything stays editable until upload — pixels are only baked in
 * upload(). warpedDataUrl is the auto-cropped (perspective-corrected) image
 * shown in review; filters are previewed on it via CSS and applied for real
 * at bake time.
 */
interface ScanPage {
  srcDataUrl: string;
  srcW: number;
  srcH: number;
  corners: Quad;
  warpedDataUrl: string;
  /** Downscaled warped image with the REAL pixel enhancement applied — what review shows. */
  previewUrl: string;
  enhance: Enhance;
  brightness: number;
  contrast: number;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function canvasFromImage(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}

/** Sharpness score (variance of Laplacian on a downscaled grayscale) — higher = sharper. */
function sharpnessScore(src: HTMLCanvasElement): number {
  const w = 300, h = Math.max(1, Math.round((src.height * 300) / src.width));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = -4 * g[i] + g[i - 1] + g[i + 1] + g[i - w] + g[i + w];
      sum += lap; sum2 += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

@Component({
  selector: 'ds-scanner',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scanner.component.html',
  styleUrls: ['./scanner.component.scss'],
})
export class ScannerComponent implements AfterViewInit, OnDestroy {
  readonly targetFolderId = input.required<string>();
  readonly closed = output<void>();
  readonly uploaded = output<DriveFile[]>();

  @ViewChild('videoEl') videoEl!: ElementRef<HTMLVideoElement>;

  readonly phase = signal<Phase>('camera');
  readonly pages = signal<ScanPage[]>([]);
  /** Index of the page currently shown/edited in review. */
  readonly current = signal(0);
  readonly page = computed<ScanPage | null>(() => this.pages()[this.current()] ?? null);
  readonly corners = signal<[Point, Point, Point, Point]>([
    { x: 10, y: 10 }, { x: 310, y: 10 }, { x: 310, y: 410 }, { x: 10, y: 410 },
  ]);
  readonly format = signal<'pdf' | 'jpeg'>('pdf');
  readonly fileName = signal('');
  readonly uploadError = signal('');
  readonly draggingCorner = signal<number | null>(null);

  readonly frozenDataUrl = signal('');
  readonly frozenSize = signal<{ w: number; h: number }>({ w: 1, h: 1 });
  /** Magnifier shown while dragging a corner (all values in wrap pixels). */
  readonly loupe = signal({ visible: false, x: 0, y: 0, bgX: 0, bgY: 0, bgW: 0, bgH: 0 });
  readonly cvStatus = signal<'loading' | 'ready' | 'failed'>('loading');
  readonly cvDetail = signal('starting…');
  /** True when the CV detector found a document in the last processed frame. */
  readonly cvFound = signal(false);

  /** Capture quality → requested camera resolution (the browser falls back
   *  to the closest the device supports). Persisted across sessions; a stored
   *  legacy 'sd' value falls back to the 4K default. */
  readonly quality = signal<'hd' | '4k'>(
    localStorage.getItem('scanQuality') === 'hd' ? 'hd' : '4k'
  );
  private static readonly QUALITY_WIDTH = { hd: 1920, '4k': 3840 } as const;

  cycleQuality(): void {
    const next = this.quality() === '4k' ? 'hd' : '4k';
    this.quality.set(next);
    localStorage.setItem('scanQuality', next);
    // Restart the stream so the new resolution takes effect immediately.
    if (this.stream) {
      this.stopCamera();
      this.startCamera();
    }
  }

  // Camera controls — capability-gated (buttons only shown when supported)
  readonly torchOn = signal(false);
  readonly torchSupported = signal(false);
  readonly zoomCaps = signal<{ min: number; max: number; step: number } | null>(null);
  readonly zoomLevel = signal(1);
  readonly canFlip = signal(false);

  private facing: 'environment' | 'user' = 'environment';
  private videoTrack: MediaStreamTrack | null = null;
  private stream: MediaStream | null = null;
  private cv: any = null;

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private fullPreviewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewGen = 0;

  /**
   * Render the review preview for a page with the exact pixel enhancement
   * (same function as the final bake). `maxDim` caps resolution for the fast
   * interactive pass; the full pass (no cap) produces pixels IDENTICAL to the
   * saved result, so zooming in shows true output quality.
   */
  private async renderPreview(idx: number, maxDim = Infinity): Promise<void> {
    const p = this.pages()[idx];
    if (!p) return;
    const gen = this.previewGen;
    const img = await loadImage(p.warpedDataUrl);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const latest = this.pages()[idx];
    if (!latest) return;
    enhanceImageData(d, latest.brightness, latest.contrast, latest.enhance);
    ctx.putImageData(d, 0, 0);
    if (gen !== this.previewGen) return; // settings changed while rendering — discard
    const url = c.toDataURL('image/jpeg', 0.92);
    this.pages.update(pages => pages.map((pg, i) => (i === idx ? { ...pg, previewUrl: url } : pg)));
  }

  /** Fast pass while adjusting (1100px, 120ms debounce), then a full-resolution
   *  pass once idle (650ms) so the preview matches the saved pixels exactly. */
  private schedulePreview(idx: number): void {
    this.previewGen++;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.fullPreviewTimer) clearTimeout(this.fullPreviewTimer);
    this.previewTimer = setTimeout(() => this.renderPreview(idx, 1100), 120);
    this.fullPreviewTimer = setTimeout(() => this.renderPreview(idx), 650);
  }

  /** Merge a partial update into the current page; filter changes re-render the preview. */
  patchPage(patch: Partial<ScanPage>): void {
    const idx = this.current();
    this.pages.update(pages =>
      pages.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    );
    if ('enhance' in patch || 'brightness' in patch || 'contrast' in patch) {
      this.schedulePreview(idx);
    }
  }

  readonly svgPoints = computed(() => {
    const { w, h } = this.frozenSize();
    return this.corners().map(c => `${c.x / w},${c.y / h}`).join(' ');
  });

  /** Even-odd path covering the whole image with the quad cut out — used to darken outside the frame. */
  readonly maskPath = computed(() => {
    const { w, h } = this.frozenSize();
    const pts = this.corners().map(c => `${c.x / w} ${c.y / h}`);
    return `M0 0H1V1H0Z M${pts.join(' L')}Z`;
  });

  readonly defaultFileName = computed(() => {
    const d = new Date();
    return `Scan ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });

  constructor(private zone: NgZone, private fileService: FileService) {}

  ngAfterViewInit(): void {
    // Lazy-load OpenCV.js in the background; detection falls back to the
    // pure-JS detector until it's ready.
    onOpenCvStatus(msg => this.zone.run(() => this.cvDetail.set(msg)));
    loadOpenCv()
      .then(cv => { this.cv = cv; this.zone.run(() => this.cvStatus.set('ready')); })
      .catch(() => { this.cv = null; this.zone.run(() => this.cvStatus.set('failed')); });
    this.startCamera();
  }

  /**
   * Run the document detector. Returns the detected quad, or a centered
   * default quad (for manual adjustment) when no document is found.
   */
  private detect(imgData: ImageData): Quad {
    if (this.cv) {
      const det = detectDocument(this.cv, imgData);
      if (lastDetectError()) this.cvDetail.set('CV error: ' + lastDetectError());
      if (det) { this.cvFound.set(true); return det.quad; }
    }
    this.cvFound.set(false);
    return defaultQuad(imgData.width, imgData.height);
  }

  ngOnDestroy(): void {
    this.stopCamera();
  }

  async startCamera(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: this.facing,
          width: { ideal: ScannerComponent.QUALITY_WIDTH[this.quality()] },
        }
      });
      const video = this.videoEl.nativeElement;
      video.srcObject = this.stream;
      await video.play();
      this.videoTrack = this.stream.getVideoTracks()[0] ?? null;
      this.readCameraCapabilities();
    } catch {
      // camera denied
    }
  }

  /** Detect torch/zoom support and whether a second camera exists. */
  private async readCameraCapabilities(): Promise<void> {
    const caps: any = this.videoTrack?.getCapabilities?.() ?? {};
    this.torchSupported.set(!!caps.torch);
    this.torchOn.set(false);
    if (caps.zoom && typeof caps.zoom.min === 'number') {
      this.zoomCaps.set({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
      const settings: any = this.videoTrack?.getSettings?.() ?? {};
      this.zoomLevel.set(settings.zoom ?? caps.zoom.min);
    } else {
      this.zoomCaps.set(null);
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.canFlip.set(devices.filter(d => d.kind === 'videoinput').length > 1);
    } catch {
      this.canFlip.set(false);
    }
  }

  async toggleTorch(): Promise<void> {
    if (!this.videoTrack) return;
    const next = !this.torchOn();
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ torch: next } as any] });
      this.torchOn.set(next);
    } catch {
      this.torchSupported.set(false);
    }
  }

  async setZoom(value: number): Promise<void> {
    if (!this.videoTrack) return;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ zoom: value } as any] });
      this.zoomLevel.set(value);
    } catch { /* unsupported mid-stream */ }
  }

  async flipCamera(): Promise<void> {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.stopCamera();
    await this.startCamera();
  }

  /** Perspective-warp a source canvas by the given corners → JPEG data URL. */
  private warpToDataUrl(src: HTMLCanvasElement, corners: Quad): string {
    const warped = this.cv
      ? perspectiveWarpCv(this.cv, src, corners)
      : perspectiveWarp(src, corners);
    return warped.toDataURL('image/jpeg', 0.92);
  }

  /** True while the shutter is processing — the viewfinder shows the frozen tap-instant frame. */
  readonly capturing = signal(false);
  @ViewChild('freezeEl') freezeEl?: ElementRef<HTMLCanvasElement>;

  async capture(): Promise<void> {
    if (this.capturing()) return;
    const video = this.videoEl.nativeElement;
    const grab = (): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d')!.drawImage(video, 0, 0);
      return c;
    };

    // The frame at the TAP INSTANT is the primary candidate — and the
    // viewfinder freezes on it immediately, so moving the phone afterwards
    // cannot change what was captured (this was the "captures late" bug).
    const tapFrame = grab();
    const freeze = this.freezeEl?.nativeElement;
    if (freeze) {
      freeze.width = tapFrame.width;
      freeze.height = tapFrame.height;
      freeze.getContext('2d')!.drawImage(tapFrame, 0, 0);
    }
    this.capturing.set(true);

    // Photo-pipeline attempt in parallel (sharp native stills where supported);
    // short timeout so it can never delay the shutter noticeably.
    let photoPromise: Promise<HTMLCanvasElement | null> = Promise.resolve(null);
    const track = this.videoTrack;
    if (track && typeof (window as any).ImageCapture === 'function') {
      photoPromise = (async () => {
        try {
          const ic = new (window as any).ImageCapture(track);
          const blob: Blob = await Promise.race([
            ic.takePhoto(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
          ]);
          const url = URL.createObjectURL(blob);
          try { return canvasFromImage(await loadImage(url)); }
          finally { URL.revokeObjectURL(url); }
        } catch { return null; }
      })();
    }

    // Two extra frames right after the tap — rescues micro-shake AT the tap.
    const extras: HTMLCanvasElement[] = [];
    for (let i = 0; i < 2; i++) {
      await new Promise(r => setTimeout(r, 80));
      extras.push(grab());
    }
    const photo = await photoPromise;
    this.stopCamera();

    // The tap frame wins unless a later candidate is CLEARLY sharper — later
    // frames are down-weighted so post-tap movement can't hijack the shot.
    let snap = tapFrame;
    let best = sharpnessScore(tapFrame);
    const weights = [0.95, 0.9];
    extras.forEach((c, i) => {
      const s = sharpnessScore(c) * weights[i];
      if (s > best) { best = s; snap = c; }
    });
    if (photo && sharpnessScore(photo) > best * 1.25) snap = photo;

    this.capturing.set(false);
    this.phase.set('review');

    // Detection runs ONCE, on the captured frame. If OpenCV is still loading,
    // wait briefly (capped) so the photo gets the accurate detector.
    if (!this.cv && this.cvStatus() === 'loading') {
      try {
        const timeout = new Promise<null>(r => setTimeout(() => r(null), 8000));
        const cv = await Promise.race([loadOpenCv(), timeout]);
        if (cv) { this.cv = cv; this.cvStatus.set('ready'); }
      } catch { /* keep fallback */ }
    }
    const imgData = snap.getContext('2d')!.getImageData(0, 0, snap.width, snap.height);
    const corners = this.detect(imgData);

    // Auto-crop immediately: review shows the warped document, not the raw photo.
    const warpedDataUrl = this.warpToDataUrl(snap, corners);
    const page: ScanPage = {
      srcDataUrl: snap.toDataURL('image/jpeg', 0.92),
      srcW: snap.width,
      srcH: snap.height,
      corners,
      warpedDataUrl,
      previewUrl: warpedDataUrl, // replaced by the enhanced render just below
      enhance: 'color',
      brightness: 100,
      contrast: 100,
    };
    this.pages.update(pages => [...pages, page]);
    this.current.set(this.pages().length - 1);
    this.schedulePreview(this.current());
  }

  // --- Page navigation (review phase) ---

  /** Filters panel visibility (Google-Drive-style bottom toolbar). */
  readonly filtersOpen = signal(false);

  // Review zoom: pinch + buttons (same idea as the media preview)
  readonly reviewZoom = signal(1);
  readonly reviewPan = signal({ x: 0, y: 0 });
  readonly reviewZoomPct = computed(() => Math.round(this.reviewZoom() * 100) + '%');
  readonly reviewTransform = computed(() => {
    const z = this.reviewZoom();
    const p = this.reviewPan();
    return z === 1 ? 'none' : `translate(${p.x}px, ${p.y}px) scale(${z})`;
  });
  private gesture = { mode: 'none' as 'none' | 'swipe' | 'pan' | 'pinch', x: 0, y: 0, dist: 0, zoom: 1, panX: 0, panY: 0, cx: 0, cy: 0 };

  resetReviewZoom(): void {
    this.reviewZoom.set(1);
    this.reviewPan.set({ x: 0, y: 0 });
  }

  zoomReview(delta: number): void {
    const z = Math.min(4, Math.max(1, this.reviewZoom() + delta));
    this.reviewZoom.set(z);
    if (z === 1) this.reviewPan.set({ x: 0, y: 0 });
  }

  selectPage(i: number): void {
    if (i >= 0 && i < this.pages().length) {
      this.current.set(i);
      this.resetReviewZoom();
    }
  }
  prevPage(): void { this.selectPage(this.current() - 1); }
  nextPage(): void { this.selectPage(this.current() + 1); }

  /** One-finger swipe navigates (at 1×), drags to pan (zoomed); two fingers pinch-zoom. */
  onPageTouchStart(e: TouchEvent): void {
    if (e.touches.length === 2) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const [t1, t2] = [e.touches[0], e.touches[1]];
      this.gesture = {
        mode: 'pinch',
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2,
        dist: Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY),
        zoom: this.reviewZoom(),
        panX: this.reviewPan().x,
        panY: this.reviewPan().y,
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
      };
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      const zoomed = this.reviewZoom() > 1;
      this.gesture = {
        mode: zoomed ? 'pan' : 'swipe',
        x: t.clientX, y: t.clientY, dist: 0,
        zoom: this.reviewZoom(),
        panX: this.reviewPan().x, panY: this.reviewPan().y,
        cx: 0, cy: 0,
      };
    }
  }

  onPageTouchMove(e: TouchEvent): void {
    const g = this.gesture;
    if (g.mode === 'pinch' && e.touches.length === 2) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      const z = Math.min(4, Math.max(1, g.zoom * (dist / Math.max(1, g.dist))));
      // Same math as PreviewComponent: keep the image point under the pinch
      // midpoint anchored (container-center origin), so moving both fingers
      // pans while spreading them zooms.
      const imageX = (g.x - g.cx - g.panX) / g.zoom;
      const imageY = (g.y - g.cy - g.panY) / g.zoom;
      this.reviewZoom.set(z);
      this.reviewPan.set(z === 1
        ? { x: 0, y: 0 }
        : { x: midX - g.cx - imageX * z, y: midY - g.cy - imageY * z });
    } else if (g.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      this.reviewPan.set({ x: g.panX + t.clientX - g.x, y: g.panY + t.clientY - g.y });
    }
  }

  onPageTouchEnd(e: TouchEvent): void {
    const g = this.gesture;
    if (g.mode === 'swipe' && e.changedTouches.length) {
      const dx = e.changedTouches[0].clientX - g.x;
      if (dx > 50) this.prevPage();
      else if (dx < -50) this.nextPage();
    }
    if (e.touches.length === 0) this.gesture = { ...g, mode: 'none' };
  }

  /** Remove the current page; back to camera when none remain. */
  deletePage(): void {
    this.resetReviewZoom();
    const idx = this.current();
    this.pages.update(pages => pages.filter((_, i) => i !== idx));
    this.current.set(Math.max(0, Math.min(idx, this.pages().length - 1)));
    if (this.pages().length === 0) {
      this.phase.set('camera');
      setTimeout(() => this.startCamera(), 50);
    }
  }

  /** Delete the current page and re-open the camera to shoot a replacement. */
  retake(): void {
    const idx = this.current();
    this.pages.update(pages => pages.filter((_, i) => i !== idx));
    this.current.set(Math.max(0, this.pages().length - 1));
    this.filtersOpen.set(false);
    this.phase.set('camera');
    setTimeout(() => this.startCamera(), 50);
  }

  /** Review "Done": back to the camera to add more pages (Drive flow). */
  addPage(): void {
    this.filtersOpen.set(false);
    this.phase.set('camera');
    setTimeout(() => this.startCamera(), 50);
  }

  /** Camera thumbnail tap: review the last captured page. */
  openLastPage(): void {
    if (!this.pages().length) return;
    this.resetReviewZoom();
    this.stopCamera();
    this.current.set(this.pages().length - 1);
    this.phase.set('review');
  }

  /** Camera "Save (n)": proceed to name/format/upload. */
  done(): void {
    this.stopCamera();
    this.fileName.set(this.defaultFileName());
    this.phase.set('format');
  }

  // --- Crop mode: re-adjust the corner quad on the original photo ---

  openCrop(): void {
    const p = this.page();
    if (!p) return;
    this.frozenDataUrl.set(p.srcDataUrl);
    this.frozenSize.set({ w: p.srcW, h: p.srcH });
    this.corners.set(p.corners);
    this.phase.set('crop');
  }

  async applyCrop(): Promise<void> {
    const p = this.page();
    if (!p) return;
    const src = canvasFromImage(await loadImage(p.srcDataUrl));
    const corners = this.corners();
    const warpedDataUrl = this.warpToDataUrl(src, corners);
    this.patchPage({ corners, warpedDataUrl, previewUrl: warpedDataUrl });
    this.schedulePreview(this.current());
    this.resetReviewZoom();
    this.phase.set('review');
  }

  cancelCrop(): void {
    this.phase.set('review');
  }

  /** Rotate the current page 90° clockwise: source, corners, and crop result. */
  async rotate(): Promise<void> {
    const p = this.page();
    if (!p) return;
    const src = canvasFromImage(await loadImage(p.srcDataUrl));
    const out = document.createElement('canvas');
    out.width = src.height;
    out.height = src.width;
    const ctx = out.getContext('2d')!;
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, 0, 0);

    // (x, y) → (oldH - y, x); old BL becomes new TL etc., so shift the
    // corner order to keep [TL, TR, BR, BL] semantics.
    const oldH = src.height;
    const [tl, tr, br, bl] = p.corners;
    const rot = (pt: Point): Point => ({ x: oldH - pt.y, y: pt.x });
    const corners: Quad = [rot(bl), rot(tl), rot(tr), rot(br)];

    const warpedDataUrl = this.warpToDataUrl(out, corners);
    this.patchPage({
      srcDataUrl: out.toDataURL('image/jpeg', 0.92),
      srcW: out.width,
      srcH: out.height,
      corners,
      warpedDataUrl,
      previewUrl: warpedDataUrl,
    });
    this.schedulePreview(this.current());
    this.resetReviewZoom();
  }

  /** Longest side of a saved page: ~290 DPI for A4 — text stays print-crisp
   *  while the file is a fraction of the raw 4K bake. */
  private static readonly SAVE_MAX_DIM = 2400;
  /** JPEG quality for saved pages. The flattened near-white background
   *  compresses extremely well, so 0.8 is visually lossless on documents. */
  private static readonly SAVE_JPEG_QUALITY = 0.8;

  /** Bake a page for upload: warped pixels + exact pixel-level enhancement,
   *  downscaled to document resolution and compressed for small PDFs. */
  private async bakePage(p: ScanPage): Promise<Blob> {
    const img = await loadImage(p.warpedDataUrl);
    const scale = Math.min(1, ScannerComponent.SAVE_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Pixel manipulation, not ctx.filter — unsupported on iOS Safari.
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    enhanceImageData(imgData, p.brightness, p.contrast, p.enhance);
    ctx.putImageData(imgData, 0, 0);
    return new Promise<Blob>(resolve =>
      canvas.toBlob(b => resolve(b!), 'image/jpeg', ScannerComponent.SAVE_JPEG_QUALITY)
    );
  }

  async upload(): Promise<void> {
    this.phase.set('uploading');
    this.uploadError.set('');
    const name = this.fileName().trim() || this.defaultFileName();
    const folderId = this.targetFolderId();
    const pages = this.pages();

    try {
      const blobs: Blob[] = [];
      for (const p of pages) blobs.push(await this.bakePage(p));

      if (this.format() === 'pdf') {
        const pdf = await PDFDocument.create();
        for (const blob of blobs) {
          const buf = await blob.arrayBuffer();
          const img = await pdf.embedJpg(buf);
          const pg = pdf.addPage([img.width, img.height]);
          pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
        const bytes = await pdf.save();
        const pdfBlob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
        const file = await this.fileService.uploadFile(folderId, name + '.pdf', 'application/pdf', pdfBlob);
        this.uploaded.emit([file]);
      } else {
        const results: DriveFile[] = [];
        for (let i = 0; i < blobs.length; i++) {
          const fname = blobs.length === 1 ? name + '.jpg' : `${name}_${i + 1}.jpg`;
          const file = await this.fileService.uploadFile(folderId, fname, 'image/jpeg', blobs[i]);
          results.push(file);
        }
        this.uploaded.emit(results);
      }
    } catch (e) {
      const apiMsg = (e as any)?.error?.error;
      this.uploadError.set(apiMsg ? `Upload failed: ${apiMsg}` : 'Upload failed. Please try again.');
      this.phase.set('format');
    }
  }

  // --- Corner dragging ---

  /** Offset between the grabbed corner and the pointer, in normalized coords —
   *  keeps the corner from jumping under the finger and lets the whole
   *  background act as a drag surface. */
  private dragOffset = { dx: 0, dy: 0 };

  onHandlePointerDown(e: PointerEvent, idx: number): void {
    e.preventDefault();
    e.stopPropagation();
    // Capture on the wrap — pointermove/pointerup handlers live there.
    const wrap = (e.target as HTMLElement).parentElement as HTMLElement;
    wrap.setPointerCapture(e.pointerId);
    this.startDrag(idx, e, wrap.getBoundingClientRect());
  }

  /** Anywhere on the image starts dragging the corner of that quadrant, so
   *  the finger never needs to hit the small circle exactly. */
  onWrapPointerDown(e: PointerEvent): void {
    if (this.draggingCorner() !== null) return;
    const wrap = e.currentTarget as HTMLElement;
    const rect = wrap.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / rect.width;
    const ry = (e.clientY - rect.top) / rect.height;
    const { w, h } = this.frozenSize();
    const cs = this.corners();
    const cx = cs.reduce((s, c) => s + c.x, 0) / 4 / w;
    const cy = cs.reduce((s, c) => s + c.y, 0) / 4 / h;
    const idx = rx < cx ? (ry < cy ? 0 : 3) : (ry < cy ? 1 : 2);
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    this.startDrag(idx, e, rect);
  }

  private startDrag(idx: number, e: PointerEvent, rect: DOMRect): void {
    const { w, h } = this.frozenSize();
    const c = this.corners()[idx];
    this.dragOffset = {
      dx: c.x / w - (e.clientX - rect.left) / rect.width,
      dy: c.y / h - (e.clientY - rect.top) / rect.height,
    };
    this.draggingCorner.set(idx);
    this.updateLoupe(rect);
  }

  onSvgPointerMove(e: PointerEvent): void {
    const idx = this.draggingCorner();
    if (idx === null) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Keep handle centres at least 5% from each edge so circles stay visible
    const pad = 0.05;
    const rx = Math.max(pad, Math.min(1 - pad, (e.clientX - rect.left) / rect.width + this.dragOffset.dx));
    const ry = Math.max(pad, Math.min(1 - pad, (e.clientY - rect.top) / rect.height + this.dragOffset.dy));
    const { w, h } = this.frozenSize();
    this.corners.update(c => {
      const next = [...c] as [Point, Point, Point, Point];
      next[idx] = { x: rx * w, y: ry * h };
      return next;
    });
    this.updateLoupe(rect);
  }

  /** Magnified view of the dragged corner, positioned clear of the finger. */
  private updateLoupe(rect: DOMRect): void {
    const idx = this.draggingCorner();
    if (idx === null) return;
    const L = 110, Z = 2.5;
    const { w, h } = this.frozenSize();
    const c = this.corners()[idx];
    const px = (c.x / w) * rect.width;
    const py = (c.y / h) * rect.height;
    const x = Math.max(0, Math.min(rect.width - L, px - L / 2));
    let y = py - L - 32;
    if (y < 0) y = Math.min(rect.height - L, py + 32);
    this.loupe.set({
      visible: true, x, y,
      bgW: rect.width * Z, bgH: rect.height * Z,
      bgX: -(px * Z - L / 2), bgY: -(py * Z - L / 2),
    });
  }

  onSvgPointerUp(): void {
    this.draggingCorner.set(null);
    this.loupe.update(v => ({ ...v, visible: false }));
  }

  private stopCamera(): void {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.videoTrack = null;
    this.torchOn.set(false);
  }

  close(): void {
    this.stopCamera();
    this.closed.emit();
  }
}
