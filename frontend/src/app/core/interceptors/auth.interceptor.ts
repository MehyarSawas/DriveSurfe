import { HttpInterceptorFn } from '@angular/common/http';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // Credentials (session cookie) are sent automatically via withCredentials
  const cloned = req.clone({ withCredentials: true });
  return next(cloned);
};
