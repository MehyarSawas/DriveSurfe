import {
  Component, input, output, signal, computed, HostListener,
  ElementRef, ViewChild, OnDestroy, AfterViewInit, NgZone, effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DriveFile } from '../../core/models/drive-file.model';
import { FolderPickerComponent } from '../../shared/components/folder-picker/folder-picker.component';
import { PdfViewerComponent } from '../../shared/components/pdf-viewer/pdf-viewer.component';

type DeletePhase = 'idle' | 'confirming' | 'countdown';

@Component({
  selector: 'ds-preview',
  standalone: true,
  imports: [CommonModule, FormsModule, FolderPickerComponent, PdfViewerComponent],
  templateUrl: './preview.component.html',
  styleUrls: ['./preview.component.scss'],
})
export class PreviewComponent implements OnDestroy, AfterViewInit {
  @ViewChild('mediaEl') mediaEl?: ElementRef<HTMLElement>;
  @ViewChild('thumbStrip') thumbStrip?: ElementRef<HTMLElement>;

  readonly file = input.required<DriveFile>();
  readonly hasPrev = input(false);
  readonly hasNext = input(false);
  readonly currentFolderId = input('');
  readonly files = input<DriveFile[]>([]);
  readonly currentIndex = input(0);

  readonly close = output<void>();
  readonly prev = output<void>();
  readonly next = output<void>();
  readonly jumpTo = output<DriveFile>();
  readonly saveSession = output<void>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly deleteStart = output<DriveFile>();
  readonly delete = output<DriveFile>();
  readonly moveFile = output<{file: DriveFile, folderId: string}>();
  readonly createFolder = output<{parentId: string, name: string, then: (f: DriveFile) => void}>();

  readonly zoom = signal(1);
  readonly isLoading = signal(false);
  readonly previewFailed = signal(false);
  readonly deletePhase = signal<DeletePhase>('idle');
  readonly countdown = signal(10);
  readonly folderPanelOpen = signal(false);
  readonly thumbnailBarOpen = signal(false);
  readonly sessionSaved = signal(false);
  private sessionSavedTimer: ReturnType<typeof setTimeout> | null = null;
  readonly isFullscreen = signal(false);
  private _fsHandler!: () => void;

  readonly swipeAction = computed<'delete' | 'move' | null>(() => {
    if (this.isTwoFingerTouch() || this.zoom() !== 1) return null;
    const dy = this.swipeOffsetY();
    if (dy < -30) return 'delete';
    if (dy > 30) return 'move';
    return null;
  });

  readonly swipeActionProgress = computed(() => {
    if (this.isTwoFingerTouch() || this.zoom() !== 1) return 0;
    const dy = this.swipeOffsetY();
    const threshold = 30;
    const full = 130;
    const abs = Math.abs(dy);
    if (abs < threshold) return 0;
    return Math.min((abs - threshold) / (full - threshold), 1);
  });

  // Swipe state
  private touchStartX = 0;
  private touchStartY = 0;
  private touchStartTime = 0;
  private touchCurrentX = 0;
  private touchCurrentY = 0;
  private isSwiping = false;
  readonly isTwoFingerTouch = signal(false);

  // Pinch-to-zoom state
  private isPinching = false;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  private pinchStartMidX = 0;
  private pinchStartMidY = 0;
  private pinchStartTx = 0;
  private pinchStartTy = 0;
  private pinchCx = 0;
  private pinchCy = 0;

  readonly swipeOffsetX = signal(0);
  readonly swipeOffsetY = signal(0);
  readonly isTransitioning = signal(false);

  private pendingInterval: ReturnType<typeof setInterval> | null = null;
  private pendingFile: DriveFile | null = null;
  private alive = true;
  readonly pendingDeleteFile = signal<DriveFile | null>(null);
  private boundTouchMove!: (e: TouchEvent) => void;

  readonly isImage = computed(() => {
    const f = this.file();
    return f.mime_type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','heic','heif'].includes(f.extension);
  });

  readonly isVideo = computed(() => {
    const f = this.file();
    return f.mime_type.startsWith('video/') || ['mp4','mov','m4v'].includes(f.extension);
  });

  readonly isPdf = computed(() => {
    const f = this.file();
    return f.mime_type === 'application/pdf' || f.extension === 'pdf';
  });

  readonly previewSrc = computed(() => {
    const f = this.file();
    return this.isVideo() ? `/api/files/${f.id}/download` : this.imagePreviewUrl(f.id);
  });

  imagePreviewUrl(fileId: string): string {
    const w = Math.min(window.screen.width * window.devicePixelRatio, 10000) | 0;
    const h = Math.min(window.screen.height * window.devicePixelRatio, 10000) | 0;
    return `/api/files/${fileId}/preview?width=${w}&height=${h}`;
  }

  constructor(private zone: NgZone, private el: ElementRef) {
    let prevFileId = '';
    effect(() => {
      const f = this.file();
      const isNewFile = f.id !== prevFileId;
      prevFileId = f.id;
      this.zoom.set(1);
      this.swipeOffsetX.set(0);
      this.swipeOffsetY.set(0);
      this.folderPanelOpen.set(false);
      this.isPinching = false;
      this.isSwiping = false;
      if (isNewFile) {
        this.previewFailed.set(false);
        if (!this.isVideo() && !this.isPdf()) this.isLoading.set(true);
        if (!this.pendingInterval) {
          this.deletePhase.set('idle');
          this.countdown.set(10);
          this.pendingDeleteFile.set(null);
        }
      }
    });

    effect(() => {
      this.currentIndex(); // track
      if (this.thumbnailBarOpen()) {
        setTimeout(() => this.scrollThumbToCenter(), 0);
      }
    });
  }

  ngAfterViewInit(): void {
    this.boundTouchMove = (e: TouchEvent) => this.zone.run(() => this.onTouchMove(e));
    this.el.nativeElement.addEventListener('touchmove', this.boundTouchMove, { passive: false });
    this._fsHandler = () => this.zone.run(() => {
      if (!document.fullscreenElement) this.isFullscreen.set(false);
    });
    document.addEventListener('fullscreenchange', this._fsHandler);
  }

  thumbnailUrl(file: DriveFile): string {
    return file.thumbnail_url ?? `/api/files/${file.id}/thumbnail`;
  }

  toggleThumbnailBar(): void {
    this.thumbnailBarOpen.update(v => !v);
    if (this.thumbnailBarOpen()) {
      setTimeout(() => this.scrollThumbToCenter(), 0);
    }
  }

  private scrollThumbToCenter(): void {
    const strip = this.thumbStrip?.nativeElement;
    if (!strip) return;
    const idx = this.currentIndex();
    const thumb = strip.children[idx] as HTMLElement | undefined;
    if (!thumb) return;
    const stripW = strip.offsetWidth;
    const thumbLeft = thumb.offsetLeft;
    const thumbW = thumb.offsetWidth;
    strip.scrollTo({ left: thumbLeft - stripW / 2 + thumbW / 2, behavior: 'smooth' });
  }

  onImageLoad(): void { this.isLoading.set(false); }
  onImageError(): void { this.isLoading.set(false); this.previewFailed.set(true); }

  onFolderSelected(folder: DriveFile): void {
    this.moveFile.emit({ file: this.file(), folderId: folder.id });
    this.folderPanelOpen.set(false);
  }

  cancelAllPending(): void {
    this.clearPending();
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.clearPending();
    if (this.sessionSavedTimer) clearTimeout(this.sessionSavedTimer);
    if (this.boundTouchMove) {
      this.el.nativeElement.removeEventListener('touchmove', this.boundTouchMove);
    }
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft': this.prev.emit(); break;
      case 'ArrowRight': this.next.emit(); break;
      case 'Escape': this.requestClose(); break;
      case 'Delete': this.initiateDelete(); break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case '+': case '=': this.zoomIn(); break;
      case '-': this.zoomOut(); break;
    }
  }

  onTouchStart(e: TouchEvent): void {
    this.isTwoFingerTouch.set(e.touches.length >= 2);
    if (e.touches.length === 2) {
      this.isPinching = true;
      this.isSwiping = false;
      const [t1, t2] = [e.touches[0], e.touches[1]];
      this.pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      this.pinchStartZoom = this.zoom();
      this.pinchStartMidX = (t1.clientX + t2.clientX) / 2;
      this.pinchStartMidY = (t1.clientY + t2.clientY) / 2;
      this.pinchStartTx = this.swipeOffsetX();
      this.pinchStartTy = this.swipeOffsetY();
      const rect = (this.el.nativeElement.querySelector('.media-area') as HTMLElement)?.getBoundingClientRect();
      this.pinchCx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      this.pinchCy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      return;
    }
    const t = e.touches[0];
    this.touchStartX = t.clientX;
    this.touchStartY = t.clientY;
    this.touchCurrentX = t.clientX;
    this.touchCurrentY = t.clientY;
    this.touchStartTime = Date.now();
    this.isSwiping = true;
    this.isTransitioning.set(false);
  }

  onTouchMove(e: TouchEvent): void {
    if (this.isPdf()) {
      // Only track horizontal movement; don't preventDefault so PDF scrolls vertically
      if (!this.isSwiping) return;
      const t = e.touches[0];
      const dx = t.clientX - this.touchStartX;
      const dy = t.clientY - this.touchStartY;
      if (Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
        this.touchCurrentX = t.clientX;
        this.swipeOffsetX.set(dx);
      }
      return;
    }
    e.preventDefault();
    if (this.isPinching && e.touches.length === 2) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const newZoom = Math.min(Math.max(this.pinchStartZoom * (dist / this.pinchStartDist), 0.5), 4);
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      // Keep the image point under the pinch focal point fixed as zoom changes
      const imageX = (this.pinchStartMidX - this.pinchCx - this.pinchStartTx) / this.pinchStartZoom;
      const imageY = (this.pinchStartMidY - this.pinchCy - this.pinchStartTy) / this.pinchStartZoom;
      const newTx = midX - this.pinchCx - imageX * newZoom;
      const newTy = midY - this.pinchCy - imageY * newZoom;
      this.zoom.set(newZoom);
      this.swipeOffsetX.set(newTx);
      this.swipeOffsetY.set(newTy);
      return;
    }
    if (!this.isSwiping) return;
    const t = e.touches[0];
    this.touchCurrentX = t.clientX;
    this.touchCurrentY = t.clientY;

    // While zoomed in, don't drag the whole image off-screen via swipe gestures
    if (this.zoom() > 1) return;

    const dx = t.clientX - this.touchStartX;
    const dy = t.clientY - this.touchStartY;

    if (Math.abs(dy) > Math.abs(dx)) {
      this.swipeOffsetY.set(dy);
      this.swipeOffsetX.set(0);
    } else {
      this.swipeOffsetX.set(dx);
      this.swipeOffsetY.set(0);
    }
  }

  onTouchEnd(e?: TouchEvent): void {
    if (!e || e.touches.length === 0) this.isTwoFingerTouch.set(false);
    if (this.isPdf()) {
      if (!this.isSwiping) return;
      this.isSwiping = false;
      const dx = this.touchCurrentX - this.touchStartX;
      this.isTransitioning.set(true);
      if (Math.abs(dx) > 80) {
        if (dx < 0 && this.hasNext()) {
          this.swipeOffsetX.set(-window.innerWidth);
          setTimeout(() => { this.swipeOffsetX.set(0); this.isTransitioning.set(false); this.next.emit(); }, 250);
        } else if (dx > 0 && this.hasPrev()) {
          this.swipeOffsetX.set(window.innerWidth);
          setTimeout(() => { this.swipeOffsetX.set(0); this.isTransitioning.set(false); this.prev.emit(); }, 250);
        } else {
          this.swipeOffsetX.set(0);
          this.isTransitioning.set(false);
        }
      } else {
        this.swipeOffsetX.set(0);
        this.isTransitioning.set(false);
      }
      return;
    }
    if (this.isPinching) {
      if (!e || e.touches.length < 2) {
        this.isPinching = false;
        if (this.zoom() <= 1) {
          this.zoom.set(1);
          this.swipeOffsetX.set(0);
          this.swipeOffsetY.set(0);
        }
      }
      return;
    }
    if (!this.isSwiping) return;
    this.isSwiping = false;

    // While zoomed in, swipe gestures are disabled
    if (this.zoom() > 1) {
      this.swipeOffsetX.set(0);
      this.swipeOffsetY.set(0);
      return;
    }

    const dx = this.touchCurrentX - this.touchStartX;
    const dy = this.touchCurrentY - this.touchStartY;

    this.isTransitioning.set(true);

    if (Math.abs(dy) > Math.abs(dx) && dy > 120) {
      // Swipe down → show folder picker
      this.swipeOffsetY.set(0);
      this.isTransitioning.set(false);
      this.folderPanelOpen.set(true);
    } else if (Math.abs(dy) > Math.abs(dx) && dy < -150) {
      // Swipe up to delete
      this.swipeOffsetY.set(-window.innerHeight);
      setTimeout(() => {
        this.swipeOffsetY.set(0);
        this.isTransitioning.set(false);
        this.initiateDelete();
      }, 300);
    } else if (Math.abs(dx) > 80) {
      if (dx < 0 && this.hasNext()) {
        // Swipe left → next
        this.swipeOffsetX.set(-window.innerWidth);
        setTimeout(() => {
          this.swipeOffsetX.set(0);
          this.isTransitioning.set(false);
          this.next.emit();
        }, 250);
      } else if (dx > 0 && this.hasPrev()) {
        // Swipe right → prev
        this.swipeOffsetX.set(window.innerWidth);
        setTimeout(() => {
          this.swipeOffsetX.set(0);
          this.isTransitioning.set(false);
          this.prev.emit();
        }, 250);
      } else {
        this.swipeOffsetX.set(0);
        this.swipeOffsetY.set(0);
      }
    } else {
      this.swipeOffsetX.set(0);
      this.swipeOffsetY.set(0);
      // Tap detection: short touch with minimal movement → toggle fullscreen
      const elapsed = Date.now() - this.touchStartTime;
      const moved = Math.abs(this.touchCurrentX - this.touchStartX) + Math.abs(this.touchCurrentY - this.touchStartY);
      if (elapsed < 280 && moved < 12 && !this.isTwoFingerTouch()) {
        this.toggleFullscreen();
      }
    }
  }

  toggleFullscreen(): void {
    if (this.isFullscreen()) {
      this.isFullscreen.set(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } else {
      this.isFullscreen.set(true);
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    }
  }

  requestClose(): void {
    this.alive = false;
    this.isFullscreen.set(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.flushPending();
    this.close.emit();
  }

  private flushPending(): void {
    if (this.pendingInterval !== null) {
      clearInterval(this.pendingInterval);
      this.pendingInterval = null;
    }
    if (this.pendingFile) {
      this.delete.emit(this.pendingFile);
      this.pendingFile = null;
    }
  }

  private clearPending(): void {
    if (this.pendingInterval !== null) {
      clearInterval(this.pendingInterval);
      this.pendingInterval = null;
    }
    this.pendingFile = null;
    this.deletePhase.set('idle');
    this.countdown.set(10);
    this.pendingDeleteFile.set(null);
  }

  initiateDelete(): void {
    // Immediately confirm any in-progress delete before starting a new one
    this.flushPending();

    const file = this.file();
    this.pendingFile = file;
    this.pendingDeleteFile.set(file);
    this.deleteStart.emit(file);
    this.deletePhase.set('countdown');
    this.countdown.set(5);
    let c = 5;
    this.pendingInterval = setInterval(() => {
      if (!this.alive) return;
      c--;
      if (c <= 0) {
        clearInterval(this.pendingInterval!);
        this.pendingInterval = null;
        this.pendingFile = null;
        this.delete.emit(file);
        this.deletePhase.set('idle');
        this.countdown.set(10);
        this.pendingDeleteFile.set(null);
      } else {
        this.countdown.set(c);
      }
    }, 1000);
  }

  cancelDelete(): void {
    this.clearPending();
  }

  onSaveSession(): void {
    this.saveSession.emit();
    this.sessionSaved.set(true);
    if (this.sessionSavedTimer) clearTimeout(this.sessionSavedTimer);
    this.sessionSavedTimer = setTimeout(() => this.sessionSaved.set(false), 2000);
  }

  zoomIn(): void { this.zoom.update(z => Math.min(z + 0.25, 4)); }
  zoomOut(): void { this.zoom.update(z => Math.max(z - 0.25, 0.25)); }
  resetZoom(): void { this.zoom.set(1); }

  mediaTransform(): string {
    const x = this.swipeOffsetX();
    const y = this.swipeOffsetY();
    const z = this.zoom();
    return `translate(${x}px, ${y}px) scale(${z})`;
  }

  countdownPercent(): number {
    return (this.countdown() / 5) * 100;
  }
}
