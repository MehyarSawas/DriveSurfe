import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

interface AuthState {
  authenticated: boolean;
  drive?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);

  readonly isAuthenticated = signal(false);
  readonly currentDrive = signal<string | null>(null);
  readonly isLoading = signal(true);

  async checkAuth(): Promise<void> {
    try {
      const state = await firstValueFrom(this.http.get<AuthState>('/api/auth/me'));
      this.isAuthenticated.set(state.authenticated);
      this.currentDrive.set(state.drive ?? null);
    } catch {
      this.isAuthenticated.set(false);
    } finally {
      this.isLoading.set(false);
    }
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/logout', {}));
    this.isAuthenticated.set(false);
    this.currentDrive.set(null);
    this.router.navigate(['/login']);
  }
}
