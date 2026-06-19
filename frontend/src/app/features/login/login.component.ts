import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

type LoadingPhase = 'login' | 'register' | null;

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
  readonly loadingPhase = signal<LoadingPhase>(null);
  readonly error = signal<string | null>(null);
  readonly registrationToken = signal('');

  async ngOnInit(): Promise<void> {
    if (this.auth.isAuthenticated()) {
      this.router.navigate(['/']);
      return;
    }
    try {
      const info = await this.auth.getPasskeyInfo();
      this.hasPasskeys.set(info.has_passkeys);
    } catch {
      // passkey info unavailable, show both options
    }
  }

  async login(): Promise<void> {
    this.loadingPhase.set('login');
    this.error.set(null);
    try {
      await this.auth.loginWithPasskey();
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? e?.message ?? 'Authentication failed');
    } finally {
      this.loadingPhase.set(null);
    }
  }

  async register(): Promise<void> {
    this.loadingPhase.set('register');
    this.error.set(null);
    try {
      await this.auth.registerPasskey(this.registrationToken() || undefined);
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? e?.message ?? 'Registration failed');
    } finally {
      this.loadingPhase.set(null);
    }
  }

  async addDevice(): Promise<void> {
    this.loadingPhase.set('login');
    this.error.set(null);
    try {
      await this.auth.loginWithPasskey();
    } catch (e: any) {
      this.error.set(e?.error?.error ?? e?.message ?? 'Authentication failed');
      this.loadingPhase.set(null);
      return;
    }
    // Logged in — now immediately register this new device
    this.loadingPhase.set('register');
    try {
      await this.auth.registerPasskey();
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? e?.message ?? 'Device registration failed');
      this.loadingPhase.set(null);
    }
  }
}
