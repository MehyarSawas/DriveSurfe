import { Component, input, output, HostListener, ElementRef, NgZone, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriveFile } from '../../../../core/models/drive-file.model';

@Component({
  selector: 'ds-file-grid',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './file-grid.component.html',
  styleUrls: ['./file-grid.component.scss'],
})
export class FileGridComponent implements AfterViewInit, OnDestroy {
  readonly files = input.required<DriveFile[]>();
  readonly selectedIds = input<Set<string>>(new Set());
  readonly trash = input(false);

  readonly fileClick = output<DriveFile>();
  readonly selectToggle = output<DriveFile>();
  readonly restore = output<DriveFile>();
  readonly rename = output<DriveFile>();
  readonly move = output<DriveFile>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly delete = output<DriveFile>();

  readonly failedThumbs = new Set<string>();
  openMenuId: string | null = null;

  private isDragSelecting = false;
  private dragVisited = new Set<string>();
  private boundDragMove!: (e: TouchEvent) => void;
  private boundDragEnd!: () => void;

  constructor(private el: ElementRef, private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.boundDragMove = (e: TouchEvent) => this.zone.run(() => this.onDragMove(e));
    this.boundDragEnd  = () => this.zone.run(() => this.onDragEnd());
    this.el.nativeElement.addEventListener('touchmove', this.boundDragMove, { passive: false });
    this.el.nativeElement.addEventListener('touchend',  this.boundDragEnd);
  }

  ngOnDestroy(): void {
    this.el.nativeElement.removeEventListener('touchmove', this.boundDragMove);
    this.el.nativeElement.removeEventListener('touchend',  this.boundDragEnd);
  }

  onSelectTouchStart(e: TouchEvent, file: DriveFile): void {
    e.stopPropagation();
    this.isDragSelecting = true;
    this.dragVisited.clear();
    this.dragVisited.add(file.id);
    if (!this.isSelected(file.id)) this.selectToggle.emit(file);
  }

  private onDragMove(e: TouchEvent): void {
    if (!this.isDragSelecting) return;
    e.preventDefault();
    const touch = e.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const card = target?.closest('[data-file-id]') as HTMLElement | null;
    if (card) {
      const fileId = card.dataset['fileId'];
      if (fileId && !this.dragVisited.has(fileId)) {
        this.dragVisited.add(fileId);
        const file = this.files().find(f => f.id === fileId);
        if (file && !this.isSelected(file.id)) this.selectToggle.emit(file);
      }
    }
  }

  private onDragEnd(): void {
    this.isDragSelecting = false;
    this.dragVisited.clear();
  }

  @HostListener('document:click')
  onDocClick(): void { this.openMenuId = null; }

  toggleMenu(e: Event, fileId: string): void {
    e.stopPropagation();
    this.openMenuId = this.openMenuId === fileId ? null : fileId;
  }

  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  isMedia(file: DriveFile): boolean {
    return !file.is_dir && (this.isImage(file) || this.isVideo(file));
  }

  isImage(file: DriveFile): boolean {
    return file.mime_type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','heic','heif'].includes(file.extension);
  }

  isVideo(file: DriveFile): boolean {
    return file.mime_type.startsWith('video/') || ['mp4','mov','m4v','avi','mkv'].includes(file.extension);
  }

  formatSize(bytes: number): string {
    if (bytes === 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }
}
