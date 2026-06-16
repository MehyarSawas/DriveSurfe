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

## Automated Deployment

Every push to `main` triggers a GitHub Actions workflow that:

1. Builds the Angular frontend in CI (Node 20)
2. SSHes into the lima-city server and runs `deploy.sh` (`git pull` + `composer install --no-dev`)
3. Rsyncs the built Angular `dist/` directly into `backend/public/` on the server

### One-time server setup

```bash
# 1. Clone the repo on the server
ssh user@your-lima-city-host
git clone https://github.com/MehyarSawas/DriveSurfe.git ~/drivesurfe

# 2. Set up environment
cd ~/drivesurfe/backend
cp .env.example .env
nano .env   # fill in SESSION_KEY, KDRIVE_CLIENT_ID, KDRIVE_CLIENT_SECRET

# 3. Initial composer install
#    If composer is in PATH:
composer install --no-dev --optimize-autoloader
#    Otherwise download composer.phar to backend/:
php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
php composer-setup.php
php composer.phar install --no-dev --optimize-autoloader

# 4. Add your GitHub Actions SSH public key to authorized_keys
echo "ssh-ed25519 AAAA..." >> ~/.ssh/authorized_keys
```

### GitHub Secrets required

Add these in your repo under **Settings → Secrets and variables → Actions**:

| Secret | Example value |
|---|---|
| `LIMA_HOST` | `ssh.lima-city.de` or your server hostname |
| `LIMA_USER` | Your lima-city SSH username |
| `LIMA_SSH_KEY` | Private key whose public half is in `~/.ssh/authorized_keys` on the server |
| `LIMA_DEPLOY_PATH` | `/home/username/drivesurfe` |

### Generating the SSH keypair (run locally)

```bash
ssh-keygen -t ed25519 -C "github-actions-drivesurfe" -f ~/.ssh/drivesurfe_deploy
# Add ~/.ssh/drivesurfe_deploy.pub to the server's authorized_keys
# Add the contents of ~/.ssh/drivesurfe_deploy (private) as the LIMA_SSH_KEY secret
```

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
