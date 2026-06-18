import { Component, OnInit, inject, signal, computed, effect, HostListener } from '@angular/core';
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
  readonly sidebarOpen = signal(window.innerWidth > 768);
  readonly previewFile = signal<DriveFile | null>(null);
  readonly previewIndex = signal(0);
  readonly searchResults = signal<DriveFile[] | null>(null);

  readonly mediaFiles = computed(() => {
    const files = this.searchResults() ?? this.fileService.files();
    return files.filter(f => !f.is_dir);
  });

  readonly displayFiles = computed(() => {
    return this.searchResults() ?? this.fileService.files();
  });

  ngOnInit(): void {
    this.loadCurrentFolder();
    this.fileService.loadFolderTree();

    effect(() => {
      const folderId = this.fileService.currentFolderId();
      this.loadCurrentFolder();
    }, { allowSignalWrites: true });
  }

  private async loadCurrentFolder(): Promise<void> {
    await this.fileService.loadFiles({
      folderId: this.fileService.currentFolderId(),
      sortBy: this.sortBy(),
      sortDir: this.sortDir(),
      type: this.filterType() || undefined,
    });
    this.searchResults.set(null);
  }

  async onSearch(query: string): Promise<void> {
    if (!query.trim()) {
      this.searchResults.set(null);
      return;
    }
    const results = await this.fileService.search(query);
    this.searchResults.set(results);
  }

  openPreview(file: DriveFile): void {
    if (file.is_dir) {
      this.fileService.navigateToFolder(file.id, file.name);
      if (window.innerWidth <= 768) this.sidebarOpen.set(false);
      return;
    }
    const idx = this.mediaFiles().findIndex(f => f.id === file.id);
    this.previewIndex.set(idx >= 0 ? idx : 0);
    this.previewFile.set(file);
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
    this.loadCurrentFolder();
  }

  async showTrash(): Promise<void> {
    await this.fileService.loadTrash();
    this.fileService.breadcrumb.set([{ id: '__trash__', name: 'Trash' }]);
    this.fileService.currentFolderId.set('__trash__');
    this.searchResults.set(null);
  }

  async showStarred(): Promise<void> {
    const results = await this.fileService.search('is:starred');
    this.searchResults.set(results);
    this.fileService.breadcrumb.set([{ id: '__starred__', name: 'Starred' }]);
  }

  logout(): void {
    this.auth.logout();
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (this.previewFile()) return; // Preview handles its own keys

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
