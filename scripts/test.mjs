import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const files = readdirSync('dist', { recursive: true })
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => path.join('dist', file));
if (!files.length) throw new Error('No compiled tests found; run npm run build first.');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
