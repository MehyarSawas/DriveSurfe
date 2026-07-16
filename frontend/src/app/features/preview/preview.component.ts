import {
  Component, input, output, signal, computed,
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
  host: { '(window:keydown)': 'onKeyDown($event)' },
})
export class PreviewComponent implements OnDestroy, AfterViewInit {
  @ViewChild('mediaEl') mediaEl?: ElementRef<HTMLElement>;
  @ViewChild('thumbStrip') thumbStrip?: ElementRef<HTMLElement>;

  readonly file = input.required<DriveFile>();
  readonly hasPrev = input(false);
  readonly hasNext = input(false);
  readonly currentFolderId = input('');
  readonly breadcrumb = input<{id: string; name: string}[]>([]);
  readonly recentFolder = input<{id: string; name: string; path: string} | null>(null);
  readonly files = input<DriveFile[]>([]);
  readonly loadingMore = input(false);
  readonly currentIndex = input(0);
  readonly sessionLoading = input(false);
  readonly isShared = input(false);

  readonly stencilBlocks = computed(() => this.loadingMore() ? new Array(30) : []);

  readonly close = output<void>();
  readonly prev = output<void>();
  readonly next = output<void>();
  readonly jumpTo = output<DriveFile>();
  readonly saveSession = output<void>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly deleteStart = output<DriveFile>();
  readonly delete = output<DriveFile>();
  readonly undoDelete = output<string>();
  readonly moveStart = output<DriveFile>();
  readonly undoMove = output<string>();
  readonly moveFile = output<{file: DriveFile, folderId: string}>();
  readonly moveFilePath = output<string>();
  readonly rename = output<DriveFile>();
  readonly copy = output<DriveFile>();
  readonly share = output<DriveFile>();
  readonly info = output<DriveFile>();
  readonly stripScrolled = output<{from: number, to: number}>();
  readonly createFolder = output<{parentId: string, name: string, then: (f: DriveFile) => void}>();

  readonly zoom = signal(1);
  readonly isLoading = signal(false);
  readonly previewFailed = signal(false);
  // Set when native <video> playback fails (unsupported codec, e.g. old
  // MPEG-4 Visual / mp4v that Safari can't decode). We then reload the source
  // from the server's on-the-fly H.264 transcode endpoint. Reset per file.
  readonly videoTranscoding = signal(false);
  // True once the (possibly transcoded) video can actually play — hides the
  // "Converting…" overlay. Reset per file.
  readonly videoReady = signal(false);
  readonly deletePhase = signal<DeletePhase>('idle');
  readonly countdown = signal(10);
  readonly folderPanelOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly titlePopupOpen = signal(false);
  readonly thumbnailBarOpen = signal(false);
  readonly thumbScrollLeft = signal(0);
  readonly thumbAtEnd = signal(false);
  readonly sessionSaved = signal(false);
  private sessionSavedTimer: ReturnType<typeof setTimeout> | null = null;
  readonly isFullscreen = signal(false);
  private _fsHandler!: () => void;

  // Slideshow autoplay — images dwell for AUTOPLAY_MS; videos play through and
  // advance when they end (a duration-based timer is the fallback if the
  // 'ended' event never fires, e.g. blocked autoplay).
  readonly autoplayOn = signal(false);
  private autoplayTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly AUTOPLAY_MS = 3500;
  @ViewChild('videoEl') private videoEl?: ElementRef<HTMLVideoElement>;

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
  private lastTapTime = 0; // for double-tap-to-fullscreen detection
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

  private pendingMoveInterval: ReturnType<typeof setInterval> | null = null;
  readonly pendingMoveFile = signal<DriveFile | null>(null);
  private pendingMoveFolderId: string | null = null;
  private pendingMoveFolderPath = '';
  readonly moveCountdown = signal(5);
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
    if (this.isVideo()) {
      return this.videoTranscoding()
        ? `/api/files/${f.id}/transcode`
        : `/api/files/${f.id}/download`;
    }
    return this.imagePreviewUrl(f.id);
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
      this.titlePopupOpen.set(false);
      this.isPinching = false;
      this.isSwiping = false;
      if (isNewFile) {
        this.previewFailed.set(false);
        this.videoTranscoding.set(false);
        this.videoReady.set(false);
        if (!this.isVideo() && !this.isPdf()) this.isLoading.set(true);
        if (!this.pendingInterval) {
          this.deletePhase.set('idle');
          this.countdown.set(10);
          this.pendingDeleteFile.set(null);
        }
        // Slideshow: (re)schedule the advance for the new item — image dwell,
        // or wait for the video to play through.
        if (this.autoplayOn()) this.scheduleAutoAdvance();
      }
    });

    effect(() => {
      this.currentIndex();
      if (this.thumbnailBarOpen()) {
        requestAnimationFrame(() => this.scrollThumbToCenter());
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
      // 'instant' so the strip never renders at position 0 before jumping
      requestAnimationFrame(() => this.scrollThumbToCenter('instant'));
    }
  }

  private scrollThumbToCenter(behavior: ScrollBehavior = 'smooth'): void {
    const strip = this.thumbStrip?.nativeElement;
    if (!strip) return;
    if (!strip.offsetWidth) {
      requestAnimationFrame(() => this.scrollThumbToCenter(behavior));
      return;
    }
    const idx = this.currentIndex();
    const thumb = strip.children[idx] as HTMLElement | undefined;
    if (!thumb) return;
    const stripW = strip.offsetWidth;
    const thumbLeft = thumb.offsetLeft;
    const thumbW = thumb.offsetWidth;
    strip.scrollTo({ left: thumbLeft - stripW / 2 + thumbW / 2, behavior });
    this.updateThumbScrollState(strip);
  }

  scrollThumbBy(px: number): void {
    const strip = this.thumbStrip?.nativeElement;
    if (!strip) return;
    strip.scrollBy({ left: px, behavior: 'smooth' });
  }

  onThumbScroll(): void {
    const strip = this.thumbStrip?.nativeElement;
    if (!strip) return;
    this.updateThumbScrollState(strip);
    const thumbW = 68;
    const from = Math.floor(strip.scrollLeft / thumbW);
    const to = Math.min(Math.ceil((strip.scrollLeft + strip.clientWidth) / thumbW), this.files().length - 1);
    this.stripScrolled.emit({ from, to });
  }

  private updateThumbScrollState(strip: HTMLElement): void {
    this.thumbScrollLeft.set(strip.scrollLeft);
    this.thumbAtEnd.set(strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4);
  }

  isNearCurrent(i: number): boolean {
    if (Math.abs(i - this.currentIndex()) <= 10) return true;
    // Also render thumbnails in the strip's visible scroll window + a small buffer
    const thumbW = 68;
    const stripFrom = Math.floor(this.thumbScrollLeft() / thumbW) - 3;
    const stripTo = stripFrom + Math.ceil((this.thumbStrip?.nativeElement?.clientWidth ?? 600) / thumbW) + 6;
    return i >= stripFrom && i <= stripTo;
  }

  onImageLoad(): void { this.isLoading.set(false); }
  onImageError(): void { this.isLoading.set(false); this.previewFailed.set(true); }

  // Native <video> couldn't play the source. If we haven't already, retry via
  // the server's on-the-fly H.264 transcode (handles old mp4v/DivX-era files
  // Safari can't decode). If the transcode source also fails, give up quietly.
  onVideoError(): void {
    if (!this.isVideo()) return;
    if (this.videoTranscoding()) {
      // Transcode source also failed (no ffmpeg / conversion error) — give up
      // and offer a download instead of spinning forever.
      this.previewFailed.set(true);
      return; // slideshow's fixed dwell timer already advances past it
    }
    this.videoReady.set(false);
    this.videoTranscoding.set(true);
  }

  onVideoReady(): void { this.videoReady.set(true); this.isLoading.set(false); }

  onFolderSelected(folder: DriveFile): void {
    this.flushPendingMove();
    const file = this.file();
    this.folderPanelOpen.set(false);
    this.pendingMoveFile.set(file);
    this.pendingMoveFolderId = folder.id;
    this.moveStart.emit(file);
    this.moveCountdown.set(5);
    let c = 5;
    this.pendingMoveInterval = setInterval(() => {
      if (!this.alive) return;
      c--;
      if (c <= 0) {
        clearInterval(this.pendingMoveInterval!);
        this.pendingMoveInterval = null;
        this.pendingMoveFolderId = null;
        this.moveFile.emit({ file, folderId: folder.id });
        this.moveFilePath.emit(this.pendingMoveFolderPath);
        this.pendingMoveFile.set(null);
        this.moveCountdown.set(5);
      } else {
        this.moveCountdown.set(c);
      }
    }, 1000);
  }

  onFolderPath(path: string): void {
    this.pendingMoveFolderPath = path;
  }

  cancelMove(): void {
    const fileId = this.pendingMoveFile()?.id;
    if (this.pendingMoveInterval !== null) {
      clearInterval(this.pendingMoveInterval);
      this.pendingMoveInterval = null;
    }
    this.pendingMoveFile.set(null);
    this.pendingMoveFolderId = null;
    this.moveCountdown.set(5);
    if (fileId) this.undoMove.emit(fileId);
  }

  private flushPendingMove(): void {
    if (this.pendingMoveInterval !== null) {
      clearInterval(this.pendingMoveInterval);
      this.pendingMoveInterval = null;
    }
    const pf = this.pendingMoveFile();
    const fid = this.pendingMoveFolderId;
    if (pf && fid) {
      this.moveFile.emit({ file: pf, folderId: fid });
      this.moveFilePath.emit(this.pendingMoveFolderPath);
    }
    this.pendingMoveFile.set(null);
    this.pendingMoveFolderId = null;
    this.pendingMoveFolderPath = '';
    this.moveCountdown.set(5);
  }

  cancelAllPending(): void {
    this.clearPending();
    this.cancelMove();
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.stopAutoplay();
    this.clearPending();
    if (this.sessionSavedTimer) clearTimeout(this.sessionSavedTimer);
    if (this.boundTouchMove) {
      this.el.nativeElement.removeEventListener('touchmove', this.boundTouchMove);
    }
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft': this.prev.emit(); break;
      case 'ArrowRight': this.next.emit(); break;
      case 'Escape': if (this.menuOpen()) { this.menuOpen.set(false); } else if (this.titlePopupOpen()) { this.titlePopupOpen.set(false); } else { this.requestClose(); } break;
      case 'Delete': this.initiateDelete(); break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case '+': case '=': this.zoomIn(); break;
      case '-': this.zoomOut(); break;
    }
  }

  onTouchStart(e: TouchEvent): void {
    if (this.menuOpen()) { this.menuOpen.set(false); this.isSwiping = false; return; }
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
    // Pinch handled for all file types
    if (this.isPinching && e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const newZoom = Math.min(Math.max(this.pinchStartZoom * (dist / this.pinchStartDist), 0.5), 4);
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      const imageX = (this.pinchStartMidX - this.pinchCx - this.pinchStartTx) / this.pinchStartZoom;
      const imageY = (this.pinchStartMidY - this.pinchCy - this.pinchStartTy) / this.pinchStartZoom;
      const newTx = midX - this.pinchCx - imageX * newZoom;
      const newTy = midY - this.pinchCy - imageY * newZoom;
      this.zoom.set(newZoom);
      this.swipeOffsetX.set(newTx);
      this.swipeOffsetY.set(newTy);
      return;
    }

    if (this.isPdf()) {
      // Single finger on PDF: only track horizontal for swipe-to-navigate; vertical scrolls natively
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

    if (!this.isPinching && !this.isSwiping) return;
    e.preventDefault();
    if (!this.isSwiping) return;
    const t = e.touches[0];
    this.touchCurrentX = t.clientX;
    this.touchCurrentY = t.clientY;

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
      const elapsed = Date.now() - this.touchStartTime;
      const flickX = Math.abs(dx) / elapsed >= 0.3 && Math.abs(dx) >= 20;
      this.isTransitioning.set(true);
      if (Math.abs(dx) > 60 || flickX) {
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
    const elapsed = Date.now() - this.touchStartTime;
    const vx = Math.abs(dx) / elapsed; // px/ms
    const vy = Math.abs(dy) / elapsed;

    // Quick flick: velocity ≥ 0.3 px/ms with at least 20px travel
    const flickX = vx >= 0.3 && Math.abs(dx) >= 20;
    const flickY = vy >= 0.3 && Math.abs(dy) >= 20;

    this.isTransitioning.set(true);

    if (Math.abs(dy) > Math.abs(dx) && (dy > 80 || (flickY && dy > 0))) {
      // Swipe down → show folder picker
      this.swipeOffsetY.set(0);
      this.isTransitioning.set(false);
      this.folderPanelOpen.set(true);
    } else if (Math.abs(dy) > Math.abs(dx) && (dy < -100 || (flickY && dy < 0))) {
      // Swipe up to delete
      this.swipeOffsetY.set(-window.innerHeight);
      setTimeout(() => {
        this.swipeOffsetY.set(0);
        this.isTransitioning.set(false);
        this.initiateDelete();
      }, 300);
    } else if (Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 60 || flickX)) {
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
      // Tap detection: a short touch with minimal movement is a tap. TWO taps
      // in quick succession (double-tap) toggle fullscreen; a single tap does
      // nothing, so an accidental tap no longer flips fullscreen.
      const moved = Math.abs(this.touchCurrentX - this.touchStartX) + Math.abs(this.touchCurrentY - this.touchStartY);
      if (elapsed < 280 && moved < 12 && !this.isTwoFingerTouch()) {
        const now = Date.now();
        if (now - this.lastTapTime < 300) {
          this.toggleFullscreen();
          this.lastTapTime = 0; // consumed — a third tap starts fresh
        } else {
          this.lastTapTime = now;
        }
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

  /** Toggle the slideshow. Images auto-advance after a fixed dwell; videos play
   *  through and advance when they finish. */
  toggleAutoplay(): void {
    if (this.autoplayOn()) { this.stopAutoplay(); return; }
    if (!this.hasNext()) return; // nothing to advance to
    this.autoplayOn.set(true);
    this.scheduleAutoAdvance(); // the file-change effect handles later items
  }

  private stopAutoplay(): void {
    this.autoplayOn.set(false);
    this.clearAutoplayTimer();
  }

  private clearAutoplayTimer(): void {
    if (this.autoplayTimer) { clearTimeout(this.autoplayTimer); this.autoplayTimer = null; }
  }

  /** Every item (image or video) dwells for a fixed time, then advances.
   *  A video is forced to play (muted, so the browser's autoplay policy allows
   *  it) for those seconds instead of showing a static frame. */
  private scheduleAutoAdvance(): void {
    this.clearAutoplayTimer();
    if (!this.autoplayOn()) return;
    if (this.isVideo()) this.playCurrentVideo();
    this.autoplayTimer = setTimeout(() => this.autoAdvance(), PreviewComponent.AUTOPLAY_MS);
  }

  /** Force the current <video> to start playing during a slideshow. Muted, so
   *  browsers don't block programmatic autoplay without a user gesture. */
  private playCurrentVideo(): void {
    const v = this.videoEl?.nativeElement;
    if (!v) return;
    v.muted = true;
    try { v.currentTime = 0; } catch { /* not seekable yet */ }
    v.play().catch(() => { /* still blocked — the frame just shows for the dwell */ });
  }

  private autoAdvance(): void {
    if (!this.autoplayOn()) return;
    if (this.hasNext()) this.next.emit();
    else this.stopAutoplay(); // reached the end
  }

  /** Video element ready — kick off playback if a slideshow is running (the
   *  element may not have existed yet when the item was first scheduled). */
  onVideoMeta(): void { if (this.autoplayOn() && this.isVideo()) this.playCurrentVideo(); }

  onTitleClick(el: HTMLElement): void {
    if (el.scrollWidth > el.offsetWidth) {
      this.titlePopupOpen.update(v => !v);
    }
  }

  requestClose(): void {
    this.alive = false;
    this.stopAutoplay();
    this.isFullscreen.set(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.flushPending();
    this.flushPendingMove();
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
    const fileId = this.pendingDeleteFile()?.id;
    this.clearPending();
    if (fileId) this.undoDelete.emit(fileId);
  }

  onSaveSession(): void {
    this.saveSession.emit();
    this.sessionSaved.set(true);
    if (this.sessionSavedTimer) clearTimeout(this.sessionSavedTimer);
    this.sessionSavedTimer = setTimeout(() => this.sessionSaved.set(false), 2000);
  }

  zoomIn(): void { this.zoom.update(z => Math.min(z + 0.25, 4)); }
  zoomOut(): void { this.zoom.update(z => Math.max(z - 0.25, 0.25)); }
  resetZoom(): void { this.zoom.set(1); this.swipeOffsetX.set(0); this.swipeOffsetY.set(0); }

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
