# DriveSurfe — Codebase Guide

DriveSurfe is a personal, single-owner cloud-drive web app: an Angular 22 SPA frontend backed by a thin PHP 8.2 / Slim 4 API that proxies **Infomaniak kDrive** (a Swiss cloud storage provider). Auth is passwordless (WebAuthn/passkeys only — no OAuth login, no username/password). There is exactly one owner account; this is not a multi-tenant app.

## Project Structure

```
DriveSurfe/
├── backend/               # PHP 8.2 + Slim 4 API
│   ├── public/             # Web root — deploy this to the server
│   │   ├── index.php        # Entry point
│   │   ├── .htaccess         # Apache rewrite: /api → index.php, else SPA fallback
│   │   └── .user.ini          # post_max_size/upload_max_filesize=100M, memory_limit=256M
│   ├── src/
│   │   ├── App/Application.php        # DI container, middleware, route registration
│   │   ├── Drive/DriveInterface.php    # Contract every storage provider must implement
│   │   ├── Drive/KDrive/KDriveClient.php    # Infomaniak kDrive API client (the core of the backend)
│   │   ├── Drive/KDrive/KDriveProvider.php   # DEAD CODE — OAuth2 provider, package not installed, unused
│   │   ├── Middleware/AuthMiddleware.php      # Session-cookie gate for protected routes
│   │   ├── Routes/{Auth,File,Action,Session}Routes.php
│   │   ├── Service/SessionService.php   # Encrypted session cookie (AES-256-CBC + HMAC)
│   │   └── Service/ThumbnailService.php  # DEAD CODE — shell-out thumbnailer, not wired to any route
│   ├── passkeys.json        # WebAuthn credential store (flat file, gitignored)
│   ├── sessions.json         # Saved preview-position "sessions" (flat file, gitignored — unrelated to auth)
│   └── .env                   # Secrets (gitignored) — see Environment Variables below
└── frontend/               # Angular 22 SPA, all standalone components, signals-based state
    └── src/
        ├── app/
        │   ├── core/          # Services, models, guards, interceptors (singleton, app-wide)
        │   ├── features/       # Route-level feature components
        │   └── shared/          # Reusable components used by 2+ features
        └── public/preview-sw.js  # Custom service worker (NOT Angular's ngsw — see below)
```

---

## Backend

### Request lifecycle
`public/index.php` → `Dotenv::createImmutable(...)->safeLoad()` (missing `.env` doesn't crash boot, but missing individual required vars throws later) → `new Application()->run()`.

`Application` builds a PHP-DI container (`SessionService`, Guzzle `Client` with `timeout: 30`, `KDriveClient`, `AuthMiddleware`), registers middleware, registers routes under `/api`, runs Slim.

### Middleware stack (applied to every response, outermost-first)
1. **Error middleware** — `displayErrorDetails` only when `APP_ENV=development`. Custom JSON handler: `{error: message}`, plus `trace`+`class` **only when the caller is authenticated or in dev mode** (not exposed to anonymous callers). Status = exception code for `HttpException`, else 500.
2. **Body parsing middleware** (`addBodyParsingMiddleware()`) — parses JSON bodies. **Gotcha:** it reads the request body stream even for content types it can't parse, leaving the pointer at EOF. The raw-binary upload route explicitly calls `$req->getBody()->rewind()` before reading — see FileRoutes below. If you add another route that reads a raw body, you need the same rewind.
3. **CORS + security headers** (`Application::registerMiddleware`):
   - `Access-Control-Allow-Origin`: derived from `APP_URL` env var (scheme+host) — **never reflects the request's Origin header**. This is the correct/safe pattern; do not change it to reflect the request origin.
   - `Access-Control-Allow-Headers: Content-Type, Authorization, X-Registration-Token, X-File-Name`
   - `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
   - `Access-Control-Allow-Credentials: true`
   - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`
   - **No Content-Security-Policy is set anywhere** (known gap — see Security section).
4. **`AuthMiddleware`** — added per-route via `->add($auth)`, not globally. Checks `SessionService::isAuthenticated()`; 401 `{error:'Unauthenticated'}` if not. Auth endpoints themselves (`/api/auth/*`) are intentionally unprotected.

### Session / Auth (WebAuthn/passkeys only — read this before touching auth)
- **Cookie**: `ds_session`, `HttpOnly`, `SameSite=Strict`, `Secure` (unless `APP_ENV=development`), 7-day TTL, `path=/`.
- **Encryption** (`SessionService`): AES-256-CBC, key = `sha256(SESSION_KEY)` (raw 32 bytes). Payload = `base64(iv(16) . hmac-sha256(ciphertext)(32) . ciphertext)`. Decrypt verifies HMAC with `hash_equals` before decrypting (encrypt-then-MAC). **Known gap: the HMAC covers only the ciphertext, not the IV** — low practical risk today (a corrupted IV just breaks JSON parsing, caught → `[]`) but if you touch this code, fix it to `hash_hmac('sha256', $iv . $ciphertext, $key, true)` to close the gap properly.
- **Stored session fields**: `authenticated` (bool), `webauthn_challenge` (base64, single-use, consumed immediately on both success and failure paths).
- **There is no OAuth login flow wired up.** `KDriveProvider.php` (League OAuth2 provider for Infomaniak) exists but `league/oauth2-client` isn't even in `composer.json` — it's dead code. Don't assume it works; either wire it properly (with CSRF `state` validation) or delete it.
- **kDrive API access uses a static long-lived `KDRIVE_TOKEN`** (from `.env`), completely separate from the user's own login session. The app owner authenticates to *DriveSurfe* via passkey; DriveSurfe then talks to kDrive using its own fixed service token.

**Registration flow** (`GET/POST /api/auth/passkey/register[/options]`):
- If passkeys already exist and caller isn't authenticated → 403 (must already be logged in to add a new device).
- If no passkeys exist yet, caller must supply `X-Registration-Token` matching `REGISTRATION_TOKEN` env var (`hash_equals` comparison — timing-safe). This is a **static, never-expiring bootstrap secret** — treat it like a password; rotate/remove it from `.env` once your first device is enrolled if you're worried about exposure, since nothing currently invalidates it automatically.
- Options include a random 16-byte user id, `residentKey: required`-equivalent, `userVerification: preferred`, 60s timeout; challenge stored in session.
- `POST register` consumes the challenge (single use), verifies via `lbuchs/webauthn`, appends `{id: base64(credId), publicKey, counter, name: "Device N"}` to `passkeys.json` (atomic tmp+rename write), sets `authenticated=true`.

**Login flow** (`GET/POST /api/auth/passkey/login[/options]`):
- 404 if no passkeys registered at all.
- `allowCredentials` is empty (resident-key/discoverable-credential flow — browser lets the user pick).
- `POST login` finds the passkey by `rawId` (`hash_equals` on decoded id), verifies via `lbuchs/webauthn`, updates the stored signature counter **only if strictly increasing** (clone-detection per WebAuthn spec; many platform authenticators like Touch ID report a static 0, which the library tolerates by design), sets `authenticated=true`.

**Persistent flat-file stores** (both in `backend/`, NOT `backend/public/` — verify your webserver vhost root is truly `backend/public` only, or these become world-readable):
- `passkeys.json` — WebAuthn credentials.
- `sessions.json` — saved **preview-position** "sessions" (unrelated to login sessions!): `{id: hex(8), file_id, file_name, folder_id, folder_name, thumbnail_url, adjacent_files[], saved_at}`. POSTing replaces any existing entry with the same `folder_id`.
- Both use atomic writes: write to a temp file with `LOCK_EX`, then `rename()`.

### `KDriveClient` — the core backend class
Talks to Infomaniak's API at two versions: `API_V2 = https://api.infomaniak.com/2/drive`, `API_V3 = .../3/drive`. `{driveId}` comes from `KDRIVE_DRIVE_ID` env var; every call sends `Authorization: Bearer {KDRIVE_TOKEN}`. **Root folder ID is the hardcoded string `'5'`** (drive root) — `folderId='5'` is allowed to bypass the numeric-ID regex validator since it's already known-safe.

Key methods and their upstream endpoints:

| Method | Upstream | Notes |
|---|---|---|
| `listFiles($folderId, $options)` | V3 `GET /files/{id}/files` | `order_by`, `order_for[x]`, `limit=50`, cursor pagination |
| `getFile($id)` | V2 `GET /files/{id}` | |
| `getFolderTree()` | V3 `GET /files/5/files?type=dir` (paginated) | builds nested tree client-side |
| `search($query, $folderId?, $options)` | V3 `GET /files/search` | `query_scope=filename`, `limit=500`, fully paginated server-side internally — **`has_more`/`cursor` in the response are always false/null**, clients always get one flat pre-resolved list |
| `createFolder($parentId, $name)` | V3 `POST /files/{parentId}/directory` | |
| `moveFile($id, $destId, $strategy)` | V3 `POST /files/{id}/move/{destId}` | `strategy='skip'` → `conflict:'error'`, else `conflict:'rename'` |
| `copyFile($id, $destId)` | V3 `POST /files/{id}/duplicate` then `POST /files/{copyId}/move/{destId}` | **returns raw (non-normalized) kDrive data**, unlike every other method |
| `uploadFile($parentId, $filename, $mimeType, $binary)` | V3 `POST /upload?directory_id=&file_name=&conflict=rename&total_size=` | raw binary body, `timeout: 300` (overrides the default 30s), throws `RuntimeException` on Guzzle error or `result:'error'` response |
| `renameFile($id, $name)` | V2 `POST /files/{id}/rename` | |
| `favorite`/`unfavorite`/`delete` | V2 `POST\|DELETE /files/{id}/favorite`, `DELETE /files/{id}` | |
| `restoreFile($id)` | V2 `POST /trash/{id}/restore` | |
| `listTrash()` | V2 `GET /trash?per_page=100` | |
| `listFavorites()` | V3 `GET /files/favorites` (paginated) | |
| `getUsage()` | V2 `GET /{driveId}` | returns `{used, total}` from `used_size`/`size` |
| `getFolderCount($id, $depth)` | V3 `GET /files/{id}/count?depth=` | |
| `getFolderSize($id)` | V2 `GET /files/{id}/sizes?depth=unlimited` | |
| `proxyDownload($id)` | V2 `GET /files/{id}/download`, streamed | see below |
| `proxyFile($id, $type, $inTrash, $query)` | V2 `GET /{files\|trash}/{id}/{thumbnail\|preview}` | see below |

**`proxyDownload`/`proxyFile` gotcha**: both bypass PSR-7 and write directly with `header()`/`echo`/`exit()` — the route's returned `$res` is unused. This means the CORS/security-header middleware still runs (headers are additive), but body emission happens outside the normal Slim response cycle.
- `proxyDownload` honors `Range` requests (validated against `^bytes=\d*-\d*$` before forwarding — prevents header injection), streams in 65536-byte chunks, stops on `connection_aborted()`, sets `Content-Disposition: inline; filename*=UTF-8''<rawurlencoded>`.
- `proxyFile` **only serves `image/*`** upstream content types (anything else, or non-2xx upstream, → 404 + `exit`); streams in 8192-byte chunks; sets `X-Content-Type-Options: nosniff`. MIME type is passed through `safeMimeType()` — an explicit allow-list (jpeg/png/gif/webp/svg+xml/heic/heif/avif, common video/audio, pdf) that maps anything unrecognized to `application/octet-stream`. **Content-Type is validated against the upstream response, never trusted from client input.**

Dead/unused code inside `KDriveClient` you can ignore or clean up: `thumbnailUrl()`, `previewUrl()`, `downloadStream()` (interface methods not called by any route — routes use the `proxy*` variants instead), `patch()` helper (defined, never called).

### API Route Table

All under `/api`. "Auth" = requires a valid `ds_session` cookie via `AuthMiddleware`. Numeric file/folder IDs are validated with `preg_match('/^\d+$/', $id)` everywhere they appear (including `destination_folder_id` on move/copy) — 400 `{error:'Invalid file ID'}` on failure.

| Method | Path | Auth | Key params | Response |
|---|---|---|---|---|
| GET | `/auth/me` | No | — | `{authenticated, drive:'kdrive'\|null}` |
| POST | `/auth/logout` | No | — | `{ok:true}` |
| GET | `/auth/passkeys` | No | — | `{count, has_passkeys}` |
| GET | `/auth/passkey/register/options` | Conditional | header `X-Registration-Token` if first passkey | WebAuthn create options |
| POST | `/auth/passkey/register` | No (challenge-gated) | `{response:{clientDataJSON, attestationObject}}` | `{ok:true}`, sets session |
| GET | `/auth/passkey/login/options` | No | — | WebAuthn get options |
| POST | `/auth/passkey/login` | No (challenge-gated) | `{rawId, response:{...}}` | `{ok:true}`, sets session |
| GET | `/files` | Yes | `folderId`(def `5`), `sortBy`, `sortDir`, `cursor` | `{data, cursor, has_more}` |
| GET | `/files/{id}` | Yes | — | `{data: file}` |
| GET | `/files/{id}/stats` | Yes | — | `{data:{count,files,directories,total_*,size}}` |
| GET | `/files/{id}/thumbnail` | Yes | `context=trash` | binary |
| GET | `/files/{id}/preview` | Yes | `context=trash`, `width`/`height`(10–10000) | binary |
| GET | `/files/{id}/download` | Yes | Range honored | binary stream |
| GET | `/folder-tree` | Yes | — | `{data: tree}` (empty root on error, never throws) |
| GET | `/search` | Yes | `q`, `folderId`, `sortBy`, `sortDir` | `{data, has_more:false, cursor:null, capped:false}` |
| GET | `/trash` | Yes | — | `{data: file[]}` |
| GET | `/favorites` | Yes | — | `{data: file[]}` |
| GET | `/usage` | Yes | — | `{data:{used,total}}` |
| POST | `/folders` | Yes | `{parent_id(def '1'), name(def 'New Folder')}` | `{data: file}` |
| POST/DELETE | `/files/{id}/favorite` | Yes | — | `{ok:true}` |
| DELETE | `/files/{id}` | Yes | — | `{ok:true}` |
| POST | `/files/{id}/restore` | Yes | — | `{data:true}` |
| POST | `/files/{id}/move` | Yes | `{destination_folder_id, strategy:'override'\|'skip'}` | `{data:true}` |
| POST | `/files/{id}/copy` | Yes | `{destination_folder_id}` | `{data: copy}` |
| POST | `/folders/{id}/upload` | Yes | headers `X-File-Name`(rawurlencoded), `Content-Type`; raw binary body | `{data: file}` |
| POST | `/files/{id}/rename` | Yes | `{name}` (1–255 chars) | `{data: file}` |
| GET/POST/DELETE | `/sessions[/{id}]` | Yes | preview-position bookmarks | see SessionRoutes |

Global error shape: `{error: message}`, plus `trace`+`class` only for authenticated/dev callers. Proxy routes (`thumbnail`/`preview`/`download`) emit bare 404/502 with no JSON body on failure.

### Environment Variables (`.env`, gitignored; see `.env.example`)

| Var | Required | Purpose |
|---|---|---|
| `APP_URL` | Yes (throws if unset) | Public frontend URL; drives CORS `Access-Control-Allow-Origin` and the WebAuthn RP-ID fallback host |
| `APP_ENV` | No (default `production`) | `development` disables error-detail hiding and cookie `Secure` flag |
| `SESSION_KEY` | Yes (throws if unset) | Session cookie encryption key, min 32 chars random |
| `REGISTRATION_TOKEN` | Only for first passkey enrollment | One-time-in-spirit (not enforced) bootstrap secret |
| `KDRIVE_DRIVE_ID` | Yes (throws at first kDrive call) | Infomaniak kDrive drive ID |
| `KDRIVE_TOKEN` | Yes (throws at first kDrive call) | Bearer token for all kDrive API calls |
| `APP_RP_ID` | No | WebAuthn RP ID override; falls back to `APP_URL` host, then `drive.msawas.com` |

### PHP body-size limits
`backend/public/.user.ini`: `post_max_size=100M`, `upload_max_filesize=100M`, `memory_limit=256M`. The upload route loads the entire request body into a PHP string (`(string) $bodyStream`) — practical upload ceiling is ~100MB per file, entirely in memory.

---

## Frontend

Angular 22, **all components standalone** (no NgModules anywhere), state via **signals** (`signal()`, `computed()`, `input()`, `output()`), strict TypeScript (`strict: true`, `strictTemplates`, `noImplicitReturns`, etc. — see `tsconfig.json`).

### Bootstrap & routing
- `main.ts` bootstraps `AppComponent` (`ds-root`, template is just `<router-outlet/>`) with `appConfig`.
- `app.config.ts` providers: `provideZoneChangeDetection({eventCoalescing:true})`, `provideRouter(routes, withRouterConfig({paramsInheritanceStrategy:'always'}))`, `provideHttpClient(withInterceptors([authInterceptor]))`, `provideServiceWorker('preview-sw.js', {enabled: !isDevMode(), registrationStrategy:'registerImmediately'})`.
- **Important**: `app.config.ts` registers the **custom** `public/preview-sw.js`, not Angular's own `ngsw-worker.js` — `ngsw-config.json` exists but describes a worker that isn't actually the one wired up. Don't be confused by its presence; it's effectively unused/vestigial. If you need to change service-worker caching behavior, edit `preview-sw.js` directly.

| Path | Guard | Component |
|---|---|---|
| `login` | — | `LoginComponent` (lazy) |
| `''` | — | redirect → `folder/5` |
| `folder/:folderId` | `authGuard` | `FileBrowserComponent` (lazy) |
| `folder/:folderId/preview/:fileId` | `authGuard` | `FileBrowserComponent` (same component) |
| `**` | — | redirect → `folder/5` |

- `authGuard` — awaits `AuthService.checkAuth()` if still loading, redirects to `/login` if not authenticated.
- `authInterceptor` — adds `withCredentials: true` to every HTTP request (session cookie auth; no bearer token in JS).

### Core models (`core/models/`)
```ts
interface DriveFile {
  id: string; name: string; type: 'file'|'dir'; mime_type: string; size: number;
  modified_at: string|null; created_at: string|null; is_dir: boolean; is_favorite: boolean;
  parent_id: string; thumbnail_url: string|null; preview_url: string|null; extension: string;
}
type SortBy = 'name' | 'last_modified_at' | 'size';
type SortDir = 'asc' | 'desc';
type ViewMode = 'grid' | 'grid-large' | 'list';
const HOME_FOLDER_ID = '5';   // kDrive personal-space root
interface PreviewSession { id; file_id; file_name; folder_id; folder_name; thumbnail_url; saved_at; adjacent_files?: DriveFile[]; }
interface BreadcrumbItem { id: string; name: string; }
interface FolderTreeNode { id: string; name: string; children: FolderTreeNode[]; }
interface DriveUsage { used: number; total: number; }
```
Special sentinel folder IDs used app-wide: `'__trash__'`, `'__starred__'`, `'__search__'` (not real kDrive IDs — the frontend routes these specially and never sends them to `/api/files`).

### Core services (all `providedIn: 'root'`)

**`AuthService`** — signals `isAuthenticated`, `currentDrive`, `isLoading`. Methods: `checkAuth()` (GET `/auth/me`), `logout()`, `getPasskeyInfo()`, `registerPasskey(token?)`, `loginWithPasskey()` — the latter two drive `navigator.credentials.create/get` and base64url-encode/decode the binary WebAuthn payloads.

**`FileService`** — the central data-access service; owns `files`, `searchResults`, `loading`, `currentFolderId`, `breadcrumb`, `folderTree`, `selectedIds`, `folderStats`, `sessions` signals. Every list/search/CRUD/upload/move/copy/rename/favorite/trash operation goes through this service — see it before adding new file operations. Two important correctness mechanisms:
- **`loadGeneration` counter** — incremented by `cancelLoad()`/`seedFiles()`; every paginated `loadFiles()` await checks it hasn't changed before writing, so a stale in-flight folder load can't clobber a newer navigation.
- **`searchGen` + `searchAbort$` Subject** — cancels in-flight search requests (`takeUntil`) when a new search starts or `abortSearch()` is called.
- `uploadFile(parentFolderId, fileName, mimeType, data: Blob)` posts the **raw Blob body** (not multipart, not base64) with `Content-Type` + `X-File-Name` (URI-encoded) headers — matches the backend's raw-binary-body expectation exactly.

**`PreviewCacheService`** — bridges to the custom service worker via `postMessage` on `navigator.serviceWorker.controller`: `cacheSession(sessionId, files)` (promotes already-cached `preview-general` entries into a per-session cache, no extra network fetches) and `deleteSession(sessionId)`.

### Custom service worker (`public/preview-sw.js`)
Intercepts **only** `GET /api/files/{id}/thumbnail` and `GET /api/files/{id}/preview` requests. Cache names: `preview-general` (overflow, populated on every cache miss) and `preview-{sessionId}` (per saved session, populated by *promoting* already-cached entries — never a fresh fetch). Lookup order on a request: all `preview-{sessionId}` caches (newest session first) → `preview-general` → network (cached into `preview-general` if `response.ok`). Message protocol: `{type:'CACHE_SESSION', sessionId, urls}` and `{type:'DELETE_SESSION', sessionId}`.

### Shared components
- **`ds-folder-picker`** — modal folder browser + new-folder creation, used for move/copy targets. Inputs: `startFolderId`, `startFolderName`, `startBreadcrumb`, `recentFolder`, `title`. Outputs: `folderSelected(DriveFile)`, `folderPath(string)`, `closed()`.
- **`ds-pdf-viewer`** — renders a PDF via `pdfjs-dist` (worker at `/assets/pdf.worker.min.mjs`) onto per-page canvases scaled to container width × devicePixelRatio. Input `fileId` (required), `zoom`.

---

## Feature Components

### FileBrowserComponent (`ds-file-browser`) — the app shell
Owns almost all app-level state: view mode, sort, filters, sidebar, all dialog/panel open-flags, and **the entire preview preload/image-cache subsystem** (see Preview & Preload Strategy below — this logic lives here, NOT inside `PreviewComponent`). Composes `FolderTreeComponent`, `BreadcrumbComponent`, `SearchBarComponent`, `FileGridComponent`/`FileListComponent`, `PreviewComponent`, `FolderPickerComponent`, `ScannerComponent`.

Key computed signals: `mediaFiles` (drives preview navigation — has special **anchor logic**: while a saved-session preview is loading, it returns a frozen `previewFileList` snapshot instead of the live paginated folder list, so background folder-loading pagination can't reset `previewIndex` mid-load; switches to the live list once it's confirmed to contain the current file), `displayFiles` (search results or folder files, MIME-prefix filtered), `previewIndex`.

Handles: navigation + breadcrumb resolution (walks `parent_id` chain), search (delegates to `FileService.search`, restores pre-search breadcrumb on cancel), preview open/close/navigate, saved "sessions" (preview-position bookmarks) including the two-phase preload described below, move/copy (via `FolderPickerComponent`, `Promise.allSettled` with partial-failure toasts, `strategy:'skip'` hardcoded for conflict handling), bulk trash/restore/download, create-folder, rename, favorite-toggle, file upload (`<input type=file>` + drag-drop), and launching `ScannerComponent`.

### PreviewComponent (`ds-preview`)
Full-screen media viewer: pinch-zoom, swipe navigation (left/right = prev/next, up = delete, down = open move-folder-picker, tap = fullscreen toggle), keyboard shortcuts, PDF via `ds-pdf-viewer`, delete/move with a 5–10s undo countdown before the action is actually committed (`initiateDelete`/`cancelDelete`, `onFolderSelected`/`cancelMove`), thumbnail filmstrip.

**Does NOT own the preload engine** — that's all in `FileBrowserComponent`. Preview's own responsibility is thumbnail-strip **virtualization**: `isNearCurrent(i)` renders an actual `<img>` only within ±10 of `currentIndex` or inside the currently-scrolled-into-view window (tracked via `thumbScrollLeft`); everything else renders a lightweight placeholder. `onThumbScroll()` emits `stripScrolled({from,to})` up to `FileBrowserComponent`, which responds by aborting background preloads — **but strip scrolling itself never triggers a new `/preview` network request** (see Preview & Preload Strategy rule #1 below).

### File-browser sub-components
- **`FileGridComponent`/`FileListComponent`** — grid and list views; both implement custom touch drag-to-multiselect (tap a file's select-circle, then drag across others; auto-scrolls near viewport edges) since native browser multi-select doesn't work well on mobile. Emit the same event surface: `fileClick`, `selectToggle`, `restore`, `rename`, `move`, `copy`, `favorite`, `download`, `delete`.
- **`FolderTreeComponent`** — recursive self-rendering tree, `expanded: Set<string>` tracks open nodes.
- **`BreadcrumbComponent`**, **`SearchBarComponent`** (500ms debounce, skips 1–2 char queries, optional "search this folder only" scope toggle).

### LoginComponent (`ds-login`)
Passkey-only UI: shows "Sign in" (+ "Add this device" two-phase flow: login with an existing passkey, then immediately register a new one) if passkeys already exist, else a `REGISTRATION_TOKEN` input + "Register this device" for first-time setup.

---

## Document Scanner (`features/scanner/`)

Camera-based document scanner: capture → auto-detect document quad → manual corner adjustment → perspective-warp flatten → brightness/contrast/B&W enhancement → assemble as PDF or JPEG → upload. This is the most algorithmically involved part of the frontend — read this section fully before touching detection or warping.

### Architecture
- **`quad-detector.ts`** — pure detection logic (OpenCV.js-based), returns a `Quad` (`[Point,Point,Point,Point]` in TL/TR/BR/BL order) or `null`.
- **`perspective-warp.ts`** — two implementations: `perspectiveWarpCv` (OpenCV `getPerspectiveTransform`+`warpPerspective`, primary) and `perspectiveWarp` (pure-JS homography via Gaussian elimination, fallback when OpenCV isn't loaded).
- **`opencv-loader.ts`** — lazy-loads OpenCV.js (~11MB) once, on first scanner use.
- **`scanner.component.ts/html/scss`** — camera capture, live preview overlay, corner-adjustment UI, enhancement controls, PDF/JPEG assembly, upload.

### OpenCV.js loading (`opencv-loader.ts`)
Self-hosted at `frontend/src/assets/opencv/opencv.js` (vendored — WASM embedded as a base64 data URI, no separate `.wasm` fetch) is tried **first**; two remote CDN fallbacks exist (`docs.opencv.org/5.0`, jsDelivr `@techstark/opencv-js`) but should be treated as emergency fallbacks only, not the primary path — self-hosting avoids CDN egress/availability issues that caused real production failures during development. The loader transparently handles three different OpenCV.js build shapes (MODULARIZE factory function, Emscripten thenable, classic global + `onRuntimeInitialized`), since different builds expose `window.cv` differently — **if you swap in a different OpenCV.js build, verify which shape it uses**, this has broken silently before. Polls every 150ms with a 40s per-source timeout before falling through to the next source. `onOpenCvStatus(fn)` streams human-readable progress into the scanner UI badge — keep this wired up; it was added specifically because silent hangs during loading were undiagnosable without it.

### Document quad detection (`quad-detector.ts`) — read before changing thresholds
This algorithm was iterated extensively against real failure photos (furniture, textured rugs, low-contrast documents, colored ID cards on wood tables) — **do not loosen the gates without re-testing against those failure modes**. Pipeline:
1. Downscale to ≤500px, grayscale, Gaussian blur.
2. Build **5 candidate masks**: Otsu threshold on luminance (bright-on-dark and dark-on-bright), Otsu threshold on the **HSV saturation channel** (bright-sat and low-sat — this is what makes colored documents like ID cards detectable on similarly-bright neutral backgrounds, where luminance alone can't separate them), and Canny edge detection + morphological close.
3. For every contour in every mask, `scoreContour()` applies a gauntlet of gates before it's even a candidate:
   - Area fraction must be 2–95% of frame.
   - Corners are extracted as the convex-hull point farthest from the centroid in each of the 4 quadrants (**not** `approxPolyDP`-to-exactly-4-points — that requirement was the root cause of repeated detection failures on documents with soft/frilly edges, since real-world contours rarely approximate to a perfect quad).
   - `solidity` (contour area / hull area) ≥ 0.9 and `rectangularity` (contour area / minAreaRect area) ≥ 0.82 — these specific thresholds were tuned against a real "carpet mistaken for a document" failure (measured ~0.84/0.78) vs. real documents (~0.95+).
   - The **extracted quad itself** (not just the contour) must also look like a rectangle: corner angles 55–125°, opposite sides within a 2.2× ratio, quad area ≥70% of hull area. This catches shapes that pass the contour-level gates but produce a garbage quad.
   - Aspect ratio ≤ 4.5:1 (rejects long thin strips like table edges).
   - **Border-touch rule**: a candidate quad touching 2 or more image borders is rejected as scenery (a table/wall/floor clipped by the camera frame), not a document. This was necessary because a tabletop can otherwise look like a perfectly clean bright rectangle.
4. Winning candidate is chosen by `score = rectangularity × solidity × √areaFraction`.
5. The winning quad is expanded ~1.2% outward from its centroid (small margin around the document, matching what a human would draw) then clamped 5% inside the frame so drag handles are never unreachable off-screen.

`defaultQuad()` (centered, 12% inset) is returned by the caller when detection finds nothing — used for manual adjustment, never silently presented as a "detection".

### Live camera vs. captured-frame detection (`scanner.component.ts`)
The live preview overlay requires **temporal stability**: a detected quad must repeat (within 5% of the frame diagonal, via `quadsSimilar`) across 2 consecutive frames before it's drawn as a locked green frame — this avoids the overlay flickering wildly across furniture while panning before a document is framed. Below that threshold it shows a gray dashed "searching" outline instead. On `capture()`, if OpenCV hasn't finished loading yet, it awaits (up to 8s via `Promise.race`) before running detection on the captured frame — the captured photo should always get the accurate detector, not silently fall back to the weaker default.

### Manual corner adjustment UX (review phase)
Deliberately mimics Google Drive/Lens-style scanning:
- Corner handles are **outline-only rings** (not filled circles) so the document edge stays visible underneath while adjusting.
- A **magnifier loupe** (110px circle, 2.5× zoom, positioned above the finger — or below near the top edge) appears while dragging, centered on the corner being moved, with a crosshair.
- Dragging can start from **anywhere on the image**, not just precisely on a handle: `onWrapPointerDown` picks the nearest corner by comparing the touch point against the quad's centroid (quadrant-based), then preserves the grab offset so the corner doesn't jump to the finger.
- Everything outside the quad is darkened (even-odd SVG mask in the review view; canvas `destination-out` compositing in the live camera view) so the document region is visually emphasized.
- All corner positions are clamped 5% inside the image bounds so handles are always reachable regardless of image aspect ratio.

### Perspective warp & enhancement (`bakeCurrentPage()`)
Warps via `perspectiveWarpCv` (OpenCV, white `BORDER_CONSTANT` fill for out-of-bounds — never black) when available, else the pure-JS `perspectiveWarp` fallback. **Brightness/contrast/grayscale/B&W enhancement is applied via direct pixel manipulation on `ImageData`** (`applyPixelEnhance`), NOT via `ctx.filter` — iOS Safari doesn't support `ctx.filter` combined with `drawImage`, which silently produced solid-black output; this was a real production bug. If you ever reintroduce a CSS/canvas filter here, verify on iOS Safari specifically. Formula: `(pixel * brightness - 128) * contrast + 128`, identity at brightness=contrast=100.

### Assembly & upload
PDF: `pdf-lib`'s `PDFDocument.create()`, `embedJpg` each page, page size = image size, saved as a `Blob` (not base64/btoa — large PDFs would blow up a data URI). JPEG: each page uploaded individually (`name.jpg` or `name_N.jpg` for multi-page). Both go through `FileService.uploadFile()`.

---

## Preview & Preload Strategy

This logic lives in **`FileBrowserComponent`**, not `PreviewComponent` (see Feature Components above) — check there first if debugging preload behavior.

### Rule #1 — `/preview` is only triggered by image navigation
The `/api/files/{id}/preview` endpoint is expensive (proxies + resizes through kDrive). It must only fire when:
- The current preview image changes (swipe / jump-to)
- A saved session opens (phase 1+2 spinner preload, below)

Opening the thumbnail strip, scrolling it, or any other strip interaction must **never** trigger `/preview`.

### Adjacent preload (`preloadAdjacent`)
Called on every image navigation. Preloads prev-2 through next+5 using `HTMLImageElement` (not `fetch()`). Uses `HTMLImageElement` because the browser keeps the **decoded bitmap in GPU memory** — subsequent display is 0ms. `fetch()` only fills disk/SW cache and still requires JPEG decode (~800ms) on display.

```
preloadCache: Map<string, HTMLImageElement>   // keeps decoded bitmaps alive
backgroundImages: Set<HTMLImageElement>        // tracks in-flight loads for cancellation
abortBackground()                              // sets img.src='' to cancel all in-flight loads
```

Eviction from `preloadCache` is intentionally absent — evicting drops the decoded bitmap, turning a 0ms hit into an 800ms disk-cache decode.

### Strip thumbnails
Rendered with `loading="lazy"` on `<img>`. Two render windows control which `<img>` elements exist in the DOM (in `PreviewComponent.isNearCurrent`): ±10 around `currentIndex`, and the strip's current scroll position ± buffer (via `thumbScrollLeft` signal). `onStripScrolled` only calls `abortBackground()` + bumps `preloadGen` — it fires zero new `/preview` requests (rule #1).

### Session preload (phases) — `FileBrowserComponent.openSession()`
When a saved session is opened:
1. **Phase 1** — current image fully downloaded (`preloadOneAndWait`), spinner shown.
2. **Phase 2** — prev-2 + next-5 fully downloaded (parallel `Promise.all`, 6s timeout each), spinner still shown.
3. Spinner dismissed. Folder loads in background (fire-and-forget).

`previewFileList` (the "anchor") pins `mediaFiles()` to the session's `adjacent_files` during phases 1+2 so background folder pagination can't reset `previewIndex`. Once the live folder data contains the current file, `mediaFiles()` auto-switches to the full folder list.

### Service Worker cache (`preview-sw.js`)
See Frontend section above for full detail. Summary: `preview-general` (overflow, all misses land here) + `preview-{sessionId}` (per-session, populated by *promoting* already-general-cached entries on save, never a fresh fetch). `DELETE_SESSION` removes that session's cache.

### Cancellation
`abortBackground()` sets `img.src=''` on every tracked background Image, immediately releasing HTTP connections. Called on: swipe/navigate, strip scroll, preview close, component destroy. `preloadGen` counter invalidates async loops (`preloadStrip`-style loops check `gen !== this.preloadGen` and bail early). `FileService.cancelLoad()` bumps `loadGeneration` to abort ongoing folder pagination, called on component destroy.

---

## Running Locally

```bash
# Backend (requires PHP 8.2+)
cd backend && composer install
php -S localhost:8080 -t public

# Frontend
cd frontend && npm install
npm start   # dev server on localhost:4200, proxies /api → localhost:8080 via proxy.conf.json
```

## Build & Deploy

Deployment is automated via `.github/workflows/deploy.yml` on every push to `main` (rsync to a lima-city server over SSH). Manual steps if doing it by hand:
1. `cd frontend && node generate-icons.mjs && npm run build` (icons must be generated before build; production budgets: 500kB warning / 1MB error initial bundle)
2. Upload `frontend/dist/drivesurfe/browser/` contents to `backend/public/`
3. Upload `backend/public/index.php` and `backend/public/.htaccess` to the server
4. Upload `backend/src/` to the server; run `composer install --no-dev --optimize-autoloader` there (or rsync a pre-built `vendor/`)
5. Set `.env` with real credentials (never commit it)

**Do not** deploy `backend/` itself as the web root — only `backend/public/` should be reachable. `passkeys.json` and `sessions.json` live in `backend/` specifically so they're outside the web root; if you ever change that layout, re-verify they're still unreachable via HTTP.

## Adding a New Drive Provider
1. Create `backend/src/Drive/NewDrive/NewDriveClient.php` implementing `DriveInterface`.
2. Register OAuth/auth routes as needed (note: no working OAuth reference implementation currently exists in this codebase — `KDriveProvider.php` is unfinished/unwired dead code, don't copy its pattern uncritically).
3. Add a frontend login option in `LoginComponent`.
4. `AuthService`/`FileService` currently assume a single fixed provider (`currentDrive` is typed as effectively just `'kdrive'`) — widen types if adding a second provider.

---

## Security Notes

A full security review has been done on this codebase (backend PHP + frontend Angular). Overall posture is solid for a single-owner personal app: CORS origin is env-derived (not reflected from request headers), session cookie flags are correct (`HttpOnly`+`SameSite=Strict`+`Secure`), all WebAuthn comparisons use `hash_equals`, file/folder IDs are validated everywhere before reaching the upstream API, MIME types on proxied media are validated against the upstream response, and no secrets appear in source control or client-visible responses.

**Known gaps, in priority order if you pick up work here:**
1. **Session cookie HMAC doesn't cover the IV** (`SessionService::encrypt`) — low practical risk today but violates encrypt-then-MAC best practice; fix is a one-line change to include the IV in the HMAC input.
2. **No Content-Security-Policy header** anywhere (API or SPA) — add one, especially given the OpenCV.js remote CDN fallbacks below.
3. **OpenCV.js CDN fallbacks have no SRI/integrity check** — self-hosted is already the primary source; consider dropping the remote fallbacks entirely or adding `integrity`+`crossorigin` attributes.
4. **`REGISTRATION_TOKEN` never expires or gets consumed** — functionally a permanent secret despite being called "one-time" in comments; either add consumption tracking or accept the risk for a personal-use app.
5. Two dead-code files reference unbuilt dependencies or shell out via `exec()`: `KDriveProvider.php` (references an uninstalled OAuth package) and `ThumbnailService.php` (unused, shells out with `escapeshellarg`-protected args but no path containment). Either finish wiring them safely or delete them — don't let a future change assume they already work.

Nothing in the review rose to critical/immediately-exploitable. Full finding-by-finding writeup with file:line references was produced during this review — see chat history for the complete text if needed.
