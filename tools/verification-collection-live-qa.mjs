import { app, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopCollector, normalizeShopUrl } from '../server/collector.js';
import { SellerPublisher } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { withVerificationContext } from '../server/human-verification.js';
import { showHumanVerification } from '../electron/human-verification.js';

// Run through live-desktop-qa.cjs with an isolated copy of the desktop key.
// Only read the customer's cookie export; write all QA data into a temp folder.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-collection-live-'));
const cookieFile = path.join(root, 'alibaba-cookies.json');
const partition = `verification-collection-${Date.now()}`;
const browserSession = session.fromPartition(partition);
const sourceFile = path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json');
const cookies = readPrivateSession(sourceFile);
writePrivateSession(cookieFile, cookies);
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
for (const cookie of cookies) {
  const domain = cookie.domain.replace(/^\./, '');
  if (!/(^|\.)(alibaba\.com|alicdn\.com)$/.test(domain)) continue;
  await browserSession.cookies.set({ ...cookie, url: `https://${domain}${cookie.path || '/'}` }).catch(() => {});
}
app.on('window-all-closed', () => {});
let lastMessage = '';
const report = { listed: 0, collected: [], windows: 0 };
const onWaiting = (message) => {
  if (message !== lastMessage) { console.log(message); lastMessage = message; }
};
globalThis.__KUA_YIPU_SELLER_BRIDGE = { humanVerification: (url, options) => showHumanVerification({
  url, partition, ...options,
  saveSession: async ({ webContents, readStorage }) => {
    writePrivateSession(cookieFile, await webContents.session.cookies.get({}));
    writePrivateSession(path.join(root, 'alibaba-storage.json'), { [new URL(webContents.getURL()).origin]: await readStorage() });
  },
  onCreated: ({ window }) => window.on('show', () => { report.windows++; console.log('验证码窗口已显示，请用户完成验证'); }),
}) };
const publisher = new SellerPublisher(root);
const collector = new ShopCollector(root, async (products, progress, options) => {
  report.listed = products.length;
  return publisher.enrichSourceProducts(products.slice(0, 2), progress, options);
});
try {
  const products = await withVerificationContext({ onWaiting }, () => collector.collectGroup(normalizeShopUrl(process.argv[2]), (event) => {
    if (event.stage === 'listing') console.log(`已读取第 ${event.page} 页，发现 ${event.found} 件`);
    if (event.product) {
      report.collected.push({ sourceId: event.product.sourceId, images: event.product.mainImages?.length || 0,
        attributes: event.product.attributes?.length || 0, warning: event.product.collectWarning || '' });
      console.log(`已采集 ${event.current}/${event.total} 件详情`);
    }
  }, { allPages: false, startPage: 1, endPage: 2, delaySeconds: 1 }));
  report.success = products.length === 2 && products.every((product) => !product.collectWarning);
  if (!report.success) process.exitCode = 1;
} catch (error) { report.error = error.message; report.code = error.code; process.exitCode = 1; }
finally {
  await publisher.shutdown(); await collector.resetContext();
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output: root }));
}
