# 1.4.18 — correct the inline editor toolbar overlay classification

Verified on 2026-09-16. Based on the archived 1.4.17 Stable commit `31f3d70`.

## Reproduction and fix

The reported failed phone product was reproduced using an isolated copy of the owner's product data and seller browser profile. The form exposed a TinyMCE inline table toolbar with `role="dialog"`, `class="mce-tinymce-inline"` and a child `role="toolbar"`. There was no blocking backdrop. The old generic dialog selector refused to continue even though the form was usable.

The publisher now excludes this specific non-modal toolbar from blocking dialogs and returns immediately when no blocker is present. Actual TinyMCE windows, `aria-modal="true"` dialogs, unknown confirmation prompts and backdrops remain blocking. It does not delete DOM nodes, click table-editing controls or confirm unknown prompts.

## Verification

- Both new browser regression cases failed on the original implementation and pass with the correction.
- 25 focused publishing tests passed, including policy warnings and real dialogs.
- Full `npm test -- --test-concurrency=2`: 189 passed, zero failed, cancelled or skipped.
- `npm run build`: passed; existing frontend chunk-size advisory remains.
- Retested the original failed product: Alibaba confirmed draft save, including the selected seller group.
- After the draft check, submitted only that failed product once. Alibaba returned an explicit success URL and confirmation that the product entered review. An existing logistics repair cleared the optional incomplete logistics group before the successful submission.
- Recorded the confirmed result back into the local workbench with a separate completed verification task. The original five-item batch history is retained. The four previously successful products were not submitted again.

Account-specific receipts, page captures and product data remain outside Git. This single-product result verifies the reproduced failure; it does not establish a success percentage for all categories or platform review outcomes.

## Windows package

Build from this branch after installing the locked dependencies:

```powershell
git switch codex/fix-posting-overlays-1.4.18
npm ci
node node_modules/playwright-core/cli.js install chromium
npm run prepare:chromium
npm test -- --test-concurrency=2
npm run dist:win:installer
```

Stop local browser tests before replacing the bundled Chromium directory. Output: `release-installer/chaodekuai-1.4.18-setup.exe`.

The delivered installer is built in `E:/workbench-build-1.4.18/chaodekuai-1.4.18-setup.exe`. Package verification checks the included prepared source, Chromium, login startup, unauthenticated API access and Electron security fuses. The package checksum and verification result accompany the GitHub release. The app remains unsigned with Authenticode, as in 1.4.17.

- NSIS build and `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.18`: passed.
- Executed the toolbar regression against the prepared publisher code: passed.
- Extracted `resources/app.asar` from the final installer and confirmed it exactly matches the tested application archive.
- Installer size: 267,004,376 bytes.
- Installer SHA-256: `9d41b2871d5a3383896936375114bd9d524657b1b70aeefef93be1bb457a82fc`.

The `Stable` branch and `v1.4.17-stable` release retain the complete original 1.4.17 archive and encrypted data backup.
