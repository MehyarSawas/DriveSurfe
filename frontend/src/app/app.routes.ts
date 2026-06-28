import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { HOME_FOLDER_ID } from './core/models/drive-file.model';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: '',
    redirectTo: `folder/${HOME_FOLDER_ID}`,
    pathMatch: 'full',
  },
  {
    path: 'folder/:folderId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/file-browser/file-browser.component').then(m => m.FileBrowserComponent),
  },
  {
    path: 'folder/:folderId/preview/:fileId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/file-browser/file-browser.component').then(m => m.FileBrowserComponent),
  },
  {
    path: '**',
    redirectTo: `folder/${HOME_FOLDER_ID}`,
  },
];
