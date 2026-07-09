import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'ds-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class AppComponent implements OnInit {
  private auth = inject(AuthService);

  ngOnInit(): void {
    this.auth.checkAuth();

    // Block browser pinch-zoom app-wide (iOS Safari ignores user-scalable=no;
    // these proprietary gesture events are its only reliable off-switch).
    // In-app zoom (preview, scanner review) uses its own touch handlers and
    // is unaffected.
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('gesturechange', e => e.preventDefault());
  }
}
