import {
  Component, input, output, signal, computed, HostListener,
  ElementRef, ViewChild, OnDestroy, effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DriveFile } from '../../core/models/drive-file.model';

type DeletePhase = 'idle' | 'confirming' | 'countdown';

@Component({
  selector: 'ds-preview',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './preview.component.html',
  styleUrls: ['./preview.component.scss'],
})
export class PreviewComponent implements OnDestroy {
  @ViewChild('mediaEl') mediaEl?: ElementRef<HTMLElement>;

  readonly file = input.required<DriveFile>();
  readonly hasPrev = input(false);
  readonly hasNext = input(false);
  readonly folderDirs = input<DriveFile[]>([]);
  readonly currentFolderId = input('');

  readonly close = output<void>();
  readonly prev = output<void>();
  readonly next = output<void>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly delete = output<DriveFile>();
  readonly moveFile = output<{file: DriveFile, folderId: string}>();
  readonly createFolder = output<{parentId: string, name: string, then: (f: DriveFile) => void}>();

  readonly zoom = signal(1);
  readonly isLoading = signal(false);
  readonly deletePhase = signal<DeletePhase>('idle');
  readonly countdown = signal(10);
  readonly folderPanelOpen = signal(false);
  readonly newFolderInputOpen = signal(false);
  readonly newFolderName = signal('');
  readonly localExtraFolders = signal<DriveFile[]>([]);
  readonly allFolderDirs = computed(() => [...this.folderDirs(), ...this.localExtraFolders()]);

  // Swipe state
  private touchStartX = 0;
  private touchStartY = 0;
  private touchCurrentX = 0;
  private touchCurrentY = 0;
  private isSwiping = false;

  readonly swipeOffsetX = signal(0);
  readonly swipeOffsetY = signal(0);
  readonly isTransitioning = signal(false);

  private countdownInterval?: ReturnType<typeof setInterval>;
  private pendingDeleteFile: DriveFile | null = null;

  readonly isImage = computed(() => {
    const f = this.file();
    return f.mime_type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','heic','heif'].includes(f.extension);
  });

  readonly isVideo = computed(() => {
    const f = this.file();
    return f.mime_type.startsWith('video/') || ['mp4','mov','m4v'].includes(f.extension);
  });

  readonly previewSrc = computed(() => {
    const f = this.file();
    return this.isVideo() ? `/api/files/${f.id}/download` : `/api/files/${f.id}/preview`;
  });

  constructor() {
    effect(() => {
      this.file();
      this.zoom.set(1);
      this.swipeOffsetX.set(0);
      this.swipeOffsetY.set(0);
      this.folderPanelOpen.set(false);
      this.newFolderInputOpen.set(false);
      this.newFolderName.set('');
      if (this.isImage()) this.isLoading.set(true);
    });
  }

  onImageLoad(): void { this.isLoading.set(false); }
  onImageError(): void { this.isLoading.set(false); }

  moveToFolder(folder: DriveFile): void {
    this.moveFile.emit({ file: this.file(), folderId: folder.id });
    this.folderPanelOpen.set(false);
  }

  submitNewFolder(): void {
    const name = this.newFolderName().trim();
    if (!name) return;
    this.createFolder.emit({
      parentId: this.currentFolderId(),
      name,
      then: (folder) => {
        this.localExtraFolders.update(f => [...f, folder]);
        this.moveToFolder(folder);
      }
    });
    this.newFolderInputOpen.set(false);
    this.newFolderName.set('');
  }

  ngOnDestroy(): void {
    this.clearCountdown();
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft': this.prev.emit(); break;
      case 'ArrowRight': this.next.emit(); break;
      case 'Escape': this.close.emit(); break;
      case 'Delete': this.initiateDelete(); break;
      case '+': case '=': this.zoomIn(); break;
      case '-': this.zoomOut(); break;
    }
  }

  onTouchStart(e: TouchEvent): void {
    const t = e.touches[0];
    this.touchStartX = t.clientX;
    this.touchStartY = t.clientY;
    this.touchCurrentX = t.clientX;
    this.touchCurrentY = t.clientY;
    this.isSwiping = true;
    this.isTransitioning.set(false);
  }

  onTouchMove(e: TouchEvent): void {
    if (!this.isSwiping) return;
    const t = e.touches[0];
    this.touchCurrentX = t.clientX;
    this.touchCurrentY = t.clientY;

    const dx = t.clientX - this.touchStartX;
    const dy = t.clientY - this.touchStartY;

    if (Math.abs(dy) > Math.abs(dx)) {
      // Vertical swipe — only track upward
      if (dy < 0) {
        this.swipeOffsetY.set(dy);
        this.swipeOffsetX.set(0);
        e.preventDefault();
      }
    } else {
      // Horizontal swipe
      this.swipeOffsetX.set(dx);
      this.swipeOffsetY.set(0);
      e.preventDefault();
    }
  }

  onTouchEnd(): void {
    if (!this.isSwiping) return;
    this.isSwiping = false;

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
    }
  }

  initiateDelete(): void {
    if (this.deletePhase() === 'countdown' && this.pendingDeleteFile) {
      // Confirm the previous pending delete immediately, then start fresh
      this.clearCountdown();
      this.delete.emit(this.pendingDeleteFile);
    }
    this.pendingDeleteFile = this.file();
    this.deletePhase.set('countdown');
    this.countdown.set(10);
    this.countdownInterval = setInterval(() => {
      const c = this.countdown() - 1;
      if (c <= 0) {
        this.clearCountdown();
        this.delete.emit(this.pendingDeleteFile!);
        this.pendingDeleteFile = null;
        this.deletePhase.set('idle');
      } else {
        this.countdown.set(c);
      }
    }, 1000);
  }

  cancelDelete(): void {
    this.clearCountdown();
    this.deletePhase.set('idle');
    this.countdown.set(10);
    this.pendingDeleteFile = null;
  }

  private clearCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = undefined;
    }
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
    return (this.countdown() / 10) * 100;
  }
}
