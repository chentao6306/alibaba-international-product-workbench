# 1.4.11 detail-image upload recovery

Verified on 2026-09-14 (Asia/Shanghai).

## Report and evidence

The customer screenshot shows repeated ordinary-editor detail upload failures, 0/8 images, after applying product references. The customer's batch is not present in the local workspace. Reference application retains the target's detail images; a successful reference cannot repair a runtime image-upload failure.

The live Alibaba plugin groups files into upload transactions. A server error cancels the group's files and removes its anchors. The previous integration put all eight images in one group, never retried that group, and timed out after 60 seconds. Its timeout message counted placeholder images instead of confirmed images.

An isolated real-page check reproduced the recovery defect: aborting one filebroker upload left seven accepted images and one placeholder; the old code timed out with the contradictory message "未完成...已插入 8/8". This proves a missing recovery path, not the exact cause of every customer 0/8 failure. The original sample also uploaded successfully without fault injection.

## Changes

- Track each image using its own plugin upload transaction, with at most three active images and three attempts per transient failure.
- Count confirmed photobank results, not loading images or unrelated existing images. Keep successful files and retry only unsuccessful files.
- Set a current editor cursor instead of reusing an old focus bookmark. Recover a lost anchor from that file's confirmed photobank URL, without uploading it again.
- Preserve source image order after retries. Save/synchronize editor content before returning success. Remove task markers, cancel outstanding uploads and restore the plugin error handler on exit.
- Report permanent capacity, format and authorization errors; retries are bounded. Missing files and platform rejection remain failures, never silently reported as successful publication.
- Keep the existing toolbar/photobank fallback for editors without the drag/paste plugin. Source product records and the authorization service are unchanged.

## Validation

- `npm test`: 163 passed, 0 failed, 0 skipped. New cases cover one-image retry isolation, missing anchors, image order, original content preservation, no duplicate images, concurrency bounds, capacity failure, timeout bounds and cleanup.
- Live editor with one aborted filebroker request: recovered 7/8 to 8/8, retrying one file.
- Live editor with one aborted photobank save: 8/8 final images, nine upload requests and eight successful photobank responses; no duplicate, placeholder or task-marker images remained.
- Full Drones Accessories draft with the same photobank fault: received draft-save confirmation with eight detail images. This validates draft behavior, not direct-publication acceptance. The sample retains its pre-existing incomplete-logistics advisory.
- `npm run build` passed with the existing frontend chunk-size advisory.
- Evidence is outside Git under `E:/workbench-install-qa-temp/description-1.4.11-*`. The isolated tooling does not modify the user's workspace or directly publish a product.

The customer batch and production network have not been replayed. Begin customer verification with a small set of previously failed products before retrying the full batch. This release does not claim a measured customer success-rate or throughput increase.

## Artifact

- `E:/workbench-build-1.4.11/chaodekuai-1.4.11-setup.exe`, 266,967,405 bytes.
- SHA-256: `e0600210b4f347d43cc8df513b57ed8adc7e0274f980772e6016dd2e50f1969c`.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.11` passed: packaged-source equality, bundled Chromium, security fuses, ASAR configuration, isolated desktop login and unauthenticated API rejection. This starts the unpacked application, not an installer on the customer's computer. The installer remains unsigned.
