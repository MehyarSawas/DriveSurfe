import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

interface AuthState {
  authenticated: boolean;
  drive?: string;
}

interface PasskeyInfo {
  count: number;
  names: string[];
}

function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToBuffer(b64: string): ArrayBuffer {
  const base64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
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

  async getPasskeyInfo(): Promise<PasskeyInfo> {
    return firstValueFrom(this.http.get<PasskeyInfo>('/api/auth/passkeys'));
  }

  async registerPasskey(token?: string): Promise<void> {
    const url = token ? `/api/auth/passkey/register/options?token=${encodeURIComponent(token)}` : '/api/auth/passkey/register/options';
    const options = await firstValueFrom(this.http.get<any>(url));

    options.challenge = base64urlToBuffer(options.challenge);
    options.user.id = base64urlToBuffer(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map((c: any) => ({
        ...c,
        id: base64urlToBuffer(c.id),
      }));
    }

    const cred = await navigator.credentials.create({ publicKey: options }) as PublicKeyCredential;
    const resp = cred.response as AuthenticatorAttestationResponse;

    await firstValueFrom(this.http.post('/api/auth/passkey/register', {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToBase64url(resp.clientDataJSON),
        attestationObject: bufferToBase64url(resp.attestationObject),
      },
    }));

    this.isAuthenticated.set(true);
    this.currentDrive.set('kdrive');
  }

  async loginWithPasskey(): Promise<void> {
    const options = await firstValueFrom(this.http.get<any>('/api/auth/passkey/login/options'));

    options.challenge = base64urlToBuffer(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials = options.allowCredentials.map((c: any) => ({
        ...c,
        id: base64urlToBuffer(c.id),
      }));
    }

    const cred = await navigator.credentials.get({ publicKey: options }) as PublicKeyCredential;
    const resp = cred.response as AuthenticatorAssertionResponse;

    await firstValueFrom(this.http.post('/api/auth/passkey/login', {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToBase64url(resp.clientDataJSON),
        authenticatorData: bufferToBase64url(resp.authenticatorData),
        signature: bufferToBase64url(resp.signature),
        userHandle: resp.userHandle ? bufferToBase64url(resp.userHandle) : null,
      },
    }));

    this.isAuthenticated.set(true);
    this.currentDrive.set('kdrive');
  }
}
