import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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

  private loadGeneration = 0;

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
      const first = await firstValueFrom(
        this.http.get<FilesResponse>('/api/files', { params })
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
          const page: FilesResponse = await firstValueFrom(
            this.http.get<FilesResponse>('/api/files', { params: { ...params, cursor } })
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

  /** Cancel any in-progress loadFiles pagination loop. */
  cancelLoad(): void {
    ++this.loadGeneration;
    this.loading.set(false);
    this.loadingMore.set(false);
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
      const res = await firstValueFrom(
        this.http.get<ApiResponse<FolderTreeNode>>('/api/folder-tree')
      );
      this.folderTree.set(res.data);
    } catch (err) {
      console.error('loadFolderTree error:', err);
    }
  }

  async loadTrash(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await firstValueFrom(
        this.http.get<ApiResponse<DriveFile[]>>('/api/trash')
      );
      this.files.set(res.data);
    } finally {
      this.loading.set(false);
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

  abortSearch(): void {
    this.searchAbort$.next();
    ++this.searchGen;
    this.searchLoading.set(false);
  }

  async search(query: string, folderId?: string, options?: { sortBy?: string; sortDir?: string }): Promise<void> {
    this.searchAbort$.next();
    const gen = ++this.searchGen;
    const params: Record<string, string> = { q: query };
    if (folderId) params['folderId'] = folderId;
    if (options?.sortBy) params['sortBy'] = options.sortBy;
    if (options?.sortDir) params['sortDir'] = options.sortDir;

    this.searchLoading.set(true);
    this.searchResults.set([]);
    this.searchCapped.set(false);

    try {
      const res = await firstValueFrom(
        this.http.get<{ data: DriveFile[]; has_more: boolean; cursor: string | null; capped: boolean }>(
          '/api/search', { params }
        ).pipe(takeUntil(this.searchAbort$))
      );
      if (gen !== this.searchGen) return;
      this.searchResults.set(res.data);
      this.searchCapped.set(res.capped ?? false);
    } finally {
      if (gen === this.searchGen) this.searchLoading.set(false);
    }
  }

  /** One page of the recursive media listing (newest first), optionally
   *  bounded to a period (unix seconds). A page may be empty while has_more
   *  is still true (server-side media filtering) — callers keep paginating. */
  async loadMediaPage(cursor?: string | null): Promise<FilesResponse> {
    const params: Record<string, string> = {};
    if (cursor) params['cursor'] = cursor;
    return firstValueFrom(
      this.http.get<FilesResponse>('/api/media', { params })
    );
  }

  /** The month-cover index so far (newest first). Each call advances the
   *  backend's cursor walk a few pages — poll until `complete` is true.
   *  `refresh` forces a head-page rescan (new uploads) ignoring the TTL. */
  async loadMediaMonths(refresh = false): Promise<MediaMonthsResponse> {
    const params: Record<string, string> = refresh ? { refresh: '1' } : {};
    const res = await firstValueFrom(
      this.http.get<ApiResponse<MediaMonthsResponse>>('/api/media/months', { params })
    );
    return res.data;
  }

  async loadShares(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<ApiResponse<DriveFile[]>>('/api/shares')
      );
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
    this.files.update(files => files.filter(f => f.id !== fileId));
  }

  async delete(file: DriveFile): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/files/${file.id}`));
    this.files.update(files => files.filter(f => f.id !== file.id));
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

  downloadFile(fileId: string, name: string): void {
    const a = document.createElement('a');
    a.href = `/api/files/${fileId}/download`;
    a.download = name;
    a.click();
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
