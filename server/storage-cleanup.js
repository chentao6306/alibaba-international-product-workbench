import fs from 'node:fs';
import path from 'node:path';

const SCOPES = ['products', 'images', 'videos', 'media'];

export function cleanupWorkspace(store, root, request = {}) {
  const scopes = [...new Set(Array.isArray(request.scopes) ? request.scopes : [])];
  if (request.confirm !== true || !scopes.length || scopes.some((scope) => !SCOPES.includes(scope))) {
    throw Object.assign(new Error('请选择清理内容并确认删除'), { status: 400 });
  }
  const state = store.read();
  if ((state.jobs || []).some((job) => ['queued', 'running', 'pause_requested', 'paused'].includes(job.status))) {
    throw Object.assign(new Error('存在运行或暂停中的任务，请完成或取消任务后再清理'), { status: 409 });
  }
  const rootPath = fs.realpathSync(root);
  const directories = { images: 'publish-images', videos: 'publish-videos', media: 'media' };
  const paths = scopes.filter((scope) => directories[scope]).map((scope) => path.resolve(rootPath, directories[scope]));
  // Refuse redirected directories before changing either workspace data or files.
  for (const target of paths) {
    if (path.dirname(target) !== rootPath || (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target))) {
      throw Object.assign(new Error('存储目录异常，无法清理'), { status: 409 });
    }
  }
  if (scopes.includes('media') && (state.descriptionTemplates || []).some(template => JSON.stringify(template).includes('/media/'))) {
    throw Object.assign(new Error('上传图片仍被详情模板引用，请先在模板管理中移除对应图片'), { status: 409 });
  }
  if (scopes.includes('media') && !scopes.includes('products') && state.products.some(product => JSON.stringify(product).includes('/media/'))) {
    throw Object.assign(new Error('上传图片仍被商品引用，请先删除对应商品或同时选择清理商品资料'), { status: 409 });
  }
  let products = 0;
  if (scopes.includes('products')) store.update((current) => {
    products = current.products.length;
    current.products = [];
    current.shops = [];
    current.groups = [];
    current.jobs = [];
  });
  for (const target of paths) {
    // Delete only entries in these fixed cache folders; never follow links.
    for (const entry of fs.existsSync(target) ? fs.readdirSync(target) : []) {
      fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    }
  }
  return { ok: true, scopes, products };
}
