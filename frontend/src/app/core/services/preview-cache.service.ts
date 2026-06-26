import { Injectable } from '@angular/core';
import { DriveFile } from '../models/drive-file.model';

@Injectable({ providedIn: 'root' })
export class PreviewCacheService {
  private get sw(): ServiceWorker | null {
    return navigator.serviceWorker?.controller ?? null;
  }

  cacheSession(sessionId: string, files: DriveFile[]): void {
    if (!this.sw) return;
    const w = Math.min(window.screen.width * devicePixelRatio, 10000) | 0;
    const h = Math.min(window.screen.height * devicePixelRatio, 10000) | 0;
    const urls: string[] = [];
    for (const f of files) {
      urls.push(`/api/files/${f.id}/thumbnail`);
      if (f.mime_type?.startsWith('image/') || ['jpg','jpeg','png','gif','webp','heic','heif'].some(e => f.extension === e)) {
        urls.push(`/api/files/${f.id}/preview?width=${w}&height=${h}`);
      }
    }
    this.sw.postMessage({ type: 'CACHE_SESSION', sessionId, urls });
  }

  deleteSession(sessionId: string): void {
    if (!this.sw) return;
    this.sw.postMessage({ type: 'DELETE_SESSION', sessionId });
  }
}
