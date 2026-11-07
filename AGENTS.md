# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the React/Vite UI.
- `server/` contains the Express API, persistence, Alibaba collectors, category routing, browser automation, and publishing logic.
- `electron/` contains the desktop main process and preload bridges.
- `auth-server/` is the separate authorization service and has its own README and Dockerfile.
- `test/` contains the Node test suite (`core.test.js`).
- `tools/` contains Chromium preparation, smoke tests, and Windows cleanup scripts.
- `dist/`, generated files in `build/`, `release*`, `vendor/chromium/`, and `node_modules/` are generated or bundled artifacts; do not edit or commit them. Keep the handwritten build sources `build/SetupBootstrap.cs` and `build/installer.nsh` in source control.

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

## Cross-category Product Requirements

- Customers collect and edit products across many unrelated categories. Treat collection, editing, category mapping, publishing, and persisted platform readback as one acceptance flow; a successful consumer-electronics listing does not validate clothing or other categories.
- Preserve source-exposed attributes, custom fields, specifications, SKU prices, images, videos, descriptions, and packaging facts with their provenance. Keep the original snapshot separate from user edits. Report unavailable data and media limits explicitly; do not silently discard data or claim completeness from a sample.
- Resolve fields against the current target leaf category and live publishing form, including control types, choices, units, required flags, dependent fields, and specification images. Prefer verified property identity and unambiguous language mappings; do not reuse unrelated categories' field definitions or guess conflicting values.
- Verify actual committed values after dependent controls change and before submission, including supplied optional values and every SKU combination/price. Distinguish source data missing, mapping failure, control rejection, account category restrictions, and transport errors.
- For each representative category, verify source-page comparison, collect/save/reopen, manual edits, draft validation, authorized publication, and published-content readback. Record the untested stages and account restrictions. Preserve publishing success when modifying shared logic.
- Automated test success alone is not approval for a full customer rollout. Keep a candidate marked as such while known production data-transfer gaps or required live integration checks remain. See `docs/claude-handoff-1.4.98.md` and `docs/release-1.4.98-source.md` for current evidence and remaining limitations. Private historical QA reports stay outside source exports.

## Commit & Pull Request Guidelines

Use short, imperative, lowercase commit subjects such as `stabilize publish progress and direct submission`; keep commits focused. Pull requests should explain behavior, list validation commands, identify configuration or packaging changes, and include UI screenshots when relevant. Call out Alibaba/browser automation risks or manual verification. Never include credentials, cookies, runtime data, or installers.

## Security & Configuration Tips

Keep seller sessions, product data, and auth settings local. Do not commit `.env` files, browser profiles, secrets, or account-data logs. Test Alibaba selector, category, and publishing changes with a draft before direct submission.
