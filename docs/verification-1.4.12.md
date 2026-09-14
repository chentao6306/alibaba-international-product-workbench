# 1.4.12 collection pagination and publishing recovery

Verified on 2026-09-14 (Asia/Shanghai).

## Report and root causes

The customer confirmed 1.4.11. Their workspace and the five failing product records are unavailable locally. Tests use the supplied shop URL, screenshot title strings and a separate local sample; they do not replay that customer's complete batch.

- The collection form defaulted to pages 1-10. The reported shop serves 16 products per page, producing exactly 160 products. The shop's total count was not the selected collection range.
- The shared field verifier removed commas from the actual input before comparing it with the unchanged expected text. Correctly saved titles containing commas were therefore reported as lost. This was reproduced against the live title input using the customer screenshot strings.
- Keywords generated from a title could include commas that Alibaba's keyword validator rejects, although the same comma is valid in a title. A live draft exposed the keyword warning after the title comparison was corrected. Keyword normalization now removes commas as well as colons, without modifying the source title or attributes. Model identifiers such as `KV100:` are not interpreted as numeric ratios.
- An aborted main-image upload occupies a slot with an error record and an undefined image URL. The old code waited 60 seconds because occupied slots were not reliable upload receipts. A live request interruption reproduced this state.

## Changes

- Default new collection requests to all pages, with an explicit range option. Preserve explicitly requested ranges and existing jobs. Report the requested range and store total in progress messages.
- Retry an empty international-store listing once, then report incomplete collection. Repeated pages, unexpected page redirects and broken next-page metadata no longer silently complete a partial job.
- Compare title text exactly; accept thousands separators only when comparing numeric inputs.
- Retry transient main-image failures at most twice. Remove only known failed files through the uploader's own callback, retain accepted file IDs, wait for active uploads and restore original image order after recovery. Verify the order before proceeding. Authorization, format and other permanent failures remain failures.
- Treat the keyword invalid-character feedback as blocking direct publication. Preserve the existing requirement for a confirmed publication receipt; an ambiguous operation failure is not blindly resubmitted.

## Validation

- Live shop `tyimx.en.alibaba.com`: 62 listing pages, 981 unique product entries, through the final page with three-second page spacing. This verifies listing discovery, not full detail enrichment for all 981 products. The screenshot's earlier count was 982.
- Real title field retained both screenshot title strings including punctuation. The old verifier rejected those exact retained values.
- Main-image fault injection: four final accepted images after one aborted request; only the failed image was resent and the original cover/order was restored. Automated coverage also exercises multiple simultaneous failures and preserves accepted IDs.
- Full draft validation passed using a Drones Accessories sample with a comma in its title and an aborted main-image request. The final run had eight confirmed detail images, no temporary detail markers and no keyword invalid-character feedback. Draft acceptance is distinct from direct-publication acceptance. The sample has a pre-existing incomplete-logistics advisory. Alibaba's page also emitted third-party JavaScript errors during the run; these did not prevent its draft-save confirmation.
- UI verification covers all-page default, range switching, responsive layouts at 1440 and 430 pixels, task pagination, origin selection and live publication counters, with no application page errors or horizontal overflow.
- `npm run build` passed with the existing frontend chunk-size advisory. Runtime evidence and screenshots remain outside Git under `E:/workbench-install-qa-temp/`.
- `npm test`: 166 passed, 0 failed, 0 skipped. Coverage includes complete/ranged pagination, empty and redirected pages, checkpoint metadata, comma-containing titles, numeric formatting, keyword punctuation, explicit invalid-character blocking and main-image recovery/order.

The customer's generic "operation failed, retry or refresh" receipt was not reproduced and has no specific cause in the supplied screenshot. This release does not claim all five customer products have been published, a measured production success rate, or a guaranteed throughput increase. First verify a small set of previously failing products before retrying the full customer batch.

## Artifact

- `E:/workbench-build-1.4.12/chaodekuai-1.4.12-setup.exe`, 266,972,957 bytes.
- SHA-256: `6ee7e81684240c4be09883bcd42a5b95ac4c2a1272f7d1f08cd0ee92660d7ac4`.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.12` passed: packaged-source equality, bundled Chromium, security fuses, ASAR configuration, isolated desktop login and unauthenticated API rejection. This starts the unpacked application, not the installer on the customer's computer. Authenticode reports `NotSigned`.
- A persistent local preview server launch was rejected by automatic approval with `blocked by policy`; no specific reason was supplied. The isolated UI server and browser verification above completed normally and the rejection does not affect this installer.
