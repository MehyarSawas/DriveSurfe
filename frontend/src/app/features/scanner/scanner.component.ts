import {
  Component, input, output, signal, computed,
  ElementRef, ViewChild, NgZone, OnDestroy, AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../core/services/file.service';
import { DriveFile } from '../../core/models/drive-file.model';
import { detectQuad, Point } from './edge-detect';
import { perspectiveWarp } from './perspective-warp';
import { PDFDocument } from 'pdf-lib';

type Phase = 'camera' | 'review' | 'format' | 'uploading';
type Enhance = 'color' | 'grayscale' | 'bw';

interface ScannedPage {
  warped: HTMLCanvasElement;
  blob: Blob;
  enhance: Enhance;
  brightness: number;
  contrast: number;
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
  @ViewChild('reviewEl') reviewEl!: ElementRef<HTMLCanvasElement>;

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

  private stream: MediaStream | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private frozenCanvas: HTMLCanvasElement | null = null;

  readonly reviewFilter = computed(() => {
    const b = this.brightness(), c = this.contrast(), e = this.enhance();
    const sat = e === 'grayscale' ? 0 : e === 'bw' ? 0 : 1;
    const con = e === 'bw' ? Math.max(c, 150) : c;
    return `brightness(${b}%) contrast(${con}%) saturate(${sat * 100}%)`;
  });

  readonly defaultFileName = computed(() => {
    const d = new Date();
    return `Scan ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });

  private thumbCache = new Map<ScannedPage, string>();

  pageThumbUrl(page: ScannedPage): string {
    if (!this.thumbCache.has(page)) {
      const url = page.warped.toDataURL('image/jpeg', 0.5);
      this.thumbCache.set(page, url);
    }
    return this.thumbCache.get(page)!;
  }

  constructor(private zone: NgZone, private fileService: FileService) {}

  ngAfterViewInit(): void {
    this.startCamera();
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
      // camera denied — still let user use file upload path
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

    const quad = detectQuad(imgData);
    this.zone.run(() => this.corners.set(quad));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const [tl, tr, br, bl] = quad;
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,230,118,0.1)';
    ctx.fill();
  }

  capture(): void {
    const video = this.videoEl.nativeElement;
    const snap = document.createElement('canvas');
    snap.width = video.videoWidth;
    snap.height = video.videoHeight;
    snap.getContext('2d')!.drawImage(video, 0, 0);
    this.frozenCanvas = snap;

    if (this.frameTimer) clearInterval(this.frameTimer);
    this.stopCamera();

    const imgData = snap.getContext('2d')!.getImageData(0, 0, snap.width, snap.height);
    const quad = detectQuad(imgData);
    this.corners.set(quad);
    this.phase.set('review');
    setTimeout(() => this.renderReview(), 50);
  }

  renderReview(): void {
    if (!this.frozenCanvas) return;
    const warped = perspectiveWarp(this.frozenCanvas, this.corners());
    const canvas = this.reviewEl?.nativeElement;
    if (!canvas) return;
    canvas.width = warped.width;
    canvas.height = warped.height;
    canvas.getContext('2d')!.drawImage(warped, 0, 0);
  }

  retake(): void {
    this.frozenCanvas = null;
    this.phase.set('camera');
    setTimeout(() => this.startCamera(), 50);
  }

  async addPage(): Promise<void> {
    await this.bakeCurrentPage();
    this.frozenCanvas = null;
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
    const warped = perspectiveWarp(this.frozenCanvas, this.corners());

    const offscreen = document.createElement('canvas');
    offscreen.width = warped.width;
    offscreen.height = warped.height;
    const ctx = offscreen.getContext('2d')!;
    ctx.filter = this.reviewFilter();
    ctx.drawImage(warped, 0, 0);
    ctx.filter = 'none';

    const blob = await new Promise<Blob>(resolve =>
      offscreen.toBlob(b => resolve(b!), 'image/jpeg', 0.9)
    );
    this.pages.update(pages => [...pages, {
      warped: offscreen, blob,
      enhance: this.enhance(),
      brightness: this.brightness(),
      contrast: this.contrast(),
    }]);
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
        const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
        const file = await this.fileService.uploadFile(folderId, name + '.pdf', 'application/pdf', base64);
        this.uploaded.emit([file]);
      } else {
        const results: DriveFile[] = [];
        for (let i = 0; i < pages.length; i++) {
          const buf = await pages[i].blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const base64 = btoa(String.fromCharCode(...bytes));
          const fname = pages.length === 1 ? name + '.jpg' : `${name}_${i + 1}.jpg`;
          const file = await this.fileService.uploadFile(folderId, fname, 'image/jpeg', base64);
          results.push(file);
        }
        this.uploaded.emit(results);
      }
    } catch (e) {
      this.uploadError.set('Upload failed. Please try again.');
      this.phase.set('format');
    }
  }

  // --- Corner dragging ---

  onCornerPointerDown(e: PointerEvent, idx: number): void {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.draggingCorner.set(idx);
  }

  onReviewPointerMove(e: PointerEvent): void {
    const idx = this.draggingCorner();
    if (idx === null) return;
    const canvas = this.reviewEl?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * scaleX));
    const y = Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * scaleY));
    this.corners.update(c => {
      const next: [Point, Point, Point, Point] = [...c] as any;
      next[idx] = { x, y };
      return next;
    });
  }

  onReviewPointerUp(): void {
    if (this.draggingCorner() !== null) {
      this.draggingCorner.set(null);
      this.renderReview();
    }
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
