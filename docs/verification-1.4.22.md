# 1.4.22 - visible publishing and reliable price tiers

## Behavior

Customers reported seven failures from an eight-product batch: the publisher identified one price row for products requiring three or four tiers. Another batch continued waiting for its description editor while the actual browser was hidden.

- Publishing now opens its actual automation browser on-screen and maximizes it. It does not substitute the separate seller-login window. The same page remains available when an editor or field-readiness check pauses the job.
- The publisher reuses this visible context, restores it for subsequent products and recovers once if closing the last tab races with the next connection. Source collection retains its existing hidden-browser behavior.
- Human verification in the visible publishing context retains its refresh control and does not hide the publishing window after verification succeeds.
- Price rows are filled and committed in sequence before requesting another range. The publisher waits for the new quantity/price pair rather than assuming creation finished after 350 milliseconds.
- Price controls are scoped to the visible ladder. Hidden copies and unrelated quantity fields cannot shift the row index. Chinese and English buttons are supported; no forced click is used on disabled add controls.
- Existing values are retained when already correct. Rebuilt rows are reconciled, extra ranges are removed and every quantity/price pair is verified before continuing. A missing ladder cannot silently degrade a multi-tier product into a single price.
- An unavailable price table raises the existing field-readiness pause condition, preserving receipts and the current queue position. Prices and tier counts are never fabricated or truncated to avoid validation.
- Live testing exposed another deferred module: the referenced SKU table could have no headers until scrolled into view. The reference writer now reveals the section and waits for its headers before matching combinations. It preserves SKU identity, stock, codes and enabled states.

## Evidence

The original implementation reproduced the exact one-row errors in real Chromium fixtures with hidden copies, delayed row creation and validation-gated add controls. The local live Alibaba page could create four rows even before this fix; therefore the evidence supports a timing/locator failure, not a platform-wide one-tier limit.

The customer product records and Windows 10 1607 virtual machine were unavailable. The customer's continued description-editor wait is not claimed fixed by displaying the window. Visibility makes its actual state inspectable; publishing still stops before submission when required data cannot be confirmed.

Private browser profiles, test product data and account screenshots remain outside Git. The original 1.4.17 Stable archive is unchanged.

## Live And Package Verification

- Full `npm test -- --test-concurrency=2`: 213 passed, zero failed, cancelled or skipped. The final run was separated from installer compression. Test page-loading budgets are independent of the intentionally short unavailable-control deadlines.
- Prepared package modules: 15 focused tests passed, covering price tiers, window visibility, human verification, referenced SKU loading and task pause semantics.
- Real Alibaba draft saved with explicit success feedback using the production code, without test-only scrolling or other helper interactions. Four price tiers were checked both after initial filling and immediately before submission; all quantities and prices matched. All seven referenced SKU rows were processed.
- CDP checks confirmed the actual publishing window was maximized at both price checks. The window regression also covers staying visible after verification, context reuse and recovery after closing the final tab.
- `npm run build` passed; the existing frontend chunk-size advisory remains.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.22` passed: packaged login startup, API authorization, bundled Chromium, security fuses and prepared code equality.
- Installer: `chaodekuai-1.4.22-setup.exe`, 267,021,897 bytes, SHA-256 `56d81bda421b7995a36164313d5c91dd9b7898de020aa0c2a01e273ffb7e0ac0`.
- The final EXE's extracted `resources/app.asar` matches the tested unpacked archive: SHA-256 `87c66d5d5c0cb546165e4cdc19bc06106b5ac357f5f0dffb476dd6591768841a`.
- No additional public product was submitted. Existing published products were not replayed. The installer remains unsigned with Authenticode, consistent with prior releases.

Quit the app normally and install over the existing version with the same Windows user and directory. Resume only unfinished products. While publishing, the browser now shows the actual form; editor-readiness pauses leave that form open for inspection.
