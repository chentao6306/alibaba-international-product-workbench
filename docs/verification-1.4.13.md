# 1.4.13 pagination, references and platform warning handling

Verified on 2026-09-14 (Asia/Shanghai). The customer confirmed version 1.4.12. Their complete workspace and the shop URL for the 42-page report were not available, so live collection used the previously supplied `tyimx.en.alibaba.com` shop.

## Reproduced Problems And Changes

- A listing response can contain an empty product section plus recommendation products, with no valid pagination metadata. The 1.4.12 parser merged recommendation modules with the actual listing and could overwrite its pager. A live explicit 1-100 run stopped at page 31 with 480 products while the first page reported 981. The collector now keeps the paginated list separate, retries transient navigation or incomplete listing responses twice, and reports incomplete collection if recovery fails. A zero-count page in the middle of a listing cannot terminate the job successfully. An actually empty first page remains valid.
- Missing-only references checked attribute rows but did not account for translated aliases, existing SKU groups or top-level values. A fresh flight controller inherited `Propellers` alongside its original `Holybro` type. References now preserve existing values across those representations. A category name used as a placeholder for product type does not prevent a genuinely missing type from being filled. Repeated references do not add duplicate values.
- Source-language auditing previously inspected working attributes. Referencing a Chinese attribute label therefore reduced the quality score of an English source and incorrectly recommended recollection. This audit now reads the immutable source snapshot.
- An actual submit opened a suspected restricted-product warning for the title word `drone`. Stale logistics feedback caused two irrelevant repair attempts, ending with a generic overlay error. Publication now recognizes that warning before field repair, reports the platform's reason, and never automatically confirms or retries it. The existing batch loop records the product failure and continues; a product policy warning does not pause the entire queue or trigger automatic reference repair.

## Live Collection And Publication

The corrected parser read 62 listing pages and 981 unique products, matching the shop's current total. This verifies discovery of the full listing, not detail enrichment of all 981 products. The earlier screenshot showed 982; inventory can change.

Three products were freshly collected and all three received the same successful same-category reference without filtering on quality. Their original scores were 96, 92 and 92. The source stock was not public; publication used the existing configured/default stock preparation. All three passed real draft-save checks after the reference correction, with eight uploaded detail images each and original type/color values retained.

Direct submission used the transformed `.packaged/server` publisher code with the explicitly authorized seller session. Results:

| Source Product | Result | New Alibaba Product ID |
| --- | --- | --- |
| 1601683888943, Holybro Kakute flight controller | Confirmed success URL; platform review pending | 1601951667158 |
| 1601685473238, Foxeer video transmitter | Confirmed success URL; platform review pending | 1601951649269 |
| 1601794133526, HQProp propeller | Restricted-product warning for `drone`; continuation was not confirmed | None |

Both successful products needed the existing recovery for an optional logistics section: Alibaba required the section to be complete or entirely empty, and accepted submission after it was cleared. Local packaging data was preserved. Some reference attributes had no matching target-form control and were reported as unmapped. Draft acceptance alone was not counted as publication success.

The reference test uses an isolated product report and browser profiles. It does not replace the user's workspace. It records every publication receipt and refuses to repeat an attempted submission automatically. The initial and corrected draft passes created test drafts in the seller account. The final policy-warning change was verified with a browser fixture matching the captured warning, without retrying the restricted item.

## Verification And Limits

- `npm test`: 170 passed, zero failed and zero skipped. `npm run build` passed with the existing frontend chunk-size advisory.
- New coverage includes recommendation-module ordering, recovery at page 31, explicit 100-page traversal, empty and redirected pages, translated reference aliases, existing custom/SKU fields, repeat-reference stability, source-language auditing, and a policy warning alongside stale logistics errors. The warning test verifies exactly one submit click, zero repair calls and no click on the continuation button.
- Real screenshots and product evidence remain outside Git under `E:/workbench-install-qa-temp/reference-live-verified/` and `E:/workbench-install-qa-temp/listing-pagination-recovered/`.
- The customer's 0/8 detail-image failure was not reproduced in these three products. Every draft and direct attempt uploaded eight detail images. This small test is not a production success-rate benchmark or a guarantee that all customer products will pass platform review. The third product requires the seller to assess the platform warning.

## Artifact

- Installer: `E:/workbench-build-1.4.13/chaodekuai-1.4.13-setup.exe`, 266,891,123 bytes.
- SHA-256: `48eaaa809c5b9418909f336fc88ae9f2e25005040793b6ba36ba40c952ba0eac`.
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.13` passed: generated-code equality with ASAR contents, bundled Chromium, security fuses, isolated desktop login startup, and rejection of unauthenticated API access. The final build contains the policy-warning correction and the category-placeholder reference regression fix.
- Authenticode status is `NotSigned`. The package check launches the unpacked application; it does not test installation on the customer's computer.
