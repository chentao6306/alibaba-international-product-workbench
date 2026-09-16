# 1.4.20 — category entry and source detail loading

Verified on 2026-09-16. Based on 1.4.19; the original 1.4.17 Stable archive remains unchanged.

## Problem and behavior

Customers reported whole batches failing on invalid categories, English form notices, unidentified description editors and missing detail images. These are distinct conditions, not evidence that replacing Chromium alone resolves them.

- Category collection now reads explicit product taxonomy or category breadcrumbs. It excludes recommendation modules and unrelated navigation; the final breadcrumb category wins over its parent.
- The category chooser matches exact IDs and recognizes English navigation controls. If the requested category cannot be selected, it does not proceed using the default category.
- Product-name detection supports English and Chinese fields, requires editability, and excludes broad substring matches that could select a subtitle. Form readiness is polled with human-verification time excluded. It reacquires the title after switching detail editors because that operation can rebuild the form.
- A resource policy detects at most two available CPU cores, at most 4.5 GiB total memory (including typical 4 GB machines), or less than 0.75 GiB free memory. Those machines use one image-processing worker, a 180-second form/editor readiness ceiling, 90-second navigation ceiling and 30-second source-frame ceiling. Other machines use three image workers, 90-second readiness, 60-second navigation and 15-second source-frame ceilings. These are maximum waits, not unconditional delays; ready pages continue immediately.
- Repeated editor checks no longer click the same switch/tab again while its iframe initializes. A genuinely rebuilt control can be clicked again, and selected tabs are left alone. Editor detection requires an editable body, not just a visible initializing iframe. Waiting progress includes elapsed seconds; failure still preserves the current task.
- A platform-invalid category triggers at most one source refresh per product per job. Automatic repair requires an untouched source category and an identical category path with a changed ID. It updates taxonomy only, preserves product content and records an audit entry. User-selected or referenced categories are not overwritten.
- If the category cannot be repaired, the task pauses at the same product. Login/editor/form unavailability also retains the 1.4.19 pause behavior. These conditions no longer add a product failure or run through the remaining batch. Submission outcomes that are uncertain are not automatically replayed.
- Preparation preserves supported local `/media/` images and data images. If detail image references are empty but the current product's description contains real images, it extracts those references. It does not fabricate missing detail images from the gallery or another product.
- Source description collection waits for delayed description iframes, including the SSR placeholder observed on a real product. It reads only description frames and scoped modules, rather than unrelated account/contact frames. The wait uses the resource policy above, excludes human-verification time and avoids waiting for absent frames on ordinary inline descriptions. A picture genuinely present in both gallery and description remains a detail picture.

## Automated verification

- Full `npm test -- --test-concurrency=2`: 202 passed; zero failed, cancelled or skipped.
- Chromium fixtures cover English category entry, exact category IDs versus substring collisions, product-name versus subtitle fields, typed category errors, DOM breadcrumb leaves, modern/legacy/structured descriptions, recommendation exclusion and an iframe inserted five seconds after page load.
- A Chromium fixture with 4x CPU throttling and a 52-second delayed editor passed. Each repeated click would restart the fixture's initialization timer; the editor was clicked once, became ready after the former 45-second deadline, and processing continued. Rebuilt controls still activate, and noneditable frames remain unready. Resource-policy tests cover two-core, 4 GiB and low-free-memory machines. This is controlled load simulation, not testing on a physical customer PC with 2 cores and 4 GB RAM.
- HTTP API regression covers a source category repaired before saving a draft, unchanged title and price, a referenced invalid category pausing without a failure receipt, and resume without repeating source refresh attempts. Existing pause/resume, collection, verification, media upload and session regressions pass in the full suite.
- `npm run build`: passed; the existing frontend chunk-size advisory remains.

## Real-site verification and limits

An isolated seller session saved a real Alibaba draft with explicit save-success feedback, three detail images, seven specification rows and the selected seller group. No additional public product was submitted during this release check.

The first source recollection reproduced a real race: correct category and six gallery images, but zero detail images. Diagnosis found an initially empty SSR description module whose description iframe attached later. After the fix, two consecutive independent runs collected the correct leaf category, six main images and three detail images without a collection warning. This check uses the owner's previously supplied sample, not the customer's unavailable 113-product data set.

Actually unavailable categories still require a valid selection. Expired seller sessions require login. Products genuinely lacking images or required facts still require those materials. These checks do not establish a customer-wide success percentage or guarantee platform approval.

Credentials, cookies, source snapshots and account-specific screenshots stay outside Git. Installers are release assets, not committed binaries.

## Windows package

- NSIS installer and `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.20`: passed. The actual packaged login window rendered and accepted interaction; the local service started and rejected unauthenticated API access.
- Fifteen category/source/readiness tests also passed against the prepared package modules, covering browser-serialized extraction callbacks after the packaging transform and slow editor initialization.
- Final installer: `chaodekuai-1.4.20-setup.exe`, 267,016,360 bytes.
- SHA-256: `0e4aa7fdfdfc8b15cef32ee523770d28a86071aece37ba2eb7a18fb7b2655773`.
- Extracted `resources/app.asar` from the final EXE and confirmed it matches the tested archive: `b20eb0078149df2325be7f663a22f506099701fe5e1896cb585241a7ce2f5a31`.
- Prepared server/Electron files, bundled Chromium and Electron security fuses were checked. The installer remains unsigned with Authenticode, consistent with earlier releases.

Build after stopping browser tests: `npm run dist:win:installer`. This check used `E:/workbench-build-1.4.20/` instead of the default `release-installer/` output directory. Quit the running app, then install over the existing version using the same Windows user and installation directory. User data remains in the existing application data directory.
