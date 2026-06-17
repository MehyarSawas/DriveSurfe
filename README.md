# DriveSurfe

A web app to connect multiple cloud drive solutions, preview images/videos with swipe gestures, and quickly clean up your media library.

## Features

- kDrive (Infomaniak) integration via OAuth2
- Image/video preview with swipe left/right navigation and swipe-up to delete
- HEIC image support via ImageMagick
- Grid and list views with thumbnails
- Folder tree navigation, breadcrumbs, search
- Favorites/Starred synced directly with kDrive
- Keyboard shortcuts (arrow keys, Delete, Enter, Escape)
- Installable PWA

## Tech Stack

- **Frontend:** Angular 22 (standalone components, signals)
- **Backend:** PHP 8.2+, Slim 4, no database (OAuth2 tokens only)
- **Host:** lima-city.de at drive.msawas.com

## Local Development

```bash
# Backend (requires PHP 8.2+)
cd backend && composer install
cp .env.example .env   # fill in credentials
php -S localhost:8080 -t public

# Frontend (in a second terminal)
cd frontend && npm install
npm start   # dev server on localhost:4200, proxies /api → localhost:8080
```

## kDrive OAuth2 App

Register at: https://manager.infomaniak.com/v3/profile/developer/applications

- Redirect URI: `https://drive.msawas.com/api/auth/kdrive/callback`
- Scopes: `drive profile email`
