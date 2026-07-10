import {
  Component, OnInit, OnDestroy, inject, signal, computed, ViewChild
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { FileService } from '../../core/services/file.service';
import { AuthService } from '../../core/services/auth.service';
import { PreviewCacheService } from '../../core/services/preview-cache.service';
import { DriveFile, SortBy, SortDir, ViewMode, HOME_FOLDER_ID, PreviewSession, BreadcrumbItem, MonthCover } from '../../core/models/drive-file.model';
import { FileGridComponent } from './components/file-grid/file-grid.component';
import { FileListComponent } from './components/file-list/file-list.component';
import { FolderTreeComponent } from './components/folder-tree/folder-tree.component';
import { BreadcrumbComponent } from './components/breadcrumb/breadcrumb.component';
import { SearchBarComponent } from './components/search-bar/search-bar.component';
import { PreviewComponent } from '../preview/preview.component';
import { FolderPickerComponent } from '../../shared/components/folder-picker/folder-picker.component';
import { ShareDialogComponent } from '../../shared/components/share-dialog/share-dialog.component';
import { ScannerComponent } from '../scanner/scanner.component';

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
    ShareDialogComponent,
    ScannerComponent,
  ],
  templateUrl: './file-browser.component.html',
  styleUrls: ['./file-browser.component.scss'],
  host: {
    '(document:click)': 'onDocClick()',
    '(window:keydown)': 'onKeyDown($event)',
  },
})
export class FileBrowserComponent implements OnInit, OnDestroy {
  protected fileService = inject(FileService);
  protected auth = inject(AuthService);
  private previewCache = inject(PreviewCacheService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly viewMode = signal<ViewMode>('grid');
  readonly sortBy = signal<SortBy>('name');
  readonly sortDir = signal<SortDir>('asc');
  readonly filterType = signal<string>('');
  readonly filterMenuOpen = signal(false);
  readonly viewMenuOpen = signal(false);
  readonly sidebarOpen = signal(window.innerWidth > 768);
  readonly previewFile = signal<DriveFile | null>(null);
  readonly pendingDeleteIds = signal<Set<string>>(new Set());
  readonly pendingMoveIds = signal<Set<string>>(new Set());
  readonly sessionLoading = signal(false);
  readonly bulkMoveToast = signal<string | null>(null);
  @ViewChild(SearchBarComponent) private searchBar?: SearchBarComponent;

  private readonly preSearchBreadcrumb = signal<BreadcrumbItem[]>([]);
  private _lastSearchEvent: { query: string; folderId?: string; folderName?: string } | null = null;

  // Holds the seeded adjacent files during session open phases 1+2 so that
  // background folder loading (which overwrites fileService.files) doesn't
  // reset previewIndex mid-phase. Cleared automatically once the full folder
  // data includes the current file (or when preview closes).
  private readonly previewFileList = signal<DriveFile[] | null>(null);

  readonly currentFolderName = computed(() => {
    const crumbs = this._lastSearchEvent
      ? this.preSearchBreadcrumb()
      : this.fileService.breadcrumb();
    return crumbs[crumbs.length - 1]?.name ?? 'My Drive';
  });

  /** Upload/create destination (scanner, file upload, new folder): the
   *  current folder if it's a real, uploadable kDrive folder, else My Drive
   *  — trash/starred/shares/search are virtual views with no valid
   *  destination to upload or create into. */
  readonly uploadTargetFolderId = computed(() =>
    this.isVirtualFolder() ? HOME_FOLDER_ID : this.fileService.currentFolderId()
  );
  readonly uploadTargetFolderName = computed(() =>
    this.isVirtualFolder() ? 'My Drive' : this.currentFolderName()
  );

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

  private previewUrl(fileId: string): string {
    const w = Math.min(window.screen.width * window.devicePixelRatio, 10000) | 0;
    const h = Math.min(window.screen.height * window.devicePixelRatio, 10000) | 0;
    return `/api/files/${fileId}/preview?width=${w}&height=${h}`;
  }

  private preloadAdjacent(index: number): void {
    this.abortBackground();
    const gen = ++this.preloadGen;
    const files = this.mediaFiles();
    this.preloadBatch([index-2, index-1, index+1, index+2, index+3, index+4, index+5], files);
    this.preloadStrip(index, gen);
  }

  // After adjacent preload, walk outward from index and preload nearby images
  // in the background. CAPPED at ±40 around the current position — walking the
  // whole list fires a /preview request per image, which with a thousands-item
  // timeline burns straight through kDrive's ~1000 req/hour API quota.
  private static readonly PRELOAD_WALK_RADIUS = 40;
  private async preloadStrip(index: number, gen: number): Promise<void> {
    const files = this.mediaFiles();
    const total = files.length;
    // Build indices spiralling out from current: index+6, index-3, index+7, index-4, ...
    const visited = new Set<number>([index-2, index-1, index, index+1, index+2, index+3, index+4, index+5]);
    const queue: number[] = [];
    const minLo = Math.max(0, index - FileBrowserComponent.PRELOAD_WALK_RADIUS);
    const maxHi = Math.min(total - 1, index + FileBrowserComponent.PRELOAD_WALK_RADIUS);
    let lo = index - 3;
    let hi = index + 6;
    while (lo >= minLo || hi <= maxHi) {
      if (hi <= maxHi) { if (!visited.has(hi)) { visited.add(hi); queue.push(hi); } hi++; }
      if (lo >= minLo) { if (!visited.has(lo)) { visited.add(lo); queue.push(lo); } lo--; }
    }
    for (const i of queue) {
      if (gen !== this.preloadGen) return;
      const f = files[i];
      if (!this.isPreloadable(f) || this.preloadCache.has(f.id)) continue;
      await this.preloadOneAndWait(f, 10000);
      if (gen !== this.preloadGen) return;
    }
  }

  onStripScrolled(_range: {from: number, to: number}): void {
    // Strip scroll only shows thumbnails — cancel any in-flight preview preloads
    // so they don't compete with the current image load. No new preview requests here.
    this.abortBackground();
    ++this.preloadGen;
  }

  readonly mediaFiles = computed(() => {
    const pending = this.pendingDeleteIds();
    const pendingMove = this.pendingMoveIds();
    const anchor = this.previewFileList();
    const rawFiles = this.fileService.searchResults() ?? this.fileService.files();
    const folderFiles = rawFiles.filter(f => !f.is_dir && !pending.has(f.id) && !pendingMove.has(f.id));

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
  /** True for any virtual (non-uploadable) view — trash, starred, search. */
  readonly isVirtualFolder = computed(() => this.fileService.currentFolderId().startsWith('__'));

  statsPopoverOpen = signal(false);
  showCreateFolder = signal(false);
  newFolderName = signal('');
  renamingFile = signal<DriveFile | null>(null);
  renameValue = signal('');
  previewFolderDirs = signal<DriveFile[]>([]);
  previewParentFolderId = signal('');
  previewParentFolderName = signal('');
  movingFiles = signal<DriveFile[] | null>(null);
  copyingFiles = signal<DriveFile[] | null>(null);
  moveConflictPending = signal<{ files: DriveFile[]; folderId: string } | null>(null);
  addMenuOpen = signal(false);
  uploadTotal = signal(0);
  uploadDone = signal(0);
  uploadErrors = signal(0);
  scanOpen = signal(false);
  sharingFile = signal<DriveFile | null>(null);

  readonly recentMoveFolder = signal<{id: string; name: string; path: string} | null>(
    (() => { try { const s = localStorage.getItem('recentMoveFolder'); return s ? JSON.parse(s) : null; } catch { return null; } })()
  );

  private saveRecentMoveFolder(folder: DriveFile, breadcrumbPath: string): void {
    const entry = { id: folder.id, name: folder.name, path: breadcrumbPath };
    this.recentMoveFolder.set(entry);
    try { localStorage.setItem('recentMoveFolder', JSON.stringify(entry)); } catch {}
  }

  ngOnDestroy(): void {
    this.abortBackground();
    this.fileService.cancelLoad();
  }

  async ngOnInit(): Promise<void> {
    this.fileService.loadSessions();
    this.fileService.loadShares();
    this.fileService.loading.set(true);

    // Warm up OpenCV.js in the background so the scanner's smart detection is
    // already initialized by the time the user opens it (dynamic import keeps
    // it out of the initial bundle; loadOpenCv caches the result).
    setTimeout(() => {
      import('../scanner/opencv-loader').then(m => m.loadOpenCv()).catch(() => { /* scanner will retry */ });
    }, 2500);

    const params = this.route.snapshot.params;
    const folderId: string = params['folderId'] ?? HOME_FOLDER_ID;
    const fileId: string | null = params['fileId'] ?? null;

    if (folderId === '__trash__') {
      await this.showTrash();
    } else if (folderId === '__starred__') {
      await this.showStarred();
    } else if (folderId === '__shares__') {
      await this.showShares();
    } else if (folderId === '__timeline__') {
      await this.showTimeline();
    } else if (folderId !== HOME_FOLDER_ID) {
      this.fileService.currentFolderId.set(folderId);
      this.resolveBreadcrumb(folderId).then(crumbs => this.fileService.breadcrumb.set(crumbs));
      await this.loadCurrentFolder();
    } else {
      await this.loadCurrentFolder();
    }

    if (fileId) {
      const file = await this.fileService.getFile(fileId).catch(() => null);
      if (file) await this.openPreview(file);
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
    this.router.navigate(['/folder', folderId], { replaceUrl: true });
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

  async onSearch(event: { query: string; folderId?: string; folderName?: string }): Promise<void> {
    if (!event.query.trim()) {
      this.cancelSearch();
      return;
    }
    if (!this._lastSearchEvent) {
      this.preSearchBreadcrumb.set(this.fileService.breadcrumb());
    }
    this._lastSearchEvent = event;
    // Update breadcrumb immediately so it always reflects current search term
    const label = event.folderId
      ? `"${event.query}" in ${event.folderName ?? 'folder'}`
      : `Search: "${event.query}"`;
    this.fileService.breadcrumb.set([{ id: '__search__', name: label }]);

    await this.fileService.search(event.query, event.folderId, {
      sortBy: this.sortBy(),
      sortDir: this.sortDir(),
    });
  }

  cancelSearch(): void {
    this.searchBar?.clearSilent();
    this.fileService.abortSearch();
    this.fileService.searchResults.set(null);
    this.fileService.searchCapped.set(false);
    const saved = this.preSearchBreadcrumb();
    const restore = saved.length
      ? saved
      : [{ id: this.fileService.currentFolderId(), name: 'My Drive' }];
    this.fileService.breadcrumb.set(restore);
    this.preSearchBreadcrumb.set([]);
    this._lastSearchEvent = null;
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
    this.abortBackground();
    ++this.preloadGen;
    this.previewFileList.set(null);
    this.previewFile.set(null);
    this.fileService.previewOpen.set(false);
    // Do not reload — folder files are already loaded (or loading in background).
    // Reloading would reset files to page 1 and lose scroll position.
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
    // Cache adjacent files for this session so thumbnails and previews load
    // instantly the next time the session is opened.
    const saved = this.fileService.sessions().find(s => s.folder_id === (folderCrumb?.id ?? this.fileService.currentFolderId()));
    if (saved) this.previewCache.cacheSession(saved.id, adj);
  }

  async removeSession(sessionId: string): Promise<void> {
    this.previewCache.deleteSession(sessionId);
    await this.fileService.deleteSession(sessionId);
  }

  async openSession(session: PreviewSession): Promise<void> {
    this.sessionLoading.set(true);

    // Check BEFORE navigateToFolder changes currentFolderId
    const alreadyInFolder = this.fileService.currentFolderId() === session.folder_id
      && this.fileService.files().length > 0;

    this.fileService.navigateToFolder(session.folder_id, session.folder_name);
    this.router.navigate(['/folder', session.folder_id], { replaceUrl: true });
    if (window.innerWidth <= 768) this.sidebarOpen.set(false);
    this.resolveBreadcrumb(session.folder_id).then(crumbs => this.fileService.breadcrumb.set(crumbs));

    const adjFiles = session.adjacent_files ?? [];
    const file = await this.fileService.getFile(session.file_id);

    if (alreadyInFolder) {
      // Folder already in memory — no reload, no anchor needed.
      this.previewFileList.set(null);
    } else {
      // Anchor mediaFiles() to adjacent files so background pagination can't
      // reset previewIndex while phases 1+2 are running.
      this.previewFileList.set(adjFiles.length ? adjFiles : [file]);
      this.fileService.seedFiles([]);   // cancel any stale load
      this.loadCurrentFolder();         // fire-and-forget
    }

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
    const files = this.mediaFiles();
    const idx = files.findIndex(f => f.id === file.id);
    if (idx === -1) return;
    // Resolve next file from snapshot BEFORE signal changes — pendingDeleteIds
    // causes mediaFiles() to potentially switch to the anchor list, which would
    // clip Math.min(idx, anchor.length-1) to the wrong position.
    const nextFile = idx < files.length - 1 ? files[idx + 1] : files[idx - 1];
    this.pendingDeleteIds.update(s => new Set([...s, file.id]));
    if (!nextFile) return; // was the only file
    this.previewFile.set(nextFile);
    this.preloadAdjacent(idx < files.length - 1 ? idx : idx - 1);
  }

  onUndoDelete(fileId: string): void {
    this.pendingDeleteIds.update(s => { const n = new Set(s); n.delete(fileId); return n; });
  }

  navigateAfterMoveStart(file: DriveFile): void {
    const files = this.mediaFiles();
    const idx = files.findIndex(f => f.id === file.id);
    if (idx === -1) return;
    const nextFile = idx < files.length - 1 ? files[idx + 1] : files[idx - 1];
    this.pendingMoveIds.update(s => new Set([...s, file.id]));
    if (!nextFile) return;
    this.previewFile.set(nextFile);
    this.preloadAdjacent(idx < files.length - 1 ? idx : idx - 1);
  }

  onUndoMove(fileId: string): void {
    this.pendingMoveIds.update(s => { const n = new Set(s); n.delete(fileId); return n; });
    this.previewFile.set(this.fileService.files().find(f => f.id === fileId) ?? this.previewFile());
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
    if (this.fileService.searchResults() !== null) {
      if (this._lastSearchEvent) this.onSearch(this._lastSearchEvent);
    } else {
      this.loadCurrentFolder();
    }
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
    this.closeSidebarOnMobile();
    await this.fileService.loadTrash();
    this.fileService.breadcrumb.set([{ id: '__trash__', name: 'Trash' }]);
    this.fileService.currentFolderId.set('__trash__');
    this.fileService.searchResults.set(null);
    this.router.navigate(['/folder', '__trash__'], { replaceUrl: true });
  }

  async showStarred(): Promise<void> {
    this.closeSidebarOnMobile();
    const results = await this.fileService.loadFavorites();
    this.fileService.searchResults.set(results);
    this.fileService.breadcrumb.set([{ id: '__starred__', name: 'Starred' }]);
    this.fileService.currentFolderId.set('__starred__');
    this.router.navigate(['/folder', '__starred__'], { replaceUrl: true });
  }

  // --- Timeline (all media under the drive, newest first, grouped by month) ---

  readonly isTimeline = computed(() => this.fileService.currentFolderId() === '__timeline__');
  readonly timelineLoadingMore = signal(false);
  readonly timelineDone = signal(false);
  private timelineCursor: string | null = null;
  private timelineGen = 0;
  private timelinePeriod: { after: number; before: number } | null = null;
  /** What the stream currently holds: 'full' or a month key — avoids reloading. */
  private timelineLoadedKey: string | null = null;

  /** iPhone-Photos-style scale: cover tiles per year / per month, or the stream. */
  readonly timelineScale = signal<'year' | 'month' | 'all'>('all');
  /** Month covers, accumulated batch-by-batch (newest first) as the backend
   *  walks history backwards. null until the first batch arrives. */
  readonly timelineCovers = signal<MonthCover[] | null>(null);
  readonly timelineCoversLoading = signal(false);
  readonly timelineCoversError = signal<string | null>(null);
  private timelineCoversComplete = false;
  private timelineCoversNextBefore: number | null = null;
  private coversGen = 0;

  /** Months grouped by year for the Months view (covers are newest-first). */
  readonly timelineMonthsByYear = computed(() => {
    const groups: { year: number; months: MonthCover[] }[] = [];
    let current: { year: number; months: MonthCover[] } | null = null;
    for (const m of this.timelineCovers() ?? []) {
      if (!current || current.year !== m.year) {
        current = { year: m.year, months: [] };
        groups.push(current);
      }
      current.months.push(m);
    }
    return groups;
  });

  /** One tile per year — its newest month's cover represents the year. */
  readonly timelineYearCovers = computed(() =>
    this.timelineMonthsByYear().map(g => ({ year: g.year, cover: g.months[0].cover }))
  );

  monthName(m: MonthCover): string {
    return new Date(m.year, m.month - 1, 1).toLocaleDateString(undefined, { month: 'long' });
  }

  /** Pull month covers batch-by-batch (12 months at a time) until history is
   *  exhausted, appending each batch so months appear progressively — newest
   *  first. Each batch is one cheap request; the backend caches historical
   *  batches so revisits are near-free. Bails if the user leaves the cover
   *  scales. Safe to call repeatedly (guarded by loading + generation). */
  private async ensureTimelineCovers(): Promise<void> {
    if (this.timelineCoversComplete || this.timelineCoversLoading()) return;
    const gen = ++this.coversGen;
    this.timelineCoversLoading.set(true);
    this.timelineCoversError.set(null);
    try {
      for (;;) {
        const res = await this.fileService.loadMediaMonths(this.timelineCoversNextBefore);
        if (gen !== this.coversGen) return;
        this.timelineCovers.update(cur => [...(cur ?? []), ...res.months]);
        this.timelineCoversNextBefore = res.next_before;
        if (res.complete || res.next_before == null) { this.timelineCoversComplete = true; break; }
        // Stop pulling more history once the user has navigated away from the
        // cover scales — they'll resume on demand.
        if (!this.isTimeline() || this.timelineScale() === 'all') break;
      }
    } catch (err) {
      console.error('timeline covers error:', err);
      if (this.timelineCovers() === null) this.timelineCovers.set([]);
      this.timelineCoversError.set((err as any)?.error?.error ?? 'Request failed');
    } finally {
      if (gen === this.coversGen) this.timelineCoversLoading.set(false);
    }
  }

  setTimelineScale(scale: 'year' | 'month' | 'all'): void {
    this.timelineScale.set(scale);
    if (scale === 'all') {
      this.resumeOrStartTimelineStream('full', null);
    } else {
      // Cover scales don't need the stream — stop its background page loop
      // immediately (it resumes from the saved cursor when returning to All).
      this.cancelTimelineStream();
      this.ensureTimelineCovers();
    }
    this.scrollContentTop();
  }

  /** Stop the background page loop without discarding what's loaded. */
  private cancelTimelineStream(): void {
    ++this.timelineGen; // running loop bails on its next generation check
    this.timelineLoadingMore.set(false);
  }

  /** Continue an interrupted stream from its cursor, or start a new one. */
  private resumeOrStartTimelineStream(key: string, period: { after: number; before: number } | null): void {
    if (this.timelineLoadedKey === key) {
      if (!this.timelineDone() && !this.timelineLoadingMore()) {
        ++this.timelineGen;
        this.ensureTimelineBuffer(); // resumes from this.timelineCursor
      }
      return;
    }
    this.startTimelineStream(key, period);
  }

  openTimelineYear(year: number): void {
    this.timelineScale.set('month');
    this.ensureTimelineCovers();
    setTimeout(() => {
      document.querySelector(`.months-year-block[data-year="${year}"]`)
        ?.scrollIntoView({ block: 'start' });
    }, 50);
  }

  openTimelineMonth(m: MonthCover): void {
    const after = Math.floor(new Date(m.year, m.month - 1, 1).getTime() / 1000);
    const before = Math.floor(new Date(m.year, m.month, 1).getTime() / 1000) - 1;
    this.timelineScale.set('all');
    // resume-or-start: re-tapping the month whose stream was interrupted
    // continues from its cursor instead of being a silent no-op
    this.resumeOrStartTimelineStream(m.key, { after, before });
    this.scrollContentTop();
  }

  private scrollContentTop(): void {
    document.querySelector('.file-content')?.scrollTo({ top: 0 });
  }

  /** DOM render window: data loads fully in the background, but only this many
   *  items are RENDERED — thousands of file cards at once freeze the app.
   *  Grows as the user scrolls near the bottom. */
  readonly timelineRenderLimit = signal(200);
  readonly timelineHasMoreToRender = computed(() =>
    this.isTimeline() && this.timelineRenderLimit() < (this.fileService.searchResults()?.length ?? 0)
  );

  /** kDrive timestamps are unix SECONDS (numbers or numeric strings); treating
   *  them as Date-parseable strings/milliseconds lands everything in Jan 1970. */
  private parseFileDate(raw: string | null): Date | null {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!isNaN(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Consecutive month/year groups from the (already date-desc) flat list —
   *  capped at the render window; the full list stays in searchResults so
   *  preview navigation spans everything loaded. */
  readonly timelineGroups = computed(() => {
    if (!this.isTimeline()) return [];
    const files = (this.fileService.searchResults() ?? []).slice(0, this.timelineRenderLimit());
    const groups: { key: string; label: string; files: DriveFile[] }[] = [];
    let current: { key: string; label: string; files: DriveFile[] } | null = null;
    for (const f of files) {
      const d = this.parseFileDate(f.modified_at);
      const key = d
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        : 'unknown';
      if (!current || current.key !== key) {
        const label: string = d
          ? d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
          : 'Unknown date';
        current = { key, label, files: [] };
        groups.push(current);
      }
      current.files.push(f);
    }
    return groups;
  });

  async showTimeline(): Promise<void> {
    this.closeSidebarOnMobile();
    this.fileService.clearSelection();
    this.fileService.breadcrumb.set([{ id: '__timeline__', name: 'Timeline' }]);
    this.fileService.currentFolderId.set('__timeline__');
    this.router.navigate(['/folder', '__timeline__'], { replaceUrl: true });
    this.timelineScale.set('all');
    this.timelineLoadedKey = null; // fresh entry — always (re)load the stream
    this.startTimelineStream('full', null);
  }

  /** (Re)start the media stream for a target: 'full' or one month (period
   *  bounds, unix seconds). No-op if that exact target is already loaded. */
  private startTimelineStream(key: string, period: { after: number; before: number } | null): void {
    if (this.timelineLoadedKey === key) return;
    this.timelineLoadedKey = key;
    this.timelinePeriod = period;
    this.fileService.searchResults.set([]);
    this.timelineCursor = null;
    this.timelineDone.set(false);
    this.timelineRenderLimit.set(200);
    ++this.timelineGen;
    this.ensureTimelineBuffer(); // fills the initial render window + buffer only
  }

  /** Grow the render window as the user approaches the bottom, and top up the
   *  data buffer to stay ahead of it. */
  onContentScroll(e: Event): void {
    if (!this.isTimeline() || this.timelineScale() !== 'all') return;
    const el = e.target as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1200) {
      const total = this.fileService.searchResults()?.length ?? 0;
      if (this.timelineRenderLimit() < total) {
        this.timelineRenderLimit.update(n => Math.min(n + 300, total));
      }
      this.ensureTimelineBuffer();
    }
  }

  /** How far ahead of the render window the data buffer is kept. */
  private static readonly TIMELINE_BUFFER = 600;

  /** Buffered LAZY loading — never loads the whole drive. With ~100k files
   *  at 1000/page, a load-everything loop fires ~100 back-to-back requests
   *  and permanently saturates kDrive's short rolling rate-limit window;
   *  instead only fetch pages while the loaded count trails the render
   *  window + buffer. Scrolling tops the buffer up; month drill-downs are
   *  naturally small. Generation-guarded against stale appends. */
  private async ensureTimelineBuffer(): Promise<void> {
    if (this.timelineLoadingMore() || this.timelineDone() || !this.isTimeline()) return;
    const gen = this.timelineGen;
    this.timelineLoadingMore.set(true);
    try {
      while (!this.timelineDone()
          && (this.fileService.searchResults()?.length ?? 0)
             < this.timelineRenderLimit() + FileBrowserComponent.TIMELINE_BUFFER) {
        const period = this.timelinePeriod;
        // A month stream seeds page 0 with modified_before = end-of-month; later
        // pages ride the cursor (which already encodes the filter). kDrive can't
        // filter modified_after into the past, so the lower bound is applied
        // client-side and the stream stops once files predate the month.
        const before = period && !this.timelineCursor ? period.before : null;
        const page = await this.fileService.loadMediaPage(this.timelineCursor, before);
        if (gen !== this.timelineGen || !this.isTimeline()) return;
        this.timelineCursor = page.cursor;
        if (!page.has_more || !page.cursor) this.timelineDone.set(true);
        let data = page.data;
        if (period) {
          const secs = (f: DriveFile) => (this.parseFileDate(f.modified_at)?.getTime() ?? 0) / 1000;
          if (page.data.some(f => secs(f) < period.after)) this.timelineDone.set(true);
          data = page.data.filter(f => { const t = secs(f); return t >= period.after && t <= period.before; });
        }
        if (data.length > 0) {
          this.fileService.searchResults.update(r => [...(r ?? []), ...data]);
        }
      }
    } catch (err) {
      console.error('timeline load error:', err);
    } finally {
      if (gen === this.timelineGen) this.timelineLoadingMore.set(false);
    }
  }

  async showShares(): Promise<void> {
    this.closeSidebarOnMobile();
    await this.fileService.loadShares();
    this.fileService.searchResults.set(this.fileService.sharedFiles());
    this.fileService.breadcrumb.set([{ id: '__shares__', name: 'My Shares' }]);
    this.fileService.currentFolderId.set('__shares__');
    this.router.navigate(['/folder', '__shares__'], { replaceUrl: true });
  }

  openShare(file: DriveFile): void {
    this.sharingFile.set(file);
  }

  /** After a share is created/updated/deleted: refresh sharedFileIds (icons
   *  everywhere), and if we're viewing "My Shares" itself, also re-sync its
   *  file list — that view's contents come from a searchResults snapshot
   *  that loadShares() alone does not touch. */
  async onShareChanged(): Promise<void> {
    await this.fileService.loadShares();
    if (this.fileService.currentFolderId() === '__shares__') {
      this.fileService.searchResults.set(this.fileService.sharedFiles());
    }
  }

  closeSidebarOnMobile(): void {
    if (window.innerWidth <= 768) this.sidebarOpen.set(false);
  }

  navigateToFolder(id: string, name: string): void {
    this.fileService.clearSelection();
    this.fileService.navigateToFolder(id, name);
    this.router.navigate(['/folder', id]);
    this.loadCurrentFolder();
    this.closeSidebarOnMobile();
  }

  async toggleFavorite(file: DriveFile): Promise<void> {
    await this.fileService.toggleFavorite(file);
    if (this.previewFile()?.id === file.id) {
      this.previewFile.update(f => f ? { ...f, is_favorite: !file.is_favorite } : f);
    }
  }

  private _pendingPickerPath = '';
  onPickerFolderPath(path: string): void { this._pendingPickerPath = path; }

  openMoveForFile(file: DriveFile): void {
    this.movingFiles.set([file]);
  }

  openBulkMove(): void {
    const ids = [...this.fileService.selectedIds()];
    const files = ids.map(id => this.displayFiles().find(f => f.id === id)).filter(Boolean) as DriveFile[];
    this.movingFiles.set(files);
  }

  openCopyForFile(file: DriveFile): void {
    this.copyingFiles.set([file]);
  }

  openBulkCopy(): void {
    const ids = [...this.fileService.selectedIds()];
    const files = ids.map(id => this.displayFiles().find(f => f.id === id)).filter(Boolean) as DriveFile[];
    this.copyingFiles.set(files);
  }

  async onCopyFolderSelected(folder: DriveFile): Promise<void> {
    const files = this.copyingFiles();
    this.copyingFiles.set(null);
    if (!files) return;
    await this.executeCopyFiles(files, folder.id);
  }

  private async executeCopyFiles(files: DriveFile[], folderId: string): Promise<void> {
    const results = await Promise.allSettled(
      files.map(f => this.fileService.copyFile(f.id, folderId))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    const copied = files.length - failed;
    if (failed > 0) {
      const msg = copied > 0
        ? `${copied} copied, ${failed} failed`
        : `Copy failed for all ${failed} files`;
      this.bulkMoveToast.set(msg);
      setTimeout(() => this.bulkMoveToast.set(null), 6000);
    } else {
      const msg = files.length === 1 ? 'Copy created' : `${files.length} copies created`;
      this.bulkMoveToast.set(msg);
      setTimeout(() => this.bulkMoveToast.set(null), 4000);
      this.saveRecentMoveFolder({ id: folderId, name: '' } as DriveFile, this._pendingPickerPath);
    }
  }

  async onPickerFolderSelected(folder: DriveFile): Promise<void> {
    const files = this.movingFiles();
    this.movingFiles.set(null);
    if (!files) return;
    await this.executeMoveFiles(files, folder.id);
  }

  private async executeMoveFiles(files: DriveFile[], folderId: string): Promise<void> {
    let nextAfterMove: DriveFile | null = null;
    if (files.length === 1 && this.previewFile()?.id === files[0].id) {
      const all = this.mediaFiles();
      const idx = all.findIndex(f => f.id === files[0].id);
      nextAfterMove = all[idx + 1] ?? all[idx - 1] ?? null;
    }

    const results = await Promise.allSettled(
      files.map(f => this.fileService.moveFile(f.id, folderId, 'skip').then(() => f.id))
    );
    const failedIds = new Set(
      results.flatMap((r, i) => r.status === 'rejected' ? [files[i].id] : [])
    );
    if (failedIds.size > 0) {
      this.fileService.selectedIds.set(failedIds);
      const moved = files.length - failedIds.size;
      const msg = moved > 0
        ? `${moved} moved, ${failedIds.size} already exist at destination`
        : `${failedIds.size} already exist at destination — nothing moved`;
      this.bulkMoveToast.set(msg);
      setTimeout(() => this.bulkMoveToast.set(null), 6000);
    } else {
      this.fileService.clearSelection();
      this.saveRecentMoveFolder({ id: folderId, name: '' } as DriveFile, this._pendingPickerPath);
    }

    if (files.length === 1 && this.previewFile()?.id === files[0].id) {
      if (!nextAfterMove) {
        this.closePreview();
      } else {
        this.previewFile.set(nextAfterMove);
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
    const results = await Promise.allSettled(files.map(f => this.fileService.delete(f).then(() => f.id)));
    const failedIds = new Set(
      results.flatMap((r, i) => r.status === 'rejected' ? [files[i].id] : [])
    );
    if (failedIds.size > 0) {
      this.fileService.selectedIds.set(failedIds);
      this.bulkMoveToast.set(`Deleted ${files.length - failedIds.size} of ${files.length} files. ${failedIds.size} failed — try again.`);
      setTimeout(() => this.bulkMoveToast.set(null), 6000);
    } else {
      this.fileService.clearSelection();
    }
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
    await this.fileService.createFolder(this.uploadTargetFolderId(), name);
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
    this.pendingMoveIds.update(s => { const n = new Set(s); n.delete(event.file.id); return n; });
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

  onNewFolderFromMenu(): void {
    this.addMenuOpen.set(false);
    this.showCreateFolder.set(true);
  }

  async onFilesSelected(event: Event): Promise<void> {
    const files = Array.from((event.target as HTMLInputElement).files ?? []);
    (event.target as HTMLInputElement).value = '';
    if (!files.length) return;
    await this.uploadFiles(files);
  }

  private async uploadFiles(files: File[]): Promise<void> {
    const folderId = this.uploadTargetFolderId();
    this.uploadTotal.set(files.length);
    this.uploadDone.set(0);
    this.uploadErrors.set(0);
    const results = await Promise.allSettled(files.map(async f => {
      const uploaded = await this.fileService.uploadFile(folderId, f.name, f.type || 'application/octet-stream', f);
      this.uploadDone.update(n => n + 1);
      return uploaded;
    }));
    const failed = results.filter(r => r.status === 'rejected').length;
    this.uploadTotal.set(0);
    this.uploadDone.set(0);
    if (failed > 0) {
      this.bulkMoveToast.set(`${results.length - failed} uploaded, ${failed} failed`);
      setTimeout(() => this.bulkMoveToast.set(null), 5000);
    } else {
      this.bulkMoveToast.set(`${results.length} file${results.length > 1 ? 's' : ''} uploaded`);
      setTimeout(() => this.bulkMoveToast.set(null), 3000);
    }
    this.loadCurrentFolder();
  }

onScanUploaded(_files: DriveFile[]): void {
    this.scanOpen.set(false);
    this.loadCurrentFolder();
  }

  onDocClick(): void {
    this.filterMenuOpen.set(false);
    this.viewMenuOpen.set(false);
    this.statsPopoverOpen.set(false);
    this.addMenuOpen.set(false);
  }

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
