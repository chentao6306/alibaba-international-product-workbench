# 1.4.23 - reveal the description editor across posting languages

## Problem and behavior

A customer's visible publishing browser remained at Basic information while the workbench waited for the description editor. The existing heading selector accepted Product description / Product details. Inspection of the real Alibaba English posting page instead found Commodity Details and Commodity Description. On the local account, the normal-mode label remained Chinese and provided an incidental fallback, so that account alone did not reproduce the customer's entire failure.

- Locate the description using the observed `desc-card-title`, `struct-productDescType`, `struct-superText` and `struct-desc-card` anchors before falling back to heading text.
- Scroll the rich-text section header into view when present. This triggers lazy initialization even when the mode controls have not yet been created, or when they are already selected above the actual editor placeholder.
- Select a visible normal-mode control, preferring the description section and ignoring hidden duplicates. Retain the existing protection against repeated clicks resetting slow editor initialization.
- Keep a visible mode control as the scroll fallback if the page has no recognized structural anchor.
- Report whether the publisher is locating the section, initializing its editor or waiting for its editable area. Timeout diagnostics include section presence, viewport position, mode selection, editor frames and script presence; the current product is not submitted on a readiness failure.
- Publishing continues to use the maximized visible browser from 1.4.22. Collection visibility and human-verification waiting are unchanged.

## Verification

- The first three focused cases failed against the previous implementation. The final four cases cover lazy English controls, hidden duplicates, a selected mode separated from the actual rich-text placeholder, diagnostic stages and a mode-only fallback.
- Full `npm test -- --test-concurrency=2`: 217 passed, zero failed, cancelled or skipped.
- Prepared package modules: 15 focused tests passed, covering description sections, delayed initialization, visible publishing and three/four-tier prices.
- `npm run build` passed; the existing frontend chunk-size advisory remains.
- The existing real-Chromium regression with four-times CPU throttling and a 52-second editor delay passed. This is a targeted slow-loading simulation, not a reproduction of Windows 10 1607 on the customer's two-core, four-GB VM.
- Real Alibaba English posting UI: the production publisher saved a draft with explicit platform success feedback, uploaded three detail images, verified four price tiers twice and processed seven referenced SKU rows. Description readiness took approximately 0.8 seconds in this local run; reaching draft save took approximately one minute. These timings are not a customer-machine speed guarantee.
- No public product was submitted or replayed. Private profiles, account data, page captures and test product records remain outside Git.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.23` passed: desktop login startup, API authorization, bundled Chromium, security fuses and equality of prepared code and archived modules.
- Installer: `chaodekuai-1.4.23-setup.exe`, 267,023,296 bytes, SHA-256 `72c7c133ab3f3d4f4b48da13ec5e3f2452e01db49e3f4ae014e3071a0c08240f`.
- The installer-extracted `resources/app.asar` matches the tested unpacked archive: SHA-256 `52d9297312e2f0326cf9a6e487a7d3d6f6c263b3adc21ab28f62c659badb0ca8`.

The exact customer's account and machine remain unavailable. This release fixes reproduced locator and lazy-initialization gaps; it does not establish that every possible editor-script/network failure is resolved.

Quit the application normally and install over the previous version under the same Windows user and installation directory. Resume unfinished items. The browser remains visible for checking any remaining initialization problem.
