import {
  Component, OnInit, OnDestroy, inject, signal, computed, HostListener
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../core/services/file.service';
import { AuthService } from '../../core/services/auth.service';
import { DriveFile, SortBy, SortDir, ViewMode, HOME_FOLDER_ID, PreviewSession } from '../../core/models/drive-file.model';
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
    DatePipe,
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
export class FileBrowserComponent implements OnInit, OnDestroy {
  protected fileService = inject(FileService);
  protected auth = inject(AuthService);

  readonly viewMode = signal<ViewMode>('grid');
  readonly sortBy = signal<SortBy>('name');
  readonly sortDir = signal<SortDir>('asc');
  readonly filterType = signal<string>('');
  readonly filterMenuOpen = signal(false);
  readonly viewMenuOpen = signal(false);
  readonly sidebarOpen = signal(window.innerWidth > 768);
  readonly previewFile = signal<DriveFile | null>(null);
  readonly pendingDeleteIds = signal<Set<string>>(new Set());
  readonly sessionLoading = signal(false);

  // Holds the seeded adjacent files during session open phases 1+2 so that
  // background folder loading (which overwrites fileService.files) doesn't
  // reset previewIndex mid-phase. Cleared automatically once the full folder
  // data includes the current file (or when preview closes).
  private readonly previewFileList = signal<DriveFile[] | null>(null);

  readonly previewIndex = computed(() => {
    const file = this.previewFile();
    if (!file) return 0;
    return Math.max(0, this.mediaFiles().findIndex(f => f.id === file.id));
  });

  // Keeps Image objects alive so the browser caches their responses
  private preloadGen = 0;
  private readonly preloadCache = new Map<string, HTMLImageElement>();
  private readonly backgroundImages = new Set<HTMLImageElement>(); // in-flight strip/scroll loads
  readonly cachedIds = signal<Set<string>>(new Set());

  private isPreloadable(f: DriveFile): boolean {
    return f.mime_type?.startsWith('image/') ||
      ['jpg','jpeg','png','gif','webp','heic','heif'].some(e => f.extension === e);
  }

  // Abort all background in-flight requests so navigation is never blocked by strip preloads
  private abortBackground(): void {
    for (const img of this.backgroundImages) {
      img.src = '';
    }
    this.backgroundImages.clear();
  }

  private preloadBatch(indices: number[], files: DriveFile[], isBackground = false): void {
    for (const i of indices) {
      if (i < 0 || i >= files.length) continue;
      const f = files[i];
      if (!this.isPreloadable(f) || this.preloadCache.has(f.id)) continue;
      const img = new Image();
      img.src = this.previewUrl(f.id);
      this.preloadCache.set(f.id, img);
      if (isBackground) this.backgroundImages.add(img);
    }
    if (this.preloadCache.size > 60) {
      const evict = this.preloadCache.size - 60;
      let n = 0;
      for (const id of this.preloadCache.keys()) {
        if (n++ >= evict) break;
        this.preloadCache.delete(id);
      }
    }
    this.cachedIds.set(new Set(this.preloadCache.keys()));
  }

  private preloadOneAndWait(file: DriveFile, ms = 5000): Promise<void> {
    if (!this.isPreloadable(file)) return Promise.resolve();
    let img = this.preloadCache.get(file.id);
    if (!img) {
      img = new Image();
      img.src = this.previewUrl(file.id);
      this.preloadCache.set(file.id, img);
      this.cachedIds.set(new Set(this.preloadCache.keys()));
    }
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise<void>(resolve => {
      img!.addEventListener('load',  () => resolve(), { once: true });
      img!.addEventListener('error', () => resolve(), { once: true });
      setTimeout(resolve, ms);
    });
  }

  private preloadThumbsAndWait(indices: number[], files: DriveFile[], ms = 3000): Promise<void> {
    const ps = indices
      .filter(i => i >= 0 && i < files.length && files[i].thumbnail_url)
      .map(i => new Promise<void>(resolve => {
        const img = new Image();
        img.onload = img.onerror = () => resolve();
        img.src = files[i].thumbnail_url!;
        setTimeout(resolve, ms);
      }));
    return Promise.all(ps).then(() => {});
  }

  private async preloadStrip(fromIndex: number, gen: number): Promise<void> {
    const files = this.mediaFiles();
    const order: number[] = [];
    let lo = fromIndex - 3, hi = fromIndex + 6;
    while (lo >= 0 || hi < files.length) {
      if (hi < files.length) order.push(hi++);
      if (lo >= 0) order.push(lo--);
    }
    for (const i of order) {
      if (gen !== this.preloadGen) return;
      const f = files[i];
      if (!this.isPreloadable(f) || this.preloadCache.has(f.id)) continue;
      const img = new Image();
      img.src = this.previewUrl(f.id);
      this.preloadCache.set(f.id, img);
      this.backgroundImages.add(img);
      this.cachedIds.set(new Set(this.preloadCache.keys()));
      await new Promise(r => setTimeout(r, 80));
    }
  }

  private previewUrl(fileId: string): string {
    const w = Math.min(window.screen.width * window.devicePixelRatio, 10000) | 0;
    const h = Math.min(window.screen.height * window.devicePixelRatio, 10000) | 0;
    return `/api/files/${fileId}/preview?width=${w}&height=${h}`;
  }

  private preloadAdjacent(index: number): void {
    this.abortBackground(); // free connections before loading new window
    const gen = ++this.preloadGen;
    const files = this.mediaFiles();
    this.preloadBatch([index-2, index-1, index+1, index+2, index+3, index+4, index+5], files);
    this.preloadStrip(index, gen);
  }

  onStripScrolled(range: {from: number, to: number}): void {
    this.abortBackground();
    const gen = ++this.preloadGen;
    const files = this.mediaFiles();
    const mid = Math.floor((range.from + range.to) / 2);
    const indices = Array.from({length: 21}, (_, i) => mid - 10 + i);
    this.preloadBatch(indices, files, true);
    this.preloadStrip(mid, gen);
  }

  readonly mediaFiles = computed(() => {
    const pending = this.pendingDeleteIds();
    const anchor = this.previewFileList();
    const rawFiles = this.fileService.searchResults() ?? this.fileService.files();
    const folderFiles = rawFiles.filter(f => !f.is_dir && !pending.has(f.id));

    if (anchor === null) return folderFiles;

    // Keep anchor until folder data has loaded far enough to include the current
    // preview file — at that point previewIndex() stays correct and navigation
    // can expand to the full folder naturally.
    const pf = this.previewFile();
    if (pf && folderFiles.some(f => f.id === pf.id)) return folderFiles;

    return anchor.filter(f => !f.is_dir && !pending.has(f.id));
  });

  readonly displayFiles = computed(() => {
    let files = this.fileService.searchResults() ?? this.fileService.files();
    const t = this.filterType();
    if (t) files = files.filter(f => f.is_dir || f.type === 'dir' || f.mime_type?.startsWith(t + '/'));
    return files;
  });

  readonly selectedCount = computed(() => this.fileService.selectedIds().size);
  readonly folderDirs = computed(() => this.displayFiles().filter(f => f.is_dir));
  readonly isTrash = computed(() => this.fileService.currentFolderId() === '__trash__');

  statsPopoverOpen = signal(false);
  showCreateFolder = signal(false);
  newFolderName = signal('');
  renamingFile = signal<DriveFile | null>(null);
  renameValue = signal('');
  previewFolderDirs = signal<DriveFile[]>([]);
  previewParentFolderId = signal('');
  previewParentFolderName = signal('');
  movingFiles = signal<DriveFile[] | null>(null);


  ngOnDestroy(): void {
    // Cancel all in-flight image preloads and the ongoing pagination loop.
    this.abortBackground();
    this.fileService.cancelLoad();
  }

  async ngOnInit(): Promise<void> {
    // Load sessions immediately — must not be delayed by folder pagination.
    this.fileService.loadSessions();

    // Show spinner immediately before any async work
    this.fileService.loading.set(true);

    const rawFolderId = new URLSearchParams(window.location.search).get('folder');
    const folderId = rawFolderId && /^(\d+|__trash__|__starred__)$/.test(rawFolderId) ? rawFolderId : null;
    if (folderId === '__trash__') {
      await this.showTrash();
    } else if (folderId === '__starred__') {
      await this.showStarred();
    } else if (folderId && folderId !== HOME_FOLDER_ID) {
      // Point the service at the right folder instantly
      this.fileService.currentFolderId.set(folderId);
      // Load files and resolve breadcrumb in parallel — neither blocks the other
      const [, breadcrumb] = await Promise.allSettled([
        this.loadCurrentFolder(),
        this.resolveBreadcrumb(folderId),
      ]);
      if (breadcrumb.status === 'fulfilled') {
        this.fileService.breadcrumb.set(breadcrumb.value);
      }
      // If breadcrumb failed we already have a minimal one from the service default
    } else {
      await this.loadCurrentFolder();
    }
    this.fileService.loadFolderTree();
  }

  // Walk up parent_id chain to build a full breadcrumb from root to folderId.
  // Never throws — individual getFile failures cause an early stop.
  private async resolveBreadcrumb(folderId: string): Promise<{ id: string; name: string }[]> {
    const crumbs: { id: string; name: string }[] = [];
    let currentId = folderId;
    while (currentId && currentId !== HOME_FOLDER_ID && currentId !== '1') {
      try {
        const folder = await this.fileService.getFile(currentId);
        crumbs.unshift({ id: folder.id, name: folder.name });
        const parentId = folder.parent_id;
        // Stop at true kDrive root, home folder, self-reference, or missing parent
        if (!parentId || parentId === currentId || parentId === '0' || parentId === '1') break;
        currentId = parentId;
      } catch {
        break;
      }
    }
    crumbs.unshift({ id: HOME_FOLDER_ID, name: 'My Drive' });
    return crumbs;
  }

  selectAll(): void {
    const allIds = new Set(this.displayFiles().map(f => f.id));
    this.fileService.selectedIds.set(allIds);
  }

  private syncUrl(folderId: string): void {
    const url = folderId === HOME_FOLDER_ID ? '/' : `/?folder=${encodeURIComponent(folderId)}`;
    window.history.replaceState(null, '', url);
  }

  private async loadCurrentFolder(): Promise<void> {
    const folderId = this.fileService.currentFolderId();
    this.fileService.loadFolderStats(folderId);
    await this.fileService.loadFiles({
      folderId,
      sortBy: this.sortBy(),
      sortDir: this.sortDir(),
    });
    this.fileService.searchResults.set(null);
  }

  formatSize(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
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
    this.fileService.previewOpen.set(true);
    this.previewFile.set(file);
    const idx = this.mediaFiles().findIndex(f => f.id === file.id);
    this.preloadAdjacent(idx >= 0 ? idx : 0);
    // Load parent folder's dirs for the move panel
    const crumbs = this.fileService.breadcrumb();
    const parentCrumb = crumbs.length >= 2 ? crumbs[crumbs.length - 2] : crumbs[0];
    this.previewParentFolderId.set(parentCrumb?.id ?? '1');
    this.previewParentFolderName.set(parentCrumb?.name ?? 'My Drive');
  }

  closePreview(): void {
    this.previewFileList.set(null);
    this.previewFile.set(null);
    this.fileService.previewOpen.set(false);
    this.loadCurrentFolder();
  }

  async saveCurrentSession(): Promise<void> {
    const file = this.previewFile();
    if (!file) return;
    const idx = this.previewIndex();
    const files = this.mediaFiles();
    const adj: DriveFile[] = [];
    for (let i = Math.max(0, idx - 10); i <= Math.min(files.length - 1, idx + 10); i++) {
      adj.push(files[i]);
    }
    const crumbs = this.fileService.breadcrumb();
    const folderCrumb = crumbs[crumbs.length - 1];
    await this.fileService.saveSession({
      file_id: file.id,
      file_name: file.name,
      folder_id: folderCrumb?.id ?? this.fileService.currentFolderId(),
      folder_name: folderCrumb?.name ?? 'My Drive',
      thumbnail_url: file.thumbnail_url,
      adjacent_files: adj,
    });
  }

  async openSession(session: PreviewSession): Promise<void> {
    this.sessionLoading.set(true);
    this.fileService.navigateToFolder(session.folder_id, session.folder_name);
    this.syncUrl(session.folder_id);
    if (window.innerWidth <= 768) this.sidebarOpen.set(false);
    this.resolveBreadcrumb(session.folder_id).then(crumbs => this.fileService.breadcrumb.set(crumbs));

    const adjFiles = session.adjacent_files ?? [];
    const file = await this.fileService.getFile(session.file_id);

    // Anchor mediaFiles() to seeded adjacent files during phases 1+2 so that
    // the background folder load below cannot overwrite previewIndex mid-phase.
    // For old sessions (no adjFiles), anchor to just the current file.
    this.previewFileList.set(adjFiles.length ? adjFiles : [file]);

    // Start loading the full folder in the background (fire-and-forget).
    // waitWhilePreviewOpen() inside loadFiles slows pagination to 400ms/page
    // while preview is open, keeping network pressure low. The effect in the
    // constructor watches fileService.files and drops the previewFileList anchor
    // once the current file appears in the folder data, switching mediaFiles()
    // to the expanding full folder — enabling strip and navigation beyond the
    // initial 21 seeded files.
    this.fileService.seedFiles([]);  // bump loadGeneration to cancel stale loads
    this.loadCurrentFolder();        // fire-and-forget

    this.openPreview(file);

    // Phase 1: current image fully downloaded
    await this.preloadOneAndWait(file);

    // Phase 2: prev2 + next5 — snapshot mediaFiles() now (still adjFiles anchor)
    const idx = this.previewIndex();
    const phase2Files = this.mediaFiles();
    await Promise.all(
      [idx - 2, idx - 1, idx + 1, idx + 2, idx + 3, idx + 4, idx + 5]
        .filter(i => i >= 0 && i < phase2Files.length)
        .map(i => this.preloadOneAndWait(phase2Files[i], 6000))
    );

    this.sessionLoading.set(false);

    // Phase 3: re-read index and files — folder first page may have arrived,
    // switching mediaFiles() to the full folder data already
    const idx2 = this.previewIndex();
    const files3 = this.mediaFiles();
    const stripIndices = Array.from({ length: 21 }, (_, i) => idx2 - 10 + i);
    this.preloadThumbsAndWait(stripIndices, files3, 3000);
    this.preloadStrip(idx2, ++this.preloadGen);
  }

  jumpToFile(file: DriveFile): void {
    const idx = this.mediaFiles().findIndex(f => f.id === file.id);
    if (idx === -1) return;
    this.previewFile.set(file);
    this.preloadAdjacent(idx);
  }

  navigatePreview(delta: number): void {
    const files = this.mediaFiles();
    const next = this.previewIndex() + delta;
    if (next >= 0 && next < files.length) {
      this.previewFile.set(files[next]);
      this.preloadAdjacent(next);
    }
  }

  navigateAfterDeleteStart(file: DriveFile): void {
    const files = this.mediaFiles(); // snapshot before adding to pending set
    const idx = files.findIndex(f => f.id === file.id);
    if (idx === -1) return;
    this.pendingDeleteIds.update(s => new Set([...s, file.id])); // remove from list immediately
    const filtered = this.mediaFiles();
    if (filtered.length === 0) return; // last file — stay on it until countdown ends
    const newIdx = Math.min(idx, filtered.length - 1);
    this.previewFile.set(filtered[newIdx]);
    this.preloadAdjacent(newIdx);
  }

  onUndoDelete(fileId: string): void {
    this.pendingDeleteIds.update(s => { const n = new Set(s); n.delete(fileId); return n; });
  }

  async deletePreviewFile(file: DriveFile): Promise<void> {
    await this.fileService.delete(file);
    this.pendingDeleteIds.update(s => { const n = new Set(s); n.delete(file.id); return n; });
    if (this.mediaFiles().length === 0) {
      this.closePreview();
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
        this.previewFile.set(remaining[idx]);
      }
    }
  }

  async handleRestore(file: DriveFile): Promise<void> {
    await this.fileService.restoreFile(file.id);
  }

  async bulkRestore(): Promise<void> {
    const ids = [...this.fileService.selectedIds()];
    await Promise.all(ids.map(id => this.fileService.restoreFile(id)));
    this.fileService.clearSelection();
  }

  async bulkDelete(): Promise<void> {
    const files = this.displayFiles().filter(f => this.fileService.selectedIds().has(f.id));
    await Promise.all(files.map(f => this.fileService.delete(f)));
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
    this.viewMenuOpen.set(false);
    this.statsPopoverOpen.set(false);
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (this.previewFile()) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const selected = this.fileService.selectedIds();
      if (selected.size > 0) {
        const files = this.displayFiles().filter(f => selected.has(f.id));
        files.forEach(f => this.fileService.delete(f));
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
