import { Component, input, output, HostListener, ElementRef, NgZone, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { DriveFile } from '../../../../core/models/drive-file.model';

@Component({
  selector: 'ds-file-list',
  standalone: true,
  imports: [CommonModule, DatePipe],
  templateUrl: './file-list.component.html',
  styleUrls: ['./file-list.component.scss'],
})
export class FileListComponent implements AfterViewInit, OnDestroy {
  readonly files = input.required<DriveFile[]>();
  readonly selectedIds = input<Set<string>>(new Set());
  readonly trash = input(false);

  readonly fileClick = output<DriveFile>();
  readonly fileDblClick = output<DriveFile>();
  readonly selectToggle = output<DriveFile>();
  readonly restore = output<DriveFile>();
  readonly move = output<DriveFile>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly delete = output<DriveFile>();

  readonly failedThumbs = new Set<string>();
  openMenuId: string | null = null;

  private isDragSelecting = false;
  private dragOrder: string[] = [];
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
    e.preventDefault(); // stop synthetic click from double-toggling
    e.stopPropagation();
    this.isDragSelecting = true;
    this.dragOrder = [file.id];
    this.selectToggle.emit(file); // always toggle on initial tap (select or deselect)
  }

  private onDragMove(e: TouchEvent): void {
    if (!this.isDragSelecting) return;
    e.preventDefault();
    const touch = e.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const row = target?.closest('[data-file-id]') as HTMLElement | null;
    if (!row) return;
    const fileId = row.dataset['fileId'];
    if (!fileId) return;

    const idx = this.dragOrder.indexOf(fileId);
    if (idx === -1) {
      this.dragOrder.push(fileId);
      const file = this.files().find(f => f.id === fileId);
      if (file && !this.isSelected(file.id)) this.selectToggle.emit(file);
    } else {
      const toDeselect = this.dragOrder.splice(idx + 1);
      for (const id of toDeselect) {
        const file = this.files().find(f => f.id === id);
        if (file && this.isSelected(file.id)) this.selectToggle.emit(file);
      }
    }
  }

  private onDragEnd(): void {
    this.isDragSelecting = false;
    this.dragOrder = [];
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
