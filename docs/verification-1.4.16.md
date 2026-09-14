# 1.4.16 collection verification recovery

Verified on 2026-09-15 (Asia/Shanghai).

## Reproduced failures

The desktop bridge waited for `isLoadingMainFrame()` to become false and then used `executeJavaScript`, which itself waits for loading to stop. A visible CAPTCHA with a stalled secondary image therefore stayed hidden. The new Electron fixture reproduces this on 1.4.15: the challenge never becomes visible within the test's observation interval.

The headless collector also reloaded its original punishment URL after desktop verification, losing the healthy destination reached by the user. It could repeatedly open hidden healthy desktop probes while the original collector stayed blocked. A browser fixture reproduces failure to resume at a healthy destination and checks that ineffective handoffs are bounded.

## Changes

- Inspect the committed document through the local Electron debugger connection, without waiting for images and frames to finish. Navigation changes invalidate earlier reads. This connection exposes no network debugging port or remote-page preload bridge.
- Only reveal visible verification prompts. Normal product pages remain hidden, including pages with stalled images. Keep actual challenges open for human completion, with refresh and pause controls.
- Read the verified page's local storage through the same connection so session export cannot hang on an unfinished page load.
- Resume collection at the verified healthy URL and confirm the collection browser itself is ready. Limit unsuccessful automatic session handoffs to two; preserve progress with a resumable pause when recovery fails.
- An initial hidden probe that cannot load a usable page within 60 seconds pauses with an actionable message. This limit is cleared when a real CAPTCHA is revealed and does not limit human completion time.
- Separate discovered listing links from saved product progress. Announce the detail total before reading the first product, so verification at that point displays `0/24`, not `24/0`. Unknown listing totals use an indeterminate progress indicator.

## Validation

- Focused browser, collection-pagination and persistence tests: 10 passed.
- Electron verification fixtures: passed visible CAPTCHA plus stalled image, hidden ordinary pages, delayed rendering, refresh, one-day simulated wait, pause and completion. Session export for a stalled ordinary page is checked too.
- `npm run build`: passed with the existing bundle-size advisory.
- `npx electron tools/verification-window-qa.mjs .packaged/electron/human-verification.js`: passed ten fixture loads against the final distribution code, including storage export from a document with a stalled image. Screenshot: `E:/workbench-install-qa-temp/verification-window-qa-ztTIMO/verification-window.png`. An intermediate source QA run failed during screenshot capture with `UnknownVizError`; the final package run passed without changing the capture checks.
- `npm test -- --test-concurrency=2`: 178 passed, zero failed, cancelled or skipped. The initial unconstrained full run competed with the build and the user's running desktop app: 177 passed and one browser case exceeded its 30-second test deadline. The production timeout and the test deadline were not extended; limiting simultaneous browser test workers allowed the complete suite to finish.

Live validation used the screenshot's `baiyintec.m.en.alibaba.com` store with an isolated copy of the desktop session. Both listing pages returned 24 unique products and one real CAPTCHA window appeared during detail collection. The expired/error state kept the window and operation waiting. After verification completed, collection resumed automatically and read two product details without collection warnings: six main images each, with ten and nineteen attributes respectively. Evidence is stored outside Git in `C:/Users/27757/AppData/Local/Temp/verification-collection-live-7BVCwC/report.json`.

The live test collected a two-product sample, not all 24 details. It did not automatically solve the CAPTCHA, submit products or modify the customer's workspace data.

For the browser API behavior, see the official [Electron executeJavaScript documentation](https://www.electronjs.org/docs/latest/api/web-contents#contentsexecutejavascriptcode-usergesture).

## Installer

- Windows NSIS build: passed.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.16`: passed version, ASAR equality, bundled browser, Electron security fuse, startup and unauthenticated API checks.
- Installer: `E:/workbench-build-1.4.16/chaodekuai-1.4.16-setup.exe`.
- Size: 266,986,626 bytes.
- Authenticode status: `NotSigned`, unchanged from previous releases.
- SHA-256: `c004e90ccc92920bbc92e105aa642fb27e6737a02aa861416273fd464d7a80b9`.
- Startup screenshot: `E:/workbench-install-qa-temp/workbench-package-qa-jewhJn/packaged-login.png`.

Installers, browser sessions and collected QA data remain outside Git. Package QA launches the unpacked application; installation on a customer's computer remains a separate check.
