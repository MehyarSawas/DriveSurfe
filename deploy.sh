#!/usr/bin/env bash
# Server-side deploy script — called by GitHub Actions via SSH.
# Runs from the repo root on the lima-city server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Pulling latest code..."
git pull origin main

echo "==> Installing PHP dependencies..."
cd backend
if command -v composer &>/dev/null; then
    composer install --no-dev --optimize-autoloader --no-interaction
elif [ -f composer.phar ]; then
    php composer.phar install --no-dev --optimize-autoloader --no-interaction
else
    echo "ERROR: composer not found. Download it to backend/composer.phar:" >&2
    echo "  php -r \"copy('https://getcomposer.org/installer', 'composer-setup.php');\"" >&2
    echo "  php composer-setup.php" >&2
    exit 1
fi

echo "==> Deploy complete."
