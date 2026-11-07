export function parseRelease(data, origin) {
  if (!data?.release) return null;
  const release = data.release;
  const artifact = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(release.envelope.payload), (char) => char.charCodeAt(0))));
  const url = new URL(release.url, origin);
  if (url.origin !== origin || !/^\/updates\/chaodekuai\/files\/[a-zA-Z0-9.-]+\.exe$/.test(url.pathname)
    || url.search || url.hash || url.username || url.password || artifact.schema !== 1 || artifact.product !== 'com.kua-yipu.workbench'
    || artifact.platform !== 'win32' || artifact.arch !== 'x64' || !/^\d+\.\d+\.\d+$/.test(artifact.version)
    || artifact.filename !== `chaodekuai-${artifact.version}-setup.exe`
    || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) throw new Error('安装包信息无效');
  return { version: artifact.version, size: artifact.size, filename: artifact.filename,
    url: url.href, title: String(release.title || ''), notes: String(release.notes || ''), publishedAt: release.publishedAt };
}
