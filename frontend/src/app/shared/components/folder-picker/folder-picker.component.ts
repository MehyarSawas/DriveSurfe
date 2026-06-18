import {
  Component, inject, input, output, signal, computed, OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../../core/services/file.service';
import { DriveFile } from '../../../core/models/drive-file.model';

interface Crumb { id: string; name: string; }

@Component({
  selector: 'ds-folder-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './folder-picker.component.html',
  styleUrls: ['./folder-picker.component.scss'],
})
export class FolderPickerComponent implements OnInit {
  private fileService = inject(FileService);

  readonly startFolderId = input<string>('1');
  readonly startFolderName = input<string>('My Drive');

  readonly folderSelected = output<DriveFile>();
  readonly closed = output<void>();

  readonly loading = signal(false);
  readonly folders = signal<DriveFile[]>([]);
  readonly breadcrumb = signal<Crumb[]>([]);
  readonly newFolderInputOpen = signal(false);
  readonly newFolderName = signal('');
  readonly creating = signal(false);

  readonly canGoBack = computed(() => this.breadcrumb().length > 1);
  readonly currentFolder = computed(() => {
    const crumbs = this.breadcrumb();
    return crumbs.length > 0 ? crumbs[crumbs.length - 1] : { id: '1', name: 'My Drive' };
  });

  ngOnInit(): void {
    this.breadcrumb.set([{ id: this.startFolderId(), name: this.startFolderName() }]);
    this.loadFolders(this.startFolderId());
  }

  private async loadFolders(folderId: string): Promise<void> {
    this.loading.set(true);
    try {
      this.folders.set(await this.fileService.fetchFolders(folderId));
    } finally {
      this.loading.set(false);
    }
  }

  openFolder(folder: DriveFile): void {
    this.breadcrumb.update(c => [...c, { id: folder.id, name: folder.name }]);
    this.loadFolders(folder.id);
  }

  goBack(): void {
    const crumbs = this.breadcrumb();
    if (crumbs.length <= 1) return;
    this.breadcrumb.set(crumbs.slice(0, -1));
    this.loadFolders(crumbs[crumbs.length - 2].id);
  }

  navigateToCrumb(index: number): void {
    const crumbs = this.breadcrumb();
    if (index >= crumbs.length - 1) return;
    this.breadcrumb.set(crumbs.slice(0, index + 1));
    this.loadFolders(crumbs[index].id);
  }

  selectFolder(folder: DriveFile): void {
    this.folderSelected.emit(folder);
  }

  async submitNewFolder(): Promise<void> {
    const name = this.newFolderName().trim();
    if (!name || this.creating()) return;
    this.creating.set(true);
    try {
      const folder = await this.fileService.createFolder(this.currentFolder().id, name, false);
      this.folders.update(f => [...f, folder]);
      this.newFolderInputOpen.set(false);
      this.newFolderName.set('');
    } finally {
      this.creating.set(false);
    }
  }
}
