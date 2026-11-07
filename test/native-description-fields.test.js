import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { compileNativeDescription, fillNativeDescriptionText, readNativeDescriptionFields, requireNativeDescriptionFields, requireNativeDescriptionAccepted } from '../server/native-description-fields.js';

test('normalizes native FAQ apostrophes without changing source facts, punctuation order or other languages', () => {
  const structure = { modules: [{ type: 'highlights', items: ['It’s light.'] }, { type: 'company', text: 'Supplier’s factory.' },
    { type: 'faq', items: [{ question: 'What’s available?', answer: 'It’s made in Bao’an. 中国。' }] }] };
  const original = structuredClone(structure);
  const plan = compileNativeDescription(structure, { textDesc: { maxLength: 2000 }, companyDesc: { maxLength: 2000 },
    companyFaqDesc: { maxItem: 10, questionLength: 100, answerLength: 1000 } });
  assert.equal(plan.textDesc, "It's light.");
  assert.equal(plan.companyDesc, "Supplier's factory.");
  assert.deepEqual(plan.companyFaqDesc, [{ question: "What's available?", answers: "It's made in Bao'an. 中国。" }]);
  assert.deepEqual(structure, original);
});

test('reports rejected native FAQ fields even when their values remain in the form model', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="companyFaqDesc"><div class="sell-error-message">请不要输入非数字、非英文、非空格字符: ’</div></div>');
    await assert.rejects(requireNativeDescriptionAccepted(page), error => {
      assert.equal(error.code, 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH');
      assert.equal(error.diagnostics.stage, 'field-validation');
      assert.match(error.message, /companyFaqDesc/);
      return true;
    });
    await page.locator('.sell-error-message').evaluate(node => { node.style.display = 'none'; });
    await requireNativeDescriptionAccepted(page);
  } finally { await browser.close(); }
});

test('rejects saved native gallery images that retain model values but fail the platform image requirements', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const id of ['detailImage', 'companyImage']) {
      await page.setContent(`<div id="${id}"><div class="image-gallery-error-container"><div class="image-gallery-error-item">
        <div class="sell-o-rich-text error"><div class="msg-text"><span>有1张图片尺寸不符合规范，尺寸需600*600以上，请重新上传</span><span>一键优化（预计消耗3豆）</span></div></div>
        </div></div></div>`);
      await assert.rejects(requireNativeDescriptionAccepted(page), error => {
        assert.equal(error.code, 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH');
        assert.equal(error.diagnostics.stage, 'field-validation');
        assert.match(error.message, new RegExp(id));
        assert.match(error.message, /600\*600/);
        assert.doesNotMatch(error.message, /消耗/);
        return true;
      });
      await fillNativeDescriptionText(page, { textDesc: '', companyDesc: '', companyFaqDesc: [], galleries: [] });
      await assert.rejects(requireNativeDescriptionAccepted(page), /600\*600/);
      await page.locator('.image-gallery-error-container').evaluate(node => { node.hidden = true; });
      await requireNativeDescriptionAccepted(page);
    }
  } finally { await browser.close(); }
});

test('waits for native FAQ question rerenders before entering answers and clears stale rows on retry', { skip: !findChromium(), timeout: 45000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="textDesc"><div contenteditable="true"></div></div><div id="companyDesc"><textarea data-real="true"></textarea></div>
      <div id="companyFaqDesc"><div class="company-faq-desc"><div id="rows"></div></div><button class="add-items">Add FAQ</button></div>
      <script>
      const state={textDesc:'',companyDesc:'',companyFaqDesc:[],detailImage:[],companyImage:[]};
      window.GlobalStore={engine:{getModels:()=>({formValues:state})}};
      const items=[{question:'Old question',answers:'Old answer'},{question:'Extra question',answers:'Extra answer'}];
      const update=()=>state.companyFaqDesc=items.filter(r=>r.question||r.answers).map(r=>({...r}));
      function render(){document.querySelector('#rows').innerHTML='';items.forEach((item,index)=>{
        const row=document.createElement('div');row.className='item';row.innerHTML='<div class="question"><input></div><div class="answers"><textarea data-real="true"></textarea></div>';
        const question=row.querySelector('input'),answer=row.querySelector('textarea');question.value=item.question;answer.value=item.answers;
        question.onchange=()=>{const value=question.value;setTimeout(()=>{items[index].question=value;update();render();},220);};
        answer.onchange=()=>{items[index].answers=answer.value;update();};document.querySelector('#rows').append(row);
      });}
      document.querySelector('.add-items').onclick=()=>{items.push({question:'',answers:''});render();};
      document.querySelector('#textDesc div').onblur=e=>state.textDesc=e.target.innerText;
      document.querySelector('#companyDesc textarea').onchange=e=>state.companyDesc=e.target.value;
      update();render();
      </script>`);
    const plan={textDesc:'Material: TPE.\nVented: Keeps cool.',companyDesc:'Founded in 2019.',companyFaqDesc:[{question:'Who are we?',answers:'A trading company.'},{question:'Quality?',answers:'Inspection.'},{question:'Services?',answers:'Parts.'}],galleries:[]};
    await fillNativeDescriptionText(page, plan);
    requireNativeDescriptionFields(plan, await readNativeDescriptionFields(page));
    const shorter={...plan,companyFaqDesc:[{question:'Manual question?',answers:'Manual answer.'}]};
    await fillNativeDescriptionText(page,shorter);
    requireNativeDescriptionFields(shorter,await readNativeDescriptionFields(page));
    assert.equal(await page.locator('.item').count(),3);
    assert.equal((await readNativeDescriptionFields(page)).companyFaqDesc.length,1);
  } finally { await browser.close(); }
});

test('rejects native images that completed in a different order or changed supplier scope', () => {
  const plan={textDesc:'A',companyDesc:'B',companyFaqDesc:[{question:'Q',answers:'A'}],galleries:[{rootId:'companyImage',value:'400',name:'Company overview',urls:['first','second']}]};
  const actual={textDesc:'A',companyDesc:'B',companyFaqDesc:plan.companyFaqDesc,detailImage:[],companyImage:[{value:'400',enName:'Company overview',imageList:[{imgURL:'first'},{imgURL:'second'}]}]};
  requireNativeDescriptionFields(plan,actual);
  const reordered=structuredClone(actual);reordered.companyImage[0].imageList.reverse();
  assert.throws(()=>requireNativeDescriptionFields(plan,reordered),/排列未保留/);
  const moved=structuredClone(actual);moved.detailImage=moved.companyImage;moved.companyImage=[];
  assert.throws(()=>requireNativeDescriptionFields(plan,moved),/分类或排列未保留/);
  const blank=structuredClone(actual);blank.companyFaqDesc[0].answers='';
  assert.throws(()=>requireNativeDescriptionFields(plan,blank),/FAQ/);
});

test('updates saved FAQ rows in place and removes surplus rows when blank edits restore saved values', { skip: !findChromium(), timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="companyFaqDesc"><div class="company-faq-desc"><div id="rows"></div></div><button class="add-items">Add FAQ</button></div>
      <script>
      const items=[{question:'Old Q1',answers:'Old A1'},{question:'Old Q2',answers:'Old A2'},{question:'Old Q3',answers:'Old A3'}];
      const state={textDesc:'',companyDesc:'',companyFaqDesc:[],detailImage:[],companyImage:[]};
      window.GlobalStore={engine:{getModels:()=>({formValues:state})}};
      window.counts={cleared:0,deleted:0};
      function render(){
        state.companyFaqDesc=items.filter(r=>r.question||r.answers).map(r=>({...r}));
        document.querySelector('#rows').innerHTML='';
        items.forEach((item,index)=>{
          const row=document.createElement('div');row.className='item';
          row.innerHTML='<div class="question"><input></div><div class="answers"><textarea data-real="true"></textarea></div><div class="faq-handle"><div class="handle-item"><i class="iconfont handle-drag">Drag</i><i class="iconfont">Delete</i></div></div>';
          for(const [selector,key] of [['input','question'],['textarea','answers']]){
            const input=row.querySelector(selector);input.value=item[key];
            input.onchange=()=>{const value=input.value;setTimeout(()=>{
              if(value)items[index][key]=value;else window.counts.cleared++;
              render();
            },200);};
          }
          row.querySelector('.iconfont:not(.handle-drag)').onclick=()=>{window.counts.deleted++;items.splice(index,1);setTimeout(render,200);};
          document.querySelector('#rows').append(row);
        });
      }
      document.querySelector('.add-items').onclick=()=>{items.push({question:'',answers:''});render();};
      render();
      </script>`);
    const plan = { textDesc: '', companyDesc: '', companyFaqDesc: [
      { question: 'Updated Q1?', answers: 'Updated A1.' }, { question: 'Updated Q2?', answers: 'Updated A2.' },
    ], galleries: [] };
    await fillNativeDescriptionText(page, plan);
    requireNativeDescriptionFields(plan, await readNativeDescriptionFields(page));
    assert.equal(await page.locator('.item').count(), 2);
    await fillNativeDescriptionText(page, plan);
    assert.deepEqual(await page.evaluate(() => window.counts), { cleared: 0, deleted: 1 });
    const empty = { ...plan, companyFaqDesc: [] };
    await fillNativeDescriptionText(page, empty);
    requireNativeDescriptionFields(empty, await readNativeDescriptionFields(page));
    assert.equal(await page.locator('.item').count(), 0);
    await fillNativeDescriptionText(page, plan);
    requireNativeDescriptionFields(plan, await readNativeDescriptionFields(page));
    assert.deepEqual(await page.evaluate(() => window.counts), { cleared: 0, deleted: 3 });
  } finally { await browser.close(); }
});
