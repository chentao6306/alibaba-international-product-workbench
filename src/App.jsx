import { useEffect, useMemo, useState } from 'react';
import {
  Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, ClipboardList, CloudUpload,
  ExternalLink, Eye, FolderTree, LayoutDashboard, Link2, LoaderCircle, Menu, PackageCheck,
  Pause, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, Store, Trash2, X
} from 'lucide-react';
import * as XLSX from 'xlsx';

const EMPTY = { shops: [], groups: [], products: [], jobs: [], settings: {}, browser: {}, collectorBrowser: {} };

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}

const STATUS = {
  ready: ['待上架', 'neutral'], drafted: ['已存草稿', 'blue'], published: ['已发布', 'green'],
  needs_review: ['需确认', 'amber'], publish_failed: ['上架失败', 'red']
};

function StatusBadge({ status, message }) {
  const [label, tone] = STATUS[status] || [status || '未知', 'neutral'];
  return <span className={`status ${tone}`} title={message || ''}><span />{label}</span>;
}

function Notice({ notice, onClose }) {
  if (!notice) return null;
  return (
    <div className={`notice ${notice.type || ''}`} role="status">
      {notice.type === 'error' ? <CircleAlert size={18} /> : <CircleCheck size={18} />}
      <span>{notice.text}</span><button className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
    </div>
  );
}

function Header({ title, subtitle, onMenu }) {
  return (
    <header className="page-header">
      <button className="icon-button mobile-menu" onClick={onMenu} title="菜单"><Menu size={20} /></button>
      <div><h1>{title}</h1><p>{subtitle}</p></div>
    </header>
  );
}

function Metric({ icon: Icon, label, value, detail, tone }) {
  return <div className={`metric ${tone || ''}`}><Icon size={18} /><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}

function SourceView({ state, refresh, notify, onMenu }) {
  const [url, setUrl] = useState('');
  const [reading, setReading] = useState(false);
  const [collectConfig, setCollectConfig] = useState({ startPage: 1, endPage: 10, delaySeconds: 3, destinationCountry: 'United States', sort: 'default' });
  const [shopPage, setShopPage] = useState(1);
  const [expandedShops, setExpandedShops] = useState({});
  const [groupPages, setGroupPages] = useState({});
  const [selectedShops, setSelectedShops] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const shopPageSize = 4;
  const groupPageSize = 8;
  const shopPageCount = Math.max(1, Math.ceil(state.shops.length / shopPageSize));
  const visibleShops = state.shops.slice((shopPage - 1) * shopPageSize, shopPage * shopPageSize);
  const activeCollect = state.jobs.find((job) => job.type === 'collect' && ['queued', 'running', 'pause_requested', 'paused'].includes(job.status));

  useEffect(() => { if (shopPage > shopPageCount) setShopPage(shopPageCount); }, [shopPage, shopPageCount]);

  async function readGroups(event) {
    event.preventDefault();
    if (!url.trim()) return;
    setReading(true);
    try {
      await api('/api/shops/read-groups', { method: 'POST', body: JSON.stringify({ url }) });
      await refresh(); notify('店铺分组读取完成');
    } catch (error) { notify(error.message, 'error'); }
    finally { setReading(false); }
  }

  async function collect(group) {
    try {
      await api(`/api/groups/${group.id}/collect`, { method: 'POST', body: JSON.stringify(collectConfig) });
      await refresh(); notify(`已开始读取“${group.name}”`);
    } catch (error) { notify(error.message, 'error'); }
  }

  async function collectMany(groups) {
    if (!groups.length) return notify('请先选择分组', 'error');
    try {
      for (const group of groups) await api(`/api/groups/${group.id}/collect`, { method: 'POST', body: JSON.stringify(collectConfig) });
      await refresh(); notify(`已开始读取 ${groups.length} 个分组`);
    } catch (error) { notify(error.message, 'error'); }
  }

  async function openCollector() {
    try {
      await api('/api/collector/open', { method: 'POST', body: JSON.stringify({ url: url.trim() || undefined }) });
      await refresh(); notify('采集浏览器已打开，请在浏览器中完成国际站验证');
    } catch (error) { notify(error.message, 'error'); }
  }

  const toggleSelected = (setter, id, checked) => setter((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));

  async function deleteShop(shop) {
    const groupCount = state.groups.filter((group) => group.shopId === shop.id).length;
    const productCount = state.products.filter((product) => product.shopId === shop.id).length;
    if (!window.confirm(`确定删除店铺“${shop.name}”吗？\n将同时删除 ${groupCount} 个分组和 ${productCount} 件已采集商品。`)) return;
    try {
      await api(`/api/shops/${shop.id}`, { method: 'DELETE' });
      setSelectedShops((current) => current.filter((id) => id !== shop.id));
      await refresh(); notify('店铺及其关联分组、商品已删除');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function deleteSelectedShops() {
    const productCount = state.products.filter((product) => selectedShops.includes(product.shopId)).length;
    if (!selectedShops.length || !window.confirm(`确定删除已选择的 ${selectedShops.length} 个店铺吗？\n将同时删除这些店铺的分组和 ${productCount} 件商品。`)) return;
    try {
      await api('/api/shops/delete', { method: 'POST', body: JSON.stringify({ ids: selectedShops }) });
      setSelectedShops([]); setSelectedGroups([]); await refresh(); notify('已批量删除店铺及关联数据');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function deleteGroup(group) {
    const productCount = state.products.filter((product) => product.groupId === group.id).length;
    if (!window.confirm(`确定删除分组“${group.name}”吗？\n将同时删除该分组的 ${productCount} 件商品。`)) return;
    try {
      await api(`/api/groups/${group.id}`, { method: 'DELETE' });
      setSelectedGroups((current) => current.filter((id) => id !== group.id));
      await refresh(); notify('分组及其商品已删除');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function deleteSelectedGroups() {
    const productCount = state.products.filter((product) => selectedGroups.includes(product.groupId)).length;
    if (!selectedGroups.length || !window.confirm(`确定删除已选择的 ${selectedGroups.length} 个分组吗？\n将同时删除这些分组的 ${productCount} 件商品。`)) return;
    try {
      await api('/api/groups/delete', { method: 'POST', body: JSON.stringify({ ids: selectedGroups }) });
      setSelectedGroups([]); await refresh(); notify('已批量删除分组及关联商品');
    } catch (error) { notify(error.message, 'error'); }
  }

  return <>
    <Header title="店铺采集" subtitle="读取阿里巴巴国际站同行店铺与商品分组" onMenu={onMenu} />
    <div className="metrics">
      <Metric icon={Store} label="同行店铺" value={state.shops.length} detail="已读取" />
      <Metric icon={FolderTree} label="商品分组" value={state.groups.length} detail="可采集" tone="orange" />
      <Metric icon={Boxes} label="商品资料" value={state.products.length} detail="已入库" tone="teal" />
    </div>
    <section className="panel source-entry">
      <div className="section-title"><div><h2>读取国际站同行店铺</h2><p>支持 *.en.alibaba.com 店铺首页、商品列表和分组链接</p></div></div>
      <form className="url-form" onSubmit={readGroups}>
        <div className="input-with-icon"><Link2 size={18} /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴阿里巴巴国际站同行店铺链接" aria-label="国际站同行店铺链接" /></div>
        <button type="button" className="secondary-button" onClick={openCollector}><ExternalLink size={17} />打开采集浏览器</button>
        <button className="primary-button" disabled={reading}>{reading ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}读取分组</button>
      </form>
      <div className="collection-options">
        <div className="option-heading"><strong>采集参数</strong><small>先读取分组，再选择指定分组或全部分组开始采集</small></div>
        <label><span>起始页</span><input type="number" min="1" value={collectConfig.startPage} onChange={(event) => setCollectConfig((v) => ({ ...v, startPage: event.target.value }))} /></label>
        <label><span>结束页</span><input type="number" min="1" value={collectConfig.endPage} onChange={(event) => setCollectConfig((v) => ({ ...v, endPage: event.target.value }))} /></label>
        <label><span>采集间隔（秒/条）</span><input type="number" min="0" step="0.5" value={collectConfig.delaySeconds} onChange={(event) => setCollectConfig((v) => ({ ...v, delaySeconds: event.target.value }))} /></label>
        <label><span>交货地国家</span><select value={collectConfig.destinationCountry} onChange={(event) => setCollectConfig((v) => ({ ...v, destinationCountry: event.target.value }))}><option>United States</option><option>United Kingdom</option><option>Germany</option><option>Canada</option><option>Australia</option><option>Saudi Arabia</option><option>United Arab Emirates</option><option>全部国家</option></select></label>
        <label><span>排序</span><select value={collectConfig.sort} onChange={(event) => setCollectConfig((v) => ({ ...v, sort: event.target.value }))}><option value="default">默认排序</option><option value="priceAsc">价格从低到高</option><option value="priceDesc">价格从高到低</option><option value="newest">最新商品</option></select></label>
      </div>
    </section>
    {activeCollect && <div className="job-banner"><LoaderCircle className={activeCollect.status === 'paused' ? '' : 'spin'} size={18} /><div><strong>{activeCollect.message}</strong><div className="progress"><i style={{ width: activeCollect.total ? `${activeCollect.progress / activeCollect.total * 100}%` : '32%' }} /></div></div><div className="job-banner-actions">{['queued', 'running'].includes(activeCollect.status) && <button className="icon-button" onClick={() => api(`/api/jobs/${activeCollect.id}/pause`, { method: 'POST' }).then(refresh)} title="暂停采集"><Pause size={16} /></button>}{activeCollect.status === 'pause_requested' && <button className="icon-button" disabled title="正在暂停"><LoaderCircle className="spin" size={16} /></button>}{activeCollect.status === 'paused' && <button className="icon-button" onClick={() => api(`/api/jobs/${activeCollect.id}/resume`, { method: 'POST' }).then(refresh)} title="继续采集"><Play size={16} /></button>}</div></div>}
    <section className="panel shop-list">
      <div className="section-title"><div><h2>店铺与分组</h2><p>{state.groups.length ? '展开店铺后选择分组读取商品' : '读取店铺后，分组将显示在这里'}</p></div><div className="section-actions">{selectedGroups.length > 0 && <><button className="secondary-button" onClick={() => collectMany(state.groups.filter((group) => selectedGroups.includes(group.id)))}><RefreshCw size={15} />读取已选分组 {selectedGroups.length}</button><button className="secondary-button danger-button" onClick={deleteSelectedGroups}><Trash2 size={15} />删除分组 {selectedGroups.length}</button></>}{state.groups.length > 0 && <button className="secondary-button" onClick={() => collectMany(state.groups)}><RefreshCw size={15} />读取全部分组</button>}{selectedShops.length > 0 && <button className="secondary-button danger-button" onClick={deleteSelectedShops}><Trash2 size={15} />删除店铺 {selectedShops.length}</button>}</div></div>
      {!state.shops.length ? <EmptyState icon={Store} title="还没有同行店铺" text="输入店铺链接开始读取分组" /> : visibleShops.map((shop) => {
        const groups = state.groups.filter((group) => group.shopId === shop.id);
        const expanded = Boolean(expandedShops[shop.id]);
        const groupPageCount = Math.max(1, Math.ceil(groups.length / groupPageSize));
        const groupPage = Math.min(groupPages[shop.id] || 1, groupPageCount);
        const visibleGroups = groups.slice((groupPage - 1) * groupPageSize, groupPage * groupPageSize);
        return <div className="shop-block" key={shop.id}>
          <div className="shop-heading"><input type="checkbox" checked={selectedShops.includes(shop.id)} onChange={(event) => toggleSelected(setSelectedShops, shop.id, event.target.checked)} aria-label={`选择店铺 ${shop.name}`} /><div className="store-mark"><Store size={18} /></div><div className="shop-info"><strong>{shop.name}</strong><a href={shop.url} target="_blank" rel="noreferrer">{new URL(shop.url).hostname}<ExternalLink size={13} /></a></div><span>{groups.length} 个分组 · {state.products.filter((product) => product.shopId === shop.id).length} 件商品</span><button className="icon-button danger" onClick={() => deleteShop(shop)} title="删除店铺"><Trash2 size={16} /></button><button className="icon-button shop-toggle" onClick={() => setExpandedShops((current) => ({ ...current, [shop.id]: !expanded }))} title={expanded ? '收起分组' : '展开分组'}>{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button></div>
          {expanded && <div className="group-list">{visibleGroups.map((group) => <div className="group-row" key={group.id}>
            <input type="checkbox" checked={selectedGroups.includes(group.id)} onChange={(event) => toggleSelected(setSelectedGroups, group.id, event.target.checked)} aria-label={`选择分组 ${group.name}`} /><FolderTree size={18} /><div><strong>{group.name}</strong><small>{group.productCount != null ? `店铺显示 ${group.productCount} 件` : group.collectedCount ? `已读取 ${group.collectedCount} 件` : '等待读取'}</small></div>
            <span className={`group-state ${group.status}`}>{group.status === 'collecting' ? '读取中' : group.status === 'done' ? '已完成' : group.status === 'failed' ? '失败' : '未读取'}</span>
            <button className="secondary-button" disabled={group.status === 'collecting'} onClick={() => collect(group)}>{group.status === 'collecting' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{group.collectedCount ? '重新读取' : '读取商品'}</button>
            <button className="icon-button danger" disabled={group.status === 'collecting'} onClick={() => deleteGroup(group)} title="删除分组"><Trash2 size={16} /></button>
          </div>)}{groupPageCount > 1 && <Pagination page={groupPage} pageCount={groupPageCount} onPage={(next) => setGroupPages((current) => ({ ...current, [shop.id]: next }))} compact />}</div>}
        </div>;
      })}
      {state.shops.length > shopPageSize && <Pagination page={shopPage} pageCount={shopPageCount} onPage={setShopPage} label={`共 ${state.shops.length} 个店铺`} />}
    </section>
  </>;
}

function Pagination({ page, pageCount, onPage, label = '', compact = false }) {
  if (pageCount <= 1) return null;
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  const pages = Array.from({ length: Math.min(5, pageCount) }, (_, index) => start + index);
  return <div className={`pagination ${compact ? 'compact' : ''}`}><span>{label || `第 ${page}/${pageCount} 页`}</span><button className="icon-button" disabled={page === 1} onClick={() => onPage(page - 1)} title="上一页"><ChevronLeft size={16} /></button>{pages.map((item) => <button key={item} className={item === page ? 'active' : ''} onClick={() => onPage(item)}>{item}</button>)}<button className="icon-button" disabled={page === pageCount} onClick={() => onPage(page + 1)} title="下一页"><ChevronRight size={16} /></button></div>;
}

function EmptyState({ icon: Icon, title, text }) {
  return <div className="empty"><div><Icon size={24} /></div><strong>{title}</strong><span>{text}</span></div>;
}

function productCompleteness(product) {
  const main = (product.mainImages || product.images || []).length;
  const detail = (product.detailImages || []).length;
  const attributes = (product.attributes || []).length;
  const tiers = (product.priceTiers || []).length;
  const variants = (product.variantGroups || []).length;
  const missing = [];
  if (main < 4) missing.push('主图');
  if (!detail) missing.push('详情图');
  if (attributes < 2) missing.push('属性');
  if (!tiers) missing.push('阶梯价');
  if (!product.origin) missing.push('产地');
  if (!(Number(product.packaging?.weight) > 0)) missing.push('包装重量');
  if (!product.description && !product.descriptionHtml) missing.push('商品详情');
  const quality = product.quality;
  if (quality?.issues?.length) {
    const qualityMissing = quality.issues.filter((item) => item.severity === 'error').map((item) => item.message);
    return { main, detail, attributes, tiers, variants, skus: (product.skus || []).length, missing: qualityMissing, complete: quality.status !== 'blocked', score: quality.score, warnings: quality.warnings, issues: quality.issues };
  }
  const complete = missing.length === 0;
  return { main, detail, attributes, tiers, variants, skus: (product.skus || []).length, missing, complete, score: complete ? 100 : Math.max(0, 100 - missing.length * 12), warnings: 0, issues: [] };
}

function hasCategoryMismatch(product, category) {
  const text = `${product.title || ''} ${product.productType || ''} ${(product.sourceCategoryPath || []).join(' ')}`;
  if (/\b(phone|smartphone|mobile|tablet|pad)\b/i.test(text)
    && /商务服务|认证、检验|检验和质量控制|business service|inspection service/i.test(category || '')) return true;
  return /motor controllers?|brushless.*motor|电机控制器|无刷.*电机/i.test(text)
    && /消费电子|consumer electronics/i.test(category || '');
}

function ProductsView({ state, refresh, notify, onMenu }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState(null);
  const [batchEditing, setBatchEditing] = useState(false);
  const [refreshingId, setRefreshingId] = useState('');
  const products = useMemo(() => state.products.filter((product) => {
    const matchesQuery = !query || product.title?.toLowerCase().includes(query.toLowerCase()) || product.sourceId?.includes(query);
    const matchesFilter = filter === 'all' || (filter === 'selected' ? product.selected : filter === 'incomplete' ? !productCompleteness(product).complete : product.status === filter);
    return matchesQuery && matchesFilter;
  }), [state.products, query, filter]);
  const pageCount = Math.max(1, Math.ceil(products.length / pageSize));
  const pagedProducts = products.slice((page - 1) * pageSize, page * pageSize);
  const allChecked = pagedProducts.length > 0 && pagedProducts.every((item) => item.selected);
  const selectedProducts = state.products.filter((item) => item.selected);

  useEffect(() => { setPage(1); }, [query, filter, pageSize]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  async function select(ids, selected) {
    await api('/api/products/select', { method: 'POST', body: JSON.stringify({ ids, selected }) });
    refresh();
  }

  async function remove(product) {
    if (!window.confirm(`确定删除“${product.title}”吗？`)) return;
    try { await api(`/api/products/${product.id}`, { method: 'DELETE' }); await refresh(); notify('商品已删除'); }
    catch (error) { notify(error.message, 'error'); }
  }

  async function removeSelected() {
    if (!selectedProducts.length || !window.confirm(`确定删除已勾选的 ${selectedProducts.length} 件商品吗？\n删除后无法从本地工作台恢复。`)) return;
    try {
      await api('/api/products/delete', { method: 'POST', body: JSON.stringify({ ids: selectedProducts.map((item) => item.id) }) });
      await refresh(); notify(`已删除 ${selectedProducts.length} 件商品`);
    } catch (error) { notify(error.message, 'error'); }
  }


  async function refreshDetail(product) {
    setRefreshingId(product.id);
    try {
      await api(`/api/products/${product.id}/refresh-detail`, { method: 'POST' });
      await refresh();
      notify('商品详情、图片、属性、规格和价格已重新采集');
    } catch (error) { notify(error.message, 'error'); }
    finally { setRefreshingId(''); }
  }

  return <>
    <Header title="商品工作台" subtitle="检查、修改并选择待上架商品" onMenu={onMenu} />
    <div className="toolbar">
      <div className="input-with-icon search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或商品 ID" /></div>
      <div className="segmented">{[['all', '全部'], ['selected', '已选择'], ['incomplete', '资料待补'], ['ready', '待上架'], ['drafted', '已存草稿']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
      {selectedProducts.length > 0 && <button className="primary-button" onClick={() => setBatchEditing(true)}><Pencil size={15} />批量修改 {selectedProducts.length}</button>}
      {selectedProducts.length > 0 && <button className="secondary-button danger-button" onClick={removeSelected}><Trash2 size={15} />删除已勾选 {selectedProducts.length}</button>}
      <label className="page-size"><span>每页</span><select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label>
      <span className="result-count">共 {products.length} 件</span>
    </div>
    <section className="panel product-panel">
      {!state.products.length ? <EmptyState icon={Boxes} title="商品资料库为空" text="先到店铺采集页读取一个商品分组" /> : <div className="table-wrap"><table className="product-table">
        <thead><tr><th className="check-cell"><input type="checkbox" checked={allChecked} onChange={(event) => select(pagedProducts.map((item) => item.id), event.target.checked)} title="勾选本页商品" /></th><th>商品</th><th>资料</th><th>售价</th><th>库存</th><th>状态</th><th className="action-cell">操作</th></tr></thead>
        <tbody>{pagedProducts.map((product) => { const completeness = productCompleteness(product); return <tr key={product.id} className={product.selected ? 'selected-row' : ''}>
          <td className="check-cell"><input type="checkbox" checked={Boolean(product.selected)} onChange={(event) => select([product.id], event.target.checked)} /></td>
          <td><div className="product-main"><div className="thumb">{product.mainImage ? <img src={product.mainImage} alt="" /> : <Boxes size={20} />}</div><div><strong>{product.title || '未命名商品'}</strong><small>ID {product.sourceId}</small></div></div></td>
          <td><span className={`data-status ${completeness.complete ? 'complete' : ''}`} title={completeness.missing.length ? `阻断项：${completeness.missing.join('、')}` : '可进入发布检查'}>{completeness.complete ? `可发布 ${completeness.score}` : `资料阻断 ${completeness.score}`}</span><small className="data-counts">主 {completeness.main} · 详 {completeness.detail} · 属 {completeness.attributes} · SKU {completeness.skus} · 价 {completeness.tiers}</small>{completeness.warnings > 0 && <small className="data-warning">另有 {completeness.warnings} 项待确认</small>}{!completeness.complete && <small className="data-missing">{completeness.missing.join('；')}</small>}</td>
          <td><b className="price">{product.currencySymbol || '¥'}{product.price || '-'}</b></td><td>{product.stock ?? '-'}</td><td><StatusBadge status={product.status} message={product.publishResult?.message} /></td>
          <td className="action-cell"><button className="icon-button" disabled={refreshingId === product.id} onClick={() => refreshDetail(product)} title="重新采集完整资料">{refreshingId === product.id ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button><button className="icon-button" onClick={() => setEditing(product)} title="编辑完整资料"><Pencil size={17} /></button><button className="icon-button danger" onClick={() => remove(product)} title="删除商品"><Trash2 size={17} /></button></td>
        </tr>; })}</tbody>
      </table></div>}
      {products.length > pageSize && <Pagination page={page} pageCount={pageCount} onPage={setPage} label={`第 ${page}/${pageCount} 页 · 共 ${products.length} 件`} />}
    </section>
    {editing && <ProductEditor product={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); notify('商品修改已保存'); }} notify={notify} />}
    {batchEditing && <BatchEditor products={selectedProducts} onClose={() => setBatchEditing(false)} onSaved={() => { setBatchEditing(false); refresh(); notify('批量修改已应用'); }} notify={notify} />}
  </>;
}

function BatchEditor({ products, onClose, onSaved, notify }) {
  const [tab, setTab] = useState('basic');
  const [form, setForm] = useState({ titlePrefix: '', titleSuffix: '', subtitle: '', keywords: '', origin: '', brand: '', productType: '', category: '', categoryId: '', pricePercent: '0', priceFixed: '0', stock: '', moq: '', deliveryDays: '', weight: '', length: '', width: '', height: '', description: '', attrName: '', attrValue: '', attrMode: 'upsert', specName: '', specOption: '', specMode: 'upsert', skuPrice: '', skuStock: '', country: 'United States', countryPrice: '', imageAction: 'dedupe', skuRows: null });
  const tabs = [['basic', '基础信息'], ['category', '产品类目'], ['trade', '交易信息'], ['logistics', '物流信息'], ['description', '商品描述'], ['attributes', '商品属性'], ['custom', '自定义属性'], ['specs', '产品规格'], ['images', '产品图片'], ['detail', '详情描述'], ['service', '证书与服务'], ['regional', '国家/地区定价']];
  const update = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  function field(label, key, type = 'text', textarea = false) { return <label className="batch-field"><span>{label}</span>{textarea ? <textarea rows="4" value={form[key]} onChange={update(key)} /> : <input type={type} value={form[key]} onChange={update(key)} />}</label>; }
  function makePatch() {
    const patch = {};
    if (tab === 'basic') {
      if (form.titlePrefix || form.titleSuffix) patch.title = products.map((p) => `${form.titlePrefix}${p.title || ''}${form.titleSuffix}`);
      if (form.subtitle) patch.subtitle = form.subtitle;
      if (form.keywords) patch.keywords = form.keywords.split(/[,，\n]/).map((v) => v.trim()).filter(Boolean);
      if (form.origin) patch.origin = form.origin;
      if (form.brand) patch.brand = form.brand;
      if (form.productType) patch.productType = form.productType;
    } else if (tab === 'category') {
      if (form.category) patch.categoryPath = form.category.split(/\s*>>\s*/).map((v) => v.trim()).filter(Boolean);
      if (form.categoryId) patch.categoryId = form.categoryId.trim();
    } else if (tab === 'trade') {
      patch.priceTransform = { percent: Number(form.pricePercent || 0), fixed: Number(form.priceFixed || 0) };
      if (form.stock !== '') patch.stock = Number(form.stock);
      if (form.moq !== '') patch.moq = Number(form.moq);
      if (form.deliveryDays !== '') patch.deliveryTime = [['1', form.deliveryDays], ['999999', form.deliveryDays]];
      if (form.skuPrice !== '' || form.skuStock !== '') patch.skuTransform = { price: form.skuPrice === '' ? null : Number(form.skuPrice), stock: form.skuStock === '' ? null : Number(form.skuStock) };
      if (Array.isArray(form.skuRows) && form.skuRows.length) patch.skuRows = form.skuRows;
    } else if (tab === 'logistics') patch.packaging = { weight: form.weight === '' ? null : Number(form.weight), length: form.length === '' ? null : Number(form.length), width: form.width === '' ? null : Number(form.width), height: form.height === '' ? null : Number(form.height) };
    else if (tab === 'description' || tab === 'detail') patch.descriptionPrefix = form.description;
    else if (tab === 'attributes' || tab === 'custom') patch.attributeOperation = { target: tab === 'custom' ? 'customAttributes' : 'attributes', mode: form.attrMode, item: { name: form.attrName.trim(), value: form.attrValue.trim(), source: 'batch-edit' } };
    else if (tab === 'specs') patch.variantOperation = { mode: form.specMode, group: { name: form.specName.trim(), options: form.specOption.split(/[,，]/).map((v) => v.trim()).filter(Boolean), source: 'batch-edit' } };
    else if (tab === 'service') patch.services = { text: form.description };
    else if (tab === 'regional') patch.regionalPricing = { country: form.country, price: Number(form.countryPrice || 0) };
    else if (tab === 'images') patch.imageOperation = form.imageAction;
    return patch;
  }
  async function apply() {
    const patch = makePatch();
    if (!Object.keys(patch).length) return notify('请填写批量修改内容', 'error');
    try { await api('/api/products/batch-update', { method: 'POST', body: JSON.stringify({ ids: products.map((p) => p.id), patch }) }); onSaved(); }
    catch (error) { notify(error.message, 'error'); }
  }
  async function applyImage(action) {
    try { await api('/api/products/batch-update', { method: 'POST', body: JSON.stringify({ ids: products.map((p) => p.id), patch: { imageOperation: action } }) }); onSaved(); }
    catch (error) { notify(error.message, 'error'); }
  }
  function currentCategory(product) { return [...(product.categoryPath || product.sourceCategoryPath || [])].join(' >> ') || '未设置'; }
  function previewFor(product) {
    if (tab === 'category') return { current: currentCategory(product), next: form.category || '请选择新类目' };
    if (tab === 'basic') return { current: product.title || '未命名商品', next: `${form.titlePrefix || ''}${product.title || '未命名商品'}${form.titleSuffix || ''}` };
    if (tab === 'trade') return { current: `价格 ${product.price || '-'} · 库存 ${product.stock ?? '-'} · 起订 ${product.moq || '-'}`, next: `价格 ${(Number(product.price || 0) * (1 + Number(form.pricePercent || 0) / 100) + Number(form.priceFixed || 0)).toFixed(2)} · 库存 ${form.stock || product.stock || '-'} · 起订 ${form.moq || product.moq || '-'}` };
    if (tab === 'logistics') return { current: `重量 ${product.packaging?.weight || '-'}kg · ${product.packaging?.length || '-'}×${product.packaging?.width || '-'}×${product.packaging?.height || '-'}cm`, next: `重量 ${form.weight || product.packaging?.weight || '-'}kg · ${form.length || product.packaging?.length || '-'}×${form.width || product.packaging?.width || '-'}×${form.height || product.packaging?.height || '-'}cm` };
    if (tab === 'images') return { current: `主图 ${(product.mainImages || product.images || []).length} 张 · 详情图 ${(product.detailImages || []).length} 张`, next: form.imageAction === 'copy-detail' ? `主图 ${(product.mainImages || product.images || []).length} 张 · 详情图将复制主图` : '去重、排序并清理空地址' };
    if (tab === 'specs') return { current: (product.variantGroups || []).map((g) => `${g.name}: ${(g.options || []).join('/')}`).join('；') || '未设置规格', next: form.specName && form.specOption ? `${form.specName}: ${form.specOption}` : '等待填写新规格' };
    if (tab === 'attributes' || tab === 'custom') {
      const key = tab === 'custom' ? 'customAttributes' : 'attributes';
      const currentItems = product[key] || [];
      const current = currentItems.length ? currentItems.map((item) => `${item.name}: ${item.value}`).join('；') : '暂无属性';
      const next = form.attrName && form.attrValue ? `${form.attrMode === 'replace' ? '替换为' : form.attrMode === 'append' ? '追加' : '更新/新增'} ${form.attrName}: ${form.attrValue}` : '等待填写属性';
      return { current, next };
    }
    if (tab === 'specs') {
      const current = (product.variantGroups || []).map((group) => `${group.name}: ${(group.options || []).join('/')}`).join('；') || '暂无规格';
      const next = form.specName && form.specOption ? `${form.specMode === 'replace' ? '替换为' : form.specMode === 'append' ? '追加' : '更新/新增'} ${form.specName}: ${form.specOption}` : '等待填写规格';
      return { current, next };
    }
    if (tab === 'description' || tab === 'detail' || tab === 'service') return { current: (product.description || '').slice(0, 80) || '暂无内容', next: form.description || '等待填写内容' };
    if (tab === 'regional') return { current: product.regionalPricing ? JSON.stringify(product.regionalPricing) : '未设置', next: form.countryPrice ? `${form.country}: ${form.countryPrice}` : '等待填写地区价格' };
    return { current: '当前值', next: '等待填写修改值' };
  }
  function exportSku() {
    const rows = products.flatMap((p) => (p.skus || []).map((sku) => ({ product: p.title, ...(sku.attributes || {}), price: sku.price || '', stock: sku.stock ?? '' })));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'SKU');
    XLSX.writeFile(workbook, 'sku-export.xlsx');
  }
  function importSku(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const workbook = XLSX.read(reader.result, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        setForm((value) => ({ ...value, skuRows: XLSX.utils.sheet_to_json(sheet, { defval: '' }) }));
      } catch (error) { notify(`SKU 文件读取失败：${error.message}`, 'error'); }
      event.target.value = '';
    };
    reader.readAsArrayBuffer(file);
  }
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer batch-drawer">
    <div className="drawer-header"><div><span>批量修改</span><h2>已选择 {products.length} 件商品</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={20} /></button></div>
    <div className="batch-tabs">{tabs.map(([value, label]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div className="batch-body">
      {tab === 'basic' && <>{field('标题前缀', 'titlePrefix')}{field('标题后缀', 'titleSuffix')}{field('统一副标题', 'subtitle')}{field('关键词（逗号或换行分隔）', 'keywords', 'text', true)}{field('产地', 'origin')}{field('品牌', 'brand')}{field('产品类型', 'productType')}</>}
      {tab === 'category' && <><label className="batch-field"><span>新产品类目（使用 &gt;&gt; 分隔）</span><input value={form.category} onChange={update('category')} placeholder="Consumer Electronics >> Computer Hardware & Software >> Webcams" /></label>{field('国际站类目 ID', 'categoryId')}<div className="category-presets">{['Consumer Electronics >> Computer Hardware & Software >> Webcams', 'Consumer Electronics >> Mobile Phone & Radio >> Rugged phone', 'Power Transmission >> Motors >> Motor Controllers', 'Business Services >> Certification, Inspection & Credit Management >> Inspection & Quality Control Services'].map((category) => <button type="button" key={category} onClick={() => setForm((v) => ({ ...v, category }))}>{category}</button>)}</div></>}
      {tab === 'trade' && <>{field('价格调整比例（%）', 'pricePercent', 'number')}{field('统一加减金额', 'priceFixed', 'number')}{field('统一库存', 'stock', 'number')}{field('统一起订量', 'moq', 'number')}{field('统一交期（天）', 'deliveryDays', 'number')}{field('SKU统一价格', 'skuPrice', 'number')}{field('SKU统一库存', 'skuStock', 'number')}<div className="batch-actions"><button type="button" className="secondary-button" onClick={exportSku}>导出 SKU Excel</button><label className="file-button secondary-button">导入 SKU Excel<input type="file" accept=".xlsx,.xls,.csv,.txt" onChange={importSku} /></label></div></>}
      {tab === 'logistics' && <>{field('毛重（kg）', 'weight', 'number')}{field('包装长（cm）', 'length', 'number')}{field('包装宽（cm）', 'width', 'number')}{field('包装高（cm）', 'height', 'number')}</>}
      {(tab === 'description' || tab === 'detail' || tab === 'service') && field('批量追加内容', 'description', 'text', true)}
      {(tab === 'attributes' || tab === 'custom') && <><label className="batch-field"><span>修改方式</span><select value={form.attrMode} onChange={update('attrMode')}><option value="upsert">更新同名属性，不存在则新增</option><option value="append">追加属性</option><option value="replace">清空后只保留本属性</option></select></label>{field('属性名称', 'attrName')}{field('属性值', 'attrValue')}</>}
      {tab === 'specs' && <><label className="batch-field"><span>修改方式</span><select value={form.specMode} onChange={update('specMode')}><option value="upsert">更新同名规格，不存在则新增</option><option value="append">追加规格</option><option value="replace">清空后只保留本规格</option></select></label>{field('规格名称', 'specName')}{field('规格选项（逗号分隔）', 'specOption')}</>}
      {tab === 'images' && <><p className="batch-help">会对所有已选商品的主图和详情图执行批量处理，并保留原始图片地址。</p><button className="secondary-button" onClick={() => applyImage('dedupe')}>图片去重并排序</button><button className="secondary-button" onClick={() => applyImage('copy-detail')}>主图复制为详情图</button><button className="secondary-button" onClick={() => applyImage('clean')}>清理空图片</button></>}
      {tab === 'regional' && <>{field('国家/地区', 'country')}{field('该地区价格', 'countryPrice', 'number')}</>}
    </div>
    <div className="batch-preview"><div className="batch-preview-title"><strong>修改预览</strong><span>先确认每个商品的当前值和修改后值，再点击保存</span></div><div className="batch-preview-table"><div className="batch-preview-head"><span>商品名称</span><span>旧值-修改前</span><span>新值-修改后</span></div>{products.map((product) => { const row = previewFor(product); return <div className="batch-preview-row" key={product.id}><strong title={product.title}>{product.title || '未命名商品'}</strong><span title={row.current}>{row.current}</span><span className={row.next.includes('等待') || row.next.includes('请选择') ? 'pending' : ''} title={row.next}>{row.next}</span></div>; })}</div></div>
    <div className="drawer-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={apply}><Save size={17} />应用到 {products.length} 件商品</button></div>
  </aside></div>;
}

function ProductEditor({ product, onClose, onSaved, notify }) {
  const initialMainImages = product.mainImages || product.images || (product.mainImage ? [product.mainImage] : []);
  const initialMoq = String(product.moq || '').match(/\d[\d,]*/)?.[0]?.replace(/,/g, '')
    || product.priceTiers?.[0]?.minQuantity || 1;
  const [form, setForm] = useState({
    title: product.title || '', price: product.price || '', stock: product.stock ?? 100, moq: initialMoq,
    subtitle: product.subtitle || '', keywords: [...(product.keywords || [])], categoryPath: [...(product.categoryPath || product.sourceCategoryPath || [])], categoryId: product.categoryId || '',
    description: product.description || '', descriptionHtml: product.descriptionHtml || '', structuredDescription: product.structuredDescription || null,
    mainImages: [...initialMainImages], detailImages: [...(product.detailImages || [])],
    attributes: (product.attributes || []).map((item) => ({ ...item })),
    customAttributes: (product.customAttributes || []).map((item) => ({ ...item })),
    variantGroups: (product.variantGroups || []).map((group) => ({ ...group, options: [...(group.options || [])] })),
    skus: (product.skus || []).map((sku) => ({ ...sku, attributes: { ...(sku.attributes || {}) } })),
    priceTiers: (product.priceTiers || []).map((tier) => ({ ...tier })), packaging: { ...(product.packaging || {}) },
    origin: product.origin || '', model: product.model || '', brand: product.brand || '', productType: product.productType || '',
    salesUnit: product.salesUnit || 'Piece', paymentMethod: product.paymentMethod || '', priceMode: product.priceMode || 'quantity-tier',
    videoUrl: product.videoUrl || '', deliveryDays: String(product.deliveryTime?.[1]?.[1] || '').match(/\d+/)?.[0] || '7',
    freightTemplate: product.freightTemplate || '', services: product.services || {}, certificates: (product.certificates || []).map((item) => ({ ...item })),
    regionalPricing: product.regionalPricing || {}
  });
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('basic');
  const update = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  const updateArray = (key, index, value) => setForm((current) => ({ ...current, [key]: current[key].map((item, itemIndex) => itemIndex === index ? value : item) }));
  const removeArray = (key, index) => setForm((current) => ({ ...current, [key]: current[key].filter((_, itemIndex) => itemIndex !== index) }));
  async function save(event) {
    event.preventDefault(); setSaving(true);
    try {
      const mainImages = form.mainImages.map((url) => url.trim()).filter(Boolean);
      await api(`/api/products/${product.id}`, { method: 'PATCH', body: JSON.stringify({
        ...form, price: Number(form.price), stock: Number(form.stock), moq: Number(form.moq), mainImages,
        images: mainImages, mainImage: mainImages[0] || '', detailImages: form.detailImages.map((url) => url.trim()).filter(Boolean),
        deliveryTime: [['1', form.deliveryDays], ['999999', form.deliveryDays]]
      }) }); onSaved();
    } catch (error) { notify(error.message, 'error'); setSaving(false); }
  }
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer">
    <div className="drawer-header"><div><span>商品编辑</span><h2>{product.sourceId}</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={20} /></button></div>
    <form onSubmit={save} className="edit-form">
      <div className="editor-tabs">{[['basic', '基础信息'], ['media', '图片与视频'], ['attributes', '商品属性'], ['custom', '自定义属性'], ['specs', '规格与SKU'], ['trade', '交易信息'], ['logistics', '物流信息'], ['service', '服务与证书'], ['description', '商品描述'], ['regional', '国家/地区定价'], ['audit', '来源与审计']].map(([value, label]) => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className={`editor-tab-pane ${tab === 'basic' ? '' : 'hidden'}`}>
      <div className={`completeness-strip ${productCompleteness({ ...product, ...form, packaging: form.packaging }).complete ? 'complete' : ''}`}><CircleCheck size={17} /><span>主图 {form.mainImages.length} · 详情图 {form.detailImages.length} · 属性 {form.attributes.length} · 规格 {form.variantGroups.length} · 阶梯价 {form.priceTiers.length}</span></div>
      <h3 className="edit-section-title">基础信息</h3>
      <label><span>商品标题</span><textarea rows="3" value={form.title} onChange={update('title')} maxLength="120" required /><small>{form.title.length}/120</small></label>
      <label><span>副标题</span><input value={form.subtitle} onChange={update('subtitle')} maxLength="128" /></label>
      <label><span>商品关键词（逗号分隔）</span><textarea rows="3" value={form.keywords.join(', ')} onChange={(event) => setForm((value) => ({ ...value, keywords: event.target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) }))} /></label>
      <div className="form-grid"><label><span>目标类目路径</span><input value={form.categoryPath.join(' >> ')} onChange={(event) => setForm((value) => ({ ...value, categoryPath: event.target.value.split(/\s*>>\s*/).filter(Boolean) }))} /></label><label><span>目标类目 ID</span><input value={form.categoryId} onChange={update('categoryId')} /></label></div>
      <div className="form-grid"><label><span>基准销售价</span><div className="prefix-input"><b>{product.currencySymbol || '$'}</b><input type="number" min="0" step="0.01" value={form.price} onChange={update('price')} required /></div></label><label><span>默认库存</span><input type="number" min="0" value={form.stock} onChange={update('stock')} required /></label><label><span>起订量</span><input type="number" min="1" value={form.moq} onChange={update('moq')} required /></label><label><span>交期（天）</span><input type="number" min="1" value={form.deliveryDays} onChange={update('deliveryDays')} /></label></div>
      <label><span>商品详情</span><textarea rows="9" value={form.description} onChange={update('description')} placeholder="商品卖点、规格说明与采购信息" /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'media' ? '' : 'hidden'}`}>
      <h3 className="edit-section-title">主图与详情图</h3>
      <div className="media-grid">{form.mainImages.map((url, index) => <div className="media-row" key={`main-${index}`}><div className="mini-preview">{url ? <img src={url} alt="" /> : <Boxes size={18} />}</div><input value={url} onChange={(event) => updateArray('mainImages', index, event.target.value)} aria-label={`主图 ${index + 1}`} /><button type="button" className="icon-button danger" onClick={() => removeArray('mainImages', index)} title="删除主图"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, mainImages: [...value.mainImages, ''] }))}><Plus size={15} />添加主图地址</button>
      <div className="media-grid">{form.detailImages.map((url, index) => <div className="media-row" key={`detail-${index}`}><div className="mini-preview">{url ? <img src={url} alt="" /> : <Boxes size={18} />}</div><input value={url} onChange={(event) => updateArray('detailImages', index, event.target.value)} aria-label={`详情图 ${index + 1}`} /><button type="button" className="icon-button danger" onClick={() => removeArray('detailImages', index)} title="删除详情图"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, detailImages: [...value.detailImages, ''] }))}><Plus size={15} />添加详情图地址</button>
      <label><span>商品视频地址</span><input value={form.videoUrl} onChange={update('videoUrl')} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'attributes' ? '' : 'hidden'}`}>
      <h3 className="edit-section-title">商品属性</h3>
      <div className="repeat-list">{form.attributes.map((item, index) => <div className="edit-data-row" key={`attr-${index}`}><input value={item.name || ''} onChange={(event) => updateArray('attributes', index, { ...item, name: event.target.value })} placeholder="属性名" /><input value={item.value || ''} onChange={(event) => updateArray('attributes', index, { ...item, value: event.target.value })} placeholder="属性值" /><button type="button" className="icon-button danger" onClick={() => removeArray('attributes', index)} title="删除属性"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, attributes: [...value.attributes, { name: '', value: '' }] }))}><Plus size={15} />添加属性</button>
      </div>
      <div className={`editor-tab-pane ${tab === 'custom' ? '' : 'hidden'}`}><h3 className="edit-section-title">自定义属性</h3><div className="repeat-list">{form.customAttributes.map((item, index) => <div className="edit-data-row" key={`custom-${index}`}><input value={item.name || ''} onChange={(event) => updateArray('customAttributes', index, { ...item, name: event.target.value })} placeholder="属性名" /><input value={item.value || ''} onChange={(event) => updateArray('customAttributes', index, { ...item, value: event.target.value })} placeholder="属性值" /><button type="button" className="icon-button danger" onClick={() => removeArray('customAttributes', index)} title="删除自定义属性"><X size={15} /></button></div>)}</div><button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, customAttributes: [...value.customAttributes, { name: '', value: '' }] }))}><Plus size={15} />添加自定义属性</button></div>
      <div className={`editor-tab-pane ${tab === 'specs' ? '' : 'hidden'}`}>
      <h3 className="edit-section-title">规格组合</h3>
      <div className="repeat-list">{form.variantGroups.map((group, index) => <div className="edit-data-row" key={`variant-${index}`}><input value={group.name || ''} onChange={(event) => updateArray('variantGroups', index, { ...group, name: event.target.value })} placeholder="规格名" /><input value={(group.options || []).join(', ')} onChange={(event) => updateArray('variantGroups', index, { ...group, options: event.target.value.split(/[,，]/).map((option) => option.trim()).filter(Boolean) })} placeholder="选项，用逗号分隔" /><button type="button" className="icon-button danger" onClick={() => removeArray('variantGroups', index)} title="删除规格"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, variantGroups: [...value.variantGroups, { name: '', options: [] }] }))}><Plus size={15} />添加规格</button>
      <h3 className="edit-section-title">SKU 明细</h3>
      {form.skus.some((sku) => sku.derived) && <div className="sku-warning"><CircleAlert size={16} />当前SKU由规格组合推导。请人工确认每行价格、库存、编码和图片后再发布。</div>}
      <div className="sku-table-wrap"><table className="sku-table"><thead><tr><th>规格组合</th><th>SKU编码</th><th>价格</th><th>库存</th><th>图片</th><th>来源</th><th /></tr></thead><tbody>{form.skus.map((sku, index) => <tr key={sku.id || index}><td>{Object.entries(sku.attributes || {}).map(([name, value]) => `${name}: ${value}`).join(' / ') || sku.name}</td><td><input value={sku.code || ''} onChange={(event) => updateArray('skus', index, { ...sku, code: event.target.value })} /></td><td><input type="number" min="0" step="0.01" value={sku.price || ''} onChange={(event) => updateArray('skus', index, { ...sku, price: event.target.value })} /></td><td><input type="number" min="0" value={sku.stock ?? ''} onChange={(event) => updateArray('skus', index, { ...sku, stock: Number(event.target.value) })} /></td><td><input value={sku.image || ''} onChange={(event) => updateArray('skus', index, { ...sku, image: event.target.value })} /></td><td><span className={`source-tag ${sku.derived ? 'derived' : ''}`}>{sku.derived ? '推导' : '来源'}</span></td><td><button type="button" className="icon-button danger" onClick={() => removeArray('skus', index)} title="删除SKU"><X size={15} /></button></td></tr>)}</tbody></table></div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, skus: [...value.skus, { id: `sku-${Date.now()}`, attributes: {}, code: '', price: value.price, stock: value.stock, image: '', derived: false, source: 'manual' }] }))}><Plus size={15} />添加SKU</button>
      </div>
      <div className={`editor-tab-pane ${tab === 'trade' ? '' : 'hidden'}`}>
      <h3 className="edit-section-title">阶梯价格</h3>
      <div className="tier-header"><span>起订量</span><span>结束量</span><span>单价 {product.currencySymbol || '$'}</span><i /></div>
      <div className="repeat-list">{form.priceTiers.map((tier, index) => <div className="tier-row" key={`tier-${index}`}><input type="number" min="1" value={tier.minQuantity || ''} onChange={(event) => updateArray('priceTiers', index, { ...tier, minQuantity: Number(event.target.value) })} /><input type="number" min="1" value={tier.maxQuantity ?? ''} placeholder="不限" onChange={(event) => updateArray('priceTiers', index, { ...tier, maxQuantity: event.target.value ? Number(event.target.value) : null })} /><input type="number" min="0" step="0.01" value={tier.price || ''} onChange={(event) => updateArray('priceTiers', index, { ...tier, price: event.target.value, currencySymbol: product.currencySymbol || '$' })} /><button type="button" className="icon-button danger" onClick={() => removeArray('priceTiers', index)} title="删除价格档"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, priceTiers: [...value.priceTiers, { minQuantity: 1, maxQuantity: null, price: value.price, currencySymbol: product.currencySymbol || '$' }] }))}><Plus size={15} />添加价格档</button>
      <div className="form-grid"><label><span>销售单位</span><input value={form.salesUnit || ''} onChange={update('salesUnit')} placeholder="Piece" /></label><label><span>付款方式</span><input value={form.paymentMethod || ''} onChange={update('paymentMethod')} /></label></div>
      <label><span>定价模式</span><select value={form.priceMode} onChange={update('priceMode')}><option value="quantity-tier">按数量阶梯价</option><option value="sku">按SKU定价</option><option value="fob-range">FOB区间价</option></select></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'logistics' ? '' : 'hidden'}`}>
      <h3 className="edit-section-title">产品与包装</h3>
      <div className="form-grid"><label><span>产品类型</span><input value={form.productType} onChange={update('productType')} /></label><label><span>品牌</span><input value={form.brand} onChange={update('brand')} /></label><label><span>型号</span><input value={form.model} onChange={update('model')} /></label><label><span>产地</span><input value={form.origin} onChange={update('origin')} /></label></div>
      <div className="form-grid packaging-grid">{[['length', '包装长 (cm)'], ['width', '包装宽 (cm)'], ['height', '包装高 (cm)'], ['weight', '包装重量 (kg)']].map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min="0" step="0.01" value={form.packaging[key] || ''} onChange={(event) => setForm((value) => ({ ...value, packaging: { ...value.packaging, [key]: event.target.value } }))} /></label>)}</div>
      <label><span>运费模板</span><input value={form.freightTemplate || ''} onChange={update('freightTemplate')} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'description' ? '' : 'hidden'}`}>
      <label><span>商品摘要</span><textarea rows="5" value={form.description} onChange={update('description')} /></label><label><span>普通富文本详情 HTML</span><textarea rows="14" value={form.descriptionHtml} onChange={update('descriptionHtml')} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'service' ? '' : 'hidden'}`}>
      <label><span>服务数据 JSON</span><textarea rows="8" value={JSON.stringify(form.services || {}, null, 2)} onChange={(event) => { try { setForm((value) => ({ ...value, services: JSON.parse(event.target.value || '{}') })); } catch {} }} /></label><div className="repeat-list">{form.certificates.map((item, index) => <div className="certificate-row" key={`certificate-${index}`}><input value={item.name || ''} placeholder="证书名称" onChange={(event) => updateArray('certificates', index, { ...item, name: event.target.value })} /><input value={item.number || ''} placeholder="证书编号" onChange={(event) => updateArray('certificates', index, { ...item, number: event.target.value })} /><select value={String(item.verified ?? '')} onChange={(event) => updateArray('certificates', index, { ...item, verified: event.target.value === '' ? null : event.target.value === 'true' })}><option value="">未核验</option><option value="true">已核验</option><option value="false">核验失败</option></select><button type="button" className="icon-button danger" onClick={() => removeArray('certificates', index)} title="删除证书"><X size={15} /></button></div>)}</div><button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, certificates: [...value.certificates, { name: '', number: '', verified: null, source: 'manual' }] }))}><Plus size={15} />添加证书</button>
      </div>
      <div className={`editor-tab-pane ${tab === 'regional' ? '' : 'hidden'}`}>
      <label><span>国家/地区价格 JSON</span><textarea rows="5" value={JSON.stringify(form.regionalPricing || {}, null, 2)} onChange={(event) => { try { setForm((value) => ({ ...value, regionalPricing: JSON.parse(event.target.value || '{}') })); } catch {} }} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'audit' ? '' : 'hidden'}`}><div className="audit-summary"><strong>质量分 {product.quality?.score ?? '-'}</strong><span>{product.quality?.errors || 0} 个阻断项 · {product.quality?.warnings || 0} 个待确认项</span></div><div className="issue-list">{(product.quality?.issues || []).map((item) => <div key={item.code} className={`issue-row ${item.severity}`}><span>{item.severity === 'error' ? '阻断' : item.severity === 'warning' ? '待确认' : '提示'}</span><strong>{item.message}</strong><code>{item.field}</code></div>)}</div><h3 className="edit-section-title">来源记录</h3><dl className="source-facts"><div><dt>平台</dt><dd>{product.source?.platform || 'alibaba.com'}</dd></div><div><dt>采集语言</dt><dd>{product.sourceLanguage || product.source?.language || '未记录'} · 请求环境 {product.sourceCaptureLocale || product.source?.captureLocale || '-'}</dd></div><div><dt>采集时间</dt><dd>{product.source?.capturedAt || '-'}</dd></div><div><dt>来源商品</dt><dd>{product.source?.productId || product.sourceId}</dd></div><div><dt>来源快照字段</dt><dd>{Object.keys(product.source?.snapshot || {}).length} 个，当前工作字段 {Object.keys(product.working || {}).length} 个</dd></div><div><dt>人工修改记录</dt><dd>{product.auditTrail?.length || 0} 次</dd></div><div><dt>发布快照</dt><dd>{product.publishHistory?.length || 0} 次</dd></div></dl><details className="source-details"><summary>查看来源快照与当前工作数据</summary><div className="source-json-grid"><div><strong>来源快照（只读）</strong><pre>{JSON.stringify(product.source?.snapshot || {}, null, 2)}</pre></div><div><strong>当前工作数据</strong><pre>{JSON.stringify(product.working || {}, null, 2)}</pre></div></div></details></div>
      <div className="source-strip"><ExternalLink size={15} /><a href={product.sourceUrl} target="_blank" rel="noreferrer">打开来源商品</a></div>
      <div className="drawer-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存修改</button></div>
    </form>
  </aside></div>;
}

function PublishView({ state, refresh, notify, onMenu }) {
  const selected = state.products.filter((item) => item.selected);
  const [mode, setMode] = useState(state.settings.publishMode || 'draft');
  const [busy, setBusy] = useState(false);
  const publishing = state.jobs.find((job) => job.type === 'publish' && ['queued', 'running', 'pause_requested'].includes(job.status));
  const pausedJob = state.jobs.find((job) => job.type === 'publish' && job.status === 'paused');
  const currentJob = publishing || pausedJob;
  const categoryMismatch = selected.some((product) => hasCategoryMismatch(product, state.settings.publishCategory));

  async function run(action, success) {
    setBusy(true);
    try { await action(); await refresh(); notify(success); } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (mode === 'submit' && !window.confirm(`将自动提交 ${selected.length} 件商品到阿里巴巴国际站，确定继续吗？`)) return;
    run(() => api('/api/publish', { method: 'POST', body: JSON.stringify({ ids: selected.map((item) => item.id), mode }) }), '批量上架任务已开始');
  }
  function pause(job) {
    run(() => api(`/api/jobs/${job.id}/pause`, { method: 'POST' }), '暂停请求已发送');
  }
  function resume(job) {
    run(() => api(`/api/jobs/${job.id}/resume`, { method: 'POST' }), '任务已继续执行');
  }
  return <>
    <Header title="上架任务" subtitle="连接 My Alibaba 并处理已选择商品" onMenu={onMenu} />
    <div className="publish-layout">
      <div className="publish-main">
        <section className="panel connection-panel"><div className="connection-top"><div className={`connection-icon ${state.browser.browserOpen ? 'online' : ''}`}><Store size={22} /></div><div><h2>阿里巴巴国际站卖家后台</h2><p>{state.browser.browserOpen ? 'My Alibaba 浏览器已打开' : '尚未打开登录浏览器'}</p></div><span className={`connection-dot ${state.browser.browserOpen ? 'online' : ''}`}>{state.browser.browserOpen ? '浏览器已连接' : '未连接'}</span></div>
          <div className="connection-actions"><button className="secondary-button" disabled={busy} onClick={() => run(() => api('/api/seller/open', { method: 'POST' }), '已打开 My Alibaba 登录浏览器')}><ExternalLink size={16} />打开 My Alibaba</button><button className="secondary-button" disabled={busy || !state.browser.browserOpen} onClick={() => run(() => api('/api/seller/bind-page', { method: 'POST' }), '国际站发布页已绑定')}><Link2 size={16} />绑定国际站发布页</button></div>
          <div className="bound-url"><span>发布页</span><code>{state.settings.publishPageUrl || '尚未绑定'}</code>{state.settings.publishPageUrl && <Check size={16} />}</div>
          {state.settings.publishCategory && <div className="bound-url category-row"><span>类目</span><code>{state.settings.publishCategory}</code>{!categoryMismatch && <Check size={16} />}</div>}
          {categoryMismatch && <div className="category-warning"><CircleAlert size={17} /><span>当前国际站发布类目与已选择商品不匹配，请先打开对应商品类目的发布表单并重新绑定</span></div>}
        </section>
        <section className="panel queue-panel"><div className="section-title"><div><h2>待上架商品</h2><p>来自商品工作台的勾选结果</p></div><strong className="queue-count">{selected.length} 件</strong></div>
          {!selected.length ? <EmptyState icon={PackageCheck} title="上架队列为空" text="到商品工作台勾选需要上架的商品" /> : <div className="queue-list">{selected.map((product) => <div className="queue-item" key={product.id}><div className="mini-thumb">{product.mainImage ? <img src={product.mainImage} alt="" /> : <Boxes size={18} />}</div><div><strong>{product.title}</strong><small>{product.publishResult?.message || `${product.currencySymbol || '¥'}${product.price} · 库存 ${product.stock}`}</small></div><StatusBadge status={product.status} message={product.publishResult?.message} /></div>)}</div>}
        </section>
      </div>
      <aside className="publish-side"><section className="panel launch-panel"><h2>执行方式</h2><div className="mode-picker"><button className={mode === 'draft' ? 'active' : ''} onClick={() => setMode('draft')}><ClipboardList size={18} /><span><strong>保存草稿</strong><small>逐条填充并保存</small></span>{mode === 'draft' && <Check size={17} />}</button><button className={mode === 'submit' ? 'active warning' : ''} onClick={() => setMode('submit')}><CloudUpload size={18} /><span><strong>直接提交</strong><small>填充后自动发布</small></span>{mode === 'submit' && <Check size={17} />}</button></div>
          <dl><div><dt>已选择</dt><dd>{selected.length} 件</dd></div><div><dt>发布页</dt><dd>{state.settings.publishPageUrl ? '已绑定' : '未绑定'}</dd></div><div><dt>执行模式</dt><dd>{mode === 'draft' ? '保存草稿' : '直接提交'}</dd></div></dl>
          {pausedJob
            ? <button className="primary-button publish-button" disabled={busy} onClick={() => resume(pausedJob)}><Play size={18} />继续处理剩余 {Math.max(0, pausedJob.total - pausedJob.progress)} 件</button>
            : <button className="primary-button publish-button" disabled={!selected.length || !state.settings.publishPageUrl || categoryMismatch || Boolean(publishing)} onClick={publish}>{publishing ? <LoaderCircle className="spin" size={18} /> : <CloudUpload size={18} />}{publishing ? '任务执行中' : `开始处理 ${selected.length} 件`}</button>}
          {publishing && <button className="secondary-button pause-button" disabled={busy || publishing.status === 'pause_requested'} onClick={() => pause(publishing)}><Pause size={17} />{publishing.status === 'pause_requested' ? '正在暂停' : '暂停任务'}</button>}
          {currentJob && <div className="compact-progress"><div><span>{currentJob.message}</span><b>{currentJob.progress}/{currentJob.total}</b></div><div className="progress"><i style={{ width: currentJob.total ? `${currentJob.progress / currentJob.total * 100}%` : '10%' }} /></div></div>}
        </section></aside>
    </div>
    <JobHistory jobs={state.jobs.filter((job) => job.type === 'publish')} refresh={refresh} notify={notify} />
  </>;
}

function JobHistory({ jobs, refresh, notify }) {
  async function control(job, action) {
    try {
      await api(`/api/jobs/${job.id}/${action}`, { method: 'POST' });
      await refresh();
      notify(action === 'pause' ? '暂停请求已发送' : '任务已继续执行');
    } catch (error) { notify(error.message, 'error'); }
  }
  return <section className="panel history-panel"><div className="section-title"><div><h2>最近任务</h2><p>上架执行结果与异常记录</p></div></div>{!jobs.length ? <div className="muted-row">暂无上架任务</div> : jobs.slice(0, 8).map((job) => <div className="history-row" key={job.id}><div className={`history-icon ${job.status}`}>{job.status === 'completed' ? <Check size={16} /> : job.status === 'failed' ? <CircleAlert size={16} /> : job.status === 'paused' ? <Pause size={16} /> : <LoaderCircle className="spin" size={16} />}</div><div><strong>{job.metadata.mode === 'submit' ? '批量直接发布' : '批量保存草稿'}</strong><small>{new Date(job.createdAt).toLocaleString('zh-CN')}</small></div><span>{job.message}</span><b>{job.progress}/{job.total || '-'}</b><div className="history-action">{['queued', 'running'].includes(job.status) && <button className="icon-button" onClick={() => control(job, 'pause')} title="暂停任务"><Pause size={16} /></button>}{job.status === 'pause_requested' && <button className="icon-button" disabled title="正在暂停"><LoaderCircle className="spin" size={16} /></button>}{job.status === 'paused' && <button className="icon-button" onClick={() => control(job, 'resume')} title="继续任务"><Play size={16} /></button>}</div></div>)}</section>;
}

function SettingsView({ state, refresh, notify, onMenu }) {
  const [form, setForm] = useState({ defaultStock: state.settings.defaultStock ?? 100, priceMarkup: state.settings.priceMarkup ?? 0 });
  async function save(event) {
    event.preventDefault();
    try { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ defaultStock: Number(form.defaultStock), priceMarkup: Number(form.priceMarkup) }) }); await refresh(); notify('默认规则已保存'); }
    catch (error) { notify(error.message, 'error'); }
  }
  return <><Header title="设置" subtitle="管理新采集商品的默认规则" onMenu={onMenu} /><section className="panel settings-panel"><div className="section-title"><div><h2>采集与定价</h2><p>仅应用于之后读取的新商品</p></div></div><form onSubmit={save} className="settings-form"><label><span>默认库存</span><input type="number" min="0" value={form.defaultStock} onChange={(event) => setForm({ ...form, defaultStock: event.target.value })} /></label><label><span>售价加价比例</span><div className="suffix-input"><input type="number" min="-99" step="0.1" value={form.priceMarkup} onChange={(event) => setForm({ ...form, priceMarkup: event.target.value })} /><b>%</b></div></label><button className="primary-button"><Save size={17} />保存规则</button></form></section><section className="panel security-panel"><div className="security-icon"><Eye size={20} /></div><div><h3>浏览器登录数据</h3><p>账号密码不写入商品数据库。My Alibaba 登录状态仅保存在本机独立浏览器目录中。</p></div></section></>;
}

const NAV = [
  { id: 'source', label: '店铺采集', icon: LayoutDashboard },
  { id: 'products', label: '商品工作台', icon: Boxes },
  { id: 'publish', label: '上架任务', icon: CloudUpload },
  { id: 'settings', label: '设置', icon: Settings }
];

export default function App() {
  const [state, setState] = useState(EMPTY);
  const [view, setView] = useState('source');
  const [notice, setNotice] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  async function refresh() { try { setState(await api('/api/state')); } catch (error) { setNotice({ text: error.message, type: 'error' }); } }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 2000); return () => clearInterval(timer); }, []);
  function notify(text, type = 'success') { setNotice({ text, type }); setTimeout(() => setNotice(null), 4200); }
  function navigate(id) { setView(id); setMenuOpen(false); }
  const props = { state, refresh, notify, onMenu: () => setMenuOpen(true) };
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}><div className="brand"><div><Boxes size={20} /></div><span><strong>Alibaba.com</strong><small>国际站商品工作台</small></span><button className="icon-button close-nav" onClick={() => setMenuOpen(false)}><X size={18} /></button></div><nav>{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={19} /><span>{label}</span>{id === 'products' && state.products.length > 0 && <b>{state.products.length}</b>}{id === 'publish' && state.products.some((item) => item.selected) && <b>{state.products.filter((item) => item.selected).length}</b>}<ChevronRight size={15} /></button>)}</nav><div className="sidebar-foot"><span className={`system-dot ${state.browser.browserOpen ? 'online' : ''}`} /><div><strong>本地服务</strong><small>{state.browser.browserOpen ? '卖家浏览器已连接' : '运行正常'}</small></div></div></aside>
    {menuOpen && <button className="nav-backdrop" onClick={() => setMenuOpen(false)} />}
    <main>{view === 'source' && <SourceView {...props} />}{view === 'products' && <ProductsView {...props} />}{view === 'publish' && <PublishView {...props} />}{view === 'settings' && <SettingsView {...props} />}</main>
    <Notice notice={notice} onClose={() => setNotice(null)} />
  </div>;
}
