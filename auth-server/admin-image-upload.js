export async function uploadAnnouncementImage(file, { token, fetchImpl = fetch }) {
  // Send a byte snapshot instead of a lazy file handle, which can become invalid
  // when the picker is cleared or another program changes the selected file.
  let bytes;
  try { bytes = await file.arrayBuffer(); }
  catch { throw Error('无法读取所选图片，请将图片保存到电脑本地后重新选择；已填写的公告内容已保留'); }
  if (!bytes.byteLength || bytes.byteLength !== file.size) throw Error('图片为空或已发生变化，请重新选择图片');
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchImpl('/api/admin/announcement-images', {
        method: 'POST', headers: { 'content-type': file.type, authorization: `Bearer ${token}` },
        body: bytes, signal: AbortSignal.timeout(60000),
      });
      break;
    } catch (error) {
      if (attempt === 0 && error.name !== 'TimeoutError' && error.name !== 'AbortError') continue;
      throw Error(error.name === 'TimeoutError' || error.name === 'AbortError'
        ? '图片上传超时，请检查网络后重试；已填写的公告内容已保留'
        : '图片上传连接中断，请重新选择图片重试；已填写的公告内容已保留');
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || (response.status === 413 ? '图片超过上传大小限制，请选择不超过 8 MB 的图片'
    : response.status === 401 ? '管理员登录已失效，请重新登录后上传图片'
      : `图片上传失败（HTTP ${response.status}），请稍后重试`));
  if (!/^\/api\/announcement-images\/[a-f0-9]{64}\.webp$/.test(data.src || '')) throw Error('上传服务返回的图片信息不完整，请重试');
  return data;
}
