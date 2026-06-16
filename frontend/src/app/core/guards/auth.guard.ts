import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isLoading()) {
    await auth.checkAuth();
  }

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }
  return true;
};
