# 1.4.10 Publishing Hotfix

Verified on 2026-09-13 (Asia/Shanghai).

## Reported Failures

The customer screenshots show a completed batch with 5 successful and 11 failed products. Most visible failures concern enabling color specifications; another concerns the main-image upload menu. A second screenshot shows an insufficient downloaded-image count and a platform image-required response. The customer's product records and failing form state were not available, so these are separate symptoms, not one proven root cause.

## Changes

- Selecting a color specification now waits for its dependent input to render. Previously, the selected state could update before the input appeared, causing an immediate failure on slower rendering.
- Color input discovery is scoped to the color row. Model specification controls use the same CSS classes on Alibaba and must not receive color values. A hidden color template cannot make an unrelated model row eligible.
- Main-image upload uses the file input inside the dedicated dropdown beside the active slot when available, including when the button label has not rendered. The existing filechooser fallback remains for other form versions. Unrelated SKU and detail uploaders are excluded.
- Downloaded and cached image formats are inspected. Invalid cached files are downloaded again. Valid oversized images are converted within the 5 MB upload limit while keeping the complete composition. Valid octet-stream image responses are accepted based on their actual format.
- Images above the 25 MB input or 40-million-pixel decode limits remain rejected. Insufficient downloads report a download error and its cause instead of claiming the source had too few images. Missing images are never invented, duplicated or replaced with another product's images.

## Verification

- `npm test`: 158 passed, 0 failed, 0 skipped.
- Focused tests cover delayed color rendering, a model control preceding the color control, missing upload labels, upload ownership, corrupted cache recovery, oversized images and corrupt downloads.
- The live Drones Accessories category (`201346401`) was inspected. Its Color and Model templates are initially hidden; Compatible Model and Type are required. The isolated sample `1601687830056` was used without modifying the user's workspace.
- Both ordinary and 4x CPU-throttled runs received draft-save confirmation. The throttled run retained four uploaded main images, the Black specification image, both compatible models and its source Type. The final pre-save stage was reached after approximately 157 seconds; this is an individual sample, not a throughput claim.
- Evidence is outside Git at `E:/workbench-install-qa-temp/drone-draft-1.4.10-first` and `E:/workbench-install-qa-temp/drone-draft-1.4.10-slow`.
- `npm run build` passed with the existing large-chunk advisory.

## Remaining Verification

The exact customer batch has not been replayed. The live sample also worked before the change on this machine; the timing and control-isolation defects were reproduced with focused fixtures. Draft confirmation does not certify direct-publication acceptance. The live draft still reports incomplete optional logistics, and no new product was directly published during this check. Customer regression should begin with one or two of the failed products before repeating a large batch.

The authorization service is unchanged at 1.4.9. This is a desktop publishing update. Installer artifacts, source product snapshots, seller sessions and QA output are excluded from Git.

## Artifact

- Installer: `E:/workbench-build-1.4.10/chaodekuai-1.4.10-setup.exe`.
- Size: 266,961,543 bytes. SHA-256: `11cbf11394d085fcaedc5aed25c5da25c5a20f320aaebf9c761d8a8ce2e65df1`.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.10` passed: compiled-source equality, bundled Chromium, security fuses, ASAR settings, isolated login startup and unauthenticated API rejection. This launches the unpacked binary, not an installer on the customer's computer. The installer remains unsigned.
