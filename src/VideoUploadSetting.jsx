import { useEffect, useRef, useState } from 'react';

export default function VideoUploadSetting({ settings, request, refresh, notify }) {
  const [enabled, setEnabled] = useState(settings.uploadProductVideos !== false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => { setEnabled(settings.uploadProductVideos !== false); }, [settings.uploadProductVideos]);
  async function change(next) {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const result = await request('/api/settings', { method: 'PATCH', body: JSON.stringify({ uploadProductVideos: next }) });
      setEnabled(result.uploadProductVideos !== false);
      await refresh();
      notify(next ? '已开启上传商品视频' : '已关闭上传商品视频，后续商品将跳过视频');
    } catch (error) { notify(error.message, 'error'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <section className="panel settings-panel">
    <div className="section-title"><div><h2>商品视频</h2><p>开关自动保存，重新打开软件后继续生效。</p></div></div>
    <div className="settings-form video-settings-form">
      <label className="switch-label"><input type="checkbox" role="switch" checked={enabled} disabled={busy}
        onChange={event => change(event.target.checked)} />上传商品视频（主图视频、详情视频）</label>
      <p className="batch-help">关闭后，发布时跳过视频下载、上传及关联等待，已采集的视频仍保留在商品中。对下一件开始处理的商品生效，正在处理的商品继续按原设置完成。</p>
      <p className="batch-help">开启后分别处理主图视频和详情视频。上传失败会停止提交当前商品；发布后若视频还在审核或等待关联，可从任务历史继续处理，无需重复上架。</p>
    </div>
  </section>;
}
