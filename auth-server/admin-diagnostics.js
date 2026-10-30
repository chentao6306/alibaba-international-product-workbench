export function installDiagnosticViewer({ api, message }) {
  const $ = id => document.getElementById(id);
  let page = 1;
  let request = 0;
  let detailRequest = 0;
  let current = null;
  const clearDetail = () => { detailRequest += 1; current = null; $('diagnosticDetail').textContent = ''; $('diagnosticScreenshots').replaceChildren(); $('downloadDiagnostic').disabled = true; };
  async function show(id) {
    clearDetail();
    const revision = detailRequest;
    try {
      const data = await api(`/api/admin/diagnostics/${encodeURIComponent(id)}`);
      if (revision !== detailRequest) return;
      current = data;
      const text = { ...data, report: { ...data.report, failures: data.report.failures?.map(failure => ({ ...failure, screenshots: failure.screenshots?.map(({ label }) => ({ label })) })) } };
      $('diagnosticDetail').textContent = JSON.stringify(text, null, 2);
      for (const failure of data.report.failures || []) for (const shot of failure.screenshots || []) {
        const figure = document.createElement('figure');
        const caption = document.createElement('figcaption'); caption.textContent = `${failure.product?.title || ''} · ${failure.at} · ${shot.label}`;
        const img = document.createElement('img'); img.src = 'data:image/jpeg;base64,' + shot.data; img.alt = shot.label; img.style.maxWidth = '100%'; img.loading = 'lazy';
        figure.append(caption, img); $('diagnosticScreenshots').append(figure);
      }
      $('downloadDiagnostic').disabled = false;
    } catch (error) { if (revision === detailRequest) message(error.message); }
  }
  async function load() {
    const revision = ++request;
    clearDetail();
    $('diagnosticList').textContent = '正在读取…';
    try {
      const data = await api(`/api/admin/diagnostics?search=${encodeURIComponent($('diagnosticSearch').value.trim())}&page=${page}`);
      if (revision !== request) return;
      $('diagnosticList').replaceChildren();
      for (const item of data.items) {
        const row = document.createElement('p');
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'secondary'; button.textContent = item.id;
        button.onclick = () => show(item.id);
        row.append(button, document.createTextNode(` ${item.account} · ${item.appVersion} · ${new Date(item.receivedAt).toLocaleString('zh-CN')} · 失败 ${item.failedProducts} 件`));
        if (item.note) { const note = document.createElement('span'); note.textContent = ` — ${item.note}`; row.append(note); }
        $('diagnosticList').append(row);
      }
      if (!data.items.length) $('diagnosticList').textContent = '没有匹配的诊断报告';
      $('diagnosticPage').textContent = `共 ${data.total} 份 · 第 ${data.page} 页`;
      $('diagnosticPrevious').disabled = data.page <= 1;
      $('diagnosticNext').disabled = data.page * data.pageSize >= data.total;
    } catch (error) { if (revision === request) { $('diagnosticList').textContent = '读取失败，请重试'; message(error.message); } }
  }
  $('diagnosticQuery').onsubmit = event => { event.preventDefault(); page = 1; void load(); };
  $('diagnosticPrevious').onclick = () => { page = Math.max(1, page - 1); void load(); };
  $('diagnosticNext').onclick = () => { page += 1; void load(); };
  $('downloadDiagnostic').onclick = () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${current.id}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return { load, clear: () => { request += 1; clearDetail(); $('diagnosticList').replaceChildren(); $('diagnosticPage').textContent = ''; $('diagnosticSearch').value = ''; page = 1; } };
}
