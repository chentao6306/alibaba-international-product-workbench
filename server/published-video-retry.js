const conflict = message => Object.assign(new Error(message), { status: 409 });
const videoIdentity = video => JSON.stringify((video?.items || [video]).map(item => [item?.id, item?.role || 'main', item?.productId]));

export function registerPublishedVideoRetry(app, { store, publisher, sellerBusy }) {
  let busy = false;
  app.use('/api', (request, response, next) => {
    if (busy && (/^\/seller\//.test(request.path) || request.path === '/publish'
      || /^\/jobs\/[^/]+\/resume$/.test(request.path) || request.path === '/references/capture-current')) {
      return next(conflict('正在完成视频关联，请稍后进行上架操作'));
    }
    next();
  });
  app.post('/api/jobs/:id/video/:productId/retry', async (request, response, next) => {
    let acquired = false;
    let attemptedVideo, attemptedUrl;
    try {
      const state = store.read();
      const job = state.jobs.find(item => item.id === request.params.id && item.type === 'publish');
      const receipt = job?.results?.[request.params.productId];
      if (receipt?.status !== 'published' || !receipt.videoAssociation) throw conflict('没有找到已发布商品的视频回执');
      if (receipt.videoAssociation.associated) return response.json({ associated: true });
      if (state.settings?.uploadProductVideos === false) throw conflict('已关闭上传商品视频，请先在设置中开启后再处理视频');
      if (busy || sellerBusy() || state.jobs.some(item => item.type === 'publish'
        && ['queued', 'running', 'pause_requested', 'paused'].includes(item.status))) throw conflict('请先完成或取消当前上架任务，再处理视频');
      const video = structuredClone(receipt.videoAssociation);
      const url = new URL(receipt.url);
      if (url.origin !== 'https://post.alibaba.com' || url.searchParams.get('primaryId') !== video.productId
        || !/^\d+$/.test(String(video.productId)) || video.pendingPublication) throw conflict('发布回执与视频商品编号不一致');
      const videos = video.items === undefined ? [video] : video.items;
      if (!/^\d+$/.test(String(video.id)) || !Array.isArray(videos) || !videos.length
        || videos.some(item => !item || item.productId !== video.productId || item.pendingPublication || !/^\d+$/.test(String(item.id))
          || !['main', 'detail'].includes(item.role || 'main'))) throw conflict('视频列表与发布回执不一致');
      busy = true; acquired = true;
      attemptedVideo = video; attemptedUrl = receipt.url;
      const association = await publisher.retryPublishedVideo(video);
      if (!association?.associated || association.id !== video.id || association.productId !== video.productId) throw conflict('平台尚未确认视频关联');
      const associatedVideos = association.items === undefined ? [association] : association.items;
      if (!Array.isArray(associatedVideos) || !associatedVideos.length || !associatedVideos.every(item => item?.associated)
        || videoIdentity(association) !== videoIdentity(video)) throw conflict('平台尚未确认全部视频及展示位置');
      // Work only on the recorded publication; a recollection or newer listing
      // must never receive an old video's result. Archived products remain valid.
      store.update(draft => {
        const targetJob = draft.jobs.find(item => item.id === job.id);
        const target = targetJob?.results?.[request.params.productId];
        const update = result => {
          if (result?.status !== 'published' || result.url !== receipt.url || videoIdentity(result.videoAssociation) !== videoIdentity(video)) return;
          result.videoAssociation = { ...association, warning: '' };
          result.message = '已提交发布（视频已关联）';
          if (result.warnings) result.warnings = result.warnings.filter(text => text !== video.warning);
        };
        update(target);
        const product = draft.products.find(item => item.id === request.params.productId);
        update(product?.publishResult);
        for (const history of product?.publishHistory || []) update(history.result);
        if (targetJob) targetJob.updatedAt = new Date().toISOString();
      });
      response.json({ associated: true });
    } catch (error) {
      const partial = error?.videoAssociation;
      const items = partial?.items === undefined ? [partial] : partial.items;
      // A failed detail association can follow a verified main association.
      // Retain only an exact, complete identity match, without changing the
      // successful listing or applying stale results to a newer publication.
      if (acquired && error?.code === 'PUBLISH_VIDEO_BANK_PENDING' && partial?.associated === false
        && partial.id === attemptedVideo.id && partial.productId === attemptedVideo.productId
        && Array.isArray(items) && items.length && items.every(item => item && typeof item.associated === 'boolean')
        && items.some(item => !item.associated) && videoIdentity(partial) === videoIdentity(attemptedVideo)) {
        try {
          store.update(draft => {
            const update = result => {
              if (result?.status !== 'published' || result.url !== attemptedUrl
                || videoIdentity(result.videoAssociation) !== videoIdentity(attemptedVideo)
                || result.videoAssociation.associated) return;
              result.videoAssociation = { ...partial, lastAttemptAt: new Date().toISOString() };
              result.message = '已提交发布（视频待关联）';
            };
            const job = draft.jobs.find(item => item.id === request.params.id);
            update(job?.results?.[request.params.productId]);
            const product = draft.products.find(item => item.id === request.params.productId);
            update(product?.publishResult);
            for (const history of product?.publishHistory || []) update(history.result);
            if (job) job.updatedAt = new Date().toISOString();
          });
        } catch (saveError) { return next(saveError); }
      }
      next(error);
    }
    finally { if (acquired) busy = false; }
  });
  return { isBusy: () => busy };
}
