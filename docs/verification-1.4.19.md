# 1.4.19 — partial collection and posting readiness

Verified on 2026-09-16. Based on 1.4.18; the original 1.4.17 Stable archive remains unchanged.

## Behavior

- After pausing list discovery, users can either continue pagination or collect details only for the products already discovered. The selected transition is saved to the checkpoint before queueing. Further pauses resume details without restarting pagination. The completion message describes the actual partial range rather than claiming the requested 100 pages were collected.
- Seller session export also works after closing the Electron seller window, using the current authorized account's persistent partition. When publishing redirects to login, it reimports the desktop session once. Ordinary synchronization continues to preserve newer CAPTCHA cookies created in the collector.
- The detail-editor switch supports Chinese and English labels, retries delayed controls, and allows 45 seconds for an editable frame. Human verification time is excluded from this limit. Unrelated editable title controls are no longer accepted as a description editor.
- An incomplete form/editor is reloaded once before any submission. If still unavailable, the batch pauses at the current product, preserving completed receipts and the remaining queue. Login expiry and account limits also pause without adding a product failure.
- Alibaba's explicit invalid-category message is reported as a category problem. The software does not substitute an unrelated category or invent required product facts.
- Unknown submission outcomes are never automatically replayed by the new readiness retry.

## Automated verification

- Full `npm test -- --test-concurrency=2`: 194 passed; zero failed, cancelled or skipped.
- Real HTTP API tests: request 100 pages, pause after four completed pages, collect eight discovered fixture products, pause again during details, resume without visiting page five or duplicating products. Also reject invalid stage transitions.
- Real Chromium fixture: English editor switch with a 16-second delayed iframe, non-editor editable controls, invalid category, and human-verification time exclusion.
- Batch API regression: login/editor/form unavailability preserves the same current product with no failure history; after recovery, valid items complete and an invalid category is reported for its item.
- `npm run build`: passed; existing frontend chunk-size advisory remains.
- `node tools/group-origin-ui-qa.mjs`: passed at desktop and narrow widths, including the new discovered-products button, existing country selectors and live publish counts.
- `npx electron tools/seller-session-qa.mjs`: passed with a real hidden Electron window, closed-window cookie export, encrypted local storage, and account partition isolation.
- The three editor/readiness cases also passed against the prepared package modules, including keeping policy prompts blocking when an editor already exists.

## Scope of the evidence

Real Alibaba draft verification also passed using an isolated copy of the previously tested owner's session and product. Alibaba returned explicit save-success feedback. Detail images (3/3), seven specification rows and the selected seller group were processed. Existing logistics repair handled incomplete optional logistics fields. Three unmapped source attributes were reported as nonblocking warnings. This was a draft-only check; no additional public listing was submitted.

Customer account data and network conditions were not available. These tests reproduce the relevant control flow and loading differences, not the customer's exact session. An expired login needs a valid seller login, and Alibaba may reject an unavailable category regardless of browser engine. The changes do not establish a universal success percentage or guarantee platform approval.

No credentials, cookies, product data, or account-specific screenshots are included in Git. Windows artifacts are distributed as release assets rather than committed binaries.

## Windows package

- NSIS installer and `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.19`: passed.
- Final installer: `chaodekuai-1.4.19-setup.exe`, 267,011,215 bytes.
- SHA-256: `73d671d716e2c92934ff0560863a8eb559de19b6f606883a01eafe9a205bfbff`.
- Extracted `resources/app.asar` from the final EXE and confirmed that it exactly matches the tested archive, including prepared server/Electron code. Checked bundled Chromium, login startup, unauthorized API rejection, and Electron security fuses.
- Build remains unsigned with Authenticode, consistent with previous releases.

Build after stopping browser tests: `npm run dist:win:installer`. The standard output directory is `release-installer/`; this verification used `E:/workbench-build-1.4.19/` to keep generated artifacts outside Git. Source branch: `codex/collection-and-publish-readiness-1.4.19`.
