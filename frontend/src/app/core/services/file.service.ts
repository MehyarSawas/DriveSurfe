import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DriveFile, FileListOptions, BreadcrumbItem, HOME_FOLDER_ID } from '../models/drive-file.model';
import { FolderTreeNode, DriveUsage } from '../models/drive.model';

interface ApiResponse<T> {
  data: T;
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
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly currentFolderId = signal(HOME_FOLDER_ID);
  readonly breadcrumb = signal<BreadcrumbItem[]>([{ id: HOME_FOLDER_ID, name: 'My Drive' }]);
  readonly folderTree = signal<FolderTreeNode | null>(null);
  readonly selectedIds = signal<Set<string>>(new Set());

  async loadFiles(options: FileListOptions): Promise<void> {
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
      this.files.set(first.data);
      this.currentFolderId.set(options.folderId);
      this.loading.set(false);

      if (first.has_more && first.cursor) {
        this.loadingMore.set(true);
        let cursor: string | null = first.cursor;
        while (cursor) {
          const page: FilesResponse = await firstValueFrom(
            this.http.get<FilesResponse>('/api/files', { params: { ...params, cursor } })
          );
          this.files.update(f => [...f, ...page.data]);
          cursor = page.has_more && page.cursor ? page.cursor : null;
        }
      }
    } catch (err) {
      console.error('loadFiles error:', err);
    } finally {
      this.loading.set(false);
      this.loadingMore.set(false);
    }
  }

  async loadFolderTree(): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<FolderTreeNode>>('/api/folder-tree')
    );
    this.folderTree.set(res.data);
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

  async search(query: string): Promise<DriveFile[]> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<DriveFile[]>>('/api/search', { params: { q: query } })
    );
    return res.data;
  }

  async getUsage(): Promise<DriveUsage> {
    const res = await firstValueFrom(
      this.http.get<ApiResponse<DriveUsage>>('/api/usage')
    );
    return res.data;
  }

  async delete(fileId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/files/${fileId}`));
    this.files.update(files => files.filter(f => f.id !== fileId));
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

  async moveFile(fileId: string, destinationFolderId: string): Promise<void> {
    await firstValueFrom(this.http.post(`/api/files/${fileId}/move`, { destination_folder_id: destinationFolderId }));
    const update = (files: DriveFile[]) => files.filter(f => f.id !== fileId);
    this.files.update(update);
    if (this.searchResults() !== null) {
      this.searchResults.update(r => r ? update(r) : r);
    }
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
