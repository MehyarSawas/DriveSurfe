# DriveSurfe

A web app to browse and manage your kDrive (Infomaniak) cloud storage — preview images and videos with swipe gestures, bulk-manage files, and keep your media library clean.

## Features

- kDrive (Infomaniak) integration
- Passkey authentication (Face ID / Touch ID) — no password required
- Image/video preview with swipe left/right navigation, pinch-to-zoom, and swipe-up to delete
- HEIC image support via ImageMagick
- Grid and list views with thumbnails
- Folder tree navigation, breadcrumbs, search
- Move files with a folder picker (breadcrumb navigation, create folder on the fly)
- Favorites/Starred synced directly with kDrive
- Bulk select, move, download, and delete
- URL-based folder navigation — reload stays where you left off
- Progressive folder loading — first files appear instantly, rest stream in the background
- Keyboard shortcuts (arrow keys, Delete, Enter, Escape)
- Installable PWA

## Tech Stack

- **Frontend:** Angular 22 (standalone components, signals)
- **Backend:** PHP 8.2+, Slim 4, no database

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

## Authentication

DriveSurfe uses **passkeys** (WebAuthn / FIDO2) — no username or password. On iPhone this means Face ID or Touch ID.

### First-time setup

1. Deploy the app and open it in your browser
2. Click **Register this device** and enter the registration token (set `REGISTRATION_TOKEN` in `.env`)
3. Complete the Face ID / Touch ID prompt
4. Done — your device's public key is stored in `backend/passkeys.json`

### Signing in

Click **Sign in with passkey** and confirm with Face ID / Touch ID. The session is stored in an encrypted cookie (`SESSION_KEY` in `.env`).

### Adding more devices

Sign in on an already-authenticated device, then open the registration flow from settings to enroll a new device.

### `.env` keys

| Key | Description |
|-----|-------------|
| `KDRIVE_TOKEN` | kDrive API token |
| `KDRIVE_DRIVE_ID` | Your kDrive drive ID |
| `SESSION_KEY` | 32-byte random string for cookie encryption |
| `REGISTRATION_TOKEN` | Secret token to gate first-time passkey registration |
