import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, ClipboardList, CloudUpload,
  ExternalLink, Eye, FolderTree, LayoutDashboard, Link2, LoaderCircle, Menu, PackageCheck,
  Pause, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, Store, Trash2, X
} from 'lucide-react';
import * as XLSX from 'xlsx';

const EMPTY = { shops: [], groups: [], products: [], jobs: [], settings: {}, browser: {}, collectorBrowser: {} };

const CATEGORY_OPTIONS = [
  { path: 'Consumer Electronics >> Camera, Photo & Accessories >> Drones Accessories', id: '201346401' },
  { path: 'Consumer Electronics >> Camera, Photo & Accessories >> Camera Accessories', id: '' },
  { path: 'Consumer Electronics >> Cables & Commonly Used Accessories >> Microphones', id: '' },
  { path: 'Consumer Electronics >> Mobile Phone & Radio >> Mobile Phones', id: '' },
  { path: 'Consumer Electronics >> Computer Hardware & Software >> Webcams', id: '' },
  { path: 'Power Transmission >> Motors >> Motor Controllers', id: '' },
  { path: 'Business Services >> Certification, Inspection & Credit Management >> Inspection & Quality Control Services', id: '' },
  { path: 'Other >> Other', id: '' }
];

function CategorySelect({ path, onChange, includeId = false }) {
  const value = path || '';
  const known = CATEGORY_OPTIONS.some((item) => item.path === value);
  const options = known || !value ? CATEGORY_OPTIONS : [{ path: value, id: '' }, ...CATEGORY_OPTIONS];
  return <>
    <select value={known ? value : ''} onChange={(event) => { const option = CATEGORY_OPTIONS.find((item) => item.path === event.target.value); onChange(option || { path: '', id: '' }); }}>
      <option value="">请选择 Alibaba 类目</option>
      {options.map((item) => <option key={item.path} value={item.path}>{item.path}{includeId && item.id ? `（ID ${item.id}）` : ''}</option>)}
    </select>
    {!known && value && <small className="batch-help">当前类目来自已采集/已绑定数据，可保留或重新选择内置类目。</small>}
  </>;
}

function displayError(message, status) {
  const text = String(message || '');
  if (/browserType\.launchPersistentContext|Target page, context or browser has been closed|user data directory is already in use|browser has been closed/i.test(text)) {
    return '采集浏览器启动失败，请先关闭已打开的采集浏览器后重试';
  }
  if (text.length > 240 || /--disable-|component-extensions|AutomationControlled|ipc-flooding|no-sandbox/i.test(text)) {
    return '读取分组失败，请稍后重试；需要验证码时系统会自动显示验证页面';
  }
  return text || `操作失败（${status || 500}）`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(displayError(data.error, response.status));
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
  const desktopSession = typeof window !== 'undefined' ? window.kuaYipu : null;
  const [session, setSession] = useState(null);
  useEffect(() => { desktopSession?.session?.().then(setSession).catch(() => {}); }, []);
  return (
    <header className="page-header">
      <button className="icon-button mobile-menu" onClick={onMenu} title="菜单"><Menu size={20} /></button>
      <div><h1>{title}</h1><p>{subtitle}</p></div>
      {session && <div className="account-summary"><strong>{session.username}</strong><span>授权至 {new Date(session.expiresAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span></div>}
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
  const collectJobs = state.jobs.filter((job) => job.type === 'collect' && ['queued', 'running', 'pause_requested', 'paused'].includes(job.status));

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

  const toggleSelected = (setter, id, checked) => setter((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));

  async function deleteShop(shop) {
    const groupCount = state.groups.filter((group) => group.shopId === shop.id).length;
    const productCount = state.products.filter((product) => product.shopId === shop.id).length;
    if (!window.confirm(`确定删除店铺“${shop.name}”吗？\n将同时删除 ${groupCount} 个分组和 ${productCount} 件已采集商品；关联的已暂停任务会自动取消。`)) return;
    try {
      await api(`/api/shops/${shop.id}`, { method: 'DELETE' });
      setSelectedShops((current) => current.filter((id) => id !== shop.id));
      await refresh(); notify('店铺及其关联分组、商品已删除');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function deleteSelectedShops() {
    const productCount = state.products.filter((product) => selectedShops.includes(product.shopId)).length;
    if (!selectedShops.length || !window.confirm(`确定删除已选择的 ${selectedShops.length} 个店铺吗？\n将同时删除这些店铺的分组和 ${productCount} 件商品；关联的已暂停任务会自动取消。`)) return;
    try {
      await api('/api/shops/delete', { method: 'POST', body: JSON.stringify({ ids: selectedShops }) });
      setSelectedShops([]); setSelectedGroups([]); await refresh(); notify('已批量删除店铺及关联数据');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function deleteGroup(group) {
    const productCount = state.products.filter((product) => product.groupId === group.id).length;
    if (!window.confirm(`确定删除分组“${group.name}”吗？\n将同时删除该分组的 ${productCount} 件商品；关联的已暂停任务会自动取消。`)) return;
    try {
      await api(`/api/groups/${group.id}`, { method: 'DELETE' });
      setSelectedGroups((current) => current.filter((id) => id !== group.id));
      await refresh(); notify('分组及其商品已删除');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function deleteSelectedGroups() {
    const productCount = state.products.filter((product) => selectedGroups.includes(product.groupId)).length;
    if (!selectedGroups.length || !window.confirm(`确定删除已选择的 ${selectedGroups.length} 个分组吗？\n将同时删除这些分组的 ${productCount} 件商品；关联的已暂停任务会自动取消。`)) return;
    try {
      await api('/api/groups/delete', { method: 'POST', body: JSON.stringify({ ids: selectedGroups }) });
      setSelectedGroups([]); await refresh(); notify('已批量删除分组及关联商品');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function controlCollect(job, action) {
    try {
      await api(`/api/jobs/${job.id}/${action}`, { method: 'POST' });
      await refresh();
      notify(action === 'cancel' ? '采集任务已取消，已经保存的商品会保留' : '采集任务已继续');
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
    {collectJobs.map((job) => <div className="job-banner" key={job.id}><LoaderCircle className={job.status === 'paused' ? '' : 'spin'} size={18} /><div><strong>{job.metadata?.groupName ? `${job.metadata.groupName}：` : ''}{job.message}</strong><div className="progress"><i style={{ width: job.total ? `${job.progress / job.total * 100}%` : '32%' }} /></div></div><div className="job-banner-actions">{['queued', 'running'].includes(job.status) && <button className="icon-button" onClick={() => api(`/api/jobs/${job.id}/pause`, { method: 'POST' }).then(refresh).catch((error) => notify(error.message, 'error'))} title="暂停采集"><Pause size={16} /></button>}{job.status === 'pause_requested' && <button className="icon-button" disabled title="正在暂停"><LoaderCircle className="spin" size={16} /></button>}{job.status === 'paused' && <><button className="icon-button" onClick={() => controlCollect(job, 'resume')} title="继续采集"><Play size={16} /></button><button className="icon-button danger" onClick={() => controlCollect(job, 'cancel')} title="取消任务并保留已采集商品"><X size={16} /></button></>}</div></div>)}
    <section className="panel shop-list">
      <div className="section-title"><div><h2>店铺与分组</h2><p>{state.groups.length ? '展开店铺后选择分组采集商品' : '读取店铺后，分组将显示在这里'}</p></div><div className="section-actions">{selectedGroups.length > 0 && <><button className="secondary-button" onClick={() => collectMany(state.groups.filter((group) => selectedGroups.includes(group.id)))}><RefreshCw size={15} />采集已选分组 {selectedGroups.length}</button><button className="secondary-button danger-button" onClick={deleteSelectedGroups}><Trash2 size={15} />删除分组 {selectedGroups.length}</button></>}{state.groups.length > 0 && <button className="secondary-button" onClick={() => collectMany(state.groups)}><RefreshCw size={15} />采集全部分组</button>}{selectedShops.length > 0 && <button className="secondary-button danger-button" onClick={deleteSelectedShops}><Trash2 size={15} />删除店铺 {selectedShops.length}</button>}</div></div>
      {!state.shops.length ? <EmptyState icon={Store} title="还没有同行店铺" text="输入店铺链接开始读取分组" /> : visibleShops.map((shop) => {
        const groups = state.groups.filter((group) => group.shopId === shop.id);
        const expanded = Boolean(expandedShops[shop.id]);
        const groupPageCount = Math.max(1, Math.ceil(groups.length / groupPageSize));
        const groupPage = Math.min(groupPages[shop.id] || 1, groupPageCount);
        const visibleGroups = groups.slice((groupPage - 1) * groupPageSize, groupPage * groupPageSize);
        return <div className="shop-block" key={shop.id}>
          <div className="shop-heading"><input type="checkbox" checked={selectedShops.includes(shop.id)} onChange={(event) => toggleSelected(setSelectedShops, shop.id, event.target.checked)} aria-label={`选择店铺 ${shop.name}`} /><div className="store-mark"><Store size={18} /></div><div className="shop-info"><strong>{shop.name}</strong><a href={shop.url} target="_blank" rel="noreferrer">{new URL(shop.url).hostname}<ExternalLink size={13} /></a></div><span>{groups.length} 个分组 · {state.products.filter((product) => product.shopId === shop.id).length} 件商品</span><button className="icon-button danger" onClick={() => deleteShop(shop)} title="删除店铺"><Trash2 size={16} /></button><button className="icon-button shop-toggle" onClick={() => setExpandedShops((current) => ({ ...current, [shop.id]: !expanded }))} title={expanded ? '收起分组' : '展开分组'}>{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button></div>
          {expanded && <div className="group-list">{visibleGroups.map((group) => <div className="group-row" key={group.id}>
            <input type="checkbox" checked={selectedGroups.includes(group.id)} onChange={(event) => toggleSelected(setSelectedGroups, group.id, event.target.checked)} aria-label={`选择分组 ${group.name}`} />{group.externalId === 'featured' ? <Store className="featured-group-icon" size={18} /> : <FolderTree size={18} />}<div><strong>{group.name}</strong><small>{group.productCount != null ? `店铺显示 ${group.productCount} 件` : group.collectedCount ? `已读取 ${group.collectedCount} 件` : '等待读取'}</small></div>
            <span className={`group-state ${group.status}`}>{group.status === 'collecting' ? '读取中' : group.status === 'done' ? '已完成' : group.status === 'failed' ? '失败' : '未读取'}</span>
            <button className="secondary-button" disabled={group.status === 'collecting'} onClick={() => collect(group)}>{group.status === 'collecting' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{group.collectedCount ? '重新采集' : '采集商品'}</button>
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
  const priceRange = product.sourcePriceRange;
  const hasPriceRange = Number(priceRange?.minPrice) > 0 && Number(priceRange?.maxPrice) >= Number(priceRange?.minPrice);
  const variants = (product.variantGroups || []).length;
  const missing = [];
  if (main < 4) missing.push('主图');
  if (!detail) missing.push('详情图');
  if (attributes < 2) missing.push('属性');
  if (!tiers && !hasPriceRange) missing.push('价格资料');
  if (!product.origin) missing.push('产地');
  if (!(Number(product.packaging?.weight) > 0)) missing.push('包装重量');
  if (!product.description && !product.descriptionHtml) missing.push('商品详情');
  const quality = product.quality;
  if (quality?.issues?.length) {
    const qualityMissing = quality.issues.filter((item) => item.severity === 'error').map((item) => item.message);
    return { main, detail, attributes, tiers, hasPriceRange, variants, skus: (product.skus || []).length, missing: qualityMissing, complete: quality.status !== 'blocked', review: quality.status === 'review', score: quality.score, warnings: quality.warnings, issues: quality.issues };
  }
  const complete = missing.length === 0;
  return { main, detail, attributes, tiers, hasPriceRange, variants, skus: (product.skus || []).length, missing, complete, review: false, score: complete ? 100 : Math.max(0, 100 - missing.length * 12), warnings: 0, issues: [] };
}

function hasCategoryMismatch(product, category) {
  const text = `${product.title || ''} ${product.productType || ''} ${(product.sourceCategoryPath || []).join(' ')}`;
  const expectedPath = (product.categoryPath?.length ? product.categoryPath : product.sourceCategoryPath) || [];
  const actualPath = String(category || '').split(/\s*(?:>>|>|\/|\\)\s*/).map((value) => value.trim()).filter(Boolean);
  const canonicalLeaf = (value) => {
    const normalized = String(value || '').toLowerCase().replace(/[,&._-]/g, ' ').replace(/\s+/g, ' ').trim();
    return ({ '无人机配件': 'drones accessories', 'drones accessories': 'drones accessories', '相机照片配件': 'camera photo accessories', 'camera photo accessories': 'camera photo accessories', '其他消费电子产品': 'other consumer electronics', 'other consumer electronics': 'other consumer electronics', '坚固型手机': 'rugged phone', 'rugged phone': 'rugged phone', '电机控制器': 'motor controllers', 'motor controller': 'motor controllers', 'motor controllers': 'motor controllers' })[normalized] || normalized;
  };
  if (expectedPath.length && actualPath.length && canonicalLeaf(expectedPath.at(-1)) !== canonicalLeaf(actualPath.at(-1))) return true;
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
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [refreshingId, setRefreshingId] = useState('');
  const products = useMemo(() => state.products.filter((product) => {
    const matchesQuery = !query || product.title?.toLowerCase().includes(query.toLowerCase()) || product.sourceId?.includes(query);
    const matchesFilter = filter === 'all' || (filter === 'selected' ? product.selected : filter === 'incomplete' ? !productCompleteness(product).complete : product.status === filter);
    return matchesQuery && matchesFilter;
  }), [state.products, query, filter]);
  const pageCount = Math.max(1, Math.ceil(products.length / pageSize));
  const pagedProducts = products.slice((page - 1) * pageSize, page * pageSize);
  const allChecked = pagedProducts.length > 0 && pagedProducts.every((item) => item.selected);
  const allProductsSelected = state.products.length > 0 && state.products.every((item) => item.selected);
  const selectedProducts = state.products.filter((item) => item.selected);
  const referenceEligibleProducts = selectedProducts.filter((product) => product.status !== 'published');
  const wasPublishedSuccessfully = (product) => product.status === 'published'
    || (product.publishHistory || []).some((entry) => ['published', 'submitted', 'success'].includes(String(entry.result?.status || entry.status || '').toLowerCase()));
  const publishedReferenceProducts = state.products.filter(wasPublishedSuccessfully);
  const referenceUnavailableReason = !selectedProducts.length
    ? '请先勾选需要补全资料的商品'
    : !referenceEligibleProducts.length
      ? '已勾选商品均已上架成功，无需引用'
      : !publishedReferenceProducts.length
        ? '当前没有上架成功的商品可供引用'
        : '用上架成功商品的类目、受控属性和规格模板覆盖发布资料';

  useEffect(() => { setPage(1); }, [query, filter, pageSize]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  async function select(ids, selected) {
    await api('/api/products/select', { method: 'POST', body: JSON.stringify({ ids, selected }) });
    await refresh();
  }

  async function selectAllProducts(selected) {
    if (!state.products.length) return;
    try {
      await api('/api/products/select', { method: 'POST', body: JSON.stringify({ all: true, selected }) });
      await refresh();
      notify(selected ? `已全选全部 ${state.products.length} 件商品` : '已取消全部商品选择');
    } catch (error) { notify(error.message, 'error'); }
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
      <div className="segmented">{[['all', '全部'], ['selected', '已选择'], ['incomplete', '资料待补'], ['ready', '待上架'], ['drafted', '已存草稿'], ['published', '上架成功'], ['publish_failed', '上架失败']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <button className="secondary-button" disabled={!state.products.length} onClick={() => selectAllProducts(!allProductsSelected)} title={allProductsSelected ? '取消全部商品的选择' : '选择商品资料库中的全部商品'}><Check size={15} />{allProductsSelected ? '取消全选' : `全选全部商品 ${state.products.length}`}</button>
      <button className="secondary-button" disabled={!state.products.length} onClick={() => setFindReplaceOpen(true)}><Search size={15} />查找替换</button>
      {selectedProducts.length > 0 && <button className="primary-button" onClick={() => setBatchEditing(true)}><Pencil size={15} />批量修改 {selectedProducts.length}</button>}
      <button className="secondary-button" disabled={!referenceEligibleProducts.length || !publishedReferenceProducts.length} title={referenceUnavailableReason} onClick={() => setReferenceOpen(true)}><ClipboardList size={15} />引用成功商品资料</button>
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
          <td><span className={`data-status ${completeness.complete ? 'complete' : ''}`} title={completeness.missing.length ? `阻断项：${completeness.missing.join('、')}` : completeness.review ? '来源未公开部分逐SKU数据，需要发布前确认' : '可进入发布检查'}>{!completeness.complete ? `资料阻断 ${completeness.score}` : completeness.review ? `资料待确认 ${completeness.score}` : `可发布 ${completeness.score}`}</span><small className="data-counts">主 {completeness.main} · 详 {completeness.detail} · 属 {completeness.attributes} · SKU {completeness.skus} · 价 {completeness.tiers || (completeness.hasPriceRange ? '区间' : 0)}</small>{completeness.warnings > 0 && <small className="data-warning">另有 {completeness.warnings} 项待确认</small>}{!completeness.complete && <small className="data-missing">{completeness.missing.join('；')}</small>}</td>
          <td><b className="price">{product.sourcePriceRange?.formattedText || `${product.currencySymbol || '¥'}${product.price || '-'}`}</b></td><td>{product.stock ?? '-'}</td><td><StatusBadge status={product.status} message={product.publishResult?.message} />{product.status === 'publish_failed' && <small className="data-missing" title={product.publishResult?.message || ''}>{product.publishResult?.message || '未记录失败原因'}</small>}</td>
          <td className="action-cell"><button className="icon-button" disabled={refreshingId === product.id} onClick={() => refreshDetail(product)} title="重新采集完整资料">{refreshingId === product.id ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button><button className="icon-button" onClick={() => setEditing(product)} title="编辑完整资料"><Pencil size={17} /></button><button className="icon-button danger" onClick={() => remove(product)} title="删除商品"><Trash2 size={17} /></button></td>
        </tr>; })}</tbody>
      </table></div>}
      {products.length > pageSize && <Pagination page={page} pageCount={pageCount} onPage={setPage} label={`第 ${page}/${pageCount} 页 · 共 ${products.length} 件`} />}
    </section>
    {editing && <ProductEditor product={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); notify('商品修改已保存'); }} notify={notify} />}
      {batchEditing && <BatchEditor products={selectedProducts} references={publishedReferenceProducts} onClose={() => setBatchEditing(false)} onSaved={async (result) => { setBatchEditing(false); await refresh(); notify(result?.categoryBindingReset ? '批量修改已应用，请重新绑定修改后类目的国际站发布表单' : '批量修改已应用'); }} notify={notify} />}
    {findReplaceOpen && <FindReplaceDialog products={selectedProducts.length ? selectedProducts : state.products} onClose={() => setFindReplaceOpen(false)} onSaved={async (result) => { setFindReplaceOpen(false); await refresh(); notify(`已替换 ${result.changedProducts} 件商品，共 ${result.total} 处`); }} notify={notify} />}
    {referenceOpen && <ReferenceDialog products={referenceEligibleProducts} references={publishedReferenceProducts} onClose={() => setReferenceOpen(false)} onSaved={async (result) => { setReferenceOpen(false); await refresh(); notify(`已套用成功商品发布模板，更新 ${result.changed.length} 件商品`); }} notify={notify} />}
  </>;
}

function FindReplaceDialog({ products, onClose, onSaved, notify }) {
  const [search, setSearch] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  async function inspect() {
    if (!search.trim()) return notify('请输入要查找的内容', 'error');
    setBusy(true);
    try { setPreview(await api('/api/products/find-replace', { method: 'POST', body: JSON.stringify({ ids: products.map((item) => item.id), search, replacement, caseSensitive, dryRun: true }) })); }
    catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview?.total) return notify('请先查找并确认匹配结果', 'error');
    setBusy(true);
    try { const result = await api('/api/products/find-replace', { method: 'POST', body: JSON.stringify({ ids: products.map((item) => item.id), search, replacement, caseSensitive }) }); onSaved(result); }
    catch (error) { notify(error.message, 'error'); setBusy(false); }
  }
  return <div className="drawer-backdrop"><aside className="drawer batch-drawer"><div className="drawer-header"><div><span>查找与替换</span><h2>{products.length} 件商品</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={20} /></button></div><div className="find-replace-form"><label><span>查找内容</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPreview(null); }} placeholder="例如 apple" autoFocus /></label><label><span>替换为</span><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="例如 liangxiang" /></label><label className="checkbox-label"><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /><span>区分大小写</span></label><button className="secondary-button" disabled={busy || !search.trim()} onClick={inspect}><Search size={16} />查找匹配</button></div>{preview && <div className="find-preview"><strong>找到 {preview.total} 处，涉及 {preview.changedProducts} 件商品</strong>{preview.matches.length ? <div className="find-preview-list">{preview.matches.map((item) => <div key={item.id}><b>{item.title || item.id}</b><span>{item.fields.map((field) => `${field.field}（${field.count}处）`).join('、')}</span></div>)}</div> : <p>没有匹配内容</p>}</div>}<div className="drawer-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !preview?.total} onClick={apply}><Save size={17} />执行替换</button></div></aside></div>;
}

function ReferenceDialog({ products, references, onClose, onSaved, notify }) {
  const [referenceId, setReferenceId] = useState(references[0]?.id || '');
  const [busy, setBusy] = useState(false);
  async function apply() {
    if (!referenceId) return notify('请选择已成功上架的引用商品', 'error');
    setBusy(true);
    try { onSaved(await api('/api/products/reference', { method: 'POST', body: JSON.stringify({ ids: products.map((item) => item.id), referenceId }) })); }
    catch (error) { notify(error.message, 'error'); setBusy(false); }
  }
  return <div className="drawer-backdrop"><aside className="drawer batch-drawer"><div className="drawer-header"><div><span>引用成功商品资料</span><h2>套用发布模板到 {products.length} 件商品</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={20} /></button></div><div className="reference-help">将覆盖国际站发布所需的类目、产地/省份、品牌、适用品牌、材质、私模、颜色及图片、适用型号、型号及图片、类型和规格。原商品标题、关键词、价格、库存、主图、详情图和来源记录保持不变。</div><label className="batch-field"><span>选择已成功上架的商品作为模板</span><select value={referenceId} onChange={(event) => setReferenceId(event.target.value)}><option value="">请选择引用商品</option>{references.map((item) => <option key={item.id} value={item.id}>{item.title || item.id}（{item.sourceId}）</option>)}</select></label><div className="reference-list">{products.map((item) => <div key={item.id}><strong>{item.title || item.id}</strong><small>{item.status === 'publish_failed' ? '上次上架失败，可套用模板后重试' : productCompleteness(item).missing.join('、') || '将替换发布属性模板'}</small></div>)}</div><div className="drawer-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !referenceId} onClick={apply}><ClipboardList size={17} />套用并保存</button></div></aside></div>;
}

function BatchEditor({ products, references, onClose, onSaved, notify }) {
  const [tab, setTab] = useState('basic');
  const [locale, setLocale] = useState('zh');
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [form, setForm] = useState({ titlePrefix: '', titleSuffix: '', subtitle: '', keywords: '', origin: '', brand: '', productType: '', category: '', categoryId: '', pricePercent: '0', priceFixed: '0', stock: '', moq: '', deliveryDays: '', weight: '', length: '', width: '', height: '', description: '', attrName: '', attrValue: '', attrMode: 'upsert', specName: '', specOption: '', specMode: 'upsert', skuPrice: '', skuStock: '', fobMinPrice: '', fobMaxPrice: '', country: 'United States', countryPrice: '', imageAction: 'dedupe', skuRows: null });
  const tabs = [['basic', '基础信息'], ['category', '产品类目'], ['trade', '交易信息'], ['logistics', '物流信息'], ['description', '商品描述'], ['attributes', '商品属性'], ['custom', '自定义属性'], ['specs', '产品规格'], ['images', '产品图片'], ['detail', '详情描述'], ['service', '证书与服务'], ['regional', '国家/地区定价']];
  const labels = { '标题前缀': 'Title prefix', '标题后缀': 'Title suffix', '统一副标题': 'Subtitle', '关键词（逗号或换行分隔）': 'Keywords (comma or line separated)', '产地': 'Origin', '品牌': 'Brand', '产品类型': 'Product type', '库存': 'Stock', '起订量': 'MOQ', '交期（天）': 'Lead time (days)', '毛重（kg）': 'Gross weight (kg)', '包装长（cm）': 'Package length (cm)', '包装宽（cm）': 'Package width (cm)', '包装高（cm）': 'Package height (cm)', '该地区价格': 'Regional price' };
  const tabLabels = { basic: ['基础信息', 'Basic'], category: ['产品类目', 'Category'], trade: ['交易信息', 'Trade'], logistics: ['物流信息', 'Logistics'], description: ['商品描述', 'Description'], attributes: ['商品属性', 'Attributes'], custom: ['自定义属性', 'Custom'], specs: ['产品规格', 'Specifications'], images: ['产品图片', 'Images'], detail: ['详情描述', 'Details'], service: ['证书与服务', 'Services'], regional: ['国家/地区定价', 'Regional pricing'] };
  const update = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  function field(label, key, type = 'text', textarea = false) { return <label className="batch-field"><span>{locale === 'en' ? (labels[label] || label) : label}</span>{textarea ? <textarea rows="4" value={form[key]} onChange={update(key)} /> : <input type={type} value={form[key]} onChange={update(key)} />}</label>; }
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
      if (form.priceMode) patch.priceMode = form.priceMode;
      if (form.stock !== '') patch.stock = Number(form.stock);
      if (form.moq !== '') patch.moq = Number(form.moq);
      if (form.deliveryDays !== '') patch.deliveryTime = [['1', form.deliveryDays], ['999999', form.deliveryDays]];
      if (form.skuPrice !== '' || form.skuStock !== '') patch.skuTransform = { price: form.skuPrice === '' ? null : Number(form.skuPrice), stock: form.skuStock === '' ? null : Number(form.skuStock) };
      if (form.fobMinPrice !== '' || form.fobMaxPrice !== '') patch.fobPrice = { minPrice: Number(form.fobMinPrice || 0), maxPrice: Number(form.fobMaxPrice || 0), currencySymbol: '$' };
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
    try { const result = await api('/api/products/batch-update', { method: 'POST', body: JSON.stringify({ ids: products.map((p) => p.id), patch }) }); onSaved(result); }
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
    <div className="drawer-header"><div><span>{locale === 'en' ? 'Batch edit' : '批量修改'}</span><h2>{locale === 'en' ? `${products.length} products selected` : `已选择 ${products.length} 件商品`}</h2></div><div className="drawer-header-actions"><div className="locale-switch"><button type="button" className={locale === 'zh' ? 'active' : ''} onClick={() => setLocale('zh')}>中文</button><button type="button" className={locale === 'en' ? 'active' : ''} onClick={() => setLocale('en')}>English</button></div><button className="icon-button" onClick={onClose} title="关闭"><X size={20} /></button></div></div>
    <div className="batch-tabs">{tabs.map(([value]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{tabLabels[value]?.[locale === 'en' ? 1 : 0] || value}</button>)}</div>
    <div className="batch-body">
      {tab === 'basic' && <>{field('标题前缀', 'titlePrefix')}{field('标题后缀', 'titleSuffix')}{field('统一副标题', 'subtitle')}{field('关键词（逗号或换行分隔）', 'keywords', 'text', true)}{field('产地', 'origin')}{field('品牌', 'brand')}{field('产品类型', 'productType')}</>}
      {tab === 'category' && <><label className="batch-field"><span>选择新产品类目</span><CategorySelect path={form.category} includeId onChange={(option) => setForm((v) => ({ ...v, category: option.path, categoryId: option.id || v.categoryId }))} /></label><label className="batch-field"><span>类目 ID（由选择或发布页绑定生成）</span><input value={form.categoryId} readOnly placeholder="选择类目后自动填充" /></label><div className="batch-actions"><button type="button" className="secondary-button" disabled={!references.length} onClick={() => setReferenceOpen(true)}><ClipboardList size={16} />引用成功商品类目与属性</button><small className="batch-help">选择一个曾经上架成功的商品，覆盖类目、产地、省份、品牌、适用品牌、材质、私模、颜色/规格及图片等发布字段。</small></div></>}
      {tab === 'trade' && <><label className="batch-field"><span>定价模式</span><select value={form.priceMode || ''} onChange={update('priceMode')}><option value="">保持原模式</option><option value="fob-range">FOB区间价格</option><option value="fob-tier">FOB阶梯价格</option><option value="quantity-tier">数量阶梯价格</option><option value="sku">SKU定价</option></select></label>{field('价格调整比例（%）', 'pricePercent', 'number')}{field('统一加减金额', 'priceFixed', 'number')}{field('统一库存', 'stock', 'number')}{field('统一起订量', 'moq', 'number')}{field('统一交期（天）', 'deliveryDays', 'number')}<div className="form-grid">{field('FOB最低价', 'fobMinPrice', 'number')}{field('FOB最高价', 'fobMaxPrice', 'number')}</div>{field('SKU统一价格', 'skuPrice', 'number')}{field('SKU统一库存', 'skuStock', 'number')}<div className="batch-actions"><button type="button" className="secondary-button" onClick={exportSku}>导出 SKU Excel</button><label className="file-button secondary-button">导入 SKU Excel<input type="file" accept=".xlsx,.xls,.csv,.txt" onChange={importSku} /></label></div></>}
      {tab === 'logistics' && <>{field('毛重（kg）', 'weight', 'number')}{field('包装长（cm）', 'length', 'number')}{field('包装宽（cm）', 'width', 'number')}{field('包装高（cm）', 'height', 'number')}</>}
      {(tab === 'description' || tab === 'detail' || tab === 'service') && field('批量追加内容', 'description', 'text', true)}
      {(tab === 'attributes' || tab === 'custom') && <><label className="batch-field"><span>修改方式</span><select value={form.attrMode} onChange={update('attrMode')}><option value="upsert">更新同名属性，不存在则新增</option><option value="append">追加属性</option><option value="replace">清空后只保留本属性</option></select></label>{field('属性名称', 'attrName')}{field('属性值', 'attrValue')}</>}
      {tab === 'specs' && <><label className="batch-field"><span>修改方式</span><select value={form.specMode} onChange={update('specMode')}><option value="upsert">更新同名规格，不存在则新增</option><option value="append">追加规格</option><option value="replace">清空后只保留本规格</option></select></label>{field('规格名称', 'specName')}{field('规格选项（逗号分隔）', 'specOption')}</>}
      {tab === 'images' && <><p className="batch-help">会对所有已选商品的主图和详情图执行批量处理，并保留原始来源快照。</p><button className="secondary-button" onClick={() => applyImage('dedupe')}>图片去重并排序</button><button className="secondary-button" onClick={() => applyImage('copy-detail')}>主图复制为详情图</button><button className="secondary-button" onClick={() => applyImage('clean')}>清理空图片</button><button className="secondary-button danger-button" onClick={() => applyImage('clear-main')}>清空全部主图</button><div className="batch-slot-actions"><span>批量删除指定主图：</span>{[1,2,3,4,5,6].map((slot) => <button key={slot} className="secondary-button danger-button" onClick={() => applyImage(`delete-main-${slot}`)}>主图 {slot}</button>)}</div></>}
      {tab === 'regional' && <>{field('国家/地区', 'country')}{field('该地区价格', 'countryPrice', 'number')}</>}
    </div>
    <div className="batch-preview"><div className="batch-preview-title"><strong>修改预览</strong><span>先确认每个商品的当前值和修改后值，再点击保存</span></div><div className="batch-preview-table"><div className="batch-preview-head"><span>商品名称</span><span>旧值-修改前</span><span>新值-修改后</span></div>{products.map((product) => { const row = previewFor(product); return <div className="batch-preview-row" key={product.id}><strong title={product.title}>{product.title || '未命名商品'}</strong><span title={row.current}>{row.current}</span><span className={row.next.includes('等待') || row.next.includes('请选择') ? 'pending' : ''} title={row.next}>{row.next}</span></div>; })}</div></div>
    <div className="drawer-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={apply}><Save size={17} />应用到 {products.length} 件商品</button></div>
  </aside>{referenceOpen && <ReferenceDialog products={products} references={references} onClose={() => setReferenceOpen(false)} onSaved={onSaved} notify={notify} />}</div>;
}

function ProductEditor({ product, onClose, onSaved, notify }) {
  const initialMainImages = product.mainImages || product.images || (product.mainImage ? [product.mainImage] : []);
  const initialFob = product.fobPrice && typeof product.fobPrice === 'object' ? product.fobPrice : {};
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
    regionalPricing: product.regionalPricing || {},
    fobMinPrice: initialFob.minPrice ?? '', fobMaxPrice: initialFob.maxPrice ?? '', fobTiers: (initialFob.tiers || []).map((tier) => ({ ...tier }))
  });
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('basic');
  const update = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  const updateArray = (key, index, value) => setForm((current) => ({ ...current, [key]: current[key].map((item, itemIndex) => itemIndex === index ? value : item) }));
  const removeArray = (key, index) => setForm((current) => ({ ...current, [key]: current[key].filter((_, itemIndex) => itemIndex !== index) }));
  function importLocalImages(event, target = 'mainImages', max = target === 'mainImages' ? 6 : 30) {
    const files = [...(event.target.files || [])].filter((file) => /^image\//i.test(file.type));
    if (!files.length) return;
    Promise.all(files.map((file) => new Promise((resolve) => { const reader = new FileReader(); reader.onload = async () => { try { const result = await api('/api/media/upload', { method: 'POST', body: JSON.stringify({ name: file.name, data: String(reader.result || '') }) }); resolve(result.url || ''); } catch (error) { notify(error.message, 'error'); resolve(''); } }; reader.onerror = () => resolve(''); reader.readAsDataURL(file); }))).then((urls) => setForm((value) => ({ ...value, [target]: [...value[target], ...urls.filter(Boolean)].slice(0, max) })));
    event.target.value = '';
  }
  function restoreSourceImages(target = 'mainImages') {
    const sourceImages = product.source?.snapshot?.[target] || [];
    const max = target === 'mainImages' ? 6 : 30;
    if (!sourceImages.length) return notify(`来源快照没有可还原的${target === 'mainImages' ? '主图' : '详情图'}`, 'error');
    setForm((value) => ({ ...value, [target]: sourceImages.slice(0, max) }));
    notify(`已从来源图片库还原${target === 'mainImages' ? '主图' : '详情图'}`);
  }
  async function watermarkImages(target = 'mainImages', remove = false) {
    const label = target === 'mainImages' ? '主图' : '详情图';
    const urls = remove ? (product.source?.snapshot?.[target] || []) : form[target];
    if (!urls.length) return notify(`没有可处理的${label}`, 'error');
    try {
      const result = await Promise.all(urls.map((url) => new Promise((resolve, reject) => { const image = new Image(); image.crossOrigin = 'anonymous'; image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || 1200; canvas.height = image.naturalHeight || 800; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height); if (!remove) { context.fillStyle = 'rgba(255,255,255,.72)'; context.fillRect(18, canvas.height - 54, 270, 36); context.fillStyle = '#f06423'; context.font = 'bold 22px Microsoft YaHei'; context.fillText('抄得快', 30, canvas.height - 28); } resolve(canvas.toDataURL('image/jpeg', .9)); }; image.onerror = () => reject(new Error('图片跨域或格式不支持')); image.src = url; })));
      setForm((value) => ({ ...value, [target]: result.slice(0, target === 'mainImages' ? 6 : 30) }));
      notify(remove ? `已从来源图片恢复${label}（去除本工具水印）` : `${label}水印已添加`);
    } catch (error) { notify(`图片处理失败：${error.message}`, 'error'); }
  }
  function validateEditorForm(formElement) {
    const invalid = [...formElement.elements].find((control) => control.willValidate && !control.checkValidity());
    if (!invalid) return true;
    const pane = invalid.closest('.editor-tab-pane');
    const invalidTab = pane?.dataset.editorTab;
    const label = invalid.closest('label')?.querySelector(':scope > span')?.textContent?.trim() || '表单字段';
    const reason = invalid.validity.valueMissing ? '不能为空' : invalid.validity.rangeUnderflow ? '小于允许的最小值' : invalid.validity.rangeOverflow ? '超过允许的最大值' : invalid.validity.stepMismatch ? '数字精度或步进格式不正确' : '格式不正确';
    if (invalidTab && invalidTab !== tab) setTab(invalidTab);
    notify(`请检查${label}：${reason}`, 'error');
    window.setTimeout(() => {
      invalid.focus({ preventScroll: false });
      invalid.reportValidity();
    }, 0);
    return false;
  }
  async function save(event) {
    event.preventDefault();
    if (!validateEditorForm(event.currentTarget)) return;
    setSaving(true);
    try {
      const mainImages = form.mainImages.map((url) => url.trim()).filter(Boolean);
      const fobPrice = { minPrice: Number(form.fobMinPrice || 0), maxPrice: Number(form.fobMaxPrice || 0), currencySymbol: product.currencySymbol || '$', tiers: form.fobTiers.map((tier) => ({ ...tier, minQuantity: Number(tier.minQuantity || 0), maxQuantity: tier.maxQuantity ? Number(tier.maxQuantity) : null, price: Number(tier.price || 0) })) };
      await api(`/api/products/${product.id}`, { method: 'PATCH', body: JSON.stringify({
        ...form, price: Number(form.price), stock: Number(form.stock), moq: Number(form.moq), mainImages,
        images: mainImages, mainImage: mainImages[0] || '', detailImages: form.detailImages.map((url) => url.trim()).filter(Boolean),
        fobPrice,
        deliveryTime: [['1', form.deliveryDays], ['999999', form.deliveryDays]]
      }) });
      await onSaved();
    } catch (error) { notify(error.message, 'error'); }
    finally { setSaving(false); }
  }
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer">
    <div className="drawer-header"><div><span>商品编辑</span><h2>{product.sourceId}</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={20} /></button></div>
    <form onSubmit={save} className="edit-form" noValidate>
      <div className="editor-tabs">{[['basic', '基础信息'], ['media', '图片与视频'], ['attributes', '商品属性'], ['custom', '自定义属性'], ['specs', '规格与SKU'], ['trade', '交易信息'], ['logistics', '物流信息'], ['service', '服务与证书'], ['description', '商品描述'], ['regional', '国家/地区定价'], ['audit', '来源与审计']].map(([value, label]) => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className={`editor-tab-pane ${tab === 'basic' ? '' : 'hidden'}`} data-editor-tab="basic">
      <div className={`completeness-strip ${productCompleteness({ ...product, ...form, packaging: form.packaging }).complete ? 'complete' : ''}`}><CircleCheck size={17} /><span>主图 {form.mainImages.length} · 详情图 {form.detailImages.length} · 属性 {form.attributes.length} · 规格 {form.variantGroups.length} · 价格 {product.sourcePriceRange?.formattedText || `${form.priceTiers.length} 档`}</span></div>
      <h3 className="edit-section-title">基础信息</h3>
      <label><span>商品标题</span><textarea rows="3" value={form.title} onChange={update('title')} maxLength="120" required /><small>{form.title.length}/120</small></label>
      <label><span>副标题</span><input value={form.subtitle} onChange={update('subtitle')} maxLength="128" /></label>
      <label><span>商品关键词（逗号分隔）</span><textarea rows="3" value={form.keywords.join(', ')} onChange={(event) => setForm((value) => ({ ...value, keywords: event.target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) }))} /></label>
      <div className="form-grid"><label><span>目标类目（请选择）</span><CategorySelect path={form.categoryPath.join(' >> ')} includeId onChange={(option) => setForm((value) => ({ ...value, categoryPath: option.path ? option.path.split(' >> ') : [], categoryId: option.id || value.categoryId }))} /></label><label><span>目标类目 ID</span><input value={form.categoryId} readOnly placeholder="由类目选择自动填充" /></label></div>
      <div className="form-grid"><label><span>基准销售价</span><div className="prefix-input"><b>{product.currencySymbol || '$'}</b><input type="number" min="0" step="0.01" value={form.price} onChange={update('price')} required /></div></label><label><span>默认库存</span><input type="number" min="0" value={form.stock} onChange={update('stock')} required /></label><label><span>起订量</span><input type="number" min="1" value={form.moq} onChange={update('moq')} required /></label><label><span>交期（天）</span><input type="number" min="1" value={form.deliveryDays} onChange={update('deliveryDays')} /></label></div>
      <label><span>商品详情</span><textarea rows="9" value={form.description} onChange={update('description')} placeholder="商品卖点、规格说明与采购信息" /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'media' ? '' : 'hidden'}`} data-editor-tab="media">
      <h3 className="edit-section-title">主图与详情图</h3>
      <h4 className="media-section-title">主图（最多 6 张）</h4>
      <div className="image-toolbar"><label className="file-button secondary-button"><Plus size={15} />上传本地图片<input type="file" accept="image/*" multiple onChange={(event) => importLocalImages(event, 'mainImages', 6)} /></label><button type="button" className="secondary-button" onClick={() => restoreSourceImages('mainImages')}>从来源图片库还原</button><button type="button" className="secondary-button" onClick={() => watermarkImages('mainImages', false)}>添加水印</button><button type="button" className="secondary-button" onClick={() => watermarkImages('mainImages', true)}>去除本工具水印</button><button type="button" className="secondary-button danger-button" onClick={() => setForm((value) => ({ ...value, mainImages: [] }))}>清空主图</button></div>
      <div className="media-grid">{form.mainImages.map((url, index) => <div className="media-row" key={`main-${index}`}><strong className="media-index">主图 {index + 1}</strong><div className="mini-preview">{url ? <img src={url} alt="" /> : <Boxes size={18} />}</div><input value={url} onChange={(event) => updateArray('mainImages', index, event.target.value)} aria-label={`主图 ${index + 1}`} /><button type="button" className="icon-button danger" onClick={() => removeArray('mainImages', index)} title="删除主图"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" disabled={form.mainImages.length >= 6} onClick={() => setForm((value) => ({ ...value, mainImages: [...value.mainImages, ''] }))}><Plus size={15} />添加主图地址</button>
      <h4 className="media-section-title">详情图（支持本地上传与来源还原）</h4>
      <div className="image-toolbar"><label className="file-button secondary-button"><Plus size={15} />上传本地详情图<input type="file" accept="image/*" multiple onChange={(event) => importLocalImages(event, 'detailImages', 30)} /></label><button type="button" className="secondary-button" onClick={() => restoreSourceImages('detailImages')}>从来源图片库还原详情图</button><button type="button" className="secondary-button" onClick={() => watermarkImages('detailImages', false)}>添加水印</button><button type="button" className="secondary-button" onClick={() => watermarkImages('detailImages', true)}>去除本工具水印</button><button type="button" className="secondary-button danger-button" onClick={() => setForm((value) => ({ ...value, detailImages: [] }))}>清空详情图</button></div>
      <div className="media-grid">{form.detailImages.map((url, index) => <div className="media-row" key={`detail-${index}`}><strong className="media-index">详情图 {index + 1}</strong><div className="mini-preview">{url ? <img src={url} alt="" /> : <Boxes size={18} />}</div><input value={url} onChange={(event) => updateArray('detailImages', index, event.target.value)} aria-label={`详情图 ${index + 1}`} /><button type="button" className="icon-button danger" onClick={() => removeArray('detailImages', index)} title="删除详情图"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, detailImages: [...value.detailImages, ''] }))}><Plus size={15} />添加详情图地址</button>
      <label><span>商品视频地址</span><input value={form.videoUrl} onChange={update('videoUrl')} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'attributes' ? '' : 'hidden'}`} data-editor-tab="attributes">
      <h3 className="edit-section-title">商品属性</h3>
      <div className="repeat-list">{form.attributes.map((item, index) => <div className="edit-data-row" key={`attr-${index}`}><input value={item.name || ''} onChange={(event) => updateArray('attributes', index, { ...item, name: event.target.value })} placeholder="属性名" /><input value={item.value || ''} onChange={(event) => updateArray('attributes', index, { ...item, value: event.target.value })} placeholder="属性值" /><button type="button" className="icon-button danger" onClick={() => removeArray('attributes', index)} title="删除属性"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, attributes: [...value.attributes, { name: '', value: '' }] }))}><Plus size={15} />添加属性</button>
      </div>
      <div className={`editor-tab-pane ${tab === 'custom' ? '' : 'hidden'}`} data-editor-tab="custom"><h3 className="edit-section-title">自定义属性</h3><div className="repeat-list">{form.customAttributes.map((item, index) => <div className="edit-data-row" key={`custom-${index}`}><input value={item.name || ''} onChange={(event) => updateArray('customAttributes', index, { ...item, name: event.target.value })} placeholder="属性名" /><input value={item.value || ''} onChange={(event) => updateArray('customAttributes', index, { ...item, value: event.target.value })} placeholder="属性值" /><button type="button" className="icon-button danger" onClick={() => removeArray('customAttributes', index)} title="删除自定义属性"><X size={15} /></button></div>)}</div><button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, customAttributes: [...value.customAttributes, { name: '', value: '' }] }))}><Plus size={15} />添加自定义属性</button></div>
      <div className={`editor-tab-pane ${tab === 'specs' ? '' : 'hidden'}`} data-editor-tab="specs">
      <h3 className="edit-section-title">规格组合</h3>
      <div className="repeat-list">{form.variantGroups.map((group, index) => <div className="edit-data-row" key={`variant-${index}`}><input value={group.name || ''} onChange={(event) => updateArray('variantGroups', index, { ...group, name: event.target.value })} placeholder="规格名" /><input value={(group.options || []).join(', ')} onChange={(event) => updateArray('variantGroups', index, { ...group, options: event.target.value.split(/[,，]/).map((option) => option.trim()).filter(Boolean) })} placeholder="选项，用逗号分隔" /><button type="button" className="icon-button danger" onClick={() => removeArray('variantGroups', index)} title="删除规格"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, variantGroups: [...value.variantGroups, { name: '', options: [] }] }))}><Plus size={15} />添加规格</button>
      <h3 className="edit-section-title">SKU 明细</h3>
      {form.skus.some((sku) => sku.derived) && <div className="sku-warning"><CircleAlert size={16} />当前SKU由规格组合推导。请人工确认每行价格、库存、编码和图片后再发布。</div>}
      <div className="sku-table-wrap"><table className="sku-table"><thead><tr><th>规格组合</th><th>SKU编码</th><th>价格</th><th>库存</th><th>图片</th><th>来源</th><th /></tr></thead><tbody>{form.skus.map((sku, index) => <tr key={sku.id || index}><td>{Object.entries(sku.attributes || {}).map(([name, value]) => `${name}: ${value}`).join(' / ') || sku.name}</td><td><input value={sku.code || ''} onChange={(event) => updateArray('skus', index, { ...sku, code: event.target.value })} /></td><td><input type="number" min="0" step="0.01" value={sku.price || ''} onChange={(event) => updateArray('skus', index, { ...sku, price: event.target.value })} /></td><td><input type="number" min="0" value={sku.stock ?? ''} onChange={(event) => updateArray('skus', index, { ...sku, stock: Number(event.target.value) })} /></td><td><input value={sku.image || ''} onChange={(event) => updateArray('skus', index, { ...sku, image: event.target.value })} /></td><td><span className={`source-tag ${sku.derived ? 'derived' : ''}`}>{sku.derived ? '推导' : '来源'}</span></td><td><button type="button" className="icon-button danger" onClick={() => removeArray('skus', index)} title="删除SKU"><X size={15} /></button></td></tr>)}</tbody></table></div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, skus: [...value.skus, { id: `sku-${Date.now()}`, attributes: {}, code: '', price: value.price, stock: value.stock, image: '', derived: false, source: 'manual' }] }))}><Plus size={15} />添加SKU</button>
      </div>
      <div className={`editor-tab-pane ${tab === 'trade' ? '' : 'hidden'}`} data-editor-tab="trade">
      <h3 className="edit-section-title">阶梯价格</h3>
      {product.sourcePriceRange && <div className="sku-warning"><CircleAlert size={16} />来源页面公开价格区间：{product.sourcePriceRange.formattedText} / {product.sourcePriceRange.unit || form.salesUnit}。来源未公开的逐 SKU 价格不会由系统推测或改写。</div>}
      <div className="tier-header"><span>起订量</span><span>结束量</span><span>单价 {product.currencySymbol || '$'}</span><i /></div>
      <div className="repeat-list">{form.priceTiers.map((tier, index) => <div className="tier-row" key={`tier-${index}`}><input type="number" min="1" value={tier.minQuantity || ''} onChange={(event) => updateArray('priceTiers', index, { ...tier, minQuantity: Number(event.target.value) })} /><input type="number" min="1" value={tier.maxQuantity ?? ''} placeholder="不限" onChange={(event) => updateArray('priceTiers', index, { ...tier, maxQuantity: event.target.value ? Number(event.target.value) : null })} /><input type="number" min="0" step="0.01" value={tier.price || ''} onChange={(event) => updateArray('priceTiers', index, { ...tier, price: event.target.value, currencySymbol: product.currencySymbol || '$' })} /><button type="button" className="icon-button danger" onClick={() => removeArray('priceTiers', index)} title="删除价格档"><X size={15} /></button></div>)}</div>
      <button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, priceTiers: [...value.priceTiers, { minQuantity: 1, maxQuantity: null, price: value.price, currencySymbol: product.currencySymbol || '$' }] }))}><Plus size={15} />添加价格档</button>
      <div className="form-grid"><label><span>销售单位</span><input value={form.salesUnit || ''} onChange={update('salesUnit')} placeholder="Piece" /></label><label><span>付款方式</span><input value={form.paymentMethod || ''} onChange={update('paymentMethod')} /></label></div>
      <label><span>定价模式</span><select value={form.priceMode} onChange={update('priceMode')}><option value="quantity-tier">按数量阶梯价</option><option value="sku">按SKU定价</option><option value="fob-range">FOB区间价格</option><option value="fob-tier">FOB阶梯价格</option><option value="source-range">来源公开区间价</option></select></label>
      {form.priceMode === 'fob-range' && <div className="form-grid"><label><span>FOB最低价</span><input type="number" min="0" step="0.01" value={form.fobMinPrice} onChange={update('fobMinPrice')} /></label><label><span>FOB最高价</span><input type="number" min="0" step="0.01" value={form.fobMaxPrice} onChange={update('fobMaxPrice')} /></label></div>}
      {form.priceMode === 'fob-tier' && <><h3 className="edit-section-title">FOB阶梯价格</h3><div className="tier-header"><span>起订量</span><span>结束量</span><span>FOB单价 {product.currencySymbol || '$'}</span><i /></div><div className="repeat-list">{form.fobTiers.map((tier, index) => <div className="tier-row" key={`fob-${index}`}><input type="number" min="1" value={tier.minQuantity || ''} onChange={(event) => updateArray('fobTiers', index, { ...tier, minQuantity: Number(event.target.value) })} /><input type="number" min="1" value={tier.maxQuantity ?? ''} placeholder="不限" onChange={(event) => updateArray('fobTiers', index, { ...tier, maxQuantity: event.target.value ? Number(event.target.value) : null })} /><input type="number" min="0" step="0.01" value={tier.price || ''} onChange={(event) => updateArray('fobTiers', index, { ...tier, price: event.target.value })} /><button type="button" className="icon-button danger" onClick={() => removeArray('fobTiers', index)} title="删除FOB价格档"><X size={15} /></button></div>)}</div><button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, fobTiers: [...value.fobTiers, { minQuantity: 1, maxQuantity: null, price: value.price }] }))}><Plus size={15} />添加FOB价格档</button></>}
      </div>
      <div className={`editor-tab-pane ${tab === 'logistics' ? '' : 'hidden'}`} data-editor-tab="logistics">
      <h3 className="edit-section-title">产品与包装</h3>
      <div className="form-grid"><label><span>产品类型</span><input value={form.productType} onChange={update('productType')} /></label><label><span>品牌</span><input value={form.brand} onChange={update('brand')} /></label><label><span>型号</span><input value={form.model} onChange={update('model')} /></label><label><span>产地</span><input value={form.origin} onChange={update('origin')} /></label></div>
      <div className="form-grid packaging-grid">{[['length', '包装长 (cm)'], ['width', '包装宽 (cm)'], ['height', '包装高 (cm)'], ['weight', '包装重量 (kg)']].map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min="0" step="any" value={form.packaging[key] || ''} onChange={(event) => setForm((value) => ({ ...value, packaging: { ...value.packaging, [key]: event.target.value } }))} /></label>)}</div>
      <label><span>运费模板</span><input value={form.freightTemplate || ''} onChange={update('freightTemplate')} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'description' ? '' : 'hidden'}`} data-editor-tab="description">
      <label><span>商品摘要</span><textarea rows="5" value={form.description} onChange={update('description')} /></label><label><span>普通富文本详情 HTML</span><textarea rows="14" value={form.descriptionHtml} onChange={update('descriptionHtml')} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'service' ? '' : 'hidden'}`} data-editor-tab="service">
      <label><span>服务数据 JSON</span><textarea rows="8" value={JSON.stringify(form.services || {}, null, 2)} onChange={(event) => { try { setForm((value) => ({ ...value, services: JSON.parse(event.target.value || '{}') })); } catch {} }} /></label><div className="repeat-list">{form.certificates.map((item, index) => <div className="certificate-row" key={`certificate-${index}`}><input value={item.name || ''} placeholder="证书名称" onChange={(event) => updateArray('certificates', index, { ...item, name: event.target.value })} /><input value={item.number || ''} placeholder="证书编号" onChange={(event) => updateArray('certificates', index, { ...item, number: event.target.value })} /><select value={String(item.verified ?? '')} onChange={(event) => updateArray('certificates', index, { ...item, verified: event.target.value === '' ? null : event.target.value === 'true' })}><option value="">未核验</option><option value="true">已核验</option><option value="false">核验失败</option></select><button type="button" className="icon-button danger" onClick={() => removeArray('certificates', index)} title="删除证书"><X size={15} /></button></div>)}</div><button type="button" className="secondary-button add-row-button" onClick={() => setForm((value) => ({ ...value, certificates: [...value.certificates, { name: '', number: '', verified: null, source: 'manual' }] }))}><Plus size={15} />添加证书</button>
      </div>
      <div className={`editor-tab-pane ${tab === 'regional' ? '' : 'hidden'}`} data-editor-tab="regional">
      <label><span>国家/地区价格 JSON</span><textarea rows="5" value={JSON.stringify(form.regionalPricing || {}, null, 2)} onChange={(event) => { try { setForm((value) => ({ ...value, regionalPricing: JSON.parse(event.target.value || '{}') })); } catch {} }} /></label>
      </div>
      <div className={`editor-tab-pane ${tab === 'audit' ? '' : 'hidden'}`} data-editor-tab="audit"><div className="audit-summary"><strong>质量分 {product.quality?.score ?? '-'}</strong><span>{product.quality?.errors || 0} 个阻断项 · {product.quality?.warnings || 0} 个待确认项</span></div><div className="issue-list">{(product.quality?.issues || []).map((item) => <div key={item.code} className={`issue-row ${item.severity}`}><span>{item.severity === 'error' ? '阻断' : item.severity === 'warning' ? '待确认' : '提示'}</span><strong>{item.message}</strong><code>{item.field}</code></div>)}</div><h3 className="edit-section-title">来源记录</h3><dl className="source-facts"><div><dt>平台</dt><dd>{product.source?.platform || 'alibaba.com'}</dd></div><div><dt>采集语言</dt><dd>{product.sourceLanguage || product.source?.language || '未记录'} · 请求环境 {product.sourceCaptureLocale || product.source?.captureLocale || '-'}</dd></div><div><dt>采集时间</dt><dd>{product.source?.capturedAt || '-'}</dd></div><div><dt>来源商品</dt><dd>{product.source?.productId || product.sourceId}</dd></div><div><dt>来源快照字段</dt><dd>{Object.keys(product.source?.snapshot || {}).length} 个，当前工作字段 {Object.keys(product.working || {}).length} 个</dd></div><div><dt>人工修改记录</dt><dd>{product.auditTrail?.length || 0} 次</dd></div><div><dt>发布快照</dt><dd>{product.publishHistory?.length || 0} 次</dd></div></dl><details className="source-details"><summary>查看来源快照与当前工作数据</summary><div className="source-json-grid"><div><strong>来源快照（只读）</strong><pre>{JSON.stringify(product.source?.snapshot || {}, null, 2)}</pre></div><div><strong>当前工作数据</strong><pre>{JSON.stringify(product.working || {}, null, 2)}</pre></div></div></details></div>
      <div className="source-strip"><ExternalLink size={15} /><a href={product.sourceUrl} onClick={(event) => { event.preventDefault(); if (window.kuaYipu?.openSource) window.kuaYipu.openSource(product.sourceUrl).catch(() => {}); else window.open(product.sourceUrl, '_blank', 'noopener,noreferrer'); }} rel="noreferrer">打开来源商品</a></div>
      <div className="drawer-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存修改</button></div>
    </form>
  </aside></div>;
}

function PublishView({ state, refresh, notify, onMenu }) {
  const selected = state.products.filter((item) => item.selected);
  const [mode, setMode] = useState(state.settings.publishMode || 'submit');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState({ groups: [], bindings: [] });
  const publishing = state.jobs.find((job) => job.type === 'publish' && ['queued', 'running', 'pause_requested'].includes(job.status));
  const pausedJob = state.jobs.find((job) => job.type === 'publish' && job.status === 'paused');
  const currentJob = publishing || pausedJob;
  useEffect(() => {
    const ids = selected.map((item) => item.id).join(',');
    api(`/api/publish/plan${ids ? `?ids=${encodeURIComponent(ids)}` : ''}`).then(setPlan).catch(() => setPlan({ groups: [], bindings: [] }));
  }, [state.products]);
  const unresolvedGroups = plan.groups.filter((group) => group.error || !group.url);
  const automaticGroups = plan.groups.filter((group) => !group.error && group.url);

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
  function cancel(job) {
    run(() => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }), '任务已取消，已完成数据会保留');
  }
  return <>
    <Header title="上架任务" subtitle="连接 My Alibaba 并处理已选择商品" onMenu={onMenu} />
    <div className="publish-layout">
      <div className="publish-main">
        <section className="panel connection-panel"><div className="connection-top"><div className={`connection-icon ${state.browser.browserOpen ? 'online' : ''}`}><Store size={22} /></div><div><h2>阿里巴巴国际站卖家后台</h2><p>{state.browser.browserOpen ? 'My Alibaba 浏览器已打开' : '尚未打开登录浏览器'}</p></div><span className={`connection-dot ${state.browser.browserOpen ? 'online' : ''}`}>{state.browser.browserOpen ? '浏览器已连接' : '未连接'}</span></div>
          <div className="connection-actions"><button className="secondary-button" disabled={busy} onClick={() => run(() => api('/api/seller/open', { method: 'POST' }), '已打开 My Alibaba 登录浏览器')}><ExternalLink size={16} />打开 My Alibaba</button><button className="secondary-button" disabled={busy || !state.browser.browserOpen} onClick={() => run(() => api('/api/seller/bind-page', { method: 'POST' }), '国际站发布页已绑定')}><Link2 size={16} />旧数据手动绑定</button></div>
          <div className="bound-url"><span>发布路由</span><code>{selected.length ? `${automaticGroups.length} 个类目自动处理${unresolvedGroups.length ? `，${unresolvedGroups.length} 个需确认` : ''}` : '尚未选择商品'}</code>{selected.length && !unresolvedGroups.length && <Check size={16} />}</div>
          {automaticGroups.length > 0 && <div className="bound-url category-row"><span>类目任务</span><code>{automaticGroups.map((group) => `${group.category || group.categoryId}（${group.products.length}件）`).join('；')}</code><Check size={16} /></div>}
          {unresolvedGroups.map((group) => <div className="category-warning" key={group.key}><CircleAlert size={17} /><span>{group.error || `类目 ${group.category || group.categoryId} 尚未绑定，请打开对应发布表单并绑定一次`}</span></div>)}
        </section>
        <section className="panel queue-panel"><div className="section-title"><div><h2>待上架商品</h2><p>来自商品工作台的勾选结果</p></div><strong className="queue-count">{selected.length} 件</strong></div>
          {!selected.length ? <EmptyState icon={PackageCheck} title="上架队列为空" text="到商品工作台勾选需要上架的商品" /> : <div className="queue-list">{selected.map((product) => <div className="queue-item" key={product.id}><div className="mini-thumb">{product.mainImage ? <img src={product.mainImage} alt="" /> : <Boxes size={18} />}</div><div><strong>{product.title}</strong><small>{product.publishResult?.message || `${product.currencySymbol || '¥'}${product.price} · 库存 ${product.stock}`}</small></div><StatusBadge status={product.status} message={product.publishResult?.message} /></div>)}</div>}
        </section>
      </div>
      <aside className="publish-side"><section className="panel launch-panel"><h2>执行方式</h2><div className="mode-picker"><button className={mode === 'draft' ? 'active' : ''} onClick={() => setMode('draft')}><ClipboardList size={18} /><span><strong>保存草稿</strong><small>逐条填充并保存</small></span>{mode === 'draft' && <Check size={17} />}</button><button className={mode === 'submit' ? 'active warning' : ''} onClick={() => setMode('submit')}><CloudUpload size={18} /><span><strong>直接提交</strong><small>填充后自动发布</small></span>{mode === 'submit' && <Check size={17} />}</button></div>
          <dl><div><dt>已选择</dt><dd>{selected.length} 件</dd></div><div><dt>类目任务</dt><dd>{plan.groups.length ? `${plan.groups.length} 组` : '未生成'}</dd></div><div><dt>执行模式</dt><dd>{mode === 'draft' ? '保存草稿' : '直接提交'}</dd></div></dl>
          {pausedJob
            ? <><button className="primary-button publish-button" disabled={busy} onClick={() => resume(pausedJob)}><Play size={18} />继续处理剩余 {Math.max(0, pausedJob.total - pausedJob.progress)} 件</button><button className="secondary-button pause-button" disabled={busy} onClick={() => cancel(pausedJob)}><X size={17} />取消任务</button></>
            : <button className="primary-button publish-button" disabled={!selected.length || Boolean(unresolvedGroups.length) || Boolean(publishing) || !plan.groups.length} onClick={publish}>{publishing ? <LoaderCircle className="spin" size={18} /> : <CloudUpload size={18} />}{publishing ? '任务执行中' : `开始处理 ${selected.length} 件`}</button>}
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
      notify(action === 'pause' ? '暂停请求已发送' : action === 'cancel' ? '任务已取消，已完成数据会保留' : '任务已继续执行');
    } catch (error) { notify(error.message, 'error'); }
  }
  return <section className="panel history-panel"><div className="section-title"><div><h2>最近任务</h2><p>上架执行结果与异常记录</p></div></div>{!jobs.length ? <div className="muted-row">暂无上架任务</div> : jobs.slice(0, 8).map((job) => <div className="history-row" key={job.id}><div className={`history-icon ${job.status}`}>{job.status === 'completed' ? <Check size={16} /> : job.status === 'failed' ? <CircleAlert size={16} /> : job.status === 'paused' ? <Pause size={16} /> : <LoaderCircle className="spin" size={16} />}</div><div><strong>{job.metadata.mode === 'submit' ? '批量直接发布' : '批量保存草稿'}</strong><small>{new Date(job.createdAt).toLocaleString('zh-CN')}</small></div><span>{job.message}</span><b>{job.progress}/{job.total || '-'}</b><div className="history-action">{['queued', 'running'].includes(job.status) && <button className="icon-button" onClick={() => control(job, 'pause')} title="暂停任务"><Pause size={16} /></button>}{job.status === 'pause_requested' && <button className="icon-button" disabled title="正在暂停"><LoaderCircle className="spin" size={16} /></button>}{job.status === 'paused' && <><button className="icon-button" onClick={() => control(job, 'resume')} title="继续任务"><Play size={16} /></button><button className="icon-button danger" onClick={() => control(job, 'cancel')} title="取消任务"><X size={16} /></button></>}</div></div>)}</section>;
}

function SettingsView({ state, refresh, notify, onMenu }) {
  const [form, setForm] = useState({ defaultStock: state.settings.defaultStock ?? 100, priceMarkup: state.settings.priceMarkup ?? 0 });
  const [storage, setStorage] = useState(null);
  useEffect(() => { api('/api/storage').then(setStorage).catch(() => {}); }, []);
  async function save(event) {
    event.preventDefault();
    try { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ defaultStock: Number(form.defaultStock), priceMarkup: Number(form.priceMarkup) }) }); await refresh(); notify('默认规则已保存'); }
    catch (error) { notify(error.message, 'error'); }
  }
  return <><Header title="设置" subtitle="管理新采集商品的默认规则" onMenu={onMenu} /><section className="panel settings-panel"><div className="section-title"><div><h2>采集与定价</h2><p>仅应用于之后读取的新商品</p></div></div><form onSubmit={save} className="settings-form"><label><span>默认库存</span><input type="number" min="0" value={form.defaultStock} onChange={(event) => setForm({ ...form, defaultStock: event.target.value })} /></label><label><span>售价加价比例</span><div className="suffix-input"><input type="number" min="-99" step="0.1" value={form.priceMarkup} onChange={(event) => setForm({ ...form, priceMarkup: event.target.value })} /><b>%</b></div></label><button className="primary-button"><Save size={17} />保存规则</button></form></section><section className="panel storage-panel"><div className="section-title"><div><h2>图片与视频存储目录</h2><p>以下是当前实际使用的本地目录，磁盘不足时可在这里定位并清理临时文件</p></div></div>{storage ? <div className="storage-list"><div><strong>商品工作区</strong><code>{storage.workspace}</code><small>{Math.round((storage.bytes.workspace || 0) / 1024)} KB</small></div><div><strong>采集/上架图片</strong><code>{storage.images}</code><small>{Math.round((storage.bytes.images || 0) / 1024 / 1024 * 10) / 10} MB</small></div><div><strong>视频文件</strong><code>{storage.videos}</code><small>{Math.round((storage.bytes.videos || 0) / 1024 / 1024 * 10) / 10} MB</small></div><div><strong>媒体上传目录</strong><code>{storage.media}</code><small>{Math.round((storage.bytes.media || 0) / 1024 / 1024 * 10) / 10} MB</small></div><p className="batch-help">源码模式默认位于项目目录的 .data；桌面版/安装版位于 Electron userData 目录。删除图片或视频前请确认没有正在执行的上架任务。</p></div> : <div className="muted-row">正在读取存储目录…</div>}</section><section className="panel security-panel"><div className="security-icon"><Eye size={20} /></div><div><h3>浏览器登录数据</h3><p>账号密码不写入商品数据库。My Alibaba 登录状态仅保存在本机独立浏览器目录中。</p></div></section></>;
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
  const refreshInFlight = useRef(null);
  const mounted = useRef(true);
  async function refresh() {
    // State includes captured product details. Keep only one request active so
    // StrictMode and the polling timer cannot queue repeated multi-megabyte
    // JSON parses and React renders in the Electron renderer.
    if (refreshInFlight.current) return refreshInFlight.current;
    const request = api('/api/state')
      .then((nextState) => { if (mounted.current) setState(nextState); return nextState; })
      .catch((error) => { if (mounted.current) setNotice({ text: error.message, type: 'error' }); throw error; })
      .finally(() => { if (refreshInFlight.current === request) refreshInFlight.current = null; });
    refreshInFlight.current = request;
    return request;
  }
  useEffect(() => {
    mounted.current = true;
    refresh().catch(() => {});
    const timer = setInterval(() => refresh().catch(() => {}), 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    const heartbeat = window.kuaYipu?.heartbeat;
    if (!heartbeat) return undefined;
    const timer = setInterval(() => heartbeat().catch(() => {}), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
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
