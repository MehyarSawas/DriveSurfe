import {
  Component, inject, input, output, signal, computed, OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../../core/services/file.service';
import { DriveFile, HOME_FOLDER_ID } from '../../../core/models/drive-file.model';

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

  readonly startFolderId = input<string>(HOME_FOLDER_ID);
  readonly startFolderName = input<string>('My Drive');
  // Optional: pass the full breadcrumb path so back navigation walks up properly
  readonly startBreadcrumb = input<Crumb[]>([]);

  readonly folderSelected = output<DriveFile>();
  readonly closed = output<void>();

  readonly loading = signal(false);
  readonly folders = signal<DriveFile[]>([]);
  readonly breadcrumb = signal<Crumb[]>([]);
  readonly newFolderInputOpen = signal(false);
  readonly newFolderName = signal('');
  readonly creating = signal(false);

  readonly canGoBack = computed(() => {
    const crumbs = this.breadcrumb();
    return crumbs.length > 1 || (crumbs.length === 1 && crumbs[0].id !== HOME_FOLDER_ID);
  });
  readonly currentFolder = computed(() => {
    const crumbs = this.breadcrumb();
    return crumbs.length > 0 ? crumbs[crumbs.length - 1] : { id: HOME_FOLDER_ID, name: 'My Drive' };
  });

  ngOnInit(): void {
    const fullPath = this.startBreadcrumb();
    if (fullPath.length > 0) {
      this.breadcrumb.set(fullPath.map(c => ({ id: c.id, name: c.name })));
      this.loadFolders(fullPath[fullPath.length - 1].id);
    } else {
      this.breadcrumb.set([{ id: this.startFolderId(), name: this.startFolderName() }]);
      this.loadFolders(this.startFolderId());
    }
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

  async goBack(): Promise<void> {
    const crumbs = this.breadcrumb();
    if (crumbs.length > 1) {
      // Step back through our local navigation history
      this.breadcrumb.set(crumbs.slice(0, -1));
      this.loadFolders(crumbs[crumbs.length - 2].id);
    } else {
      // Beyond local history — resolve parent via API using parent_id
      const currentId = crumbs[0]?.id;
      if (!currentId || currentId === HOME_FOLDER_ID) return;
      this.loading.set(true);
      try {
        const folder = await this.fileService.getFile(currentId);
        const parentId = folder.parent_id;
        if (!parentId || parentId === currentId || parentId === '0' || parentId === HOME_FOLDER_ID) {
          // Reached home root
          this.breadcrumb.set([{ id: HOME_FOLDER_ID, name: 'My Drive' }]);
          await this.loadFolders(HOME_FOLDER_ID);
          return;
        }
        const parentName = (await this.fileService.getFile(parentId)).name;
        this.breadcrumb.set([{ id: parentId, name: parentName }]);
        await this.loadFolders(parentId);
      } finally {
        this.loading.set(false);
      }
    }
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
