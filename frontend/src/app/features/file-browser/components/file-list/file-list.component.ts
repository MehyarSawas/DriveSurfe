import { Component, input, output, ElementRef, NgZone, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { DriveFile } from '../../../../core/models/drive-file.model';

@Component({
  selector: 'ds-file-list',
  standalone: true,
  imports: [CommonModule, DatePipe],
  templateUrl: './file-list.component.html',
  styleUrls: ['./file-list.component.scss'],
  host: { '(document:click)': 'onDocClick()' },
})
export class FileListComponent implements AfterViewInit, OnDestroy {
  readonly files = input.required<DriveFile[]>();
  readonly selectedIds = input<Set<string>>(new Set());
  readonly trash = input(false);
  readonly sharedIds = input<Set<string>>(new Set());

  readonly fileClick = output<DriveFile>();
  readonly fileDblClick = output<DriveFile>();
  readonly selectToggle = output<DriveFile>();
  readonly restore = output<DriveFile>();
  readonly rename = output<DriveFile>();
  readonly move = output<DriveFile>();
  readonly copy = output<DriveFile>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly delete = output<DriveFile>();
  readonly share = output<DriveFile>();

  isShared(id: string): boolean {
    return this.sharedIds().has(id);
  }

  readonly failedThumbs = new Set<string>();
  openMenuId: string | null = null;

  private isDragSelecting = false;
  private dragStartIdx = -1;
  private dragRange = new Set<string>();
  private lastTouchY = 0;
  private scrollInterval: ReturnType<typeof setInterval> | null = null;
  private boundDragMove!: (e: TouchEvent) => void;
  private boundDragEnd!: () => void;

  constructor(private el: ElementRef, private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.boundDragMove = (e: TouchEvent) => this.zone.run(() => this.onDragMove(e));
    this.boundDragEnd  = () => this.zone.run(() => this.onDragEnd());
    document.addEventListener('touchmove', this.boundDragMove, { passive: true });
    document.addEventListener('touchend',  this.boundDragEnd);
  }

  ngOnDestroy(): void {
    document.removeEventListener('touchmove', this.boundDragMove);
    document.removeEventListener('touchend',  this.boundDragEnd);
    this.stopAutoScroll();
  }

  onSelectTouchStart(e: TouchEvent, file: DriveFile): void {
    e.preventDefault(); // stop synthetic click from double-toggling
    e.stopPropagation();
    const alreadySelected = this.isSelected(file.id);
    if (alreadySelected) {
      this.isDragSelecting = false;
      this.selectToggle.emit(file);
      return;
    }
    this.isDragSelecting = true;
    this.dragStartIdx = this.files().findIndex(f => f.id === file.id);
    this.dragRange = new Set([file.id]);
    this.selectToggle.emit(file);
  }

  private onDragMove(e: TouchEvent): void {
    if (!this.isDragSelecting) return;
    // No preventDefault — allow native scroll to run simultaneously
    const touch = e.touches[0];
    this.lastTouchY = touch.clientY;
    this.updateAutoScroll(touch.clientY);

    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const row = target?.closest('[data-file-id]') as HTMLElement | null;
    if (!row) return;
    const fileId = row.dataset['fileId'];
    if (!fileId) return;

    const files = this.files();
    const currentIdx = files.findIndex(f => f.id === fileId);
    if (currentIdx === -1 || this.dragStartIdx === -1) return;

    const lo = Math.min(this.dragStartIdx, currentIdx);
    const hi = Math.max(this.dragStartIdx, currentIdx);
    const newRange = new Set(files.slice(lo, hi + 1).map(f => f.id));

    // Select files newly in range
    for (const id of newRange) {
      if (!this.dragRange.has(id)) {
        const file = files.find(f => f.id === id);
        if (file && !this.isSelected(id)) this.selectToggle.emit(file);
      }
    }
    // Deselect files that left the range
    for (const id of this.dragRange) {
      if (!newRange.has(id)) {
        const file = files.find(f => f.id === id);
        if (file && this.isSelected(id)) this.selectToggle.emit(file);
      }
    }

    this.dragRange = newRange;
  }

  private updateAutoScroll(clientY: number): void {
    const threshold = 80;
    const vH = window.innerHeight;
    const nearEdge = clientY < threshold || clientY > vH - threshold;
    if (nearEdge && !this.scrollInterval) {
      this.scrollInterval = setInterval(() => {
        const y = this.lastTouchY;
        const t = threshold;
        const speed = y < t
          ? -Math.round((t - y) / t * 12)
          : Math.round((y - (vH - t)) / t * 12);
        this.getScrollContainer()?.scrollBy(0, speed);
      }, 16);
    } else if (!nearEdge) {
      this.stopAutoScroll();
    }
  }

  private stopAutoScroll(): void {
    if (this.scrollInterval !== null) {
      clearInterval(this.scrollInterval);
      this.scrollInterval = null;
    }
  }

  private getScrollContainer(): Element | null {
    let el: Element | null = this.el.nativeElement.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
      el = el.parentElement;
    }
    return document.documentElement;
  }

  private onDragEnd(): void {
    this.isDragSelecting = false;
    this.dragStartIdx = -1;
    this.dragRange = new Set();
    this.stopAutoScroll();
  }

  onDocClick(): void { this.openMenuId = null; }

  toggleMenu(e: Event, fileId: string): void {
    e.stopPropagation();
    this.openMenuId = this.openMenuId === fileId ? null : fileId;
  }

  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  formatSize(bytes: number): string {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  fileTypeLabel(file: DriveFile): string {
    if (file.is_dir) return 'Folder';
    const ext = file.extension.toUpperCase();
    return ext || 'File';
  }
}
