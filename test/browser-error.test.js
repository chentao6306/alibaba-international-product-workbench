import test from 'node:test';
import assert from 'node:assert/strict';
import { userFacingError } from '../server/browser-error.js';
import { publishEnvironmentBlockCode, publishRepairPlan } from '../server/publish-recovery.js';

test('names the observed field on a paused interaction without displaying internal selectors', () => {
  const message = userFacingError(Object.assign(new Error('locator.click: intercepted'), {
    code: 'PUBLISH_CONTROL_OBSCURED', diagnostics: { target: { label: 'Fabric Treatment', className: 'next-menu' } },
  }));
  assert.match(message, /Fabric Treatment/);
  assert.doesNotMatch(message, /locator|next-menu/);
  const uncertain = userFacingError(Object.assign(new Error('locator.click: Timeout'), {
    code: 'PUBLISH_CONTROL_RESULT_UNKNOWN', diagnostics: { target: { label: '类型' } },
  }));
  assert.match(uncertain, /类型.*未重复点击/);
  assert.doesNotMatch(uncertain, /locator|Timeout/);
});

test('pauses technical browser failures without exposing call logs or repairing fields from selector text', () => {
  for (const text of [
    "locator.scrollIntoViewIfNeeded: Timeout 3000ms exceeded. Call log: waiting for locator('.image-uploader #image-placeholder-span')",
    "locator.fill: Timeout 30000ms exceeded. Call log: waiting for input[name='required']",
    'locator.hover: Element is not attached to the DOM',
    'locator.evaluate: Execution context was destroyed, most likely because of a navigation',
    'locator.count: Target page, context or browser has been closed',
    'locator.click: Error: strict mode violation: 2 elements',
  ]) {
    const error = new Error(text);
    assert.equal(publishEnvironmentBlockCode(error), 'PUBLISH_CONTROL_NOT_READY');
    assert.deepEqual(publishRepairPlan(error), []);
    assert.doesNotMatch(userFacingError(error), /locator\.|Call log:|Timeout|DOM|strict mode|弹窗遮罩/);
  }
  for (const text of ['属性[Type] 必须填写', '国际站主图上传失败：文件超过大小限制']) {
    assert.equal(userFacingError(new Error(text)), text);
    assert.equal(publishEnvironmentBlockCode(new Error(text)), '');
  }
});
