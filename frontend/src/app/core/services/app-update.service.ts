import { Injectable, signal } from '@angular/core';

/**
 * Detects when a newer build has been deployed and lets the app refresh into
 * it — without a reinstall. index.html is served no-cache and its entry
 * bundles are content-hashed, so a new deploy changes those filenames. We
 * snapshot the current ones at startup and, on focus + a slow interval,
 * fetch index.html and compare. A change flips `updateReady`; the app shows a
 * one-tap pill that reloads into the fresh code.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  readonly updateReady = signal(false);
  private baseline: string | null = null;

  start(): void {
    if (this.baseline !== null) return; // start once
    this.baseline = this.currentSignature();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.check();
    });
    setInterval(() => this.check(), 10 * 60 * 1000);
  }

  reload(): void {
    location.reload();
  }

  /** Signature of the hashed entry bundles loaded in the current document. */
  private currentSignature(): string {
    return this.sig(
      Array.from(document.querySelectorAll('script[src]'))
        .map(s => s.getAttribute('src') ?? '')
    );
  }

  private sig(srcs: string[]): string {
    return srcs
      .map(s => s.split('/').pop() ?? s)
      .filter(f => /^(main|polyfills|chunk|scripts)[.-].*\.js$/.test(f))
      .sort()
      .join('|');
  }

  private async check(): Promise<void> {
    if (this.updateReady() || !this.baseline) return;
    try {
      const res = await fetch('index.html', { cache: 'no-store' });
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
