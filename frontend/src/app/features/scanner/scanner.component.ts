import {
  Component, input, output, signal, computed,
  ElementRef, ViewChild, NgZone, OnDestroy, AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../core/services/file.service';
import { DriveFile } from '../../core/models/drive-file.model';
import { Point, Quad, detectDocument, defaultQuad, lastDetectError, quadsSimilar } from './quad-detector';
import { perspectiveWarp, perspectiveWarpCv } from './perspective-warp';
import { loadOpenCv, onOpenCvStatus } from './opencv-loader';
import { PDFDocument } from 'pdf-lib';

type Phase = 'camera' | 'review' | 'format' | 'uploading';
type Enhance = 'color' | 'grayscale' | 'bw';

function applyPixelEnhance(data: Uint8ClampedArray, brightness: number, contrast: number, enhance: Enhance): void {
  // Google-Drive-style auto enhancement: find the luminance black/white points
  // from the histogram and stretch so the paper background reads as true white
  // (the paper is the brightest large region — map its level to 255).
  const hist = new Uint32Array(256);
  const totalPx = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    hist[(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0]++;
  }
  let cum = 0, black = 0, white = 255;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= totalPx * 0.02) { black = v; break; } }
  cum = 0;
  for (let v = 255; v >= 0; v--) { cum += hist[v]; if (cum >= totalPx * 0.10) { white = v; break; } }
  // Guard: near-flat images (all one tone) must not get blown out
  if (white - black < 40) { black = 0; white = 255; }
  const stretch = 255 / (white - black);

  // b=1 and c=1 at defaults (100/100) → sliders are identity on top of auto
  const b = brightness / 100;
  const c = (enhance === 'bw' ? Math.max(contrast, 150) : contrast) / 100;
  // Mild saturation lift in color mode so document colors stay vivid after whitening
  const sat = enhance === 'color' ? 1.18 : 0;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], bl = data[i + 2];

    // Auto white/black point stretch (per channel, shared points)
    r  = (r  - black) * stretch;
    g  = (g  - black) * stretch;
    bl = (bl - black) * stretch;

    const luma = 0.299 * r + 0.587 * g + 0.114 * bl;
    if (enhance === 'grayscale' || enhance === 'bw') {
      r = g = bl = luma;
    } else {
      r  = luma + (r  - luma) * sat;
      g  = luma + (g  - luma) * sat;
      bl = luma + (bl - luma) * sat;
    }

    // brightness multiplies, then contrast pivots around 128 — matches CSS filter order
    r  = (r  * b - 128) * c + 128;
    g  = (g  * b - 128) * c + 128;
    bl = (bl * b - 128) * c + 128;
    data[i]     = Math.max(0, Math.min(255, r));
    data[i + 1] = Math.max(0, Math.min(255, g));
    data[i + 2] = Math.max(0, Math.min(255, bl));
  }
}

interface ScannedPage {
  blob: Blob;
  thumbUrl: string;
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
  @ViewChild('overlayEl') overlayEl!: ElementRef<HTMLCanvasElement>;

  readonly phase = signal<Phase>('camera');
  readonly pages = signal<ScannedPage[]>([]);
  readonly corners = signal<[Point, Point, Point, Point]>([
    { x: 10, y: 10 }, { x: 310, y: 10 }, { x: 310, y: 410 }, { x: 10, y: 410 },
  ]);
  readonly enhance = signal<Enhance>('color');
  readonly brightness = signal(100);
  readonly contrast = signal(100);
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

  private stream: MediaStream | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private frozenCanvas: HTMLCanvasElement | null = null;
  private cv: any = null;
  // Temporal stability: the live green frame only appears when detection
  // agrees with itself across consecutive frames.
  private lastLiveQuad: Quad | null = null;
  private stableFrames = 0;

  readonly reviewFilter = computed(() => {
    const b = this.brightness(), c = this.contrast(), e = this.enhance();
    // CSS approximation of applyPixelEnhance's auto white-point stretch +
    // saturation lift — the baked page uses the exact pixel version.
    const sat = e === 'grayscale' || e === 'bw' ? 0 : 118;
    const con = e === 'bw' ? Math.max(c, 150) : Math.round(c * 1.08);
    const bri = Math.round(b * 1.04);
    return `brightness(${bri}%) contrast(${con}%) saturate(${sat}%)`;
  });

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
        video: { facingMode: 'environment', width: { ideal: 1920 } }
      });
      const video = this.videoEl.nativeElement;
      video.srcObject = this.stream;
      await video.play();
      this.startFrameLoop();
    } catch {
      // camera denied
    }
  }

  private startFrameLoop(): void {
    this.frameTimer = setInterval(() => this.drawOverlay(), 250);
  }

  private drawOverlay(): void {
    const video = this.videoEl?.nativeElement;
    const canvas = this.overlayEl?.nativeElement;
    if (!video || !canvas || video.readyState < 2) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d')!;

    const offscreen = document.createElement('canvas');
    offscreen.width = video.videoWidth;
    offscreen.height = video.videoHeight;
    offscreen.getContext('2d')!.drawImage(video, 0, 0);
    const imgData = offscreen.getContext('2d')!.getImageData(0, 0, offscreen.width, offscreen.height);

    // Temporal stability: only trust a detection that repeats. A one-frame
    // quad on furniture/texture never shows; a real document held in view
    // stabilizes within ~2 frames (500 ms).
    const det = this.cv ? detectDocument(this.cv, imgData) : null;
    if (det) {
      this.stableFrames = this.lastLiveQuad && quadsSimilar(det.quad, this.lastLiveQuad, imgData.width, imgData.height)
        ? this.stableFrames + 1 : 1;
      this.lastLiveQuad = det.quad;
    } else {
      this.stableFrames = 0;
      this.lastLiveQuad = null;
    }
    const found = det !== null && this.stableFrames >= 2;
    const quad = found ? det!.quad : defaultQuad(imgData.width, imgData.height);
    this.zone.run(() => { this.cvFound.set(found); this.corners.set(quad); });

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const [tl, tr, br, bl] = quad;
    const quadPath = () => {
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
    };

    // Darken everything outside the locked frame.
    if (found) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'destination-out';
      quadPath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Green solid = stable document lock. Gray dashed = searching.
    ctx.strokeStyle = found ? '#00e676' : 'rgba(255,255,255,0.45)';
    ctx.setLineDash(found ? [] : [12, 10]);
    ctx.lineWidth = Math.max(2, canvas.width / 300);
    quadPath();
    ctx.stroke();
  }

  async capture(): Promise<void> {
    const video = this.videoEl.nativeElement;
    const snap = document.createElement('canvas');
    snap.width = video.videoWidth;
    snap.height = video.videoHeight;
    snap.getContext('2d')!.drawImage(video, 0, 0);
    this.frozenCanvas = snap;

    this.frozenDataUrl.set(snap.toDataURL('image/jpeg', 0.85));
    this.frozenSize.set({ w: snap.width, h: snap.height });

    if (this.frameTimer) clearInterval(this.frameTimer);
    this.stopCamera();
    this.phase.set('review');

    // Ensure the accurate OpenCV detector runs on the captured frame even if
    // the library hadn't finished loading during the live preview. Cap the wait
    // so a slow/blocked CDN can't hang the capture.
    if (!this.cv && this.cvStatus() === 'loading') {
      try {
        const timeout = new Promise<null>(r => setTimeout(() => r(null), 8000));
        const cv = await Promise.race([loadOpenCv(), timeout]);
        if (cv) { this.cv = cv; this.cvStatus.set('ready'); }
      } catch { /* keep fallback */ }
    }
    const imgData = snap.getContext('2d')!.getImageData(0, 0, snap.width, snap.height);
    this.corners.set(this.detect(imgData));
  }

  /** Rotate the captured frame 90° clockwise, remapping the corner quad. */
  rotate(): void {
    if (!this.frozenCanvas) return;
    const src = this.frozenCanvas;
    const out = document.createElement('canvas');
    out.width = src.height;
    out.height = src.width;
    const ctx = out.getContext('2d')!;
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, 0, 0);

    this.frozenCanvas = out;
    this.frozenDataUrl.set(out.toDataURL('image/jpeg', 0.85));
    this.frozenSize.set({ w: out.width, h: out.height });

    // (x, y) → (oldH - y, x); old BL becomes new TL etc., so shift the
    // corner order to keep [TL, TR, BR, BL] semantics.
    const oldH = src.height;
    const [tl, tr, br, bl] = this.corners();
    const rot = (p: Point): Point => ({ x: oldH - p.y, y: p.x });
    this.corners.set([rot(bl), rot(tl), rot(tr), rot(br)]);
    this.loupe.update(v => ({ ...v, visible: false }));
  }

  retake(): void {
    this.frozenCanvas = null;
    this.frozenDataUrl.set('');
    this.phase.set('camera');
    setTimeout(() => this.startCamera(), 50);
  }

  async addPage(): Promise<void> {
    await this.bakeCurrentPage();
    this.frozenCanvas = null;
    this.frozenDataUrl.set('');
    this.phase.set('camera');
    setTimeout(() => this.startCamera(), 50);
  }

  async done(): Promise<void> {
    await this.bakeCurrentPage();
    this.fileName.set(this.defaultFileName());
    this.phase.set('format');
  }

  private async bakeCurrentPage(): Promise<void> {
    if (!this.frozenCanvas) return;
    const warped = this.cv
      ? perspectiveWarpCv(this.cv, this.frozenCanvas, this.corners())
      : perspectiveWarp(this.frozenCanvas, this.corners());

    const offscreen = document.createElement('canvas');
    offscreen.width = warped.width;
    offscreen.height = warped.height;
    const ctx = offscreen.getContext('2d')!;
    ctx.drawImage(warped, 0, 0);

    // Apply brightness/contrast/enhance via pixel manipulation (ctx.filter unsupported on iOS Safari)
    const imgData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
    applyPixelEnhance(imgData.data, this.brightness(), this.contrast(), this.enhance());
    ctx.putImageData(imgData, 0, 0);

    const blob = await new Promise<Blob>(resolve =>
      offscreen.toBlob(b => resolve(b!), 'image/jpeg', 0.9)
    );
    const thumbUrl = offscreen.toDataURL('image/jpeg', 0.4);
    this.pages.update(pages => [...pages, { blob, thumbUrl }]);
  }

  async upload(): Promise<void> {
    this.phase.set('uploading');
    this.uploadError.set('');
    const name = this.fileName().trim() || this.defaultFileName();
    const folderId = this.targetFolderId();
    const pages = this.pages();

    try {
      if (this.format() === 'pdf') {
        const pdf = await PDFDocument.create();
        for (const page of pages) {
          const buf = await page.blob.arrayBuffer();
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
        for (let i = 0; i < pages.length; i++) {
          const fname = pages.length === 1 ? name + '.jpg' : `${name}_${i + 1}.jpg`;
          const file = await this.fileService.uploadFile(folderId, fname, 'image/jpeg', pages[i].blob);
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
    if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
  }

  close(): void {
    this.stopCamera();
    this.closed.emit();
  }
}
