import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export default async function preparePackage() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const directory of ['server', 'electron']) {
    const destination = path.join(root, '.packaged', directory);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(path.join(root, directory))) {
      if (!/\.(?:js|cjs|html)$/.test(name)) continue;
      const source = await fs.readFile(path.join(root, directory, name), 'utf8');
      // Keep function-local identifiers stable for Playwright's serialized
      // callbacks. ASAR integrity, not minification, enforces tamper detection.
      const output = /\.(?:js|cjs)$/.test(name)
        ? (await transform(source, { loader: 'js', target: 'node22', minifyWhitespace: true, minifySyntax: false, minifyIdentifiers: false, legalComments: 'none', sourcemap: false })).code
        : source;
      await fs.writeFile(path.join(destination, name), output);
    }
  }
}
