import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { DriveFile, FileListOptions, BreadcrumbItem, HOME_FOLDER_ID, PreviewSession, ShareLink, ShareLinkOptions, MonthCover, MediaMonthsResponse } from '../models/drive-file.model';
import { FolderTreeNode, DriveUsage } from '../models/drive.model';

interface ApiResponse<T> {
  data: T;
}

export interface FolderStats {
  count: number;
  files: number;
  directories: number;
  total_count: number;
  total_files: number;
  total_directories: number;
  size: number;
}

interface FilesResponse {
  data: DriveFile[];
  cursor: string | null;
  has_more: boolean;
}

export interface SearchOptions {
  sortBy?: string;
  sortDir?: string;
  types?: string[];
  all?: boolean;
}

@Injectable({ providedIn: 'root' })
export class FileService {
  private http = inject(HttpClient);

  readonly files = signal<DriveFile[]>([]);
  readonly searchResults = signal<DriveFile[] | null>(null);
  readonly searchLoading = signal(false);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly currentFolderId = signal(HOME_FOLDER_ID);
  readonly breadcrumb = signal<BreadcrumbItem[]>([{ id: HOME_FOLDER_ID, name: 'My Drive' }]);
  readonly folderTree = signal<FolderTreeNode | null>(null);
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly folderStats = signal<FolderStats | null>(null);
  readonly previewOpen = signal(false);
  readonly sessions = signal<PreviewSession[]>([]);
  readonly searchCapped = signal(false);
  /** IDs of every file/folder with an active share link — populated by loadShares(),
   *  used app-wide to decide "Share" vs "Edit share" in menus and preview. */
  readonly sharedFileIds = signal<Set<string>>(new Set());
  readonly sharedFiles = signal<DriveFile[]>([]);

  /** Bulk-share download progress: null when idle. */
  readonly shareProgress = signal<{ current: number; total: number; percent: number } | null>(null);
  /** Last bulk-share error message, shown in a dismissible banner. Null = no error. */
  readonly shareError = signal<string | null>(null);
  /** Files fully downloaded and ready to share, but the OS declined the
   *  handoff because the user-activation window from the original tap had
   *  expired by the time the download finished (navigator.share() requires
   *  a FRESH gesture — there is no way to keep the original one alive across
   *  a slow download). Non-null means the UI should offer a one-tap "Share
   *  now" retry; tapping it calls retryShare() from that tap's own gesture. */
  readonly pendingShareFiles = signal<File[] | null>(null);

  private loadGeneration = 0;
  /** Emits to actually abort in-flight /api/files requests (via takeUntil) —
   *  bumping loadGeneration alone only discards a stale response after it
   *  lands, it doesn't free the connection/bandwidth. Triggered by
   *  cancelLoad()/cancelAllLoads() — used when a view is genuinely being
   *  left (destroy/navigate), where there's nothing to resume. */
  private loadAbort$ = new Subject<void>();

  /** True while background loads (folder pagination, thumbnails) should
   *  hold off starting anything new — set around a share/download so it
   *  isn't competing for bandwidth/backend workers. Nothing already in
   *  flight is aborted; only the NEXT page/thumbnail waits, then continues
   *  from where it left off once resumeBackgroundLoads() runs. */
  readonly backgroundLoadsPaused = signal(false);
  private resumeLoads$ = new Subject<void>();

  private async waitIfPaused(): Promise<void> {
    while (this.backgroundLoadsPaused()) {
      await firstValueFrom(this.resumeLoads$);
    }
  }

  /** /api/folder-tree has no cursor the client can resume from — unlike
   *  paginated file loads, aborting it mid-flight means the ENTIRE walk
   *  restarts from scratch. That's still worth it to free the connection/
   *  backend worker immediately for a slow share/download; it's just not
   *  free the way pausing a not-yet-started request is. */
  private folderTreeInFlight = false;
  private folderTreeNeedsRestart = false;
  private folderTreeAbort$ = new Subject<void>();

  pauseBackgroundLoads(): void {
    this.backgroundLoadsPaused.set(true);
    if (this.folderTreeInFlight) {
      this.folderTreeNeedsRestart = true;
      this.folderTreeAbort$.next();
    }
  }

  /** Resume paused background loads. Folder pagination continues from its
   *  existing cursor (nothing was lost), any thumbnails held back start
   *  fetching normally, and a folder-tree walk interrupted mid-flight
   *  restarts from the top (see the field doc above). */
  resumeBackgroundLoads(): void {
    this.backgroundLoadsPaused.set(false);
    this.resumeLoads$.next();
  }

  async loadFiles(options: FileListOptions): Promise<void> {
    this.folderStats.set(null);
    const generation = ++this.loadGeneration;

    this.loading.set(true);
    this.loadingMore.set(false);
    const params: Record<string, string> = {
      folderId: options.folderId,
      sortBy: options.sortBy,
      sortDir: options.sortDir,
    };
    if (options.type) params['type'] = options.type;

    try {
      await this.waitIfPaused();
      if (generation !== this.loadGeneration) return;
      const first = await firstValueFrom(
        this.http.get<FilesResponse>('/api/files', { params }).pipe(takeUntil(this.loadAbort$))
      );
      if (generation !== this.loadGeneration) return;
      this.files.set(first.data);
      this.currentFolderId.set(options.folderId);
      this.loading.set(false);

      if (first.has_more && first.cursor) {
        this.loadingMore.set(true);
        let cursor: string | null = first.cursor;
        while (cursor) {
          if (generation !== this.loadGeneration) return;
          await this.waitIfPaused();
          if (generation !== this.loadGeneration) return;
          const page: FilesResponse = await firstValueFrom(
            this.http.get<FilesResponse>('/api/files', { params: { ...params, cursor } }).pipe(takeUntil(this.loadAbort$))
          );
          if (generation !== this.loadGeneration) return;
          this.files.update(f => [...f, ...page.data]);
          cursor = page.has_more && page.cursor ? page.cursor : null;
        }
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      console.error('loadFiles error:', err);
    } finally {
      if (generation === this.loadGeneration) {
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    }
  }

  async loadFolderStats(folderId: string): Promise<void> {
    try {
      this.folderStats.set(await this.getFolderStats(folderId));
    } catch { /* non-critical */ }
  }

  /** Folder stats as a return value (doesn't touch the shared folderStats
   *  signal) — used by the per-file Info dialog. */
  async getFolderStats(folderId: string): Promise<FolderStats> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<FolderStats>>(`/api/files/${folderId}/stats`)
    );
    return res.data;
  }

  async loadSessions(): Promise<void> {
    try {
      const res = await firstValueFrom(this.http.get<PreviewSession[]>('/api/sessions'));
      this.sessions.set(Array.isArray(res) ? res : []);
    } catch { /* non-critical */ }
  }

  /** Cancel any in-progress loadFiles pagination loop, actually aborting the
   *  underlying HTTP request(s) so they stop competing for bandwidth/
   *  connections — not just discarding a response after it lands. */
  cancelLoad(): void {
    this.loadAbort$.next();
    ++this.loadGeneration;
    this.loading.set(false);
    this.loadingMore.set(false);
  }

  /** Cancel EVERY in-flight view load — folder pagination, trash, favorites,
   *  shares (via the load generation) and search (via its abort subject) — so
   *  switching views (My Drive ↔ Trash ↔ Favorites ↔ Shares ↔ Timeline ↔ …)
   *  can't have a late response from the view being left land in the new one.
   *  Called at the start of every view switch. */
  cancelAllLoads(): void {
    this.loadAbort$.next();
    ++this.loadGeneration;
    this.searchAbort$.next();
    ++this.searchGen;
    this.loading.set(false);
    this.loadingMore.set(false);
    this.searchLoading.set(false);
  }

  /** Seed a file list and cancel any in-progress loadFiles so it won't overwrite the seeded data. */
  seedFiles(files: DriveFile[]): void {
    ++this.loadGeneration;
    this.files.set(files);
    this.searchResults.set(null);
    this.loading.set(false);
    this.loadingMore.set(false);
  }

  async saveSession(s: Omit<PreviewSession, 'id' | 'saved_at'>): Promise<void> {
    await firstValueFrom(this.http.post('/api/sessions', s));
    this.loadSessions();
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.update(list => list.filter(s => s.id !== id));
    await firstValueFrom(this.http.delete(`/api/sessions/${id}`));
  }

  async loadFolderTree(): Promise<void> {
    try {
      await this.waitIfPaused();
      this.folderTreeInFlight = true;
      const res = await firstValueFrom(
        this.http.get<ApiResponse<FolderTreeNode>>('/api/folder-tree').pipe(takeUntil(this.folderTreeAbort$))
      );
      this.folderTreeInFlight = false;
      this.folderTree.set(res.data);
    } catch (err) {
      this.folderTreeInFlight = false;
      if (this.folderTreeNeedsRestart) {
        // Interrupted by pauseBackgroundLoads() mid-flight — restart from
        // the top once whatever paused it resumes (waitIfPaused() above
        // handles that on the next call).
        this.folderTreeNeedsRestart = false;
        this.loadFolderTree();
        return;
      }
      console.error('loadFolderTree error:', err);
    }
  }

  /** Load the trash root, or a trashed subfolder's contents. With no sort
   *  args the backend default applies (deleted_at desc). */
  async loadTrash(sortBy?: string, sortDir?: string, folderId?: string | null): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    try {
      const params: Record<string, string> = {};
      if (sortBy && sortDir) { params['sortBy'] = sortBy; params['sortDir'] = sortDir; }
      const url = folderId ? `/api/trash/${folderId}/files` : '/api/trash';
      const res = await firstValueFrom(
        this.http.get<ApiResponse<DriveFile[]>>(url, { params })
      );
      if (generation !== this.loadGeneration) return; // superseded by a newer load / view switch
      this.files.set(res.data);
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  async loadFavorites(): Promise<DriveFile[]> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<DriveFile[]>>('/api/favorites')
    );
    return res.data;
  }

  private searchGen = 0;
  private searchAbort$ = new Subject<void>();
  /** Cursor + params for loading further search pages (load-more-on-scroll). */
  private searchCursor: string | null = null;
  private lastSearch: { query: string; folderId?: string; options: SearchOptions } | null = null;
  readonly searchHasMore = signal(false);
  readonly searchLoadingMore = signal(false);

  abortSearch(): void {
    this.searchAbort$.next();
    ++this.searchGen;
    this.searchLoading.set(false);
    this.searchLoadingMore.set(false);
    this.searchHasMore.set(false);
    this.searchCursor = null;
    this.lastSearch = null;
  }

  private searchParams(query: string, folderId: string | undefined, options: SearchOptions, cursor?: string | null): Record<string, string> {
    const params: Record<string, string> = { q: query };
    if (folderId) params['folderId'] = folderId;
    if (options.sortBy) params['sortBy'] = options.sortBy;
    if (options.sortDir) params['sortDir'] = options.sortDir;
    if (options.types?.length) params['types'] = options.types.join(',');
    if (options.all) params['all'] = '1';
    if (cursor) params['cursor'] = cursor;
    return params;
  }

  async search(query: string, folderId?: string, options?: SearchOptions): Promise<void> {
    this.searchAbort$.next();
    const gen = ++this.searchGen;
    const opts = options ?? {};
    this.lastSearch = { query, folderId, options: opts };
    this.searchCursor = null;
    this.searchHasMore.set(false);

    this.searchLoading.set(true);
    this.searchResults.set([]);
    this.searchCapped.set(false);

    try {
      const res = await firstValueFrom(
        this.http.get<{ data: DriveFile[]; has_more: boolean; cursor: string | null; capped: boolean }>(
          '/api/search', { params: this.searchParams(query, folderId, opts) }
        ).pipe(takeUntil(this.searchAbort$))
      );
      if (gen !== this.searchGen) return;
      this.searchResults.set(res.data);
      this.searchCursor = res.cursor;
      this.searchHasMore.set(res.has_more);
      this.searchCapped.set(res.capped ?? false);
    } finally {
      if (gen === this.searchGen) this.searchLoading.set(false);
    }
  }

  /** Fetch the next page of the current search and append it (scroll-driven). */
  async loadMoreSearch(): Promise<void> {
    if (!this.searchCursor || this.searchLoadingMore() || !this.lastSearch) return;
    const gen = this.searchGen;
    const { query, folderId, options } = this.lastSearch;
    this.searchLoadingMore.set(true);
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: DriveFile[]; has_more: boolean; cursor: string | null; capped: boolean }>(
          '/api/search', { params: this.searchParams(query, folderId, options, this.searchCursor) }
        ).pipe(takeUntil(this.searchAbort$))
      );
      if (gen !== this.searchGen) return;
      this.searchResults.update(cur => [...(cur ?? []), ...res.data]);
      this.searchCursor = res.cursor;
      this.searchHasMore.set(res.has_more);
    } finally {
      if (gen === this.searchGen) this.searchLoadingMore.set(false);
    }
  }

  /** One page of the recursive media listing (newest first), optionally
   *  bounded to a period (unix seconds). A page may be empty while has_more
   *  is still true (server-side media filtering) — callers keep paginating. */
  async loadMediaPage(cursor?: string | null, order: 'asc' | 'desc' = 'desc'): Promise<FilesResponse> {
    const params: Record<string, string> = {};
    if (cursor) params['cursor'] = cursor;
    if (order === 'asc') params['order'] = 'asc';
    return firstValueFrom(
      this.http.get<FilesResponse>('/api/media', { params })
    );
  }

  /** The live month-cover index (newest first). A plain call is read-only.
   *  `rebuild` advances a full rebuild of the whole index a few pages — poll
   *  until `complete` is true (the fresh walk has finished and swapped in,
   *  dropping any deleted files). */
  async loadMediaMonths(rebuild = false): Promise<MediaMonthsResponse> {
    const params: Record<string, string> = rebuild ? { rebuild: '1' } : {};
    const res = await firstValueFrom(
      this.http.get<ApiResponse<MediaMonthsResponse>>('/api/media/months', { params })
    );
    return res.data;
  }

  /** Sidebar-pinned folders — server-side so pins match across devices. */
  async loadPins(): Promise<{ id: string; name: string }[]> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<{ id: string; name: string }[]>>('/api/pins')
    );
    return res.data;
  }

  async addPin(id: string, name: string): Promise<{ id: string; name: string }[]> {
    const res = await firstValueFrom(
      this.http.post<ApiResponse<{ id: string; name: string }[]>>('/api/pins', { id, name })
    );
    return res.data;
  }

  async removePin(id: string): Promise<{ id: string; name: string }[]> {
    const res = await firstValueFrom(
      this.http.delete<ApiResponse<{ id: string; name: string }[]>>(`/api/pins/${id}`)
    );
    return res.data;
  }

  async loadShares(): Promise<void> {
    const generation = this.loadGeneration;
    try {
      const res = await firstValueFrom(
        this.http.get<ApiResponse<DriveFile[]>>('/api/shares')
      );
      if (generation !== this.loadGeneration) return; // superseded by a view switch
      this.sharedFiles.set(res.data);
      this.sharedFileIds.set(new Set(res.data.map(f => f.id)));
    } catch (err) {
      console.error('loadShares error:', err);
    }
  }

  async getShareLink(fileId: string): Promise<ShareLink | null> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<ShareLink | null>>(`/api/files/${fileId}/share`)
    );
    return res.data;
  }

  async createShareLink(fileId: string, options: ShareLinkOptions): Promise<ShareLink> {
    const res = await firstValueFrom(
      this.http.post<ApiResponse<ShareLink>>(`/api/files/${fileId}/share`, options)
    );
    this.sharedFileIds.update(s => new Set([...s, fileId]));
    return res.data;
  }

  async updateShareLink(fileId: string, options: Partial<ShareLinkOptions>): Promise<void> {
    await firstValueFrom(this.http.put(`/api/files/${fileId}/share`, options));
  }

  async deleteShareLink(fileId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/files/${fileId}/share`));
    this.sharedFileIds.update(s => { const n = new Set(s); n.delete(fileId); return n; });
    this.sharedFiles.update(files => files.filter(f => f.id !== fileId));
  }

  async getUsage(): Promise<DriveUsage> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<DriveUsage>>('/api/usage')
    );
    return res.data;
  }

  async restoreFile(fileId: string): Promise<void> {
    await firstValueFrom(this.http.post(`/api/files/${fileId}/restore`, {}));
    this.removeFromLists(fileId);
  }

  /** Drop a file id from BOTH files() and searchResults() — the latter backs
   *  the timeline / starred / shares / search views, so a delete that only
   *  touched files() left those views showing the removed item. */
  private removeFromLists(fileId: string): void {
    this.files.update(files => files.filter(f => f.id !== fileId));
    this.searchResults.update(r => r ? r.filter(f => f.id !== fileId) : r);
  }

  /** Permanently remove one item from the trash (irreversible). */
  async permanentDelete(fileId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/trash/${fileId}`));
    this.removeFromLists(fileId);
  }

  /** Empty the whole trash (irreversible). */
  async emptyTrash(): Promise<void> {
    await firstValueFrom(this.http.delete('/api/trash'));
    this.files.set([]);
  }

  async delete(file: DriveFile): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/files/${file.id}`));
    this.removeFromLists(file.id);
    this.folderStats.update(s => {
      if (!s) return s;
      const isDir = file.is_dir;
      return {
        ...s,
        count:             s.count - 1,
        files:             isDir ? s.files : s.files - 1,
        directories:       isDir ? s.directories - 1 : s.directories,
        total_count:       s.total_count - 1,
        total_files:       isDir ? s.total_files : s.total_files - 1,
        total_directories: isDir ? s.total_directories - 1 : s.total_directories,
        size:              isDir ? s.size : Math.max(0, s.size - (file.size ?? 0)),
      };
    });
  }

  async toggleFavorite(file: DriveFile): Promise<void> {
    if (file.is_favorite) {
      await firstValueFrom(this.http.delete(`/api/files/${file.id}/favorite`));
    } else {
      await firstValueFrom(this.http.post(`/api/files/${file.id}/favorite`, {}));
    }
    const update = (files: DriveFile[]) =>
      files.map(f => f.id === file.id ? { ...f, is_favorite: !f.is_favorite } : f);
    this.files.update(update);
    if (this.searchResults() !== null) {
      this.searchResults.update(r => r ? update(r) : r);
    }
  }

  async createFolder(parentId: string, name: string, addToFileList = true): Promise<DriveFile> {
    const res = await firstValueFrom(
      this.http.post<ApiResponse<DriveFile>>('/api/folders', { parent_id: parentId, name })
    );
    const folder = res.data;
    if (addToFileList) {
      this.files.update(files => [folder, ...files]);
    }
    return folder;
  }

  async moveFile(fileId: string, destinationFolderId: string, strategy: 'override' | 'skip' = 'override'): Promise<void> {
    await firstValueFrom(this.http.post(`/api/files/${fileId}/move`, { destination_folder_id: destinationFolderId, strategy }));
    const update = (files: DriveFile[]) => files.filter(f => f.id !== fileId);
    this.files.update(update);
    if (this.searchResults() !== null) {
      this.searchResults.update(r => r ? update(r) : r);
    }
  }

  async copyFile(fileId: string, destinationFolderId: string): Promise<void> {
    await firstValueFrom(this.http.post(`/api/files/${fileId}/copy`, { destination_folder_id: destinationFolderId }));
  }

  async uploadFile(parentFolderId: string, fileName: string, mimeType: string, data: Blob): Promise<DriveFile> {
    const effectiveMime = mimeType || data.type || 'application/octet-stream';
    const res = await firstValueFrom(
      this.http.post<{data: DriveFile}>(
        `/api/folders/${parentFolderId}/upload`,
        data,
        { headers: { 'Content-Type': effectiveMime, 'X-File-Name': encodeURIComponent(fileName) } }
      )
    );
    return res.data;
  }

  async renameFile(fileId: string, name: string): Promise<void> {
    await firstValueFrom(this.http.post(`/api/files/${fileId}/rename`, { name }));
    const update = (files: DriveFile[]) => files.map(f => f.id === fileId ? { ...f, name } : f);
    this.files.update(update);
    if (this.searchResults() !== null) {
      this.searchResults.update(r => r ? update(r) : r);
    }
  }

  async fetchFolders(folderId: string): Promise<DriveFile[]> {
    const allFolders: DriveFile[] = [];
    let cursor: string | null = null;
    do {
      const params: Record<string, string> = { folderId };
      if (cursor) params['cursor'] = cursor;
      const res = await firstValueFrom(
        this.http.get<FilesResponse>('/api/files', { params })
      );
      allFolders.push(...res.data.filter(f => f.is_dir));
      cursor = res.has_more && res.cursor ? res.cursor : null;
    } while (cursor);
    return allFolders;
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<DriveFile>>(`/api/files/${fileId}`)
    );
    return res.data;
  }

  /** Conservative ceiling above which downloading first is likely to blow the
   *  Web Share gesture window before share() can run (NotAllowedError is a
   *  gesture-timing issue, not a documented API size limit — canShare() does
   *  not reliably predict it, so this is a heuristic, not an API check). */
  private static readonly SHARE_SIZE_WARN_BYTES = 40 * 1024 * 1024; // 40MB total

  async shareFiles(driveFiles: DriveFile[]): Promise<void> {
    this.shareError.set(null);
    if (driveFiles.length === 0) return;

    const nav = navigator as Navigator & {
      share?: (d: ShareData) => Promise<void>;
      canShare?: (d: ShareData) => boolean;
    };

    // Platforms with no Web Share API at all (desktop Firefox on any OS,
    // Windows browsers outside a secure context, etc.) can never show a
    // native share sheet no matter what we download — skip straight to plain
    // downloads (same path as bulkDownload) so the action still does
    // something useful instead of dead-ending with an error.
    if (!nav.share) {
      driveFiles.forEach(f => this.downloadFile(f.id, f.name, false));
      return;
    }

    // Fast, size-based pre-check: NOT a canShare() call. canShare() with
    // placeholder Files gives false negatives here (kDrive's reported
    // mime_type often doesn't match the real download's Content-Type), and
    // the actual failure mode for big files is gesture-window expiry during
    // download, which canShare() can't predict anyway.
    const totalBytes = driveFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalBytes > FileService.SHARE_SIZE_WARN_BYTES) {
      this.shareError.set(
          driveFiles.length > 1
              ? 'These files are too large to share together. Try sharing fewer files at once.'
              : 'This file is too large to share.'
      );
      return;
    }

    // Pausing/resuming background loads (folder pagination, thumbnails) is
    // the CALLER's responsibility here (see bulkShare() in
    // FileBrowserComponent) — it needs to pause and imperatively interrupt
    // in-flight thumbnails BEFORE calling this method (so nothing races the
    // download's own connection), and resume/restart them only once this
    // whole call settles, which a plain internal try/finally here can't
    // express as cleanly as the caller awaiting this promise.
    this.shareProgress.set({ current: 0, total: driveFiles.length, percent: 0 });

    const files: File[] = [];
    const failedNames: string[] = [];

    for (let i = 0; i < driveFiles.length; i++) {
      const file = driveFiles[i];
      const url = `/api/files/${file.id}/download?dl=1`;
      try {
        const blob = await this.downloadWithProgress(url, pct =>
            this.shareProgress.set({ current: i, total: driveFiles.length, percent: pct })
        );
        files.push(new File([blob], file.name, { type: blob.type || 'application/octet-stream' }));
        this.shareProgress.set({ current: i + 1, total: driveFiles.length, percent: 100 });
      } catch {
        failedNames.push(file.name);
      }
    }

    this.shareProgress.set(null);

    if (files.length === 0) {
      this.shareError.set(`Couldn't download ${failedNames.length === 1 ? 'the file' : 'any files'} to share. Please try again.`);
      return;
    }

    // Real canShare() check, on the ACTUAL downloaded blobs — this is the one
    // that gives a trustworthy answer, per your Mac testing. If the platform
    // refuses these files, we've already paid for the download — save them
    // locally instead of throwing that work away.
    if (nav.canShare && !nav.canShare({ files })) {
      this.saveBlobsLocally(files);
      if (failedNames.length > 0) {
        this.shareError.set(`${failedNames.length} file(s) couldn't be included: ${failedNames.join(', ')}`);
      }
      return;
    }

    try {
      await nav.share({ files });
    } catch (err) {
      if (this.isShareGestureExpiredError(err)) {
        // The download took long enough that the user-activation window
        // from the original tap expired — navigator.share() can ONLY be
        // called from a fresh gesture, there is no way to keep the old one
        // alive. The files are already downloaded, so offer a one-tap retry
        // instead of silently falling back to a plain download.
        this.pendingShareFiles.set(files);
        const base = files.length > 1
            ? 'Files are ready — tap Share to send them.'
            : 'File is ready — tap Share to send it.';
        this.shareError.set(
            failedNames.length > 0
                ? `${base} (${failedNames.length} file(s) couldn't be included: ${failedNames.join(', ')})`
                : base
        );
        return;
      }
      if (this.isShareSizeError(err)) {
        // A genuine size limit — retrying won't help, save the files instead.
        this.saveBlobsLocally(files);
      }
      /* otherwise: user dismissed the share sheet — not an error */
    }

    if (failedNames.length > 0) {
      const prefix = this.shareError() ? this.shareError() + ' Also, ' : '';
      this.shareError.set(`${prefix}${failedNames.length} file(s) couldn't be included: ${failedNames.join(', ')}`);
    }
  }

  /** Retries navigator.share() using files already downloaded by a previous
   *  shareFiles() call whose activation window expired. Call this as the
   *  FIRST thing in a fresh click/tap handler ("Share now" button) — any
   *  await before it burns the new gesture too, and share() would fail
   *  again for the same reason. */
  async retryShare(): Promise<void> {
    const files = this.pendingShareFiles();
    if (!files) return;
    this.pendingShareFiles.set(null);
    this.shareError.set(null);

    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (!nav.share) {
      this.saveBlobsLocally(files);
      return;
    }

    try {
      await nav.share({ files });
    } catch (err) {
      if (this.isShareGestureExpiredError(err) || this.isShareSizeError(err)) {
        // Failed again even with a fresh gesture — stop prompting and just
        // save the files rather than loop the retry forever.
        this.saveBlobsLocally(files);
      }
      /* otherwise: user dismissed the share sheet — not an error */
    }
  }

  private isShareGestureExpiredError(err: unknown): boolean {
    return (err as any)?.name === 'NotAllowedError';
  }

  private isShareSizeError(err: unknown): boolean {
    const name = (err as any)?.name ?? '';
    const message = String((err as any)?.message ?? err ?? '').toLowerCase();
    return name === 'DataError' || message.includes('too large') || message.includes('exceeds share limit');
  }

  /** Saves already-downloaded blobs to disk via a synthetic anchor click —
   *  the fallback when the OS share sheet isn't available or refuses the
   *  files, so the user still ends up with them instead of nothing. Revoking
   *  the object URL is deferred a tick so the download has time to start. */
  private saveBlobsLocally(files: File[]): void {
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  /** Downloads a URL as a Blob while reporting percentage progress. */
  private downloadWithProgress(url: string, onProgress: (pct: number) => void): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.http.get(url, { responseType: 'blob', reportProgress: true, observe: 'events' }).subscribe({
        next: event => {
          if (event.type === HttpEventType.DownloadProgress) {
            if (event.total) onProgress(Math.round((event.loaded / event.total) * 100));
          } else if (event.type === HttpEventType.Response) {
            if (event.body) resolve(event.body);
            else reject(new Error('Empty response body'));
          }
        },
        error: err => reject(err),
      });
    });
  }

  async downloadFile(fileId: string, name: string, allowShare = true): Promise<void> {
    const url = `/api/files/${fileId}/download?dl=1`;

    // iOS standalone PWAs (WKWebView) can't trigger a normal file download, but
    // they DO support the Web Share API — fetch the file and hand it to the OS
    // share sheet so the user gets "Save to Files" / share options.
    // (Skipped for bulk downloads — one share sheet per file would be unusable.)
    const nav = navigator as Navigator & {
      share?: (d: ShareData) => Promise<void>;
      canShare?: (d: ShareData) => boolean;
    };
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (allowShare && isIOS && nav.share) {
      try {
        const res = await firstValueFrom(
          this.http.get(url, { responseType: 'blob' })
        );
        const file = new File([res], name, { type: res.type || 'application/octet-stream' });
        if (!nav.canShare || nav.canShare({ files: [file] })) {
          // Once the OS share sheet is presented, this handoff is done — do NOT
          // fall through to the anchor. If share() rejects it's a user cancel
          // (AbortError), which is a completed action, not a retry: the anchor
          // fallback would navigate the PWA webview to the download URL and
          // trap the user on a dead "open in preview" page.
          try {
            await nav.share({ files: [file] });
          } catch {
            /* user dismissed the sheet — nothing more to do */
          }
          return;
        }
      } catch {
        /* couldn't fetch the blob or build the file — fall through to anchor */
      }
    }

    // Everywhere else: a plain attachment download (no _blank — the attachment
    // disposition downloads without navigating, so nothing gets trapped).
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  navigateToFolder(id: string, name: string): void {
    this.folderStats.set(null);
    const crumbs = this.breadcrumb();
    const isVirtual = crumbs.length > 0 && crumbs[0].id.startsWith('__');
    if (isVirtual) {
      this.breadcrumb.set(id === HOME_FOLDER_ID ? [{ id: HOME_FOLDER_ID, name: 'My Drive' }] : [{ id: HOME_FOLDER_ID, name: 'My Drive' }, { id, name }]);
      this.currentFolderId.set(id);
      return;
    }
    const existingIdx = crumbs.findIndex(c => c.id === id);
    if (existingIdx >= 0) {
      this.breadcrumb.set(crumbs.slice(0, existingIdx + 1));
    } else {
      this.breadcrumb.update(c => [...c, { id, name }]);
    }
    this.currentFolderId.set(id);
  }

  toggleSelect(id: string): void {
    this.selectedIds.update(set => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }
}
