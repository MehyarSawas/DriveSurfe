import {
  Component, input, output, signal, computed,
  ElementRef, ViewChild, NgZone, OnDestroy, AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../core/services/file.service';
import { DriveFile } from '../../core/models/drive-file.model';
import { detectQuad, Point } from './edge-detect';
import { detectQuadCv, lastCvError } from './edge-detect-cv';
import { perspectiveWarp, perspectiveWarpCv } from './perspective-warp';
import { loadOpenCv, onOpenCvStatus } from './opencv-loader';
import { PDFDocument } from 'pdf-lib';

type Phase = 'camera' | 'review' | 'format' | 'uploading';
type Enhance = 'color' | 'grayscale' | 'bw';

function applyPixelEnhance(data: Uint8ClampedArray, brightness: number, contrast: number, enhance: Enhance): void {
  // b=1 and c=1 at defaults (100/100) → pixel unchanged
  const b = brightness / 100;
  const c = (enhance === 'bw' ? Math.max(contrast, 150) : contrast) / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], bl = data[i + 2];
    if (enhance === 'grayscale' || enhance === 'bw') {
      const luma = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = g = bl = luma;
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
  readonly cvStatus = signal<'loading' | 'ready' | 'failed'>('loading');
  readonly cvDetail = signal('starting…');
  /** True when the CV detector found a document in the last processed frame. */
  readonly cvFound = signal(false);

  private stream: MediaStream | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private frozenCanvas: HTMLCanvasElement | null = null;
  private cv: any = null;

  readonly reviewFilter = computed(() => {
    const b = this.brightness(), c = this.contrast(), e = this.enhance();
    const sat = e === 'grayscale' ? 0 : e === 'bw' ? 0 : 1;
    const con = e === 'bw' ? Math.max(c, 150) : c;
    return `brightness(${b}%) contrast(${con}%) saturate(${sat * 100}%)`;
  });

  readonly svgPoints = computed(() => {
    const { w, h } = this.frozenSize();
    return this.corners().map(c => `${c.x / w},${c.y / h}`).join(' ');
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

  /** Best available quad detector: OpenCV when loaded, pure-JS fallback otherwise. */
  private detect(imgData: ImageData): [Point, Point, Point, Point] {
    if (this.cv) {
      const q = detectQuadCv(this.cv, imgData);
      if (lastCvError()) this.cvDetail.set('CV error: ' + lastCvError());
      if (q) { this.cvFound.set(true); return q; }
      this.cvFound.set(false);
    }
    return detectQuad(imgData);
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

    const quad = this.detect(imgData);
    this.zone.run(() => this.corners.set(quad));

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Green solid = CV detector locked onto a document.
    // Gray dashed = no document found (frame-default fallback quad).
    const found = this.cv !== null && this.cvFound();
    ctx.strokeStyle = found ? '#00e676' : 'rgba(255,255,255,0.45)';
    ctx.setLineDash(found ? [] : [12, 10]);
    ctx.lineWidth = Math.max(2, canvas.width / 300);
    ctx.beginPath();
    const [tl, tr, br, bl] = quad;
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
    if (found) {
      ctx.fillStyle = 'rgba(0,230,118,0.1)';
      ctx.fill();
    }
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

  // --- SVG corner dragging ---

  onHandlePointerDown(e: PointerEvent, idx: number): void {
    e.preventDefault();
    e.stopPropagation();
    // Capture on the wrap — pointermove/pointerup handlers live there.
    const wrap = (e.target as HTMLElement).parentElement;
    wrap?.setPointerCapture(e.pointerId);
    this.draggingCorner.set(idx);
  }

  onSvgPointerMove(e: PointerEvent): void {
    const idx = this.draggingCorner();
    if (idx === null) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Keep handle centres at least 5% from each edge so circles stay visible
    const pad = 0.05;
    const rx = Math.max(pad, Math.min(1 - pad, (e.clientX - rect.left) / rect.width));
    const ry = Math.max(pad, Math.min(1 - pad, (e.clientY - rect.top) / rect.height));
    const { w, h } = this.frozenSize();
    this.corners.update(c => {
      const next = [...c] as [Point, Point, Point, Point];
      next[idx] = { x: rx * w, y: ry * h };
      return next;
    });
  }

  onSvgPointerUp(): void {
    this.draggingCorner.set(null);
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
