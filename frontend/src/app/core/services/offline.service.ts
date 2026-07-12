import { Injectable, computed, signal } from '@angular/core';
import { DriveFile } from '../models/drive-file.model';

/**
 * "Available offline" — the user marks files to keep on the device. Metadata
 * is persisted in localStorage (so the Offline list works with no network),
 * and each item's thumbnail + preview is cached into `preview-offline`.
 *
 * That cache name intentionally starts with `preview-`: the existing service
 * worker already treats every `preview-*` cache (except the general overflow
 * one) as a persistent lookup source, so it serves offline media WITHOUT any
 * service-worker changes — and this bucket is never auto-evicted.
 */
@Injectable({ providedIn: 'root' })
export class OfflineService {
  private static readonly KEY = 'ds-offline-items';
  private static readonly CACHE = 'preview-offline';

  readonly items = signal<DriveFile[]>(OfflineService.load());
  readonly ids = computed(() => new Set(this.items().map(f => f.id)));

  isOffline(id: string): boolean {
    return this.ids().has(id);
  }

  async toggle(file: DriveFile): Promise<void> {
    if (this.isOffline(file.id)) {
      await this.remove(file.id);
    } else {
      await this.add(file);
    }
  }

  async add(file: DriveFile): Promise<void> {
    if (file.is_dir || this.isOffline(file.id)) return;
    this.items.update(l => [...l, file]);
    this.persist();
    try {
      const cache = await caches.open(OfflineService.CACHE);
      const urls = [`/api/files/${file.id}/thumbnail`];
      if (this.isImage(file)) urls.push(this.previewUrl(file.id));
      await Promise.allSettled(urls.map(u => cache.add(u)));
    } catch {
      /* Cache Storage unavailable — metadata still saved */
    }
  }

  async remove(id: string): Promise<void> {
    this.items.update(l => l.filter(f => f.id !== id));
    this.persist();
    try {
      const cache = await caches.open(OfflineService.CACHE);
      const keys = await cache.keys();
      await Promise.all(
        keys.filter(r => r.url.includes(`/api/files/${id}/`)).map(r => cache.delete(r))
      );
    } catch { /* nothing to clean */ }
  }

  private previewUrl(id: string): string {
    const w = Math.min(window.screen.width * window.devicePixelRatio, 10000) | 0;
    const h = Math.min(window.screen.height * window.devicePixelRatio, 10000) | 0;
    return `/api/files/${id}/preview?width=${w}&height=${h}`;
  }

  private isImage(f: DriveFile): boolean {
    return f.mime_type?.startsWith('image/')
      || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(f.extension);
  }

  private persist(): void {
    try {
      localStorage.setItem(OfflineService.KEY, JSON.stringify(this.items()));
    } catch { /* storage full/blocked */ }
  }

  private static load(): DriveFile[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(OfflineService.KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
