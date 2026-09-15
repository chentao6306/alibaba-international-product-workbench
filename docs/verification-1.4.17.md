# 1.4.17 collection checkpoints and complete product references

Verified on 2026-09-16 (Asia/Shanghai).

## Corrections

- Collection persists the next listing URL, visited pages, discovered products and completed detail IDs in separate atomic checkpoint files. Resume retains counters and retries the unfinished page or product. Completed and cancelled tasks clear their checkpoints. Old versions did not record listing checkpoints, so their historical counters cannot reconstruct a queue.
- Explicit reference copies the selected successful product's category, attributes, specification options/images, SKU codes, quantities and enabled states. It clears stale template fields and preserves target title, prices, main images and description. Missing packaging/shipping data can be supplemented. Automatic submission-error repair remains restricted to relevant attributes and the same category.
- Successful attribute receipts preserve option labels and multiple selected values. English and Chinese attribute aliases share the same mapping. The English Add Color control and multiple checkbox selections now work.
- The publisher fills the actual virtualized SKU table by specification identity and checks every row, including rows outside the initial viewport. Missing combinations are disabled. Disabled reference rows retain their codes and quantities; zero stock is no longer changed into default stock during reference preparation.
- Verification transfers the requesting browser's user agent and cookies to the desktop window. If the desktop session cannot restore the collector, the original browser profile handles verification and remains available for continued work. Cookie imports apply only changed desktop values so they do not overwrite a newer verification state obtained in the collector. Unchanged storage imports no longer accumulate scripts.
- JSON state caching includes file identity to detect atomic replacements with equal timestamps and sizes on Windows.

## Automated validation

- `npm test -- --test-concurrency=2`: 186 tests passed; zero failures, cancellations or skips.
- Coverage includes listing/detail pause and resume, interruption and retry, collector recreation with disk checkpoints, 62-page/982-item pagination, API progress persistence, reference idempotence, immutable source snapshots, prices, category routing, virtual SKU scrolling and disabled/zero-stock rows.
- `npm run build`: passed; existing frontend chunk-size advisory remains.
- `node tools/reference-ui-qa.mjs`: passed real UI-to-API reference selection, preview and save at desktop and narrow widths.
- `node tools/group-origin-ui-qa.mjs`: passed collection controls, task pagination, live publication counts and origin selection.
- `npx electron tools/verification-window-qa.mjs .packaged/electron/human-verification.js`: passed ten page loads, including hidden normal pages, visible challenges with stalled resources, refresh, pause, completion and simulated long waits.

## Live Alibaba validation

Used isolated session and data copies; the customer's workspace was not overwritten.

- Read the screenshot store's two listing pages: 24 unique products. Paused after page one and confirmed the recreated collector continued at page two.
- Read two real product details with six main images each and ten/nineteen attributes respectively.
- Referenced a successful product, saved a real draft, then directly submitted one product. Alibaba returned a success URL with a new product ID. The English logistics validation was repaired before the successful submission.
- After adding complete SKU writing, independently verified all 20 real specification combinations and saved another complete draft successfully.
- A subsequent fresh collection run reached a real CAPTCHA and remained waiting for the user. Its long-wait refresh-and-resume live acceptance is still pending; the window and checkpoint were retained. Automated fixtures verify that behavior, but do not replace this pending live step.

The live sample does not establish a percentage success rate for every category or a large production batch. Alibaba validation, required product facts and account-specific restrictions still apply. A saved draft may contain warnings that direct submission must repair; draft success is not treated as a publication receipt.

## Distribution

Windows NSIS output: `E:/workbench-build-1.4.17-final/chaodekuai-1.4.17-setup.exe`.

Package startup and integrity validation uses `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.17-final E:/workbench-build-1.4.17/win-unpacked`. Rebuilding the initial output encountered an NSIS output-file lock; the final installer is generated from the verified application directory into a fresh output directory. QA reports, screenshots, sessions, account data and installers remain outside Git.

- NSIS build and packaged startup/API/security-fuse checks: passed.
- Extracted `resources/app.asar` directly from the final installer and verified its SHA-256 equals the tested application archive. The archive's server and Electron files also equal the final prepared source.
- Installer size: 267,003,819 bytes.
- Installer SHA-256: `36f9dd8a3452d147f6815f587993b915dcc8b12069a0cb0f90a50fdbf89b0257`.
- Authenticode: unsigned, unchanged from prior releases. Installation on a customer's machine remains separate from the unpacked-application startup check.
