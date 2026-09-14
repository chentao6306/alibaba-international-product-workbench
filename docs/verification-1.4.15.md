# 1.4.15 show the verification window only for a visible CAPTCHA

Verified on 2026-09-15 (Asia/Shanghai).

## Regression and correction

The 1.4.14 desktop verification bridge showed its window immediately after creating the local toolbar. The authenticated Electron account partition can load an ordinary product even when the background collector was challenged, so this exposed ordinary product pages. Its document inspector also treated generic `baxia`/`challenge` containers and empty `.nc-container` elements as active verification. The earlier checks did not account for transparent ancestors or elements positioned outside the viewport.

Both regressions were reproduced before changing the implementation: the Electron test rejected a normal product because its window was already visible, and the browser test classified an empty `baxia-container` on a healthy product page as a challenge.

The window now probes while hidden and excluded from the taskbar. Only a rendered, visible verification prompt/control or an expired challenge reveals it. Ordinary pages complete cookie synchronization without displaying the window. Generic containers, hidden/transparent/offscreen prompts and one-pixel verification frames do not trigger it. A verification URL that has not rendered its challenge is treated as pending, not as evidence to display a window.

Once a real challenge has appeared, the 1.4.14 refresh, indefinite human wait, pause/resume and checkpoint behavior remains active. The initial hidden probe has a 60-second page-load bound; that bound is cleared when the challenge is shown and never limits the time a user has to solve it. A healthy page must still pass two consecutive checks before verification completes.

## Verification scope

The expanded browser fixtures cover healthy products containing auxiliary verification markup, hidden ancestor styles, hidden expired-verification text, offscreen prompts, one-pixel frames, visible verification frames and real slider controls. Hidden error text neither opens a window nor keeps a healthy product stuck waiting. The normal cases also call the collection verification entry point and confirm it returns without entering verification.

The Electron fixture loads ordinary, delayed and ordinary product pages consecutively and records zero window-show events. It also closes a hidden probe and verifies that cleanup does not reveal it. It then renders a CAPTCHA after a delay, verifies the window was hidden before the challenge appeared, and exercises the existing day-long clock simulation, expired/blank refresh states, successful completion and explicit pause.

These are controlled browser/Electron fixtures; the exact customer product URL was unavailable. They verify the reported regression paths without solving a live Alibaba CAPTCHA or changing the user's seller data.

- Final `npm test`: 177 passed, zero failed and zero skipped. An intermediate run had an unrelated authorization development-service pagination assertion fail (3 records instead of 12); its isolated rerun and the final full run passed. No authorization-service code was changed.
- `npm run build`: passed with the existing frontend chunk-size advisory.
- `npx electron tools/verification-window-qa.mjs`: passed. An earlier run alongside the full browser test suite and frontend build exceeded the QA harness's 60-second limit; running the desktop QA separately passed without extending that limit.
- Source-window evidence is stored outside Git in `E:/workbench-install-qa-temp/verification-window-qa-ZnRlXh/`.

## Final packaged validation and artifact

- Windows NSIS installer build: passed.
- `npx electron tools/verification-window-qa.mjs .packaged/electron/human-verification.js`: passed against the final transformed package code, with nine fixture loads. Evidence: `E:/workbench-install-qa-temp/verification-window-qa-mQZf4h/verification-window.png`.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.15`: passed version, bundled-code equality, Chromium, Electron fuse, isolated startup and unauthenticated API checks. Startup evidence: `E:/workbench-install-qa-temp/workbench-package-qa-qND40i/packaged-login.png`.
- Installer: `E:/workbench-build-1.4.15/chaodekuai-1.4.15-setup.exe`.
- Size: 266,985,028 bytes.
- SHA-256: `d3a0456d1fb1e5d8919f42fc696ae588809522fbb193f3f24cba951f33b89f9f`.
- Authenticode status: `NotSigned`, unchanged from prior releases.

Installers, screenshots and runtime data remain outside Git.
