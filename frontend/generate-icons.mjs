/**
 * Icon step (kept for the build/deploy pipeline).
 *
 * The PWA icons, maskable icons, apple-touch icon, in-app logo and favicon
 * are hand-designed artwork committed to the repo (a folder-with-waves mark),
 * NOT generated. This script used to draw a placeholder mark and would
 * OVERWRITE those files on every build, so it is now a no-op guard: it only
 * verifies the committed icons are present and exits successfully.
 *
 * To change the icons, replace the files in src/assets/icons/ directly.
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REQUIRED = [
  'icon-192x192.png',
  'icon-512x512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

let missing = 0;
for (const name of REQUIRED) {
  const p = join(__dirname, 'src/assets/icons', name);
  if (existsSync(p)) {
    console.log(`✓ ${name} (committed)`);
  } else {
    console.error(`✗ MISSING ${name}`);
    missing++;
  }
}

if (missing > 0) {
  console.error(`\n${missing} icon(s) missing from src/assets/icons/ — commit the artwork.`);
  process.exit(1);
}
console.log('All committed icons present — nothing to generate.');
