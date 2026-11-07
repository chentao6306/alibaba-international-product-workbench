import assert from 'node:assert/strict';
import test from 'node:test';
import { publishRepairPlan, submitWithRepairs } from '../server/publish-recovery.js';

test('repairs images, specifications and logistics from the same validation response', async () => {
  const calls = [];
  const failures = [
    new Error('商品图片项必填项不能为空；错误项商品规格项1项；重量已填写 体积已填写 物流属性未填写'),
    Object.assign(new Error('产地必填项不能为空'), { requiredFields: ['产地'] }),
  ];
  const receipt = { verifiedBy: 'success-url' };
  const repairs = Object.fromEntries(['mainImages', 'specifications', 'logistics', 'attributes'].map((field) => [field, async () => {
    calls.push(field);
    return true;
  }]));
  const result = await submitWithRepairs({
    submit: async () => {
      calls.push('submit');
      if (failures.length) throw failures.shift();
      return receipt;
    },
    repairs,
  });
  assert.equal(result, receipt);
  assert.deepEqual(calls, ['submit', 'specifications', 'attributes', 'logistics', 'mainImages', 'submit', 'attributes', 'submit']);
});

test('image-only validation includes a real image repair instead of only filling specification text', () => {
  const plan = publishRepairPlan(new Error('错误项商品图片项1项；商品图片项必填项不能为空'));
  assert.ok(plan.includes('mainImages'));
  assert.ok(plan.includes('specifications'));
  assert.ok(!plan.includes('logistics'));
});

test('preserves recovery for generic Chinese and English required-image feedback', () => {
  for (const message of ['请上传图片', 'At least one image is required', '商品图片上传失败']) {
    assert.ok(publishRepairPlan(new Error(message)).includes('mainImages'));
  }
  assert.ok(publishRepairPlan(new Error('Required information is missing')).includes('attributes'));
});

test('never retries restrictions, quota limits or ambiguous publication receipts', async () => {
  for (const message of [
    '商品图片项必填项不能为空；疑似涉及禁限售，会造成风控违规问题',
    '国际站账号发布额度不足：您发布的产品总量已超出限制',
    '提交后未检测到国际站成功反馈',
    'Timeout 5000ms exceeded',
  ]) {
    const error = new Error(message);
    let submissions = 0;
    await assert.rejects(submitWithRepairs({
      submit: async () => { submissions += 1; throw error; },
      repairs: { mainImages: () => assert.fail('must not repair') },
    }), (result) => result === error);
    assert.equal(submissions, 1);
  }
});

test('bounds retries and preserves the latest platform error without reporting success', async () => {
  let submissions = 0;
  await assert.rejects(submitWithRepairs({
    submit: async () => { submissions += 1; throw new Error(`商品图片项必填项不能为空 ${submissions}`); },
    repairs: { mainImages: async () => true },
  }), /不能为空 3$/);
  assert.equal(submissions, 3);

  submissions = 0;
  await assert.rejects(submitWithRepairs({
    submit: async () => { submissions += 1; throw new Error('产地必填项不能为空'); },
    repairs: { attributes: async () => false },
  }), /产地/);
  assert.equal(submissions, 1);
});
