# 1.4.7 Authorization Connection Recovery

Verified on 2026-09-12 (Asia/Shanghai).

## Behavior

- Previously any heartbeat exception revoked the local session and closed the workbench. Temporary network errors and HTTP 408/429/500/502/503/504 now retry without logging out a verified user.
- Administrators can set each account's offline grace period to an integer from 1 to 60 minutes, default 5. The next successful heartbeat applies changes. Older clients require the 1.4.7 update for this behavior.
- Grace is measured from the last successful check using server time and a monotonic clock. Retries and client clock rollback cannot extend it, and the license expiry always limits it.
- After grace expires, the workbench stays open with a connection banner. Current collection/publishing work saves its result, then subsequent products pause. Mutations are blocked; authenticated local state remains readable. Reconnection restores access, and paused jobs require explicit resume to avoid unrequested publishing.
- Confirmed rejection, expiry or revocation still terminates authorization. A sufficiently long outage can expire the signed session token and require another login. First login still requires the server.
- The default endpoint is now `https://106.55.45.126/`. Tencent Cloud TCP 443 access is enabled. HTTPS on port 80 remains compatible with 1.4.6; HTTP administration redirects to standard HTTPS. Legacy HTTP client routes remain subject to the existing credential restrictions.

## Validation

- `npm test`: 142 passed, 0 failed.
- `npm run build`: passed; existing large-chunk advisory remains.
- `node tools/desktop-auth-qa.mjs`: isolated Electron identity fixture, encrypted credentials, API gate, transient outage, grace expiry, reconnection without login and explicit revocation passed. Desktop and 430px mobile screenshots inspected.
- `node tools/admin-qa.mjs`: desktop/mobile account-policy editing and persistence passed, along with existing account and announcement operations.
- `test/authorization-task-pause.test.js`: collection progress and current draft receipt survive an outage; resuming processes only the remaining product. This uses controlled publisher/collector fixtures, not a live seller submission.
- `auth-server/deploy/security-qa.sh`: both functional and security suites passed on isolated PostgreSQL databases on the production host. Temporary test databases were removed.
- `node tools/security-live-probe.mjs`: production health 1.4.7, valid TLS 1.3, HTTP admin redirect, rejected unauthenticated/forged admin requests, blocked private files, invalid-account/SQL-injection rejection and inaccessible ports 5432/8790 passed.
- Nginx configuration and HTTP/TLS legacy POST-body compatibility passed. Authorization service, Nginx and PostgreSQL are active; no new service error entries were reported after deployment.
- `certbot renew --dry-run`: simulated renewal succeeded with the deployed Nginx configuration (server log at 2026-09-12 01:25:02).
- `node tools/desktop-package-qa.mjs E:/workbench-build-1.4.7`: packaged version/source, Chromium, Electron security fuses, ASAR integrity configuration, login-window launch and unauthenticated API rejection passed.

## Deployment And Artifact

The additive migration adds `licenses.offline_grace_minutes`; existing expiry dates, credentials and device policies are unchanged.

- Service and database backup: `/var/backups/kua-yipu-auth-20260912011427`.
- Nginx backup: `/var/backups/kua-yipu-compatible-tls-20260912011430`.
- Installer: `E:/workbench-build-1.4.7/chaodekuai-1.4.7-setup.exe`.
- Size: 266868596 bytes.
- SHA-256: `3befaefc62b26d94a43ca9f4355439f7314d29c0018d291af00192f870a5fb91`.

The NSIS installer was built and its packaged application was launched in an isolated profile. The installed customer application was not overwritten during QA. No commercial Authenticode certificate is configured; this installer remains unsigned. These checks do not establish that the application or server cannot be compromised.
