# DriveSurfe — Codebase Guide

## Project Structure

```
DriveSurfe/
├── backend/          # PHP 8.2 + Slim 4 API
│   ├── public/       # Web root (deploy this to server)
│   └── src/          # Application source
└── frontend/         # Angular 22 SPA
    └── src/app/
        ├── core/     # Services, models, guards, interceptors
        ├── features/ # Route-based feature modules
        └── shared/   # Reusable components
```

## Backend

- Entry: `backend/public/index.php`
- Routes defined in `backend/src/Routes/`
- All drives implement `Drive\DriveInterface`
- Session stored in encrypted cookie (no DB)
- Config via `.env` file

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/auth/kdrive/login | Redirect to kDrive OAuth |
| GET | /api/auth/kdrive/callback | OAuth callback, sets session |
| POST | /api/auth/logout | Clear session |
| GET | /api/files?folderId= | List files in folder |
| GET | /api/files/{id} | Get file metadata |
| GET | /api/files/{id}/thumbnail | Proxied thumbnail |
| GET | /api/files/{id}/preview | Proxied preview |
| GET | /api/files/{id}/download | Proxied download |
| POST | /api/files/{id}/favorite | Toggle favorite |
| DELETE | /api/files/{id} | Move to trash |
| GET | /api/trash | List trash |
| GET | /api/search?q= | Search files |
| GET | /api/folder-tree | Get full folder tree |

## Frontend

- Angular 22, all components standalone
- State via signals
- No NgModule used anywhere
- `DriveService` handles all API communication
- `AuthService` manages login state

## Running Locally

```bash
# Backend (requires PHP 8.2+)
cd backend && composer install
php -S localhost:8080 -t public

# Frontend
cd frontend && npm install
npm start   # dev server on localhost:4200
```

## Deployment

1. `cd frontend && npm run build`
2. Upload `frontend/dist/drivesurfe/browser/` contents to `backend/public/`
3. Upload `backend/` (except vendor) to server
4. Run `composer install --no-dev` on server
5. Set `.env` with credentials

## Adding a New Drive Provider

1. Create `backend/src/Drive/NewDrive/NewDriveClient.php` implementing `DriveInterface`
2. Register OAuth routes in `AuthRoutes.php`
3. Add frontend login button in `login.component`
