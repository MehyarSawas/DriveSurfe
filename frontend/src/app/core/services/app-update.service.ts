import { Injectable, signal } from '@angular/core';

/**
 * Detects when a newer build has been deployed and lets the app refresh into
 * it — without a reinstall. index.html is served no-cache and its entry
 * bundles are content-hashed, so a new deploy changes those filenames. We
 * snapshot the current ones at startup and re-check on several triggers
 * (shortly after load, on focus/visibility, when coming online, and on an
 * interval). A change flips `updateReady`; the app shows a one-tap pill that
 * reloads into the fresh code.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  readonly updateReady = signal(false);
  private baseline: string | null = null;

  start(): void {
    if (this.baseline !== null) return; // start once
    this.baseline = this.currentSignature();

    const check = () => this.check();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    setInterval(check, 5 * 60 * 1000);   // every 5 min while open
    setTimeout(check, 5000);             // first check shortly after load
  }

  reload(): void {
    location.reload();
  }

  /** Signature of the entry bundle filenames loaded in the current document. */
  private currentSignature(): string {
    return this.sig(
      Array.from(document.querySelectorAll('script[src]'))
        .map(s => s.getAttribute('src') ?? '')
    );
  }

  /** All same-origin .js bundle filenames, sorted — any hash change (from a
   *  new deploy) changes this string. Broad on purpose so it doesn't depend on
   *  a specific Angular bundle-naming scheme. */
  private sig(srcs: string[]): string {
    return srcs
      .map(s => (s.split('?')[0].split('/').pop() ?? ''))
      .filter(f => f.endsWith('.js'))
      .sort()
      .join('|');
  }

  private async check(): Promise<void> {
    if (this.updateReady() || !this.baseline) return;
    try {
      // Unique URL each time — some installed PWAs (iOS especially) serve a
      // cached index.html even with no-store, which would hide the update.
      const res = await fetch(`index.html?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.text();
      const srcs = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g)).map(m => m[1]);
      const latest = this.sig(srcs);
      if (latest && latest !== this.baseline) this.updateReady.set(true);
    } catch {
      /* offline or blocked — try again next time */
    }
  }
}
