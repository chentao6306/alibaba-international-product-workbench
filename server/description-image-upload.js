import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Runs inside the seller page. Each file has its own Alibaba upload group:
// the plugin cancels an entire group when one image fails.
function editorUploadAction({ action, id, files, timeoutMs, maxAttempts, concurrency }) {
  const editors = [...new Set([...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])])];
  const editor = action === 'init'
    ? editors.find((item) => item && !item.hidden && item.plugins?.alipicpastedrag)
    : editors.find((item) => item?.__workbenchDetailUpload?.id === id);
  const plugin = editor?.plugins?.alipicpastedrag;
  if (!editor || !plugin?.insertAnchorImages || !plugin?.uploadFiles) return { unavailable: true };
  const body = editor.getBody();
  const sync = () => { editor.save(); editor.fire('input'); editor.fire('change'); };
  const remoteUrl = (value) => /^(?:https?:)?\/\//i.test(String(value || '')) && !/loading|progress|placeholder/i.test(value);
  const marker = 'data-workbench-detail-upload';
  const cancel = (item) => {
    const file = item.file;
    if (!file) return;
    const group = plugin.pendingGroup?.[file.groupId];
    // Remove the group first so late upload callbacks cannot insert old images.
    if (group) {
      delete plugin.pendingGroup[file.groupId];
      for (const xhr of group.photoBankXHRs || []) { try { xhr.abort(); } catch {} }
      try { plugin.uploader?.cancelUpload([file]); } catch {}
    }
  };
  if (action === 'init') {
    if (!body || editor.__workbenchDetailUpload) return { error: '详情编辑器未就绪或仍有图片上传任务' };
    const items = files.map((data, index) => {
      const bytes = Uint8Array.from(atob(data.data), (char) => char.charCodeAt(0));
      return { index, file: new File([bytes], data.name, { type: data.type }), status: 'pending', attempts: 0, code: '' };
    });
    if (plugin.checkFilesError?.(items.map((item) => item.file))) {
      return { error: '国际站编辑器拒绝详情图片，请检查图片格式、大小或剩余图片数量' };
    }
    const state = { id, items, originalError: plugin.showServerError };
    state.errorHandler = function (error, file) {
      const item = items.find((entry) => entry.file === file);
      if (item) {
        item.code = String(error?.errorCode || 'UNKNOWN_ERROR');
        item.message = String(error?.errorMsg || error?.message || '').slice(0, 300);
      }
      return state.originalError?.apply(this, arguments);
    };
    plugin.showServerError = state.errorHandler;
    editor.__workbenchDetailUpload = state;
    return { initialized: true };
  }
  const state = editor.__workbenchDetailUpload;
  if (action === 'cleanup' || action === 'finish') {
    for (const item of state.items) {
      cancel(item);
      if (item.status !== 'success') item.node?.remove();
    }
    if (action === 'finish' && state.items.every((item) => item.status === 'success')) {
      // Retries can finish out of order. Keep the source image sequence in
      // the saved description, including an image recovered after its peers.
      for (const item of state.items) {
        const paragraph = body.ownerDocument.createElement('p');
        paragraph.append(item.node);
        body.append(paragraph);
      }
    }
    for (const node of body.querySelectorAll(`[${marker}]`)) {
      if (node.getAttribute(marker).startsWith(`${id}-`)) node.removeAttribute(marker);
    }
    if (plugin.showServerError === state.errorHandler) plugin.showServerError = state.originalError;
    delete editor.__workbenchDetailUpload;
    sync();
    return { cleaned: true };
  }
  const now = Date.now();
  for (const item of state.items.filter((entry) => entry.status === 'uploading')) {
    const data = item.file.serverData;
    if (data && (data.success || data.failureReason === 'DUPLICATE') && remoteUrl(data.photobankUrl)) {
      // A render or stale cursor bookmark can remove the anchor while the
      // server accepts the file. Reinsert that confirmed URL, without reupload.
      let node = item.node?.isConnected ? item.node : body.querySelector(`[${marker}="${id}-${item.index}"]`);
      if (!node) {
        node = body.ownerDocument.createElement('img');
        const paragraph = body.ownerDocument.createElement('p');
        paragraph.append(node);
        body.append(paragraph);
      }
      node.setAttribute(marker, `${id}-${item.index}`);
      node.setAttribute('src', data.photobankUrl);
      node.removeAttribute('data-mce-src');
      node.removeAttribute('alt');
      node.style.maxWidth = '100%';
      node.style.height = 'auto';
      if (Number(data.width) > 0) node.setAttribute('width', String(data.width));
      if (Number(data.height) > 0) node.setAttribute('height', String(data.height));
      item.node = node;
      item.status = 'success';
      item.code = '';
      sync();
    } else if (item.code || (now - item.startedAt > 1000 && !plugin.pendingGroup?.[item.file.groupId]) || now - item.startedAt >= timeoutMs) {
      item.code ||= data?.failureReason || 'UPLOAD_TIMEOUT';
      cancel(item);
      item.node?.remove();
      item.status = 'failed';
      item.retryAt = now + 500 * item.attempts;
    }
  }
  const permanent = (code) => /noCapacity|capacity|quota|FILE_(?:SIZE|TYPE|FORMAT)|FORMAT_ERROR|IMAGE_(?:LENGTH|WIDTH)_EXCEED|UNAUTHORIZED|FORBIDDEN|login|csrf/i.test(code);
  for (const item of state.items) {
    if (item.status === 'failed' && !permanent(item.code) && item.attempts < maxAttempts && now >= item.retryAt) item.status = 'pending';
  }
  const fatal = state.items.find((item) => item.status === 'failed' && (permanent(item.code) || item.attempts >= maxAttempts));
  let active = state.items.filter((item) => item.status === 'uploading').length;
  if (!fatal) for (const item of state.items) {
    if (active >= concurrency) break;
    if (item.status !== 'pending') continue;
    item.attempts++;
    item.code = '';
    item.message = '';
    item.startedAt = now;
    // A fresh File/UUID keeps late callbacks from an aborted attempt separate.
    item.file = new File([item.file], item.file.name, { type: item.file.type });
    item.file.fileUUID = `${id}-${item.index}-${item.attempts}`;
    item.status = 'uploading';
    try {
      editor.focus();
      editor.selection.select(body, true);
      editor.selection.collapse(false);
      // The plugin reuses lastFocusBookmark. Clear it after moving to the end
      // so a bookmark from before setContent cannot override this cursor.
      editor.selection.lastFocusBookmark = null;
      plugin.insertAnchorImages([item.file]);
      item.node = body.querySelector(`img[alt="${item.file.fileUUID}"]`);
      if (!item.node) throw new Error('EDITOR_ANCHOR_MISSING');
      item.node.setAttribute(marker, `${id}-${item.index}`);
      plugin.uploadFiles([item.file]);
      active++;
    } catch (error) { item.code = error.message || 'EDITOR_UPLOAD_START_FAILED'; }
  }
  return {
    completed: state.items.filter((item) => item.status === 'success').length,
    attempts: state.items.map((item) => item.attempts),
    fatal: fatal ? { index: fatal.index, code: fatal.code, message: fatal.message || '' } : null
  };
}

export async function uploadEditorDetailImages(page, imagePaths, onProgress = () => {}, options = {}) {
  const id = `detail-${crypto.randomUUID()}`;
  const config = {
    id, timeoutMs: options.timeoutMs ?? 45000, maxAttempts: options.maxAttempts ?? 3,
    concurrency: 3
  };
  const files = await Promise.all(imagePaths.map(async (file) => ({
    name: path.basename(file), type: path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
    data: (await fs.readFile(file)).toString('base64')
  })));
  const initialized = await page.evaluate(editorUploadAction, { ...config, action: 'init', files });
  if (initialized.unavailable) return null;
  if (initialized.error) throw Object.assign(new Error(initialized.error), { code: 'DETAIL_IMAGE_UPLOAD_FAILED' });
  let completed = 0;
  let lastProgress = '';
  // Also bound the whole transaction if the editor or callbacks stop responding.
  const deadline = Date.now() + (config.timeoutMs + 3000) * config.maxAttempts * Math.ceil(files.length / config.concurrency);
  try {
    while (Date.now() < deadline) {
      const status = await page.evaluate(editorUploadAction, { ...config, action: 'tick' });
      if (status.unavailable) throw new Error('详情编辑器在上传期间被重新加载，请重试当前商品');
      completed = status.completed;
      const retries = status.attempts.filter((attempt) => attempt > 1).length;
      const progress = `上传详情图片 ${completed}/${files.length}${retries ? `（已重试 ${retries} 张）` : ''}`;
      if (progress !== lastProgress) { onProgress(progress); lastProgress = progress; }
      if (completed === files.length) {
        const finalized = await page.evaluate(editorUploadAction, { ...config, action: 'finish' });
        if (!finalized.cleaned) throw new Error('详情图片已上传，但编辑器内容未保存，请重试当前商品');
        return completed;
      }
      if (status.fatal) {
        const { index, code, message } = status.fatal;
        let failureCode = 'DETAIL_IMAGE_UPLOAD_FAILED';
        let reason = `第 ${index + 1} 张：${code}`;
        if (/^(?:noCapacity|CAPACITY_EXCEEDED|STORAGE_FULL|INSUFFICIENT_STORAGE)$/i.test(code)) {
          failureCode = 'PUBLISH_IMAGE_BANK_FULL';
          reason = '图片银行空间不足，任务已保留；请在国际站确认图片空间，处理后继续';
        } else if (/UNAUTHORIZED|login|csrf/i.test(code)) {
          failureCode = 'LOGIN_REQUIRED';
          reason = '图片上传授权失效，请重新登录国际站后继续';
        } else if (/capacity|quota|FORBIDDEN/i.test(code)) {
          // A request quota or permission limit is not proof of full storage.
          failureCode = 'PUBLISH_IMAGE_SERVICE_BLOCKED';
          reason = `图片上传服务受限（平台代码：${code}），请检查国际站提示后继续`;
        }
        throw Object.assign(new Error(`详情图片上传失败（完成 ${completed}/${files.length} 张）：${reason}`), {
          code: failureCode,
          diagnostics: { section: 'detail-images', completed, total: files.length, index, platformCode: code, platformMessage: message },
        });
      }
      await page.waitForTimeout(options.pollMs ?? 400);
    }
    throw new Error(`详情图片上传超时（完成 ${completed}/${files.length} 张），请检查网络后重试`);
  } catch (error) {
    error.code ||= 'DETAIL_IMAGE_UPLOAD_FAILED';
    throw error;
  } finally {
    await page.evaluate(editorUploadAction, { ...config, action: 'cleanup' }).catch(() => {});
  }
}
