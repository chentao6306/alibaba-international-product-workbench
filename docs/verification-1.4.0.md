# 1.4.0 Verification

Date: 2026-09-10

## Changes

- Manual successful-product references accept different categories and fill missing fields, including partial package dimensions. Target titles, prices, inventory, images, descriptions, SKU commerce and categories are preserved.
- Modern 1688 collection reads offer modules rather than seller/company modules. Original language, currency, attributes, SKU inventory and packaging evidence are retained. Both string and object-based external description responses are supported without evaluating supplier scripts.
- Collection completeness is separated from international publishing preparation. USD pricing, an international target category and the required product information still need to be supplied before international submission.
- Settings supports confirmed cleanup of image caches, video caches, uploaded media and product records. Unfinished tasks prevent cleanup; referenced uploaded media cannot be removed on its own. Account sessions and announcement receipts are retained.
- Authorization defaults to multiple devices per account, with an individual administrative switch. Expiration, suspension and revocation still apply to all devices. Temporary connection failures no longer immediately close an otherwise valid client session.
- Admin accounts have status filters, search and pagination. Announcements support drafts, publication, withdrawal, list display and popup display. Client navigation displays an unread dot; read receipts are stored per account on each computer and are specific to the announcement revision.

## Automated Checks

- `npm test`: 105 passed, 0 failed, 0 skipped.
- `npm run build`: passed. Vite retains a bundle-size advisory.
- API regression: a different-category reference fills origin and package fields while preserving the target source fingerprint and commercial data; cleanup requires confirmation.
- Isolated PostgreSQL service: simultaneous sessions on two device IDs, single-device replacement, re-enabling multiple devices, suspension, expiration, renewal, pagination, draft/public/withdrawn announcements, invalid requests and unauthenticated administrative access.
- Browser checks: desktop and 390 px viewport; client popup, read persistence, unread dot, cleanup confirmation and execution, native product display. Fixed a cleanup modal width issue found during this check.
- Production admin read-only browser check: 23 retained accounts displayed as 20 + 3 rows, 7 expired accounts returned by the expired filter, announcement section loaded, no browser errors.

## Real Collection Checks

| Platform / Product ID | Main Images | Detail Images | Attributes | SKUs | Source Price |
| --- | ---: | ---: | ---: | ---: | --- |
| 1688 / 1015352008828 | 5 | 7 | 25 | 6 | CNY 73.60 |
| 1688 / 959219084225 | 4 | 3 | 9 | 9 | CNY 99.00 |

The first product also returned 1 kg and 50 x 30 x 10 cm packaging. Checks used an isolated copy of the local browser profile and product workspace. Existing customer product records were not rewritten by these checks; previously incomplete records need recollection after upgrading.

AliExpress live collection and cross-platform draft/direct submission were not verified in this release check. Unit parsing tests are not evidence of a successful real listing. Source capture preserves original values; it does not infer exchange rates or invent missing product facts.

## Deployment And Package

- Production authorization service at `http://106.55.45.126/` reports version 1.4.0.
- Existing database and service files were backed up before the additive schema migration. The announcement table privileges were corrected and production endpoints retested. No test notices were published to production. The isolated test service was stopped and its database removed.
- Installer: `E:\workbench-build-1.4.0\chaodekuai-1.4.0-setup.exe`.
- Size: 244756964 bytes.
- SHA-256: `d295baffe4d5c61b2af340a0624a7649c66861ab982fb75cc9ed604bfa110865`.
- All packaged server modules, frontend assets and Electron main code match the working source. The package includes the JSON5 dependency and excludes workspace/session files. Bundled Chromium 151 starts successfully and loads the application.
- Build output was placed on E: after C: ran out of space. Runtime product data and previous installers were not deleted.
