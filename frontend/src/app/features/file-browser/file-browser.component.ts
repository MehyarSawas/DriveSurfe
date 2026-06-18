import {
  Component, OnInit, inject, signal, computed, HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../core/services/file.service';
import { AuthService } from '../../core/services/auth.service';
import { DriveFile, SortBy, SortDir, ViewMode } from '../../core/models/drive-file.model';
import { FileGridComponent } from './components/file-grid/file-grid.component';
import { FileListComponent } from './components/file-list/file-list.component';
import { FolderTreeComponent } from './components/folder-tree/folder-tree.component';
import { BreadcrumbComponent } from './components/breadcrumb/breadcrumb.component';
import { SearchBarComponent } from './components/search-bar/search-bar.component';
import { PreviewComponent } from '../preview/preview.component';
import { FolderPickerComponent } from '../../shared/components/folder-picker/folder-picker.component';

@Component({
  selector: 'ds-file-browser',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    FileGridComponent,
    FileListComponent,
    FolderTreeComponent,
    BreadcrumbComponent,
    SearchBarComponent,
    PreviewComponent,
    FolderPickerComponent,
  ],
  templateUrl: './file-browser.component.html',
  styleUrls: ['./file-browser.component.scss'],
})
export class FileBrowserComponent implements OnInit {
  protected fileService = inject(FileService);
  protected auth = inject(AuthService);

  readonly viewMode = signal<ViewMode>('grid');
  readonly sortBy = signal<SortBy>('name');
  readonly sortDir = signal<SortDir>('asc');
  readonly filterType = signal<string>('');
  readonly filterMenuOpen = signal(false);
  readonly sidebarOpen = signal(window.innerWidth > 768);
  readonly previewFile = signal<DriveFile | null>(null);
  readonly previewIndex = signal(0);

  // Keeps Image objects alive so the browser caches their responses
  private preloadCache = new Map<string, HTMLImageElement>();

  readonly mediaFiles = computed(() => {
    const files = this.fileService.searchResults() ?? this.fileService.files();
    return files.filter(f => !f.is_dir);
  });

  readonly displayFiles = computed(() => {
    let files = this.fileService.searchResults() ?? this.fileService.files();
    const t = this.filterType();
    if (t) files = files.filter(f => f.is_dir || f.type === 'dir' || f.mime_type?.startsWith(t + '/'));
    return files;
  });

  readonly selectedCount = computed(() => this.fileService.selectedIds().size);
  readonly folderDirs = computed(() => this.displayFiles().filter(f => f.is_dir));

  showCreateFolder = signal(false);
  newFolderName = signal('');
  renamingFile = signal<DriveFile | null>(null);
  renameValue = signal('');
  previewFolderDirs = signal<DriveFile[]>([]);
  previewParentFolderId = signal('');
  previewParentFolderName = signal('');
  movingFiles = signal<DriveFile[] | null>(null);

  async ngOnInit(): Promise<void> {
    const folderId = new URLSearchParams(window.location.search).get('folder');
    if (folderId === '__trash__') {
      await this.showTrash();
    } else if (folderId === '__starred__') {
      await this.showStarred();
    } else if (folderId && folderId !== '1') {
      try {
        const folder = await this.fileService.getFile(folderId);
        this.fileService.currentFolderId.set(folderId);
        this.fileService.breadcrumb.set([{ id: folderId, name: folder.name }]);
        await this.loadCurrentFolder();
      } catch {
        // Folder no longer accessible — fall back to root
        this.syncUrl('1');
        await this.loadCurrentFolder();
      }
    } else {
      await this.loadCurrentFolder();
    }
    this.fileService.loadFolderTree();
  }

  private syncUrl(folderId: string): void {
    const url = folderId === '1' ? '/' : `/?folder=${encodeURIComponent(folderId)}`;
    window.history.replaceState(null, '', url);
  }

  private async loadCurrentFolder(): Promise<void> {
    await this.fileService.loadFiles({
      folderId: this.fileService.currentFolderId(),
      sortBy: this.sortBy(),
      sortDir: this.sortDir(),
    });
    this.fileService.searchResults.set(null);
  }

  async onSearch(query: string): Promise<void> {
    if (!query.trim()) {
      this.fileService.searchResults.set(null);
      return;
    }
    const results = await this.fileService.search(query);
    this.fileService.searchResults.set(results);
    this.fileService.breadcrumb.set([{ id: '__search__', name: `Search: "${query}"` }]);
  }

  async openPreview(file: DriveFile): Promise<void> {
    if (file.is_dir) {
      this.navigateToFolder(file.id, file.name);
      if (window.innerWidth <= 768) this.sidebarOpen.set(false);
      return;
    }
    const idx = this.mediaFiles().findIndex(f => f.id === file.id);
    const resolvedIdx = idx >= 0 ? idx : 0;
    this.previewIndex.set(resolvedIdx);
    this.previewFile.set(file);
    this.preloadAdjacent(resolvedIdx);
    // Load parent folder's dirs for the move panel
    const crumbs = this.fileService.breadcrumb();
    const parentCrumb = crumbs.length >= 2 ? crumbs[crumbs.length - 2] : crumbs[0];
    this.previewParentFolderId.set(parentCrumb?.id ?? '1');
    this.previewParentFolderName.set(parentCrumb?.name ?? 'My Drive');
  }

  closePreview(): void {
    this.previewFile.set(null);
  }

  navigatePreview(delta: number): void {
    const files = this.mediaFiles();
    const next = this.previewIndex() + delta;
    if (next >= 0 && next < files.length) {
      this.previewIndex.set(next);
      this.previewFile.set(files[next]);
      this.preloadAdjacent(next);
    }
  }

  private preloadAdjacent(index: number): void {
    const files = this.mediaFiles();
    const isImage = (f: DriveFile) =>
      f.mime_type?.startsWith('image/') ||
      ['jpg','jpeg','png','gif','webp','heic','heif'].some(e => f.extension === e);

    const toPreload = [index - 1, index + 1, index + 2]
      .filter(i => i >= 0 && i < files.length)
      .map(i => files[i])
      .filter(f => isImage(f));

    // Evict entries not in the new set to keep memory bounded
    const keepIds = new Set([files[index]?.id, ...toPreload.map(f => f.id)]);
    for (const id of this.preloadCache.keys()) {
      if (!keepIds.has(id)) this.preloadCache.delete(id);
    }

    for (const f of toPreload) {
      if (!this.preloadCache.has(f.id)) {
        const img = new Image();
        img.src = `/api/files/${f.id}/preview`;
        this.preloadCache.set(f.id, img);
      }
    }
  }

  async deletePreviewFile(file: DriveFile): Promise<void> {
    await this.fileService.delete(file.id);
    const files = this.mediaFiles();
    if (files.length === 0) {
      this.closePreview();
    } else {
      const idx = Math.min(this.previewIndex(), files.length - 1);
      this.previewIndex.set(idx);
      this.previewFile.set(files[idx]);
    }
  }

  toggleSort(by: SortBy): void {
    if (this.sortBy() === by) {
      this.sortDir.update(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortBy.set(by);
      this.sortDir.set('asc');
    }
    this.loadCurrentFolder();
  }

  setFilter(type: string): void {
    this.filterType.set(type);
    this.filterMenuOpen.set(false);
  }

  toggleFilterMenu(e: Event): void {
    e.stopPropagation();
    this.filterMenuOpen.update(v => !v);
  }

  async showTrash(): Promise<void> {
    await this.fileService.loadTrash();
    this.fileService.breadcrumb.set([{ id: '__trash__', name: 'Trash' }]);
    this.fileService.currentFolderId.set('__trash__');
    this.fileService.searchResults.set(null);
    this.syncUrl('__trash__');
  }

  async showStarred(): Promise<void> {
    const results = await this.fileService.loadFavorites();
    this.fileService.searchResults.set(results);
    this.fileService.breadcrumb.set([{ id: '__starred__', name: 'Starred' }]);
    this.fileService.currentFolderId.set('__starred__');
    this.syncUrl('__starred__');
  }

  navigateToFolder(id: string, name: string): void {
    this.fileService.navigateToFolder(id, name);
    this.syncUrl(id);
    this.loadCurrentFolder();
  }

  async toggleFavorite(file: DriveFile): Promise<void> {
    await this.fileService.toggleFavorite(file);
    if (this.previewFile()?.id === file.id) {
      this.previewFile.update(f => f ? { ...f, is_favorite: !file.is_favorite } : f);
    }
  }

  openMoveForFile(file: DriveFile): void {
    this.movingFiles.set([file]);
  }

  openBulkMove(): void {
    const ids = [...this.fileService.selectedIds()];
    const files = ids.map(id => this.displayFiles().find(f => f.id === id)).filter(Boolean) as DriveFile[];
    this.movingFiles.set(files);
  }

  async onPickerFolderSelected(folder: DriveFile): Promise<void> {
    const files = this.movingFiles();
    this.movingFiles.set(null);
    if (!files) return;
    await Promise.all(files.map(f => this.fileService.moveFile(f.id, folder.id)));
    this.fileService.clearSelection();
    // If moved from preview context, advance preview
    if (files.length === 1 && this.previewFile()?.id === files[0].id) {
      const remaining = this.mediaFiles();
      if (remaining.length === 0) {
        this.closePreview();
      } else {
        const idx = Math.min(this.previewIndex(), remaining.length - 1);
        this.previewIndex.set(idx);
        this.previewFile.set(remaining[idx]);
      }
    }
  }

  async bulkDelete(): Promise<void> {
    const ids = [...this.fileService.selectedIds()];
    await Promise.all(ids.map(id => this.fileService.delete(id)));
    this.fileService.clearSelection();
  }

  bulkDownload(): void {
    this.fileService.selectedIds().forEach(id => {
      const file = this.displayFiles().find(f => f.id === id);
      if (file) this.fileService.downloadFile(file.id, file.name);
    });
  }

  async submitCreateFolder(): Promise<void> {
    const name = this.newFolderName().trim();
    if (!name) return;
    await this.fileService.createFolder(this.fileService.currentFolderId(), name);
    this.showCreateFolder.set(false);
    this.newFolderName.set('');
  }

  handleRename(file: DriveFile): void {
    this.renamingFile.set(file);
    this.renameValue.set(file.name);
  }

  async submitRename(): Promise<void> {
    const file = this.renamingFile();
    const name = this.renameValue().trim();
    if (!file || !name) return;
    await this.fileService.renameFile(file.id, name);
    this.renamingFile.set(null);
  }

  async handleMove(event: {file: DriveFile, folderId: string}): Promise<void> {
    this.movingFiles.set([event.file]);
    await this.onPickerFolderSelected({ id: event.folderId } as DriveFile);
  }

  async handleCreateFolderFromPreview(event: {parentId: string, name: string, then: (f: DriveFile) => void}): Promise<void> {
    const folder = await this.fileService.createFolder(event.parentId, event.name);
    event.then(folder);
  }

  logout(): void {
    this.auth.logout();
  }

  @HostListener('document:click')
  onDocClick(): void {
    this.filterMenuOpen.set(false);
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (this.previewFile()) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const selected = this.fileService.selectedIds();
      if (selected.size > 0) {
        selected.forEach(id => this.fileService.delete(id));
        this.fileService.clearSelection();
      }
    }

    if (e.key === 'Enter') {
      const selected = [...this.fileService.selectedIds()];
      if (selected.length === 1) {
        const file = this.displayFiles().find(f => f.id === selected[0]);
        if (file) this.openPreview(file);
      }
    }

    if (e.key === 'Escape') {
      this.fileService.clearSelection();
    }
  }
}
