import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Persistent data root. On Render this is the mounted disk (`/var/data`). */
export function getDataDir() {
  const configured = String(process.env.DATA_DIR || '').trim();
  const dir = configured || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
