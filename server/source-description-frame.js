import { readAlibabaAttributeRows } from './category-attributes.js';

export async function readSourceDescriptionFrame(page, { selector, waitForFrame = false, timeoutMs = 15000, verify } = {}) {
  let deadline = performance.now() + timeoutMs;
  let nextVerification = 0;
  let last = null;
  do {
    const frames = page.frames().filter((frame) => /\/descIframe\.html(?:[?#]|$)/i.test(frame.url()));
    for (const iframe of await page.locator(selector).all()) {
      const handle = await iframe.elementHandle().catch(() => null);
      try {
        const frame = await handle?.contentFrame().catch(() => null);
        if (frame && !frames.includes(frame)) frames.push(frame);
      } finally { await handle?.dispose().catch(() => {}); }
    }
    for (const frame of frames) {
      const result = await frame.evaluate(() => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const root = (document.querySelector('#detail_decorate_root') || document.body)?.cloneNode(true);
        if (!root) return null;
        root.querySelectorAll('script, style, link, noscript').forEach((node) => node.remove());
        const images = [...root.querySelectorAll('img')].map((image) => {
          const value = image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src') || '';
          let src = '';
          try { src = new URL(value, location.href).href; } catch {}
          if (!/^https?:\/\//i.test(src) || !/\/(?:kf|ibank|img)\/|\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(src)) return null;
          image.setAttribute('src', src);
          return { src, alt: clean(image.alt) };
        }).filter(Boolean);
        const videos = [...root.querySelectorAll('video')].flatMap((video) => {
          const value = video.getAttribute('src') || video.querySelector('source')?.getAttribute('src');
          if (!value) return [];
          let url = '';
          try { url = new URL(value, location.href).href; } catch {}
          if (!/^https?:\/\//i.test(url)) return [];
          video.setAttribute('src', url);
          return [{ role: 'detail', url, source: 'description-iframe' }];
        });
        return { html: root.innerHTML, text: clean(root.textContent), images, videos };
      }).catch(() => null);
      if (result) {
        result.attributes = await frame.evaluate(readAlibabaAttributeRows, { description: true }).catch(() => []);
        last = result;
      }
      if (result?.images.length || (result?.text.length > 120 && !/^(?:loading|加载中|正在加载)/i.test(result.text))) return result;
    }
    if (!frames.length && !waitForFrame) return null;
    if (performance.now() >= nextVerification) {
      const started = performance.now();
      await verify?.();
      deadline += performance.now() - started;
      nextVerification = performance.now() + 3000;
    }
    await page.waitForTimeout(300);
  } while (performance.now() < deadline);
  return last;
}
