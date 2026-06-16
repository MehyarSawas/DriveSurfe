import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriveFile } from '../../../../core/models/drive-file.model';

@Component({
  selector: 'ds-file-grid',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './file-grid.component.html',
  styleUrls: ['./file-grid.component.scss'],
})
export class FileGridComponent {
  readonly files = input.required<DriveFile[]>();
  readonly selectedIds = input<Set<string>>(new Set());

  readonly fileClick = output<DriveFile>();
  readonly fileDblClick = output<DriveFile>();
  readonly favorite = output<DriveFile>();
  readonly download = output<DriveFile>();
  readonly delete = output<DriveFile>();

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
