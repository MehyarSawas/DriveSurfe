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

## Preview & Preload Strategy

### Rule #1 — `/preview` is only triggered by image navigation
The `/api/files/{id}/preview` endpoint is expensive. It must only fire when:
- The current preview image changes (swipe / jump-to)
- A session opens (phase 1+2 spinner preload)

Opening the thumbnail strip, scrolling it, or any other strip interaction must **never** trigger `/preview`.

### Adjacent preload (`preloadAdjacent`)
Called on every image navigation. Preloads prev-2 through next+5 using `HTMLImageElement` (not `fetch()`). Uses `HTMLImageElement` because the browser keeps the **decoded bitmap in GPU memory** — subsequent display is 0 ms. `fetch()` only fills disk/SW cache and still requires JPEG decode (~800 ms) on display.

```
preloadCache: Map<string, HTMLImageElement>   // keeps decoded bitmaps alive
backgroundImages: Set<HTMLImageElement>        // tracks in-flight loads for cancellation
abortBackground()                              // sets img.src='' to cancel all in-flight loads
```

Eviction from `preloadCache` is intentionally absent — evicting drops the decoded bitmap, turning a 0 ms hit into an 800 ms disk-cache decode.

### Strip thumbnails
Rendered with `loading="lazy"` on `<img>`. Two render windows control which `<img>` elements exist in the DOM:
- ±10 around `currentIndex()` (always rendered)
- The strip's current scroll position ± buffer (via `thumbScrollLeft` signal)

The shimmer placeholder (`z-index: 1`) is covered by the loaded `<img>` (`z-index: 2`, `position: absolute`) — no JS load-event tracking needed.

Strip scroll (`onStripScrolled`) only calls `abortBackground()` + bumps `preloadGen` to cancel stale preview loads. It fires zero new `/preview` requests.

### Session preload (phases)
When a saved session is opened (`openSession`):
1. **Phase 1** — current image fully downloaded (`preloadOneAndWait`), spinner shown
2. **Phase 2** — prev-2 + next-5 fully downloaded, spinner still shown
3. Spinner dismissed. Folder loads in background (fire-and-forget).

`previewFileList` signal anchors `mediaFiles()` to the session's `adjacent_files` during phases 1+2 so background folder pagination can't reset `previewIndex`. Once the folder data contains the current file, `mediaFiles()` auto-switches to the full folder list.

### Service Worker cache (`preview-sw.js`)
Intercepts all `/api/files/*/thumbnail` and `/api/files/*/preview` requests.
- **`preview-general`** — overflow cache, populated on every cache miss (all preview/thumbnail fetches land here automatically)
- **`preview-{sessionId}`** — per-session cache, populated on save by promoting already-cached entries from `preview-general` (no extra fetches)

On session delete, `DELETE_SESSION` message removes `preview-{sessionId}`.

### Cancellation
`abortBackground()` sets `img.src = ''` on every tracked background Image, immediately releasing HTTP connections. Called on: swipe/navigate, strip scroll, preview close, component destroy.

`preloadGen` counter invalidates async loops: any `preloadStrip`-style loop checks `gen !== this.preloadGen` and returns early if cancelled.

`fileService.cancelLoad()` bumps `loadGeneration` to abort ongoing folder pagination, called on component destroy.

## Adding a New Drive Provider

1. Create `backend/src/Drive/NewDrive/NewDriveClient.php` implementing `DriveInterface`
2. Register OAuth routes in `AuthRoutes.php`
3. Add frontend login button in `login.component`
