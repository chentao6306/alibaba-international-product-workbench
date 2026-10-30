import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const application = process.env.QA_PACKAGED_APPLICATION;
const archive = path.join(application, 'resources', 'app.asar');
const require = createRequire(import.meta.url);
require('bytenode');
require(path.join(archive, 'electron/protected-loader.jsc'))(archive);
const { publishJobMessage } = await import(pathToFileURL(path.join(archive, 'server/publish-progress.js')));
const { runWithProgressTimeout } = await import(pathToFileURL(path.join(archive, 'server/progress-timeout.js')));
const metadata = JSON.parse(fs.readFileSync(path.join(archive, 'package.json')));
let signal, stopped = false;
const result = {
  version: metadata.version,
  waitingMessage: publishJobMessage({ type: 'publish', status: 'running', progress: 2, total: 6,
    metadata: { mode: 'draft' }, message: '正在处理 3/6：测试商品 - 等待人工验证，已保存的采集进度保留' }),
};
try {
  await runWithProgressTimeout((report, cancellation) => {
    signal = cancellation;
    report('上传主图');
    return new Promise(() => {});
  }, { timeoutMs: 50, onTimeout: () => { stopped = true; } });
} catch (error) {
  Object.assign(result, { timeoutCode: error.code, stopped, hasCancellationSignal: Boolean(signal), aborted: signal?.aborted });
}
fs.mkdirSync(process.env.QA_OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.QA_OUTPUT_DIR, 'old-package-wait.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
