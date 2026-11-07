// Runs the same browser fixtures against a preserved build without editing it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const codeRoot = path.resolve(process.env.QA_CODE_ROOT || '.');
const output = process.env.QA_OUTPUT_DIR;
assert.ok(output);
fs.mkdirSync(output, { recursive: true });
const tests = ['main-image-recovery', 'origin-packaging', 'posting-interaction'];
// Keep normal node_modules resolution from this repository for the fixtures.
fs.mkdirSync('.data', { recursive: true });
const directory = fs.mkdtempSync(path.resolve('.data', 'version-recovery-'));
const files = tests.map(name => {
  const file = path.join(directory, `${name}.test.mjs`);
  let content = fs.readFileSync(`test/${name}.test.js`, 'utf8')
    .replace(/from '(\.\.\/server\/[^']+)'/g, (_, relative) => `from '${pathToFileURL(path.join(codeRoot, relative.slice(3))).href}'`);
  if (process.env.QA_IGNORE_PROGRESS_WORDING === '1') content = content.replace(/^\s*assert\.ok\(progress\.includes\([^\n]+\n/gm, '\n');
  fs.writeFileSync(file, content);
  return file;
});
const log = fs.openSync(path.join(output, 'regression.log'), 'wx');
let result;
try { result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
  ...(process.env.QA_TEST_NAME_PATTERN ? [`--test-name-pattern=${process.env.QA_TEST_NAME_PATTERN}`] : []), ...files], { stdio: ['ignore', log, log], windowsHide: true }); }
finally { fs.closeSync(log); }
const summary = { version: JSON.parse(fs.readFileSync(path.join(codeRoot, 'package.json'))).version,
  exitCode: result.status, error: result.error?.message, fixtures: tests, directory,
  ignoredProgressWording: process.env.QA_IGNORE_PROGRESS_WORDING === '1', pattern: process.env.QA_TEST_NAME_PATTERN };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exitCode = result.status || (result.error ? 1 : 0);
