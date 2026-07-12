import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { AppUpdateService } from './core/services/app-update.service';

@Component({
  selector: 'ds-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    @if (update.updateReady()) {
      <button class="app-update-banner" (click)="update.reload()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-8 8s3.57 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        Update available — tap to refresh
      </button>
    }
  `,
  styles: [`
    .app-update-banner {
      position: fixed;
      left: 50%;
      bottom: calc(18px + env(safe-area-inset-bottom));
      transform: translateX(-50%);
      z-index: 4000;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 11px 20px;
      border: none;
      border-radius: 999px;
      background: var(--color-primary, #14a4dd);
      color: #fff;
      font: 600 14px/1 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      cursor: pointer;
      animation: app-update-in 0.25s ease;
    }
    .app-update-banner svg { width: 17px; height: 17px; fill: currentColor; }
    @keyframes app-update-in {
      from { opacity: 0; transform: translate(-50%, 12px); }
      to   { opacity: 1; transform: translate(-50%, 0); }
    }
  `],
})
export class AppComponent implements OnInit {
  private auth = inject(AuthService);
  protected update = inject(AppUpdateService);

  ngOnInit(): void {
    this.auth.checkAuth();
    this.update.start();

    // Block browser pinch-zoom app-wide (iOS Safari ignores user-scalable=no;
    // these proprietary gesture events are its only reliable off-switch).
    // In-app zoom (preview, scanner review) uses its own touch handlers and
    // is unaffected.
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('gesturechange', e => e.preventDefault());
  }
}
