# 1.4.21 — editor initialization, keyword fields and browser connection

Verified on 2026-09-16. Based on 1.4.20; the original 1.4.17 Stable archive is unchanged.

## Problem and behavior

A customer batch saved two products and failed two. One error waited for `.posting-field-keywords textarea.nth(1)` after that index disappeared; another spent three minutes in the browser-connection stage.

- Keyword input now resolves the first visible, enabled, editable keyword field each time. It survives removal of hidden clones and replacement of the input during a React update. Generic description textareas are excluded.
- If a field cannot retain its value, the error identifies the field and pauses the task at that product, preserving earlier success receipts. Raw locator timeouts are not exposed as product failures. Other fields keep their existing value-commit and verification behavior.
- Browser connection reports individual stages. Desktop cookie export and page-storage reads have independent limits. A frozen optional desktop synchronization can fall back to saved cookies; the normal login check still applies.
- Browser launch, cookie import, page creation and preparation are bounded. The connection step no longer performs a duplicate product navigation before the publishing navigation.
- Pause is registered before connecting. Aborted work cannot proceed after synchronization resolves late, and a browser/page returned after its connection deadline is disposed. An unusable existing browser is detached before recovery; closing an old context cannot clear a newer context.
- Browser unavailability pauses the same product without counting a failure or consuming the rest of the batch. Unknown submission outcomes are not automatically retried by this change.
- The description heading and normal-editor control are scrolled into view before checking editor initialization. A real Alibaba page had no editor iframe before this scroll and created `super-text-container_ifr` after it: selected mode alone was insufficient to trigger the lazy module.
- Checked radio modes are not toggled again. An explicitly unchecked mode can receive one additional activation if the first click failed; controls without a checked state retain the single-click protection for slow initialization.
- Editor readiness timeout no longer triggers a second whole-page reload and full readiness wait. It pauses once with a specific reason (mode unselected, iframe absent, or iframe not editable). Structural diagnostics contain mode/frame counts and script-load state, not product content, cookies or page HTML. Form-entry recovery retains its existing single retry.

## Verification

- Full `npm test -- --test-concurrency=2`: 208 passed, zero failed, cancelled or skipped.
- Real Chromium fixture: remove the hidden first keyword textarea, replace the visible input and erase its first value during input; verify that the replacement receives the correct keywords and an unrelated textarea stays unchanged. A disappearing keyword input produces the typed pause condition.
- Connection tests cover timeouts, disposing late browser results, pausing during unresolved login synchronization, and classifying connection failures. HTTP API regression verifies browser/field errors preserve progress, receipts and the remaining queue.
- Editor fixtures cover a selected mode whose iframe is created only when its heading enters the viewport, an initial radio click that does not stick, structured timeout diagnostics and no whole-page retry after editor timeout. The prior 52-second/4x CPU-throttled initialization test still passes.
- `npm run build`: passed; the existing frontend chunk-size advisory remains.
- Real Alibaba draft: explicit save-success feedback after running the new connection and keyword paths, with three detail images and seven specification rows. No additional public product was submitted.

The customer smartwatch and motor records, their exact runtime session and their Windows 10 1607 VM were unavailable. This verifies the reproduced DOM failure, lazy initialization and connection lifecycle, not a measured success rate or runtime compatibility for all customer machines. Platform login, required facts and review rules still apply.

Private sessions, account-specific screenshots and product data remain outside Git. Source branch: `codex/fix-keywords-and-browser-connection-1.4.21`.

## Windows package

- Thirteen focused tests passed against prepared package modules, including keyword replacement, cancelled/late connections, HTTP task pause behavior, cookie import and editor lazy loading.
- `npx electron tools/seller-session-qa.mjs`: passed, including closed-window sessions and account isolation.
- NSIS build and `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.21`: passed. Verified packaged login startup, API authorization, bundled Chromium, security fuses and prepared source equality.
- Installer: `chaodekuai-1.4.21-setup.exe`, 267,019,547 bytes, SHA-256 `847a6559a144de7937ccebe38606c829c1bfada1986e133fcb40d559aeaf55ef`.
- The final EXE's extracted `resources/app.asar` matches the tested archive: SHA-256 `70cdc1d3b98e19b7d7d212d7f110702ca7e1d2403617304c9f7f64efc72e8919`.
- Installer remains unsigned with Authenticode, consistent with previous releases. Quit the running app and install over the existing version using the same Windows user and directory; existing user data is retained.
