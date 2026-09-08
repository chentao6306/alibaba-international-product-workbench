# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the React/Vite UI.
- `server/` contains the Express API, persistence, Alibaba collectors, category routing, browser automation, and publishing logic.
- `electron/` contains the desktop main process and preload bridges.
- `auth-server/` is the separate authorization service and has its own README and Dockerfile.
- `test/` contains the Node test suite (`core.test.js`).
- `tools/` contains Chromium preparation, smoke tests, and Windows cleanup scripts.
- `dist/`, `build/`, `release*`, `vendor/chromium/`, and `node_modules/` are generated or bundled artifacts; do not edit or commit them.

## Build, Test, and Development Commands

Run from the repository root with Node.js 20+:

```powershell
npm install                 # install the locked dependency tree
npm run dev                 # run Vite and the API together for development
npm run build               # build the frontend into dist/
npm test                    # run all node:test cases
npm start                   # serve the built app at 127.0.0.1:8787
npm run desktop:dev         # run the Electron shell with live services
npm run dist:win:installer  # build the Windows NSIS installer
```

Use `npm run prepare:chromium` before packaging when the bundled browser is missing. Keep `package-lock.json` in sync.

## Coding Style & Naming Conventions

Use ES modules and existing JavaScript/JSX patterns: two-space indentation, semicolons, single quotes, and nearby trailing-comma style. Name functions and variables in `camelCase`, React components in `PascalCase`, and true constants in `UPPER_SNAKE_CASE`. Keep responsibilities in existing modules. No formatter or linter is configured; preserve nearby formatting and run tests after edits.

## Testing Guidelines

Tests use Node’s built-in `node:test` and `node:assert/strict`; add focused cases to `test/core.test.js` or a nearby `*.test.js` file. Name tests as behavior statements, e.g. `test('routes selected products into automatic exact-leaf category groups', ...)`. Run `npm test` before submitting. There is no coverage threshold; cover new parsing, routing, persistence, and publishing behavior directly.

## Commit & Pull Request Guidelines

Use short, imperative, lowercase commit subjects such as `stabilize publish progress and direct submission`; keep commits focused. Pull requests should explain behavior, list validation commands, identify configuration or packaging changes, and include UI screenshots when relevant. Call out Alibaba/browser automation risks or manual verification. Never include credentials, cookies, runtime data, or installers.

## Security & Configuration Tips

Keep seller sessions, product data, and auth settings local. Do not commit `.env` files, browser profiles, secrets, or account-data logs. Test Alibaba selector, category, and publishing changes with a draft before direct submission.
