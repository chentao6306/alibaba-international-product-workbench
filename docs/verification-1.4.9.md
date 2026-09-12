# 1.4.9 Reliability, Progress And Connection Policy

Verified on 2026-09-12 (Asia/Shanghai).

## Changes

- Publishing outcomes are checkpointed per product. The UI polls compact job updates every 1.5 seconds and shows success, failure and remaining counts during the batch. Retrying a product replaces its previous outcome instead of double-counting it. Old jobs without outcomes show processed counts instead of invented success counts.
- Current products show an in-progress badge instead of their previous failure. An unrecognized submit button throws a product-level failure and cannot be counted as a successful publication. Product-level errors continue with the next item; authorization, verification and account-quota interruptions retain the pause behavior.
- Workspace reads cache the parsed file and clone only selected data for job polling. External writes invalidate the cache. Stage-only messages avoid rewriting the product database; product outcomes and pause checkpoints remain durable atomic writes.
- Group collection no longer delays each already-loaded listing row. Detail/page pacing is retained. Group completion does not save all checkpointed products a second time or overwrite edits made after their checkpoint. Link collection saves the completed item before honoring a pause.
- Plain attribute controls commit on blur before Escape. The live model control removed an uncommitted row on Escape and then caused repeated locator timeouts. Missing model inputs are recreated using their own Add control. Detached fields fail quickly.
- The live phone form reproduced the customer's colon error specifically in the keyword field. Generated and supplied keywords normalize colons (numeric ratios become `1 to 1`) and respect the 384-character limit. The original title, source keywords and radio-band attribute are preserved. Keyword writes are verified instead of silently ignoring a failure.
- Publication refills attributes once when Alibaba auto-saves and reloads a new draft. Required category attributes, as well as required specification values, are checked before the final action. This recovery never repeats a submit action.
- Feedback reads use one DOM snapshot rather than many locator round trips. Specification-image lookup no longer waits for nonexistent inputs in heading labels. Already committed colors are not rewritten during repeated checks. All source option images still require completed upload verification.
- A live CDN download failure was previously reported as an upload failure. Specification download errors now identify their actual cause. Transient HTTP/network failures receive up to three attempts; permanent HTTP failures are not retried. Up to twelve current-product color images are prefetched through the existing shared three-worker queue and verified from cache before upload.
- Batch origin and regional-price country selection use the shared country dropdown. Origin changes are included in the batch preview. Compact progress layouts are checked on desktop and narrow viewports.

## Authorization

- Administrators can configure connection grace for 1 hour, 1 day, 3 days or 15 days per account. The new default is 1 day; explicit existing settings are preserved. License expiration and explicit revocation still take precedence.
- An offline client cannot receive a newly issued revocation until it reconnects. Longer grace permits continued offline use until its signed lease expires, bounded by the license expiration. This is a configuration tradeoff, not immediate offline revocation.
- Version 1.4.9 advertises the new signed connection-policy capability. Older clients receive a maximum one-hour lease. They must update to use longer periods.
- Leases use server time plus a monotonic local clock; changing the wall clock does not extend authorization. Expired heartbeat tokens can be refreshed using the saved activation credential. Explicit denials are not recovered as network outages.
- On revocation the editor window is retained, jobs pause and checkpoint, writes are blocked, and login can restore the same window without reloading unsaved editor state.
- The production PostgreSQL authorization service was tested in an isolated database before deployment. The final update includes idempotent schema migration and a code/database backup at `/var/backups/kua-yipu-auth-20260912205131`.
- The public HTTPS health endpoint reports version 1.4.9. Authorization, Nginx and PostgreSQL services are active. The public smoke probe used the existing private-certificate setup; it is not evidence of public CA trust.

## Verification

- `npm test`: 156 passed, 0 failed, 0 skipped. The suite covers authorization expiry/outages, request security, collection parsing/checkpoints, pricing, source integrity, references, required attributes, upload ownership, image download retries, ambiguous submission receipts and batch continuation.
- UI QA verifies country selection saves correctly, counters update before the last item finishes, prior failure messages are hidden for the active item, and desktop/mobile layouts do not overflow.
- Electron authentication QA verifies that a denied session retains the workspace window and blocks writes. Admin UI QA verifies the multi-day policy controls. Both passed.
- A read-only probe of the existing 29 MB workspace measured 20 old-style full JSON parses at 4,659 ms versus 20 cached job projections at 10 ms. This measures progress reads, not overall publishing throughput.
- Live model-only reproduction improved from a 43,664 ms failure to a 1,783 ms successful commit with its original value retained.
- Two final live phone checks received draft-save confirmation with their target group, country, required category attributes, source specification dimensions and all ten / three color images. Neither final check reported the keyword-colon error. Reports remain outside the repository in `E:/workbench-install-qa-temp/publish-phone-1.4.9-verified` and `E:/workbench-install-qa-temp/publish-phone-secondary-1.4.9-final`.
- For the same ten-color product, elapsed time from the first stage to the final save action fell from about 371 seconds to 219 seconds. Network and platform response times vary; these are individual samples, not a general throughput guarantee or measurements of final publication acceptance.

## Release Limits

- Customer 1.4.7 product/reference data was unavailable. Customer-wide success percentages cannot be inferred from these local fixtures and draft checks.
- Draft save receipts are recorded separately from direct publication. A successful draft can still contain Alibaba logistics warnings. The all-or-empty logistics repair remains covered by tests, but this run does not certify direct-submit acceptance for every category or customer batch.
- No new customer product was directly published in this verification. Live draft records and reports are QA evidence, not advertised listings or success-rate statistics.
- The installer remains unsigned because no Authenticode certificate is configured. The existing Vite large-chunk advisory remains; functional and packaging checks are required independently.
- Desktop and authorization changes must both be installed to use the new connection policy. Runtime data, browser cookies, credentials, generated files and installers are excluded from Git.

## Artifact

- Installer: `E:/workbench-build-1.4.9/chaodekuai-1.4.9-setup.exe`.
- Size: 266,959,918 bytes. SHA-256: `2e6147acf8ae86de069bc503c115d637b6389ce7164443d44c97d0332759ca82`.
- `tools/desktop-package-qa.mjs E:/workbench-build-1.4.9` passed: packaged-source equality, bundled Chromium, Electron security fuses, ASAR integrity settings, isolated login startup and unauthenticated API rejection. This check launches the unpacked application; it does not replace installer testing on customer machines.
