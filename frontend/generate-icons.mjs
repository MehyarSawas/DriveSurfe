/**
 * Icon step (kept for the build/deploy pipeline).
 *
 * The PWA icons in src/assets/icons/ and the favicon are now hand-designed
 * artwork committed to the repo (a folder-with-waves mark), NOT generated.
 * This script used to draw a placeholder mark and would OVERWRITE those files
 * on every build, so it is now a no-op guard: it only verifies the committed
 * icons are present and exits successfully, leaving the artwork untouched.
 *
 * To change the icons, replace the PNGs in src/assets/icons/ directly.
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS = [72, 96, 128, 144, 152, 192, 384, 512];

let missing = 0;
for (const size of ICONS) {
  const p = join(__dirname, `src/assets/icons/icon-${size}x${size}.png`);
  if (existsSync(p)) {
    console.log(`✓ icon-${size}x${size}.png (committed)`);
  } else {
    console.error(`✗ MISSING icon-${size}x${size}.png`);
    missing++;
  }
}

if (missing > 0) {
  console.error(`\n${missing} icon(s) missing from src/assets/icons/ — commit the artwork PNGs.`);
  process.exit(1);
}
console.log('All committed icons present — nothing to generate.');
