# 1.4.8 Publishing Form Reliability

Verified on 2026-09-12 (Asia/Shanghai).

## Findings And Changes

- The customer confirmed version 1.4.7. Their workspace and reference product were unavailable, so the seven reported failures could not be reproduced item by item.
- The live Drones Accessories form (`201346401`) renders required Type inside `#struct-specification`, under `p-200399262`. The old general attribute locator excluded that entire section. It now locates exact required attribute rows without wandering into unrelated fields or optional SKU controls.
- Checkbox attributes select a real existing option or commit the source value through Alibaba's custom Add control. The concrete source Type specification takes precedence over the category name placed in `productType` by older collectors. Required specification values are checked again before submission.
- Manual references now use category values captured at successful publication, as automatic repairs already did. Existing target attributes, prices and media retain the only-missing reference behavior. A reference is not evidence that all target fields will pass the platform validator.
- Main images use the file chooser opened by the active main-image slot or a scoped input. A page-wide multiple file input can belong to another uploader and is no longer selected as a shortcut.
- Specification image verification rejects temporary blob/data previews, checks every option and skips repeat downloads for completed images. Missing option images are no longer reported as a completed group repair.
- Overlay handling verifies that the blocking dialog disappeared. Unknown confirmations remain untouched. Ordinary button timeouts no longer incorrectly report an editor-switch overlay failure.
- Existing bounded retry, ambiguous-receipt protection and per-product queue continuation remain in place. No publishing concurrency increase was introduced.

## Validation

- `npm test`: 147 passed, 0 failed.
- Focused regression coverage includes required Type in the specification section, custom-value commit, unrelated input preservation, main-image portal ownership, incomplete specification images, safe dialog closure, accepted reference values and colon-prefixed platform errors.
- Live custom Type probe: `Flight Controller` was added and checked through the real posting control.
- Live draft using an existing local drone-accessory product: Alibaba returned `保存成功`. The final captured Type was only `Propeller Blades`; country was `China`. Detail uploads, main-image uploads and source color image verification completed.
- The live draft still reported incomplete optional logistics alongside its save receipt. Saving a draft does not establish direct-submit acceptance; the existing all-or-empty logistics repair remains covered by tests.
- No customer product was directly submitted during this verification. No customer-specific success percentage is claimed.

- `npm run build`: passed; the existing large-chunk advisory remains.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.8`: packaged source equality, version, Chromium, Electron security fuses, ASAR integrity configuration, isolated login-window launch and unauthenticated API rejection passed.
- Packaging used the installed Electron 44.3.0 distribution via `--config.electronDist=node_modules/electron/dist` after the redundant GitHub download timed out.

## Artifact

- Installer: `E:/workbench-build-1.4.8/chaodekuai-1.4.8-setup.exe`.
- Size: 266954169 bytes.
- SHA-256: `a2ba1847ad7091a21e91bb3788422db417a8486250cb386dea9e1668785c7682`.
- This is a desktop update. No authorization-server deployment or database migration is required.

The packaged application was launched in an isolated profile; the installed application was not overwritten during QA. The installer remains unsigned, as no commercial Authenticode certificate is configured. Reports containing local product data and browser profiles are stored outside the repository and are not included in Git.
