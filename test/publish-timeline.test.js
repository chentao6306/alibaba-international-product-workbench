import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublishTimeline } from '../server/publish-timeline.js';
import { createRuntimeDiagnostics } from '../server/runtime-diagnostics.js';

test('attempt timing separates waiting from work and keeps the failed stage without recording product text', () => {
  let ms = 100;
  const timeline = createPublishTimeline('publishing', { clock: () => ms });
  ms = 140; timeline.advance('正在填写商品属性');
  ms = 155; assert.equal(timeline.advance('正在填写原产地属性'), null);
  ms = 190; timeline.advance('verification', { waiting: true });
  ms = 5190; timeline.advance('attributes');
  ms = 5210;
  const result = timeline.snapshot('failed');
  assert.equal(result.totalMs, 5110);
  assert.deepEqual(result.entries.map(item => [item.durationMs, item.outcome]), [
    [40, 'completed'], [50, 'completed'], [5000, 'waiting'], [20, 'failed'],
  ]);
  assert.equal(result.entries.at(-1).stage, 'attributes');
  assert.equal(result.truncated, false);
  result.entries[0].stage = 'corrupted';
  assert.equal(timeline.snapshot().entries[0].stage, 'publishing');
  ms = 5220; timeline.advance('private seller title https://example.invalid/?secret=value');
  assert.equal(timeline.snapshot().entries.at(-1).stage, 'unknown');
  assert.doesNotMatch(JSON.stringify(timeline.snapshot()), /secret|private|example/);
});

test('many repeated progress events use bounded memory and preserve the initial and latest stages', () => {
  let ms = 0;
  const timeline = createPublishTimeline('publishing', { clock: () => ms });
  for (let i = 0; i < 20000; i++) { ms++; timeline.advance(i % 2 ? 'attributes' : 'specifications'); }
  const result = timeline.snapshot('completed');
  assert.equal(result.entries.length, 120);
  assert.equal(result.truncated, true);
  assert.equal(result.entries[0].stage, 'publishing');
  assert.equal(result.entries.at(-1).stage, 'attributes');
  assert.equal(result.entries.at(-1).outcome, 'completed');
  assert.equal(result.totalMs, 20000);
  assert.ok(JSON.stringify(result).length < 15000);
});

test('timings remain finite and nonnegative if the clock moves backwards or reports invalid values', () => {
  let ms = 100;
  const timeline = createPublishTimeline('publishing', { clock: () => ms });
  ms = 300; timeline.advance('images');
  for (const value of [0, NaN, Infinity]) {
    ms = value;
    assert.equal(timeline.snapshot().totalMs, 200);
    assert.equal(timeline.snapshot().entries.at(-1).durationMs, 0);
  }
  ms = 100 + 8 * 86400000;
  assert.equal(timeline.snapshot().totalMs, 7 * 86400000);
});

test('runtime performance records correlate attempts with safe modes and reject arbitrary values', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-timing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.log'), log = createRuntimeDiagnostics(file);
  const attemptId = '00000000-0000-4000-8000-000000000001';
  log('publish-stage-completed', { attemptId, mode: 'draft', processingMode: 'rules', stage: 'images', stageMs: 250.3 });
  log('publish-failed', { attemptId: 'private-token', mode: 'private-title', processingMode: 'api-key', stageMs: Infinity });
  const [valid, invalid] = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(valid.attemptId, attemptId);
  assert.equal(valid.mode, 'draft');
  assert.equal(valid.processingMode, 'rules');
  assert.equal(valid.stageMs, 250);
  assert.equal(invalid.attemptId, undefined);
  assert.equal(invalid.mode, undefined);
  assert.equal(invalid.processingMode, undefined);
  assert.equal(invalid.stageMs, undefined);
});
