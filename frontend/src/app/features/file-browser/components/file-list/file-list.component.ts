import { Component, input, output, signal, ElementRef, NgZone, AfterViewInit, OnDestroy } from '@angular/core';
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
  readonly pinnedIds = input<Set<string>>(new Set());
  readonly offlineIds = input<Set<string>>(new Set());
  /** While true, thumbnails not yet requested hold off starting — used
   *  while a share/download is racing to finish so new thumbnail fetches
   *  don't compete with it. Anything already loading/loaded is untouched
   *  (never cancelled); it just resumes issuing new ones once this flips
   *  back to false. */
  readonly pauseThumbnails = input(false);

  readonly fileClick = output<DriveFile>();
  readonly fileDblClick = output<DriveFile>();
  readonly selectToggle = output<DriveFile>();
  readonly restore = output<DriveFile>();
  readonly permanentDelete = output<DriveFile>();
  readonly rename = output<DriveFile>();
  readonly move = output<DriveFile>();
  readonly copy = output<DriveFile>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly delete = output<DriveFile>();
  readonly share = output<DriveFile>();
  readonly info = output<DriveFile>();
  readonly pin = output<DriveFile>();
  readonly offline = output<DriveFile>();

  isOffline(id: string): boolean {
    return this.offlineIds().has(id);
  }

  isPinned(id: string): boolean {
    return this.pinnedIds().has(id);
  }

  isShared(id: string): boolean {
    return this.sharedIds().has(id);
  }

  readonly failedThumbs = new Set<string>();
  /** Files whose thumbnail has already been assigned a real src — once a
   *  file is in here, thumbSrc() always returns its real URL, so a request
   *  already loading/loaded is never reset to '' (never cancelled). */
  private readonly startedThumbs = new Set<string>();
  /** Files whose <img> already fired (load) — i.e. genuinely finished, not
   *  just started. Used to tell "still mid-transfer" apart from "done"
   *  without ever inspecting img.complete/naturalWidth directly. */
  private readonly loadedThumbs = new Set<string>();
  /** Files whose thumbnail is currently interrupted — the @if in the
   *  template removes the <img> entirely for these, which is what actually
   *  cancels an in-flight request (no manual DOM/src mutation involved).
   *  Removing it from this set lets the @if recreate the element fresh, so
   *  there's no stale Angular binding cache to fight — a brand new element
   *  has no history. */
  private readonly interruptedThumbs = signal<ReadonlySet<string>>(new Set());
  openMenuId: string | null = null;

  /** Returns the thumbnail URL to bind, holding off files not yet started
   *  while pauseThumbnails() is true. See the field doc above. */
  thumbSrc(file: DriveFile): string {
    if (this.startedThumbs.has(file.id)) return file.thumbnail_url ?? '';
    if (this.pauseThumbnails()) return '';
    this.startedThumbs.add(file.id);
    return file.thumbnail_url ?? '';
  }

  /** Whether this file's <img> should exist in the DOM at all right now —
   *  false only while interrupted (see interruptLoadingThumbnails()). */
  thumbActive(id: string): boolean {
    return !this.interruptedThumbs().has(id);
  }

  onThumbLoad(id: string): void {
    this.loadedThumbs.add(id);
  }

  /** Interrupts thumbnails that are still mid-transfer (started but haven't
   *  fired (load) yet) by removing their <img> from the DOM via the
   *  template's @if — the browser cancels any in-flight request for an
   *  element that's removed. Thumbnails that already finished loading are
   *  left alone (no point re-fetching, and no visual disruption). Pair with
   *  resumeInterruptedThumbnails() once the share/download is done. */
  interruptLoadingThumbnails(): void {
    const toInterrupt = this.files()
      .filter(f => this.startedThumbs.has(f.id) && !this.loadedThumbs.has(f.id))
      .map(f => f.id);
    if (toInterrupt.length === 0) return;
    toInterrupt.forEach(id => this.startedThumbs.delete(id));
    this.interruptedThumbs.update(s => new Set([...s, ...toInterrupt]));
  }

  /** Brings back thumbnails interrupted by interruptLoadingThumbnails() —
   *  the @if recreates each <img> fresh, so thumbSrc() reissues its real
   *  URL on a brand-new element with no stale binding history. */
  resumeInterruptedThumbnails(): void {
    this.interruptedThumbs.set(new Set());
  }

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
