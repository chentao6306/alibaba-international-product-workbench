import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';

const root = process.env.QA_OUTPUT_DIR;
const publisher = new SellerPublisher(root);
try {
  const context = await publisher.sourceBrowser();
  const page = await context.newPage();
  const product = await publisher.readSourceProduct(page, { sourceId: '1600458114095', sourceUrl: process.env.QA_SOURCE_URL || 'https://germany.alibaba.com/product-detail/GaN-Charger-65W-2-ports-US_1600458114095.html' });
  const frames = [];
  for (const frame of page.frames()) {
    frames.push({ url: frame.url(), state: await frame.evaluate(() => ({
      title: document.title,
      bodyStart: document.body?.innerText?.slice(0, 250),
      roots: [...document.querySelectorAll('#detail_decorate_root, [data-module-name="module_description"], [data-module-name="module_structure_description"], [data-testid="module-description"], [data-testid="module-details-structure-description"], #J-rich-text-description')].map(node => ({ tag: node.tagName, id: node.id, module: node.getAttribute('data-module-name'), testid: node.getAttribute('data-testid'), text: node.innerText?.slice(0, 1000), html: node.innerHTML, images: [...node.querySelectorAll('img')].map(img => img.src) })),
    })).catch(error => ({ error: error.message })) });
  }
  fs.writeFileSync(path.join(root, 'source-frames.json'), JSON.stringify({ product, frames }, null, 2));
  console.log(JSON.stringify(frames.map(frame => ({ url: new URL(frame.url).origin + new URL(frame.url).pathname, title: frame.state.title, roots: frame.state.roots?.map(({ html, images, ...row }) => ({ ...row, length: html.length, images: images.length })) }))));
} finally { await publisher.shutdown(); }
