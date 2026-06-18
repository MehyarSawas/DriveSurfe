import { Component, input, output } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { DriveFile } from '../../../../core/models/drive-file.model';

@Component({
  selector: 'ds-file-list',
  standalone: true,
  imports: [CommonModule, DatePipe],
  templateUrl: './file-list.component.html',
  styleUrls: ['./file-list.component.scss'],
})
export class FileListComponent {
  readonly files = input.required<DriveFile[]>();
  readonly selectedIds = input<Set<string>>(new Set());

  readonly fileClick = output<DriveFile>();
  readonly fileDblClick = output<DriveFile>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly delete = output<DriveFile>();

  readonly failedThumbs = new Set<string>();

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
