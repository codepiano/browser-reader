import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
await cp('src/client/index.html', 'dist/public/index.html');
