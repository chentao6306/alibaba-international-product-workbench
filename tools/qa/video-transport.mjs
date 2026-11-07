// Read-only public-media probe; uses a fresh browser without seller cookies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { findChromium } from '../../server/browser-runtime.js';
import { SellerPublisher } from '../../server/publisher.js';

const root = process.env.QA_OUTPUT_DIR;
if (!root) throw new Error('QA_OUTPUT_DIR required');
fs.mkdirSync(root, { recursive: true });
const urls = JSON.parse(fs.readFileSync(process.env.QA_VIDEO_URLS_FILE));
const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--mute-audio'] });
const results = [];
try {
  const page = await browser.newPage();
  for (const url of urls) {
    if (process.env.QA_VIDEO_DOWNLOAD === '1') {
      const publisher = new SellerPublisher(root);
      const row = { url, productionDownload: true, startedAt: new Date().toISOString() }; results.push(row);
      try {
        row.file = await publisher.downloadProductVideo({ videoUrl: url, sourceUrl: 'https://www.alibaba.com/' }, page);
        row.bytes = fs.statSync(row.file).size;
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(row.file)) hash.update(chunk);
        row.sha256 = hash.digest('hex'); row.ok = row.bytes > 0;
      } catch (error) { row.error = error.message; }
      finally { await publisher.shutdown(); }
      row.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(root, 'production-video-download.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(row));
      continue;
    }
    const cdp = await page.context().newCDPSession(page);
    let handle;
    const row = { url, startedAt: new Date().toISOString() }; results.push(row);
    const timer = setTimeout(() => cdp.detach().catch(() => {}), 45000);
    try {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const { resource } = await cdp.send('Network.loadNetworkResource', { frameId: frameTree.frame.id, url,
        options: { disableCache: true, includeCredentials: false } });
      handle = resource.stream;
      row.status = resource.httpStatusCode; row.error = resource.netErrorName;
      if (!resource.success || !handle) throw new Error(resource.netErrorName || 'No network stream');
      const hash = crypto.createHash('sha256'); row.bytes = 0;
      for (;;) {
        const chunk = await cdp.send('IO.read', { handle, size: 256 * 1024 });
        const buffer = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
        if (!row.bytes) row.magic = buffer.subarray(0, 16).toString('hex');
        row.bytes += buffer.length;
        if (row.bytes > 100 * 1024 * 1024) throw new Error('Video exceeds 100 MiB');
        hash.update(buffer);
        if (chunk.eof) break;
      }
      row.sha256 = hash.digest('hex'); row.ok = row.bytes > 0;
    } catch (error) { row.error = error.message; }
    finally {
      clearTimeout(timer);
      if (handle) await cdp.send('IO.close', { handle }).catch(() => {});
      await cdp.detach().catch(() => {});
      row.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(root, 'public-video-stream-probe.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(row));
    }
  }
} finally { await browser.close(); }
