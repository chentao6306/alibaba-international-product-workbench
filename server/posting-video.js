import { load } from 'cheerio';
import { descriptionSourceHash } from './description-structure.js';

export function videoResourceKey(value) {
  try {
    const url = new URL(value);
    const id = /^(?:play|cloud)\.video\.alibaba\.com$/i.test(url.hostname) && url.pathname.match(/\/(\d+)\.mp4$/)?.[1];
    return id ? `alibaba-video:${id}` : url.href;
  } catch { return String(value || ''); }
}

export function productVideoUploads(product, { uploadProductVideos = true } = {}) {
  if (uploadProductVideos === false) return [];
  const videos = Array.isArray(product.videos) ? product.videos : [];
  const main = product.videoUrl || videos.find(video => video.role === 'main' && video.url)?.url;
  const result = main ? [{ role: 'main', url: main }] : [];
  const seen = new Set();
  for (const video of videos) {
    if (video.role !== 'detail' || !video.url) continue;
    const key = videoResourceKey(video.url);
    if (!seen.has(key)) { result.push({ ...video, role: 'detail' }); seen.add(key); }
  }
  return result;
}

// JSON-LD describes a product's video, not its display position. Prefer the
// observed gallery and never promote a known detail clip into the main slot.
export function resolveCollectedVideos(videos = []) {
  const observedMain = videos.find(video => video.role === 'main' && video.source !== 'json-ld' && video.url);
  const details = new Set(videos.filter(video => video.role === 'detail').map(video => videoResourceKey(video.url)));
  const resolved = videos.map(video => video.source === 'json-ld'
    ? { ...video, role: observedMain ? (videoResourceKey(observedMain.url) === videoResourceKey(video.url) ? 'main' : details.has(videoResourceKey(video.url)) ? 'detail' : 'unclassified')
      : details.has(videoResourceKey(video.url)) ? 'detail' : video.role }
    : video);
  return { videos: resolved, videoUrl: (observedMain || resolved.find(video => video.role === 'main'))?.url || '' };
}

export function requireSupportedVideoPlan(product, options = {}) {
  const planned = productVideoUploads(product, options);
  const details = planned.filter(video => video.role === 'detail');
  if (details.length > 1) {
    const warning = `当前商品有 ${details.length} 段详情视频，平台视频关联入口只支持一段；本次选择第一段，其他视频仍保留在来源资料中`;
    options.videoWarnings = [...(options.videoWarnings || []), warning];
    options.onProgress?.('详情视频超过平台限制，已选择第一段继续处理');
    // Keep the source product intact but submit only the capability supported
    // by the current platform form. The omitted source URLs remain persisted
    // for a later retry if Alibaba exposes additional detail-video slots.
    const selected = [...planned.filter(video => video.role !== 'detail'), details[0]];
    selected.warnings = [warning];
    return selected;
  }
  return planned;
}

const videoRecordKey = record => JSON.stringify([String(record.id || ''), record.url || '']);
const readyVideo = record => record.status == null || /^(?:success|done|ready|approved|complete|completed)$/i.test(String(record.status));

export function newlyAcceptedVideo(before, after) {
  if (after.pending) return null;
  const existing = new Set((before.records || []).map(videoRecordKey));
  return (after.records || []).find(record => (record.id || record.url) && readyVideo(record) && !existing.has(videoRecordKey(record))) || null;
}

export function requireAcceptedInlineVideo(state, expected) {
  if (state.pending || !state.records?.some(record => videoRecordKey(record) === videoRecordKey(expected) && readyVideo(record))) {
    throw Object.assign(new Error('主图视频在填写其他内容后未保留，已停止提交；请重试当前商品'), {
      code: 'PUBLISH_VIDEO_BINDING_LOST', diagnostics: { section: 'main-video', expected, actual: state.records || [] },
    });
  }
}

export function combineVideoAssociations(items) {
  if (!items.length) return null;
  // A later verified association supersedes its earlier pending warning.
  items = items.map(item => item.associated ? { ...item, warning: '' } : item);
  if (items.length === 1) return items[0];
  return { ...items[0], items, associated: items.every(item => item.associated),
    pendingPublication: items.some(item => item.pendingPublication),
    warning: items.map(item => item.warning).filter(Boolean).join('；') };
}

// Apply only to the transient publish copy. Collected media, original snapshots
// and editor data must survive switching video uploads off and back on.
export function productForVideoUpload(product, { uploadProductVideos = true } = {}) {
  if (uploadProductVideos !== false) return product;
  const withoutEmbeds = html => {
    if (!html) return html;
    const $ = load(html, null, false);
    $('video, source, track, iframe, embed, object').remove();
    return $.root().html() || '';
  };
  const descriptionHtml = withoutEmbeds(product.descriptionHtml);
  const saved = product.structuredDescription;
  // Removing video embeds is an internal publish transform, not a merchant
  // edit. Keep verified native module identities bound to the transformed
  // HTML; reparsing sanitized HTML can lose company gallery headings. Never
  // revalidate stale modules after the merchant has changed the description.
  const verifiedStructure = saved?.version === 1
    && saved.sourceHtmlHash === descriptionSourceHash(product.descriptionHtml || '');
  return { ...product, videoUrl: '', videos: [], descriptionHtml,
    ...(product.structuredDescription ? { structuredDescription: { ...product.structuredDescription,
      html: withoutEmbeds(product.structuredDescription.html), videos: [],
      ...(verifiedStructure ? { sourceHtmlHash: descriptionSourceHash(descriptionHtml || '') } : {}),
    } } : {}),
  };
}

// Chromium can reach media CDNs through the customer's browser network path
// even when Node's connection fails. Keep large videos in bounded stream chunks.
export async function browserVideoResponse(page, url, { signal } = {}) {
  signal?.throwIfAborted();
  const session = await page.context().newCDPSession(page);
  let handle;
  let disposing;
  const dispose = () => disposing ||= (async () => {
    signal?.removeEventListener('abort', aborted);
    if (handle) await session.send('IO.close', { handle }).catch(() => {});
    await session.detach().catch(() => {});
  })();
  const aborted = () => { void dispose(); };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    signal?.throwIfAborted();
    const { frameTree } = await session.send('Page.getFrameTree');
    const { resource } = await session.send('Network.loadNetworkResource', {
      frameId: frameTree.frame.id, url, options: { disableCache: true, includeCredentials: false },
    });
    handle = resource.stream;
    signal?.throwIfAborted();
    if (!resource.success || !handle) throw new Error(`商品视频浏览器下载失败（${resource.netErrorName || resource.httpStatusCode || '无数据流'}）`);
    const status = Number(resource.httpStatusCode || 0);
    return {
      ok: status >= 200 && status < 300, status, headers: new Headers(resource.headers || {}), dispose,
      body: (async function* () {
        try {
          for (;;) {
            signal?.throwIfAborted();
            const chunk = await session.send('IO.read', { handle, size: 256 * 1024 });
            signal?.throwIfAborted();
            if (chunk.data) yield Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
            if (chunk.eof) break;
          }
        } finally { await dispose(); }
      })(),
    };
  } catch (error) { await dispose(); throw error; }
}

// Read the real media model without enabling capabilities disabled by Alibaba.
export function readPostingVideoState() {
  const records = [];
  const configs = [];
  for (const node of document.querySelectorAll('.posting-field-media, [id="imageMedia"], .video-upload-placeholder')) {
    let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (props.mediaConfig?.video) configs.push(props.mediaConfig.video);
      const model = props.id === 'imageMedia' || props.name === 'imageMedia' ? props.value
        : props.id === 'scImages' || props.name === 'scImages' ? props.imageMediaValue : null;
      const values = Array.isArray(model) ? model : Array.isArray(model?.itemList) ? model.itemList : model ? [model] : [];
      for (const value of values) {
        if (typeof value !== 'object' || !value) continue;
        const type = value.type || value.mediaType;
        const video = value.videoId || value.video || /^video$/i.test(String(type)) || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(value.videoUrl || value.url || '');
        if (!video) continue;
        const id = value.videoId || value.id || value.video?.id;
        const url = value.videoUrl || value.url || value.video?.url;
        if ((id || url) && !records.some(row => row.id === id && row.url === url)) records.push({ id, url, status: value.status ?? value.mediaStatus, type });
      }
    }
  }
  const visible = node => Boolean(node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
  const previews = [...document.querySelectorAll('.posting-field-media video[src], .posting-field-media video source[src], .uploader-video-selected video[src]')]
    .filter(visible).map(node => node.src).filter(url => /^https?:\/\//i.test(url));
  const pending = [...document.querySelectorAll('.posting-field-media .uploading, .posting-field-media .loading, .uploader-video-uploading')].some(visible);
  return { available: configs.length ? configs.some(config => config.visible !== false) : null,
    config: configs[0] ? { visible: configs[0].visible, fileSizeLimit: configs[0].fileSizeLimit, durationLimit: configs[0].durationLimit, url: configs[0].url } : null,
    records, previews, pending, accepted: !pending && (records.some(record => record.status == null || /^(?:success|done|ready|approved|complete|completed)$/i.test(String(record.status))) || previews.length > 0) };
}

export function publicProductVideoUrl(product) {
  try {
    const url = new URL(product.videoUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password
      || /^(?:localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(url.hostname)) return '';
    return url.href;
  } catch { return ''; }
}

export function videoUnavailableError(state) {
  return Object.assign(new Error(state.available === false ? '当前账号或类目未开放主图视频关联功能' : '国际站主图视频入口尚未就绪'), {
    code: state.available === false ? 'PUBLISH_VIDEO_NOT_AVAILABLE' : 'PUBLISH_VIDEO_CONTROL_NOT_READY',
    diagnostics: { section: 'main-video', available: state.available, config: state.config },
  });
}
