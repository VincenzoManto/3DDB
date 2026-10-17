// Builds the publishable package: UI -> server/public, server + CLI -> server/dist/cli.js.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(server, '..');

console.log('› building the UI');
execSync('npm run build -w client', { cwd: root, stdio: 'inherit' });

console.log('› copying the UI into the package');
rmSync(join(server, 'public'), { recursive: true, force: true });
cpSync(join(root, 'client', 'dist'), join(server, 'public'), { recursive: true });

console.log('› bundling the server and CLI');
rmSync(join(server, 'dist'), { recursive: true, force: true });
await build({
  entryPoints: [join(server, 'src', 'cli.ts')],
  outfile: join(server, 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Dependencies stay normal npm dependencies (native drivers, WASM assets); only our code is bundled.
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
});

copyFileSync(join(root, 'README.md'), join(server, 'README.md'));
copyFileSync(join(root, "LICENSE"), join(server, "LICENSE"));
console.log('✔ package ready: run "npm pack" or "npm publish" from the server folder');
