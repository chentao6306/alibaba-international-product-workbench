import { localFetch } from './local-api.js';
import CollectionFolderDelete from './CollectionFolderDelete.jsx';
import { createContext, useContext, useState } from 'react';
import { FolderTree, Plus, Pencil, Trash2, X, Save } from 'lucide-react';

async function request(url, method, body) {
  const response = await localFetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '分组操作失败');
  return data;
}

export const FolderOperationContext = createContext(() => {});

export default function CollectionFolders({ state, folderId, refresh, notify }) {
  const setWorkspaceBusy = useContext(FolderOperationContext);
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const folders = state.collectionFolders || [];
  const current = folders.find((item) => item.id === folderId);
  async function run(action) {
    setBusy(true); setWorkspaceBusy(true);
    try { await action(); await refresh(); return true; }
    catch (error) { notify(error.message, 'error'); return false; }
    finally { setBusy(false); setWorkspaceBusy(false); }
  }
  function edit(folder = {}) { setEditing(folder); setName(folder.name || ''); }
  async function save(event) {
    event.preventDefault();
    if (await run(() => request(`/api/collection-folders${editing.id ? `/${editing.id}` : ''}`, editing.id ? 'PATCH' : 'POST', { name }))) setEditing(null);
  }
  async function remove() {
    if (current) setDeleting(current);
  }
  return <>
    {deleting && <CollectionFolderDelete key={deleting.id} folder={deleting} onClose={() => setDeleting(null)} {...{ refresh, notify, setWorkspaceBusy }} />}
    <div className="collection-folder-bar"><FolderTree size={18} /><label><span>采集分组</span><select aria-label="采集分组" value={folderId} disabled={busy} onChange={(event) => run(() => request(`/api/collection-folders/${event.target.value}/select`, 'POST'))}><option value="" disabled>请新建采集分组</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}（{state.products.filter((product) => product.collectionFolderId === folder.id).length}）</option>)}</select></label><button type="button" className="icon-button" title="新建采集分组" disabled={busy} onClick={() => edit()}><Plus size={18} /></button><button type="button" className="icon-button" title="重命名采集分组" disabled={busy || !current} onClick={() => edit(current)}><Pencil size={17} /></button><button type="button" className="icon-button danger" title="删除空分组" disabled={busy || !current} onClick={remove}><Trash2 size={17} /></button></div>
    {editing && <div className="dialog-backdrop"><form className="app-dialog folder-dialog" role="dialog" aria-modal="true" aria-label={editing.id ? '重命名采集分组' : '新建采集分组'} onSubmit={save}><div className="dialog-heading"><h2>{editing.id ? '重命名采集分组' : '新建采集分组'}</h2><button type="button" className="icon-button" title="关闭" disabled={busy} onClick={() => setEditing(null)}><X size={18} /></button></div><label>分组名称<input aria-label="分组名称" autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><div className="dialog-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="primary-button" disabled={busy || !name.trim()}><Save size={16} />保存</button></div></form></div>}
  </>;
}
