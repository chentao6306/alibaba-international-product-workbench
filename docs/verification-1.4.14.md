# 1.4.14 persistent human verification

Verified on 2026-09-14 (Asia/Shanghai).

## Behavior

- Removed the five-minute CAPTCHA deadline in both the Electron verification window and the Chromium fallback. A confirmed challenge remains visible and the calling operation waits until verification succeeds, the user explicitly pauses/cancels, authorization requires a pause, or the application shuts down.
- The desktop window has a fixed local toolbar with refresh and pause commands. Refresh acts on the same remote browser view and account partition. Closing the window with its close button keeps the pending challenge available; the pause command stops waiting with a resumable task state.
- Completion requires two consecutive healthy document checks. A visible CAPTCHA, expired/error prompt, login page, loading document, blank page or inspection exception does not count as completion. Cookies are synchronized and the original collection page is checked again before collection continues.
- Job-specific cancellation and waiting messages flow through collection, source enrichment and publishing. Verification heartbeats keep the publication stage watchdog alive. Pausing verification does not create a publication failure or erase earlier collection checkpoints and publication receipts. A stalled renderer still allows cancellation and progress heartbeats.
- Single-product recollection no longer has a separate five-and-a-half-minute race that fails while its verification window remains open. The publication receipt check gets its normal feedback window after human verification finishes.
- The remote verification view has no Node integration or preload bridge. Refresh/pause IPC is limited to the local toolbar's main frame. Remote navigation is restricted to the supported marketplace HTTPS domains.

## Verification

- `npm test`: 177 passed, zero failed, zero skipped. Coverage includes long waits, expired/blank/login/error states, consecutive successful checks, navigation exceptions, a stalled renderer, isolated job cancellation, and collection/publishing pause and resume through the actual API.
- `npm run build`: passed, with the existing frontend chunk-size advisory.
- `npx electron tools/verification-window-qa.mjs`: passed in the real Electron window using isolated HTTPS fixtures. The test advances the process clock by one day, leaves an expired challenge visible, refreshes through a blank page, checks successful completion and pause, and verifies the toolbar fits at the minimum 640-by-480 window size.
- `npx electron tools/verification-window-qa.mjs .packaged/electron/human-verification.js`: passed against the transformed distribution code, including verification that the remote view has neither `require` nor the local toolbar bridge.
- Window evidence is outside Git under `E:/workbench-install-qa-temp/verification-window-qa-iUymeB/`. The combined screenshot contains the captured local toolbar and remote web view at their actual positions.

The long-wait and expired-CAPTCHA checks use controlled fixtures and clock advancement, not a real Alibaba CAPTCHA left running for a day. No CAPTCHA was automatically solved or bypassed. A real platform challenge still needs the user to complete it, and the platform can require another challenge after a refresh or session change.

## Artifact

- Installer: `E:/workbench-build-1.4.14/chaodekuai-1.4.14-setup.exe`, 266,982,955 bytes.
- SHA-256: `5847f3571dcd6b52da1ae8b815f8b9983fabc0bbeeb9dcf5fd9b8e07282b39eb`.
- Build used the existing local Electron 44.3.0 distribution after the runtime download stalled. Runtime and application dependencies were not upgraded.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.14` passed: generated-code equality with ASAR contents (including the verification shell and preload), bundled Chromium, security fuses, isolated desktop login startup, and rejection of unauthenticated API access.
- Authenticode status is `NotSigned`. Package QA launches the unpacked application; it does not verify installation on the customer's computer.
