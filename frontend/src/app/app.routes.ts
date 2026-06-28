import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/file-browser/file-browser.component').then(m => m.FileBrowserComponent),
    children: [
      { path: '', redirectTo: 'folder/1', pathMatch: 'full' },
      {
        path: 'folder/:folderId',
        children: [
          { path: '', pathMatch: 'full', children: [] },
          { path: 'preview/:fileId', children: [] },
        ],
      },
      { path: 'trash', children: [] },
      { path: 'starred', children: [] },
    ],
  },
  { path: '**', redirectTo: '' },
];
