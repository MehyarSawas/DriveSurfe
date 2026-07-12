import { Injectable, computed, signal } from '@angular/core';
import { DriveFile } from '../models/drive-file.model';

/**
 * "Available offline" — the user marks files to keep on the device. We persist
 * the item metadata in localStorage (so the Offline list works with no
 * network) and cache each item's thumbnail + preview into a dedicated Cache
 * Storage bucket (`offline-media`) that the service worker serves from, so the
 * media is viewable offline. The bucket is never evicted (unlike the preview
 * overflow cache).
 */
@Injectable({ providedIn: 'root' })
export class OfflineService {
  private static readonly KEY = 'ds-offline-items';
  static readonly CACHE = 'offline-media';

  readonly items = signal<DriveFile[]>(OfflineService.load());
  readonly ids = computed(() => new Set(this.items().map(f => f.id)));
  /** Ids currently being downloaded into the offline cache. */
  readonly saving = signal<Set<string>>(new Set());

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
    if (this.isOffline(file.id) || file.is_dir) return;
    this.items.update(l => [...l, file]);
    this.persist();
    this.markSaving(file.id, true);
    try {
      const cache = await caches.open(OfflineService.CACHE);
      const urls = [`/api/files/${file.id}/thumbnail`];
      if (this.isImage(file)) urls.push(this.previewUrl(file.id));
      await Promise.allSettled(urls.map(u => cache.add(u)));
    } catch {
      /* Cache Storage unavailable — metadata still saved */
    } finally {
      this.markSaving(file.id, false);
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

  private markSaving(id: string, on: boolean): void {
    this.saving.update(s => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });
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
