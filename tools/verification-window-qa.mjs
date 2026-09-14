import { app, session } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-window-qa-'));
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
async function main() {
  await app.whenReady();
  const { showHumanVerification } = await import(process.argv[2]
    ? pathToFileURL(path.resolve(process.argv[2])).href : '../electron/human-verification.js');
  const watchdog = setTimeout(() => { console.error('Verification window QA timed out'); app.exit(1); }, 60000);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const partition = `verification-qa-${Date.now()}`;
  let phase = 'challenge';
  let loads = 0;
  await session.fromPartition(partition).protocol.handle('https', () => {
    loads++;
    return new Response(phase === 'challenge' ? '<div class="nc-container">请拖动下方滑块完成验证</div>'
      : phase === 'expired' ? '<div class="nc-container">请点我重试(error:FrgxUe)</div>'
        : phase === 'blank' ? '<body></body>'
          : phase === 'delayed' ? '<body><script>setTimeout(() => { document.body.innerHTML = \'<main data-module-name="module_description">Phone loaded</main>\'; }, 1500)</script></body>'
            : phase === 'late-challenge' ? '<body><script>setTimeout(() => { document.body.innerHTML = \'<div class="nc-container">请拖动下方滑块完成验证</div>\'; }, 1500)</script></body>'
            : '<main data-module-name="module_description">Real product page after verification</main><div class="baxia-container" style="height:300px"></div><div style="opacity:0"><div class="nc-container">请点我重试(error:FrgxUe)</div></div>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const until = async (check) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await pause(100); }
    throw new Error('QA state did not arrive');
  };
  let saved = 0;
  try {
    for (const normalPhase of ['ready', 'delayed', 'ready']) {
      phase = normalPhase;
      let shows = 0;
      await showHumanVerification({ url: 'https://www.alibaba.com/product-detail/qa.html', partition,
        saveSession: async () => { saved++; }, onCreated: ({ window }) => {
          assert.equal(window.isVisible(), false, 'Normal product must start hidden');
          window.on('show', () => { shows++; });
        } });
      assert.equal(shows, 0, 'Normal product must never show even briefly');
    }
    assert.equal(saved, 3);
    saved = 0;
    phase = 'blank';
    let hiddenShows = 0;
    const stoppedProbe = showHumanVerification({ url: 'https://www.alibaba.com/product-detail/qa.html', partition,
      saveSession: async () => { saved++; }, onCreated: ({ window }) => {
        window.on('show', () => { hiddenShows++; });
        window.close();
      } });
    await assert.rejects(stoppedProbe, (error) => error.code === 'COLLECT_PAUSED');
    assert.equal(hiddenShows, 0, 'Stopping a hidden probe must not reveal a normal page');
    assert.equal(saved, 0);
    phase = 'late-challenge';
    let active;
    let completed = false;
    const operation = showHumanVerification({ url: 'https://www.alibaba.com/product-detail/qa.html', partition,
      saveSession: async () => { saved++; }, onCreated: (value) => { active = value; } }).then(() => { completed = true; });
    await until(() => active && loads > 0);
    assert.equal(active.window.isVisible(), false, 'Loading a challenge URL alone must not show a window');
    await until(() => active.contents.executeJavaScript('Boolean(document.querySelector(".nc-container"))').catch(() => false));
    await until(() => active.window.isVisible());
    assert.equal(active.window.isVisible(), true);
    assert.equal(await active.contents.executeJavaScript('typeof window.verification'), 'undefined');
    assert.equal(await active.contents.executeJavaScript('typeof require'), 'undefined');
    active.window.close();
    assert.equal(active.window.isDestroyed(), false);
    const realNow = Date.now;
    Date.now = () => realNow() + 86400000;
    await pause(2200);
    assert.equal(completed, false);
    assert.equal(active.window.isVisible(), true);
    Date.now = realNow;
    phase = 'expired';
    await active.window.webContents.executeJavaScript('document.querySelector("#refresh").click()');
    await until(() => active.contents.executeJavaScript('document.body.innerText.includes("FrgxUe")').catch(() => false));
    await pause(2200);
    assert.equal(completed, false);
    assert.equal(saved, 0);
    await active.window.webContents.capturePage().then((image) => fs.writeFileSync(path.join(root, 'verification-toolbar.png'), image.toPNG()));
    const shell = await active.window.webContents.capturePage();
    const remote = await active.contents.capturePage();
    const [width] = active.window.getContentSize();
    const offset = Math.round(64 * shell.getSize().width / width);
    await sharp(shell.toPNG()).composite([{ input: remote.toPNG(), top: offset, left: 0 }]).toFile(path.join(root, 'verification-window.png'));
    active.window.setSize(640, 480);
    await pause(300);
    assert.equal(await active.window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
    phase = 'blank'; active.refresh();
    await pause(2300);
    assert.equal(completed, false);
    phase = 'ready'; active.refresh();
    await operation;
    assert.equal(saved, 1);
    phase = 'challenge'; active = null;
    const cancelled = showHumanVerification({ url: 'https://www.alibaba.com/product-detail/qa.html', partition,
      saveSession: async () => { saved++; }, onCreated: (value) => { active = value; } });
    const rejection = assert.rejects(cancelled, (error) => error.code === 'COLLECT_PAUSED');
    await until(() => active?.window.isVisible());
    await active.window.webContents.executeJavaScript('document.querySelector("#pause").click()');
    await rejection;
    assert.equal(saved, 1);
    console.log(JSON.stringify({ passed: true, loads, screenshot: path.join(root, 'verification-window.png') }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(watchdog); app.exit(process.exitCode || 0); }
}
main().catch((error) => { console.error(error); app.exit(1); });
