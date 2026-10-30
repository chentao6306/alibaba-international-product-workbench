// Sequential, read-only verification of a recorded real publication batch.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const publication = process.env.QA_PUBLICATION_DIR, output = process.env.QA_READBACK_DIR;
assert.ok(publication && output && process.env.QA_EXPECTED_ACCOUNT && process.env.QA_DESKTOP_USER_DATA_DIR);
fs.mkdirSync(output, { recursive: true });
assert.equal(fs.existsSync(path.join(output, 'results.json')), false, 'Use a new directory to preserve previous evidence');
const ledger = JSON.parse(fs.readFileSync(path.join(publication, 'ledger.json')));
const selected = ledger.filter(row => row.mode === 'submit' && row.result?.status === 'published');
assert.ok(selected.length);
const results = [];
for (const row of selected) {
  const directory = path.join(output, row.sourceId);
  fs.mkdirSync(directory, { recursive: true });
  const fd = fs.openSync(path.join(directory, 'readback.log'), 'w');
  const startedAt = new Date().toISOString();
  console.log(`READ ${row.sourceId} ${row.publishedId}`);
  const child = spawn(process.execPath, ['node_modules/electron/cli.js', 'tools/live-desktop-qa.cjs', 'tools/published-readback-live-qa.mjs'], {
    windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env,
      QA_LEDGER_DIR: directory, QA_SOURCE_ID: row.sourceId, QA_REPORT_FILE: path.join(publication, 'ledger.json'),
      QA_WORKSPACE_FILE: path.join(publication, 'workspace/workspace.json'), QA_VERIFY_WATERMARK_PIXELS: process.env.QA_VERIFY_WATERMARK_PIXELS ?? '1',
    },
  });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  fs.closeSync(fd);
  const resultFile = path.join(directory, `${row.sourceId}-published-readback.json`);
  const detail = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : { error: 'Readback did not produce a report' };
  const result = { sourceId: row.sourceId, publishedId: row.publishedId, startedAt, exitCode,
    status: exitCode === 0 && detail.ok ? 'passed' : detail.code === 'PUBLISH_REVIEW_PENDING' ? 'review-pending' : 'failed',
    error: detail.error, watermarkedImages: detail.watermarkPixels?.length, resultFile };
  results.push(result);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(result));
}
if (results.some(row => row.status !== 'passed')) process.exitCode = 1;
