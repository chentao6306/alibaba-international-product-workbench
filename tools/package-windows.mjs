import path from 'node:path';
import { build, Platform } from 'electron-builder';
import { Arch } from 'builder-util';

const output = path.resolve(process.env.CHAODEKUAI_RELEASE_DIR || 'release-installer');
await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: {
  directories: { output }, artifactName: 'chaodekuai-${version}-inner.${ext}',
  ...(process.env.CHAODEKUAI_ELECTRON_DIST ? { electronDist: path.resolve(process.env.CHAODEKUAI_ELECTRON_DIST) } : {}),
}, publish: 'never' });
await import('./build-setup.mjs');
