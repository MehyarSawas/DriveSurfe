import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'ds-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss'],
})
export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly hasPasskeys = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly registrationToken = signal('');

  async ngOnInit(): Promise<void> {
    if (this.auth.isAuthenticated()) {
      this.router.navigate(['/']);
      return;
    }
    try {
      const info = await this.auth.getPasskeyInfo();
      this.hasPasskeys.set(info.count > 0);
    } catch {
      // passkey info unavailable, show both options
    }
  }

  async login(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.loginWithPasskey();
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? e?.message ?? 'Authentication failed');
    } finally {
      this.loading.set(false);
    }
  }

  async register(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.registerPasskey(this.registrationToken() || undefined);
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? e?.message ?? 'Registration failed');
    } finally {
      this.loading.set(false);
    }
  }
}
