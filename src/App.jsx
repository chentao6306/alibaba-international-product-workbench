import SoftwareUpdate from './SoftwareUpdate.jsx';
import ReferenceDialog from './ReferenceDialog.jsx';
import ProductEditor from './ProductEditor.jsx';
import BatchImageEditor from './BatchImageEditor.jsx';
import BatchDescriptionEditor from './BatchDescriptionEditor.jsx';
import CategorySelect from './CategorySelect.jsx';
import PublishRecovery from './PublishRecovery.jsx';
import PublishPageView from './PublishPageView.jsx';
import PublishingRiskSetting from './PublishingRiskSetting.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, ClipboardList, CloudUpload,
  ExternalLink, Eye, FolderTree, LayoutDashboard, Link2, LoaderCircle, Menu, PackageCheck,
  Pause, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, Store, Trash2, X, ScanSearch, Package, Globe, Bell
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { SOURCE_PLATFORMS, sourcePlatform, sourcePlatformLabel } from '../server/source-platform.js';
import StorageCleanup from './StorageCleanup.jsx';
import MarketplaceProcessing, { ProcessSelectedProducts } from './MarketplaceProcessing.jsx';
import { useAnnouncements, AnnouncementPopup, AnnouncementsView } from './Announcements.jsx';
import CollectionFolders from './CollectionFolders.jsx';
import CollectionTasks from './CollectionTasks.jsx';
import OriginCountrySelect from './OriginCountrySelect.jsx';
import { productOrigin, synchronizeProductOrigin } from '../server/origin-country.js';
import AuthorizationConnection from './AuthorizationConnection.jsx';
import { publishCounts, productPublishDisplay } from '../server/publish-progress.js';
import { categoryReadiness } from '../server/category-readiness.js';
import { createPublishedReferenceTemplate } from '../server/publish-reference.js';

const EMPTY = { shops: [], groups: [], collectionFolders: [], products: [], jobs: [], settings: {}, browser: {}, collectorBrowser: {} };

function PlatformTabs({ products, value, onChange }) {
  return <div className="platform-tabs" role="tablist" aria-label="来源平台">
    {[{ id: 'all', label: '全部平台' }, ...SOURCE_PLATFORMS].map((platform) => <button type="button" role="tab" aria-selected={value === platform.id} className={value === platform.id ? 'active' : ''} key={platform.id} onClick={() => onChange(platform.id)}>
      {platform.label}<span>{products.filter((product) => platform.id === 'all' || sourcePlatform(product) === platform.id).length}</span>
    </button>)}
  </div>;
}

const COLLECTION_VIEWS = {
  single: { title: '单个商品采集', platform: 'alibaba.com', method: 'product', placeholder: 'https://www.alibaba.com/product-detail/...' },
  image: { title: '以图搜品采集', platform: 'alibaba.com', method: 'image-search', placeholder: 'https://www.alibaba.com/search/page?SearchScene=imageTextSearch&imagePath=...' },
  domestic: { title: '1688 采集', platform: '1688', method: 'product', placeholder: 'https://detail.1688.com/offer/...' },
  aliexpress: { title: '速卖通采集', platform: 'aliexpress', method: 'product', placeholder: 'https://www.aliexpress.com/item/...' },
  madeinchina: { title: '中国制造网采集', platform: 'made-in-china', method: 'product', placeholder: 'https://供应商.en.made-in-china.com/product/商品编号/China-商品名称.html', note: '支持单件、多链接及店铺采集。明确匹配的国际站类目会自动带入；也可引用从1688或国际站采集后已成功上架的同类商品。发布前请核对售价、属性和规格；询价商品需填写售价。' },
};

function LinkCollectionView({ entry, state, refresh, notify, onMenu, navigate, folderId }) {
  const [micMethod, setMicMethod] = useState('product');
  const config = { ...COLLECTION_VIEWS[entry], ...(entry === 'madeinchina' ? { method: micMethod } : {}) };
  const shop = config.method === 'shop-products';
  const [urls, setUrls] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState({ startPage: 1, endPage: 1, maxProducts: 100, delaySeconds: 3 });
  const jobs = state.jobs.filter((job) => job.type === 'collect' && job.metadata?.collectionMethod === config.method && job.metadata?.sourcePlatform === config.platform && job.metadata?.collectionFolderId === folderId);
  const active = jobs.some((job) => ['queued', 'running', 'pause_requested', 'paused'].includes(job.status));
  const running = jobs.some((job) => ['queued', 'running', 'pause_requested'].includes(job.status));
  const products = state.products.filter((product) => product.collectionFolderId === folderId && sourcePlatform(product) === config.platform);
  async function submit(event) {
    event.preventDefault(); setBusy(true);
    try {
      await api('/api/collect/links', { method: 'POST', body: JSON.stringify({ urls, platform: config.platform, method: config.method, collectionFolderId: folderId, ...options }) });
      await refresh(); notify('采集任务已创建');
    } catch (error) { notify(error.message, 'error'); } finally { setBusy(false); }
  }
  async function login() {
    setBusy(true);
    try { await api('/api/collect/login', { method: 'POST', body: JSON.stringify({ platform: config.platform }) }); notify('平台登录页已打开'); }
    catch (error) { notify(error.message, 'error'); } finally { setBusy(false); }
  }
  return <>
    <Header title={config.title} subtitle={`${sourcePlatformLabel({ sourcePlatform: config.platform })} → 阿里巴巴国际站`} onMenu={onMenu} />
    <CollectionFolders {...{ state, folderId, refresh, notify }} />
    <section className="collection-entry">
      <div className="section-title"><h2>{shop ? '店铺链接' : config.method === 'image-search' ? '搜索结果链接' : '商品链接'}</h2>{config.platform !== 'alibaba.com' && <button className="secondary-button" onClick={login} disabled={busy || running}><ExternalLink size={16} />平台登录</button>}</div>
      {config.note && <p className="collection-entry-note">{config.note}</p>}
      <form onSubmit={submit} className="link-collection-form">
        {entry === 'madeinchina' && <label><span>采集方式</span><select aria-label="中国制造网采集方式" disabled={busy || running} value={micMethod} onChange={(event) => { setMicMethod(event.target.value); setUrls(''); }}><option value="product">单个商品 / 多链接批量采集</option><option value="shop-products">店铺 / 店铺商品分组采集</option></select></label>}
        <label><span>{shop ? '店铺首页、商品列表或商品分组链接（一个）' : config.method === 'image-search' ? '国际站以图搜品结果页' : '商品详情页（每行一个）'}</span><textarea aria-label="采集链接" rows={shop || config.method === 'image-search' ? 4 : 7} value={urls} onChange={(event) => setUrls(event.target.value)} placeholder={shop ? 'https://供应商.en.made-in-china.com/' : config.placeholder} required /></label>
        <div className="link-collection-options">
          {(shop || config.method === 'image-search') && [['startPage', '起始页'], ['endPage', '结束页'], ['maxProducts', '商品上限']].map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min="1" max={key === 'maxProducts' ? 1000 : 100} value={options[key]} onChange={(event) => setOptions({ ...options, [key]: Number(event.target.value) })} /></label>)}
          <label><span>采集间隔（秒）</span><input type="number" min="0" max="60" step="0.5" value={options.delaySeconds} onChange={(event) => setOptions({ ...options, delaySeconds: Number(event.target.value) })} /></label>
          <button className="primary-button" disabled={busy || active || !urls.trim() || !folderId}>{busy ? <LoaderCircle size={17} className="spin" /> : <Play size={17} />}{active ? '采集任务未完成' : '开始采集'}</button>
        </div>
      </form>
    </section>
    <div className="collection-summary"><span>当前分组已入库 <strong>{products.length}</strong> 件</span><button className="secondary-button" onClick={() => navigate('products', config.platform)}><Boxes size={16} />查看商品</button></div>
    <JobHistory jobs={jobs} refresh={refresh} notify={notify} />
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
  publishing: ['正在上架', 'blue'],
  publish_paused: ['上架已暂停', 'amber'], publish_pausing: ['正在暂停', 'amber'], publish_queued: ['等待处理', 'neutral'],
  publish_waiting: ['间隔等待中', 'blue'],
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

function SourceView({ state, refresh, notify, onMenu, folderId }) {
  const [url, setUrl] = useState('');
  const [reading, setReading] = useState(false);
  const [collectConfig, setCollectConfig] = useState({ allPages: true, startPage: 1, endPage: 10, delaySeconds: 3, destinationCountry: 'United States', sort: 'default' });
  const [shopPage, setShopPage] = useState(1);
  const [expandedShops, setExpandedShops] = useState({});
  const [groupPages, setGroupPages] = useState({});
  const [selectedShops, setSelectedShops] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const shopPageSize = 4;
  const groupPageSize = 8;
  const shopPageCount = Math.max(1, Math.ceil(state.shops.length / shopPageSize));
  const visibleShops = state.shops.slice((shopPage - 1) * shopPageSize, shopPage * shopPageSize);
  const collectJobs = state.jobs.filter((job) => job.type === 'collect' && job.metadata?.collectionFolderId === folderId && ['queued', 'running', 'pause_requested', 'paused'].includes(job.status));

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
    if (!folderId) return notify('请先新建并选择采集分组', 'error');
    try {
      await api(`/api/groups/${group.id}/collect`, { method: 'POST', body: JSON.stringify({ ...collectConfig, collectionFolderId: folderId }) });
      await refresh(); notify(`已开始读取“${group.name}”`);
    } catch (error) { notify(error.message, 'error'); }
  }

  async function collectMany(groups) {
    if (!folderId) return notify('请先新建并选择采集分组', 'error');
    if (!groups.length) return notify('请先选择分组', 'error');
    try {
      for (const group of groups) await api(`/api/groups/${group.id}/collect`, { method: 'POST', body: JSON.stringify({ ...collectConfig, collectionFolderId: folderId }) });
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
      notify(action === 'collect-discovered' ? '已停止继续翻页，开始采集已发现商品的详情' : action === 'cancel' ? '采集任务已取消，已经保存的商品会保留' : action === 'pause' ? '已请求暂停采集' : '采集任务已继续');
    } catch (error) { notify(error.message, 'error'); }
  }

  return <>
    <Header title="店铺采集" subtitle="读取阿里巴巴国际站同行店铺与商品分组" onMenu={onMenu} />
    <CollectionFolders {...{ state, folderId, refresh, notify }} />
    <div className="metrics">
      <Metric icon={Store} label="同行店铺" value={state.shops.length} detail="已读取" />
      <Metric icon={FolderTree} label="商品分组" value={state.groups.length} detail="可采集" tone="orange" />
      <Metric icon={Boxes} label="当前采集分组" value={state.products.filter((product) => product.collectionFolderId === folderId).length} detail="已入库" tone="teal" />
    </div>
    <section className="panel source-entry">
      <div className="section-title"><div><h2>读取国际站同行店铺</h2><p>支持 *.en.alibaba.com 店铺首页、商品列表和分组链接</p></div></div>
      <form className="url-form" onSubmit={readGroups}>
        <div className="input-with-icon"><Link2 size={18} /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴阿里巴巴国际站同行店铺链接" aria-label="国际站同行店铺链接" /></div>
        <button className="primary-button" disabled={reading}>{reading ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}读取分组</button>
      </form>
      <div className="collection-options">
        <label><span>采集范围</span><select value={collectConfig.allPages ? 'all' : 'range'} onChange={(event) => setCollectConfig((v) => ({ ...v, allPages: event.target.value === 'all', startPage: 1 }))}><option value="all">全部页</option><option value="range">指定页数</option></select></label>
        <label><span>起始页</span><input type="number" min="1" disabled={collectConfig.allPages} value={collectConfig.startPage} onChange={(event) => setCollectConfig((v) => ({ ...v, startPage: event.target.value }))} /></label>
        <label><span>结束页</span><input type="number" min="1" disabled={collectConfig.allPages} value={collectConfig.allPages ? '' : collectConfig.endPage} placeholder={collectConfig.allPages ? '最后一页' : ''} onChange={(event) => setCollectConfig((v) => ({ ...v, endPage: event.target.value }))} /></label>
        <label><span>采集间隔（秒/条）</span><input type="number" min="0" step="0.5" value={collectConfig.delaySeconds} onChange={(event) => setCollectConfig((v) => ({ ...v, delaySeconds: event.target.value }))} /></label>
        <label><span>交货地国家</span><select value={collectConfig.destinationCountry} onChange={(event) => setCollectConfig((v) => ({ ...v, destinationCountry: event.target.value }))}><option>United States</option><option>United Kingdom</option><option>Germany</option><option>Canada</option><option>Australia</option><option>Saudi Arabia</option><option>United Arab Emirates</option><option>全部国家</option></select></label>
        <label><span>排序</span><select value={collectConfig.sort} onChange={(event) => setCollectConfig((v) => ({ ...v, sort: event.target.value }))}><option value="default">默认排序</option><option value="priceAsc">价格从低到高</option><option value="priceDesc">价格从高到低</option><option value="newest">最新商品</option></select></label>
      </div>
    </section>
    <CollectionTasks key={folderId} jobs={collectJobs} onControl={controlCollect} />
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
            <span className={`group-state ${group.status}`}>{group.status === 'collecting' ? '读取中' : group.status === 'done' ? '已完成' : group.status === 'failed' ? '失败' : group.collectedCount > 0 ? '已读取部分' : '未读取'}</span>
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
  if (!product.description && !product.descriptionHtml && !product.hasDescription) missing.push('商品详情');
  const quality = product.quality;
  if (quality && Array.isArray(quality.issues)) {
    const qualityMissing = quality.issues.filter((item) => item.severity === 'error').map((item) => item.message);
    return { main, detail, attributes, tiers, hasPriceRange, variants, skus: product.skuCount ?? (product.skus || []).length, missing: qualityMissing, complete: quality.status !== 'blocked', review: quality.status === 'review', score: quality.score, warnings: quality.warnings, issues: quality.issues };
  }
  const complete = missing.length === 0;
  return { main, detail, attributes, tiers, hasPriceRange, variants, skus: product.skuCount ?? (product.skus || []).length, missing, complete, review: false, score: complete ? 100 : Math.max(0, 100 - missing.length * 12), warnings: 0, issues: [] };
}

function CategoryReadiness({ product }) {
  const check = product.categoryReadiness || categoryReadiness(product);
  const pending = [...check.missing, ...check.conflicts];
  const message = check.status === 'covered' ? `已核对 ${check.checked} 项类目必填资料`
    : check.status === 'incomplete' ? `类目资料待核对：${pending.join('、')}`
    : check.status === 'stale' ? '类目要求需重新核验' : '类目必填项待核验';
  const explanation = check.status === 'covered' ? '本地资料已覆盖最近一次发布页的必填属性，发布时仍会复核当前控件、规格和物流要求。'
    : check.status === 'incomplete' ? '请在商品属性中补充或确认这些字段；发布时会再次读取当前类目要求。'
    : '尚无近期发布页的类目要求记录，不能仅凭已有资料判定可上架。首次发布检查后会更新同类商品。';
  return <small className={pending.length ? 'data-warning' : 'data-counts'} title={explanation}>{message}</small>;
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

function ProductsView({ state, refresh, notify, onMenu, platform, setPlatform, navigate, folderId }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState(null);
  const [loadingEditor, setLoadingEditor] = useState(false);
  const editorRequest = useRef(0);
  const [batchEditing, setBatchEditing] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [refreshingId, setRefreshingId] = useState('');
  const [moveFolderId, setMoveFolderId] = useState('');
  const folderProducts = useMemo(() => state.products.filter((product) => product.collectionFolderId === folderId), [state.products, folderId]);
  const platformProducts = useMemo(() => folderProducts.filter((product) => platform === 'all' || sourcePlatform(product) === platform), [folderProducts, platform]);
  const products = useMemo(() => platformProducts.filter((product) => {
    const matchesQuery = !query || product.title?.toLowerCase().includes(query.toLowerCase()) || product.sourceId?.includes(query);
    const matchesFilter = filter === 'all' || (filter === 'selected' ? product.selected : filter === 'incomplete' ? !productCompleteness(product).complete : productPublishDisplay(product, state.jobs).status === filter);
    return matchesQuery && matchesFilter;
  }), [platformProducts, query, filter, state.jobs]);
  const pageCount = Math.max(1, Math.ceil(products.length / pageSize));
  const pagedProducts = products.slice((page - 1) * pageSize, page * pageSize);
  const allChecked = pagedProducts.length > 0 && pagedProducts.every((item) => item.selected);
  const allProductsSelected = products.length > 0 && products.every((item) => item.selected);
  const selectedProducts = platformProducts.filter((item) => item.selected);
  const referenceEligibleProducts = selectedProducts.filter((product) => product.status !== 'published');
  const wasPublishedSuccessfully = (product) => product.publishedSuccessfully || product.status === 'published'
    || (product.publishHistory || []).some((entry) => ['published', 'submitted', 'success'].includes(String(entry.result?.status || entry.status || '').toLowerCase()));
  const publishedReferenceProducts = state.products.filter(wasPublishedSuccessfully);
  const referenceUnavailableReason = !selectedProducts.length
    ? '请先勾选需要补全资料的商品'
    : !referenceEligibleProducts.length
      ? '已勾选商品均已上架成功，无需引用'
      : '引用成功商品的类目、商品属性、规格及 SKU 信息';

  useEffect(() => { editorRequest.current++; setLoadingEditor(false); setPage(1); setMoveFolderId(''); setEditing(null); setBatchEditing(false); setFindReplaceOpen(false); setReferenceOpen(false); return () => { editorRequest.current++; }; }, [folderId]);
  useEffect(() => { setPage(1); }, [query, filter, pageSize, platform]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  async function select(ids, selected) {
    await api('/api/products/select', { method: 'POST', body: JSON.stringify({ ids, selected }) });
    await refresh();
  }

  async function openEditor(products, batch = false) {
    const request = ++editorRequest.current;
    setLoadingEditor(true);
    try {
      // Read serially so large selections cannot flood the renderer with JSON.
      const details = [];
      for (const product of products) {
        details.push(product.summary ? await api('/api/products/' + encodeURIComponent(product.id)) : product);
        if (request !== editorRequest.current) return;
      }
      if (batch) setBatchEditing(details); else setEditing(details[0]);
    } catch (error) { if (request === editorRequest.current) notify(error.message, 'error'); }
    finally { if (request === editorRequest.current) setLoadingEditor(false); }
  }

  async function selectAllProducts(selected) {
    if (!products.length) return;
    try {
      await api('/api/products/select', { method: 'POST', body: JSON.stringify({ ids: products.map((item) => item.id), selected }) });
      await refresh();
      notify(selected ? `已选择当前结果 ${products.length} 件商品` : '已取消当前结果的选择');
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
    <CollectionFolders {...{ state, folderId, refresh, notify }} />
    <PlatformTabs products={folderProducts} value={platform} onChange={setPlatform} />
    <div className="toolbar">
      <div className="input-with-icon search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或商品 ID" /></div>
      <div className="segmented">{[['all', '全部'], ['selected', '已选择'], ['incomplete', '资料待补'], ['ready', '待上架'], ['publish_paused', '上架已暂停'], ['drafted', '已存草稿'], ['published', '上架成功'], ['publish_failed', '上架失败']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <button className="secondary-button" disabled={!products.length} onClick={() => selectAllProducts(!allProductsSelected)}><Check size={15} />{allProductsSelected ? '取消全选' : `全选当前结果 ${products.length}`}</button>
      {selectedProducts.length > 0 && <button className="primary-button" onClick={() => navigate('publish', platform)}><CloudUpload size={15} />选中商品上架 {selectedProducts.length}</button>}
      <button className="secondary-button" disabled={!platformProducts.length} onClick={() => setFindReplaceOpen(true)}><Search size={15} />查找替换</button>
      {selectedProducts.length > 0 && <button className="primary-button" disabled={loadingEditor} onClick={() => openEditor(selectedProducts, true)}><Pencil size={15} />批量修改 {selectedProducts.length}</button>}
      <button className="secondary-button" disabled={!referenceEligibleProducts.length} title={referenceUnavailableReason} onClick={() => setReferenceOpen(true)}><ClipboardList size={15} />引用成功商品资料</button>
      <ProcessSelectedProducts products={platformProducts} refresh={refresh} notify={notify} />
      {selectedProducts.length > 0 && <button className="secondary-button danger-button" onClick={removeSelected}><Trash2 size={15} />删除已勾选 {selectedProducts.length}</button>}
      {selectedProducts.length > 0 && <div className="move-folder-control"><select aria-label="移动到分组" value={moveFolderId} onChange={(event) => setMoveFolderId(event.target.value)}><option value="">移动到分组</option>{(state.collectionFolders || []).filter((folder) => folder.id !== folderId).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button className="icon-button" title="移动已选商品" disabled={!moveFolderId} onClick={() => api('/api/products/move-folder', { method: 'POST', body: JSON.stringify({ ids: selectedProducts.map((item) => item.id), collectionFolderId: moveFolderId }) }).then(refresh).then(() => notify('商品已移动')).catch((error) => notify(error.message, 'error'))}><FolderTree size={17} /></button></div>}
      <label className="page-size"><span>每页</span><select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label>
      <span className="result-count">共 {products.length} 件</span>
    </div>
    <section className="panel product-panel">
      {!products.length ? <EmptyState icon={Boxes} title="当前分组暂无匹配商品" text="" /> : <div className="table-wrap"><table className="product-table">
        <thead><tr><th className="check-cell"><input type="checkbox" checked={allChecked} onChange={(event) => select(pagedProducts.map((item) => item.id), event.target.checked)} title="勾选本页商品" /></th><th>商品</th><th>资料</th><th>售价</th><th>库存</th><th>状态</th><th className="action-cell">操作</th></tr></thead>
        <tbody>{pagedProducts.map((product) => { const completeness = productCompleteness(product); const display = productPublishDisplay(product, state.jobs); return <tr key={product.id} className={product.selected ? 'selected-row' : ''}>
          <td className="check-cell"><input type="checkbox" checked={Boolean(product.selected)} onChange={(event) => select([product.id], event.target.checked)} /></td>
          <td><div className="product-main"><div className="thumb">{product.mainImage ? <img src={product.mainImage} alt="" /> : <Boxes size={20} />}</div><div><strong>{product.title || '未命名商品'}</strong><small><span className={`platform-label platform-${sourcePlatform(product).replace('.', '-')}`}>{sourcePlatformLabel(product)}</span> ID {product.sourceId}</small></div></div></td>
          <td><span className={`data-status ${completeness.complete ? 'complete' : ''}`} title={completeness.missing.length ? `阻断项：${completeness.missing.join('、')}` : completeness.review ? '来源未公开部分逐SKU数据，需要发布前确认' : '可进入发布检查'}>{!completeness.complete ? `资料阻断 ${completeness.score}` : completeness.review ? `资料待确认 ${completeness.score}` : `资料齐全 ${completeness.score}`}</span><CategoryReadiness product={product} /><small className="data-counts">主 {completeness.main} · 详 {completeness.detail} · 属 {completeness.attributes} · SKU {completeness.skus} · 价 {completeness.tiers || (completeness.hasPriceRange ? '区间' : 0)}</small>{completeness.warnings > 0 && <small className="data-warning">另有 {completeness.warnings} 项待确认</small>}{!completeness.complete && <small className="data-missing">{completeness.missing.join('；')}</small>}</td>
          <td><b className="price">{!product.priceConversion && product.sourcePriceRange?.formattedText || `${product.currencySymbol || '¥'}${product.price || '-'}`}</b></td><td>{product.stock ?? '-'}</td><td><StatusBadge status={display.status} message={display.message} />{(display.jobId || display.status === 'publish_failed') && <small className="data-missing" title={display.message}>{display.message || '未记录失败原因'}</small>}</td>
          <td className="action-cell"><button className="icon-button" disabled={refreshingId === product.id} onClick={() => refreshDetail(product)} title="重新采集完整资料">{refreshingId === product.id ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button><button className="icon-button" disabled={loadingEditor} onClick={() => openEditor([product])} title="编辑完整资料"><Pencil size={17} /></button><button className="icon-button danger" onClick={() => remove(product)} title="删除商品"><Trash2 size={17} /></button></td>
        </tr>; })}</tbody>
      </table></div>}
      {products.length > pageSize && <Pagination page={page} pageCount={pageCount} onPage={setPage} label={`第 ${page}/${pageCount} 页 · 共 ${products.length} 件`} />}
    </section>
    {editing && <ProductEditor product={editing} CategorySelect={CategorySelect} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); notify('商品修改已保存'); }} notify={notify} />}
      {batchEditing && <BatchEditor products={batchEditing} references={publishedReferenceProducts} onClose={() => setBatchEditing(false)} onSaved={async (result) => { setBatchEditing(false); await refresh(); notify(result?.categoryBindingReset ? '批量修改已应用，请重新绑定修改后类目的国际站发布表单' : '批量修改已应用'); }} notify={notify} />}
    {findReplaceOpen && <FindReplaceDialog products={selectedProducts.length ? selectedProducts : platformProducts} onClose={() => setFindReplaceOpen(false)} onSaved={async (result) => { setFindReplaceOpen(false); await refresh(); notify(`已替换 ${result.changedProducts} 件商品，共 ${result.total} 处`); }} notify={notify} />}
    {referenceOpen && <ReferenceDialog products={referenceEligibleProducts} references={publishedReferenceProducts} onClose={() => setReferenceOpen(false)} onSaved={async (result) => { setReferenceOpen(false); await refresh(); notify(`已引用类目、属性和规格，更新 ${result.changed.length} 件商品`); }} notify={notify} />}
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

function BatchEditor({ products, references, onClose, onSaved, notify }) {
  const [imageGuard, setImageGuard] = useState({ busy: false, dirty: false });
  function closeBatch() {
    if (imageGuard.busy) return notify('正在处理，请稍候', 'error');
    if (!imageGuard.dirty || window.confirm('修改尚未保存，确认放弃？')) onClose();
  }
  const [usdRate, setUsdRate] = useState('');
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
      if (usdRate) patch.usdRate = usdRate;
      if (Number(form.pricePercent) || Number(form.priceFixed)) patch.priceTransform = { percent: Number(form.pricePercent || 0), fixed: Number(form.priceFixed || 0) };
      if (form.priceMode) patch.priceMode = form.priceMode;
      if (form.stock !== '') patch.stock = Number(form.stock);
      if (form.moq !== '') patch.moq = Number(form.moq);
      if (form.deliveryDays !== '') patch.deliveryTime = [['1', form.deliveryDays], ['999999', form.deliveryDays]];
      if (form.skuPrice !== '' || form.skuStock !== '') patch.skuTransform = { price: form.skuPrice === '' ? null : Number(form.skuPrice), stock: form.skuStock === '' ? null : Number(form.skuStock) };
      if (form.fobMinPrice !== '' || form.fobMaxPrice !== '') patch.fobPrice = { minPrice: Number(form.fobMinPrice || 0), maxPrice: Number(form.fobMaxPrice || 0), currencySymbol: '$' };
      if (Array.isArray(form.skuRows) && form.skuRows.length) patch.skuRows = form.skuRows;
    } else if (tab === 'logistics') {
      const packaging = Object.fromEntries(['weight', 'length', 'width', 'height'].filter((key) => form[key] !== '').map((key) => [key, Number(form[key])]));
      if (Object.keys(packaging).length) patch.packaging = packaging;
      if (form.origin) patch.origin = form.origin;
    }
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
  function currentCategory(product) { return [...(product.categoryPath || product.sourceCategoryPath || [])].join(' >> ') || '未设置'; }
  function previewFor(product) {
    if (tab === 'category') return { current: currentCategory(product), next: form.category || '请选择新类目' };
    if (tab === 'basic') return {
      current: `${product.title || '未命名商品'}${form.origin ? ` · 产地：${productOrigin(product) || '未设置'}` : ''}`,
      next: `${form.titlePrefix || ''}${product.title || '未命名商品'}${form.titleSuffix || ''}${form.origin ? ` · 产地：${form.origin}` : ''}`
    };
    if (tab === 'trade') return { current: `价格 ${product.price || '-'} · 库存 ${product.stock ?? '-'} · 起订 ${product.moq || '-'}`, next: `价格 ${(Number(product.price || 0) * (1 + Number(form.pricePercent || 0) / 100) + Number(form.priceFixed || 0)).toFixed(2)} · 库存 ${form.stock || product.stock || '-'} · 起订 ${form.moq || product.moq || '-'}` };
    if (tab === 'logistics') return { current: `原产地 ${productOrigin(product) || '-'} · 重量 ${product.packaging?.weight || '-'}kg · ${product.packaging?.length || '-'}×${product.packaging?.width || '-'}×${product.packaging?.height || '-'}cm`, next: `原产地 ${form.origin || productOrigin(product) || '-'} · 重量 ${form.weight || product.packaging?.weight || '-'}kg · ${form.length || product.packaging?.length || '-'}×${form.width || product.packaging?.width || '-'}×${form.height || product.packaging?.height || '-'}cm` };
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
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeBatch(); }}><aside className="drawer batch-drawer">
    <div className="drawer-header"><div><span>{locale === 'en' ? 'Batch edit' : '批量修改'}</span><h2>{locale === 'en' ? `${products.length} products selected` : `已选择 ${products.length} 件商品`}</h2></div><div className="drawer-header-actions"><div className="locale-switch"><button type="button" className={locale === 'zh' ? 'active' : ''} onClick={() => setLocale('zh')}>中文</button><button type="button" className={locale === 'en' ? 'active' : ''} onClick={() => setLocale('en')}>English</button></div><button className="icon-button" onClick={closeBatch} title="关闭"><X size={20} /></button></div></div>
    <div className="batch-tabs">{tabs.map(([value]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => { if (value !== tab && (imageGuard.busy || imageGuard.dirty)) return notify('请先保存修改或放弃未保存修改', 'error'); setTab(value); }}>{tabLabels[value]?.[locale === 'en' ? 1 : 0] || value}</button>)}</div>
    <div className="batch-body">
      {tab === 'trade' && products.some((product) => product.currencySymbol !== '$') && <label className="batch-field"><span>换算汇率（1 原币 = 多少美元）</span><input type="number" min="0.000001" step="any" value={usdRate} onChange={(event) => setUsdRate(event.target.value)} />{usdRate && <small>仅换算尚未转为美元的商品</small>}</label>}
      {tab === 'basic' && <>{field('标题前缀', 'titlePrefix')}{field('标题后缀', 'titleSuffix')}{field('统一副标题', 'subtitle')}{field('关键词（逗号或换行分隔）', 'keywords', 'text', true)}<label className="batch-field"><span>原产地（国家）</span><OriginCountrySelect value={form.origin} emptyLabel="保持原产地" onChange={(origin) => setForm((current) => ({ ...current, origin }))} /></label>{field('品牌', 'brand')}{field('产品类型', 'productType')}</>}
      {tab === 'category' && <><div className="batch-field"><span>选择新产品类目</span><CategorySelect path={form.category} categoryId={form.categoryId} onChange={(option) => setForm((v) => ({ ...v, category: option.path, categoryId: option.id }))} /></div><label className="batch-field"><span>类目 ID（由选择或发布页绑定生成）</span><input value={form.categoryId} readOnly placeholder="选择类目后自动填充" /></label><div className="batch-actions"><button type="button" className="secondary-button" onClick={() => setReferenceOpen(true)}><ClipboardList size={16} />引用成功商品资料</button><small className="batch-help">选择成功商品，引用其类目、商品属性和完整规格。</small></div></>}
      {tab === 'trade' && <><label className="batch-field"><span>定价模式</span><select value={form.priceMode || ''} onChange={update('priceMode')}><option value="">保持原模式</option><option value="fob-range">FOB区间价格</option><option value="fob-tier">FOB阶梯价格</option><option value="quantity-tier">数量阶梯价格</option><option value="sku">SKU定价</option></select></label>{field('价格调整比例（%）', 'pricePercent', 'number')}{field('统一加减金额', 'priceFixed', 'number')}{field('统一库存', 'stock', 'number')}{field('统一起订量', 'moq', 'number')}{field('统一交期（天）', 'deliveryDays', 'number')}<div className="form-grid">{field('FOB最低价', 'fobMinPrice', 'number')}{field('FOB最高价', 'fobMaxPrice', 'number')}</div>{field('SKU统一价格', 'skuPrice', 'number')}{field('SKU统一库存', 'skuStock', 'number')}<div className="batch-actions"><button type="button" className="secondary-button" onClick={exportSku}>导出 SKU Excel</button><label className="file-button secondary-button">导入 SKU Excel<input type="file" accept=".xlsx,.xls,.csv,.txt" onChange={importSku} /></label></div></>}
      {tab === 'logistics' && <><label className="batch-field"><span>原产地（国家）</span><OriginCountrySelect value={form.origin} emptyLabel="保持原产地" onChange={(origin) => setForm((current) => ({ ...current, origin }))} /></label>{field('毛重（kg）', 'weight', 'number')}{field('包装长（cm）', 'length', 'number')}{field('包装宽（cm）', 'width', 'number')}{field('包装高（cm）', 'height', 'number')}</>}
      {(tab === 'description' || tab === 'service') && field('批量追加内容', 'description', 'text', true)}
      {(tab === 'attributes' || tab === 'custom') && <><label className="batch-field"><span>修改方式</span><select value={form.attrMode} onChange={update('attrMode')}><option value="upsert">更新同名属性，不存在则新增</option><option value="append">追加属性</option><option value="replace">清空后只保留本属性</option></select></label>{field('属性名称', 'attrName')}{field('属性值', 'attrValue')}</>}
      {tab === 'specs' && <><label className="batch-field"><span>修改方式</span><select value={form.specMode} onChange={update('specMode')}><option value="upsert">更新同名规格，不存在则新增</option><option value="append">追加规格</option><option value="replace">清空后只保留本规格</option></select></label>{field('规格名称', 'specName')}{field('规格选项（逗号分隔）', 'specOption')}</>}
      {tab === 'images' && <BatchImageEditor products={products} onSaved={onSaved} notify={notify} onGuardChange={setImageGuard} />}
      {tab === 'detail' && <BatchDescriptionEditor products={products} onSaved={onSaved} notify={notify} onGuardChange={setImageGuard} />}
      {tab === 'regional' && <><label className="batch-field"><span>销售国家/地区</span><OriginCountrySelect ariaLabel="定价国家/地区" value={form.country} onChange={(country) => setForm((current) => ({ ...current, country }))} /></label>{field('该地区价格', 'countryPrice', 'number')}</>}
    </div>
    {!['images', 'detail'].includes(tab) && <><div className="batch-preview"><div className="batch-preview-title"><strong>修改预览</strong><span>先确认每个商品的当前值和修改后值，再点击保存</span></div><div className="batch-preview-table"><div className="batch-preview-head"><span>商品名称</span><span>旧值-修改前</span><span>新值-修改后</span></div>{products.map((product) => { const row = previewFor(product); return <div className="batch-preview-row" key={product.id}><strong title={product.title}>{product.title || '未命名商品'}</strong><span title={row.current}>{row.current}</span><span className={row.next.includes('等待') || row.next.includes('请选择') ? 'pending' : ''} title={row.next}>{row.next}</span></div>; })}</div></div>
    <div className="drawer-actions"><button type="button" className="secondary-button" onClick={closeBatch}>取消</button><button className="primary-button" onClick={apply}><Save size={17} />应用到 {products.length} 件商品</button></div></>}
  </aside>{referenceOpen && <ReferenceDialog products={products} references={references} onClose={() => setReferenceOpen(false)} onSaved={onSaved} notify={notify} />}</div>;
}


function PublishView({ state, refresh, notify, onMenu, platform, setPlatform, folderId }) {
  const allSelected = state.products.filter((item) => item.selected && item.collectionFolderId === folderId);
  const selected = allSelected.filter((item) => platform === 'all' || sourcePlatform(item) === platform);
  const [mode, setMode] = useState(state.settings.publishMode || 'submit');
  const [listingMode, setListingMode] = useState(state.settings.listingMode || 'auto');
  const [publishDelayMinSeconds, setPublishDelayMinSeconds] = useState(Number(state.settings.publishDelayMinSeconds || 0));
  const [publishDelayMaxSeconds, setPublishDelayMaxSeconds] = useState(Number(state.settings.publishDelayMaxSeconds || 0));
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState({ groups: [], bindings: [] });
  const [planError, setPlanError] = useState('');
  const [planLoading, setPlanLoading] = useState(false);
  const [planRetry, setPlanRetry] = useState(0);
  const [sellerGroups, setSellerGroups] = useState([]);
  const [sellerGroupId, setSellerGroupId] = useState('');
  const [groupsLoading, setGroupsLoading] = useState(false);
  const sellerGroup = sellerGroups.find((group) => group.id === sellerGroupId) || null;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(selected.length / 30));
  const selectionKey = JSON.stringify(selected.map((item) => [item.id, item.categoryId, item.categoryPath, item.updatedAt]));
  const publishing = state.jobs.find((job) => job.type === 'publish' && ['queued', 'running', 'pause_requested'].includes(job.status));
  const pausedJob = !publishing && state.jobs.find((job) => job.type === 'publish' && job.status === 'paused');
  const currentJob = publishing || pausedJob;
  const delayValid = String(publishDelayMinSeconds).trim() !== '' && String(publishDelayMaxSeconds).trim() !== ''
    && Number.isFinite(Number(publishDelayMinSeconds)) && Number.isFinite(Number(publishDelayMaxSeconds))
    && Number(publishDelayMinSeconds) >= 0 && Number(publishDelayMaxSeconds) <= 300
    && Number(publishDelayMaxSeconds) >= Number(publishDelayMinSeconds);
  useEffect(() => {
    if (currentJob) {
      setListingMode(currentJob.metadata?.listingMode || 'complete-logistics');
      setPublishDelayMinSeconds(Number(currentJob.metadata?.publishDelay?.minSeconds || 0));
      setPublishDelayMaxSeconds(Number(currentJob.metadata?.publishDelay?.maxSeconds || 0));
      setMode(currentJob.metadata?.mode === 'submit' ? 'submit' : 'draft');
    }
  }, [currentJob?.id, currentJob?.metadata?.listingMode, currentJob?.metadata?.publishDelay?.minSeconds, currentJob?.metadata?.publishDelay?.maxSeconds]);
  useEffect(() => {
    let active = true;
    setPlanLoading(true); setPlanError('');
    api('/api/publish/plan', { method: 'POST', body: JSON.stringify({ ids: selected.map((item) => item.id) }) })
      .then((value) => { if (active) setPlan(value); })
      .catch((error) => { if (active) { setPlan({ groups: [], bindings: [] }); setPlanError(error.message); } })
      .finally(() => { if (active) setPlanLoading(false); });
    return () => { active = false; };
  }, [selectionKey, planRetry]);
  useEffect(() => { setPage(1); }, [platform, folderId]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const unresolvedGroups = plan.groups.filter((group) => group.error || !group.url);
  const automaticGroups = plan.groups.filter((group) => !group.error && group.url);

  async function run(action, success) {
    setBusy(true);
    try { await action(); await refresh(); notify(success); } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!delayValid) return notify('上架间隔须为 0 至 300 秒，最长时间不能小于最短时间', 'error');
    if (mode === 'submit' && !window.confirm(`将自动提交 ${selected.length} 件商品到阿里巴巴国际站，确定继续吗？`)) return;
    if (groupsLoading) return;
    run(() => api('/api/publish', { method: 'POST', body: JSON.stringify({ ids: selected.map((item) => item.id), mode, listingMode, publishDelayMinSeconds, publishDelayMaxSeconds, collectionFolderId: folderId, sellerGroup }) }), '批量上架任务已开始');
  }
  async function retryFailed(products) {
    if (!delayValid) return notify('请检查上架间隔设置', 'error');
    if (mode === 'submit' && !window.confirm('将重新提交所选的 ' + products.length + ' 件失败商品，确定继续吗？')) return;
    await run(() => api('/api/publish', { method: 'POST', body: JSON.stringify({ ids: products.map((item) => item.id), failedOnly: true, mode, listingMode, publishDelayMinSeconds, publishDelayMaxSeconds, collectionFolderId: folderId, sellerGroup }) }), '失败商品重试任务已开始');
  }
  async function loadSellerGroups() {
    setGroupsLoading(true);
    try {
      const { groups } = await api(`/api/seller/product-groups?categoryId=${encodeURIComponent(plan.groups.find((group) => group.categoryId)?.categoryId || '')}`);
      setSellerGroups(groups);
      if (!groups.some((group) => group.id === sellerGroupId)) setSellerGroupId('');
      notify(groups.length ? `已读取 ${groups.length} 个国际站分组` : '国际站账号尚未设置商品分组');
    } catch (error) { notify(error.message, 'error'); }
    finally { setGroupsLoading(false); }
  }
  function pause(job) {
    run(() => api(`/api/jobs/${job.id}/pause`, { method: 'POST' }), '暂停请求已发送');
  }
  function resume(job) {
    if (!delayValid) return notify('上架间隔须为 0 至 300 秒，最长时间不能小于最短时间', 'error');
    run(() => api(`/api/jobs/${job.id}/resume`, { method: 'POST', body: JSON.stringify({ listingMode, publishDelayMinSeconds, publishDelayMaxSeconds }) }), '任务已继续执行');
  }
  function cancel(job) {
    run(() => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }), '任务已取消，已完成数据会保留');
  }
  return <>
    <Header title="上架任务" subtitle="发布到阿里巴巴国际站" onMenu={onMenu} />
    <CollectionFolders {...{ state, folderId, refresh, notify }} />
    <PlatformTabs products={allSelected} value={platform} onChange={setPlatform} />
    <div className="publish-layout">
      <div className="publish-main">
        <PublishRecovery products={state.products.filter((item) => item.collectionFolderId === folderId && (platform === 'all' || sourcePlatform(item) === platform))} disabled={busy || Boolean(currentJob) || groupsLoading} onRetry={retryFailed} refresh={refresh} notify={notify} />
        <section className="publish-categories">
          <div className="category-summary"><h2>目标类目</h2><span>{planLoading ? '正在读取' : `${automaticGroups.length} 组已就绪`}</span></div>
          {planError && <div className="category-warning"><CircleAlert size={17} /><span>类目预览失败：{planError}</span><button className="icon-button" onClick={() => setPlanRetry((value) => value + 1)} title="重新读取类目"><RefreshCw size={16} /></button></div>}
          {automaticGroups.map((group) => <div className="category-plan-row" key={group.key}><span>{sourcePlatformLabel({ sourcePlatform: group.sourcePlatform })}</span><strong>{group.category || group.categoryId}</strong><b>{group.products.length} 件</b></div>)}
          {unresolvedGroups.length > 0 && <div className="category-warning"><CircleAlert size={17} /><span>{unresolvedGroups.reduce((sum, group) => sum + group.products.length, 0)} 件商品待确认类目，启动后逐件检查。</span></div>}
        </section>
        <section className="panel queue-panel"><div className="section-title"><div><h2>待上架商品</h2></div><strong className="queue-count">{selected.length} 件</strong></div>
          {!selected.length ? <EmptyState icon={PackageCheck} title="上架队列为空" text="" /> : <div className="queue-list">{selected.slice((page - 1) * 30, page * 30).map((product) => {
            const display = productPublishDisplay(product, state.jobs);
            return <div className="queue-item" key={product.id}><div className="mini-thumb">{product.mainImage ? <img src={product.mainImage} alt="" /> : <Boxes size={18} />}</div><div><strong>{product.title}</strong><small><span className="platform-label">{sourcePlatformLabel(product)}</span> {display.message || `${product.currencySymbol || '¥'}${product.price} · 库存 ${product.stock ?? '-'}`}</small></div><StatusBadge status={display.status} message={display.message} /></div>;
          })}</div>}
          {pageCount > 1 && <Pagination page={page} pageCount={pageCount} onPage={setPage} label={`第 ${page}/${pageCount} 页`} />}
        </section>
      </div>
      <aside className="publish-side"><section className="panel launch-panel"><h2>执行方式</h2><div className="mode-picker"><button className={mode === 'draft' ? 'active' : ''} onClick={() => setMode('draft')}><ClipboardList size={18} /><span><strong>保存草稿</strong><small>逐条填充并保存</small></span>{mode === 'draft' && <Check size={17} />}</button><button className={mode === 'submit' ? 'active warning' : ''} onClick={() => setMode('submit')}><CloudUpload size={18} /><span><strong>直接提交</strong><small>填充后自动发布</small></span>{mode === 'submit' && <Check size={17} />}</button></div>
          <dl><div><dt>已选择</dt><dd>{selected.length} 件</dd></div><div><dt>来源平台</dt><dd>{platform === 'all' ? '全部平台' : sourcePlatformLabel({ sourcePlatform: platform })}</dd></div><div><dt>类目任务</dt><dd>{planLoading ? '读取中' : planError ? '预览失败' : plan.groups.length ? `${plan.groups.length} 组` : '启动后检查'}</dd></div><div><dt>执行模式</dt><dd>{mode === 'draft' ? '保存草稿' : '直接提交'}</dd></div></dl>
          <p className="batch-help">上架仅使用已保存的商品资料，不会自动重新采集。缺少资料时，请在商品工作台编辑补充或主动重新采集。</p>
          <p className="batch-help">单个商品出错会记录原因并继续下一件，不会自动暂停整批。主图接收不完整会自动重试；提交结果待核对的商品不会自动重复提交。</p>
          <div className="seller-group-picker"><label htmlFor="seller-group">国际站目标分组</label><div><select id="seller-group" disabled={groupsLoading || Boolean(currentJob)} value={currentJob?.metadata?.sellerGroup?.id || sellerGroupId} onChange={(event) => setSellerGroupId(event.target.value)}><option value="">不指定分组</option>{currentJob?.metadata?.sellerGroup && !sellerGroups.some((group) => group.id === currentJob.metadata.sellerGroup.id) && <option value={currentJob.metadata.sellerGroup.id}>{currentJob.metadata.sellerGroup.path}</option>}{sellerGroups.map((group) => <option key={group.id} value={group.id}>{group.path}</option>)}</select><button className="icon-button" title="读取国际站分组" disabled={groupsLoading || Boolean(publishing)} onClick={loadSellerGroups}><RefreshCw size={18} className={groupsLoading ? 'spin' : ''} /></button></div></div>
          <div className="seller-group-picker"><label htmlFor="listing-mode">销售方式</label><select id="listing-mode" disabled={Boolean(publishing) || busy} value={listingMode} onChange={(event) => setListingMode(event.target.value)}><option value="auto">自动判断（推荐）</option><option value="inquiry">询盘展示（商机品）</option><option value="complete-logistics">填写完整物流资料</option></select><p className="batch-help">{listingMode === 'auto' ? '资料齐全时填写完整物流；缺少运输资料且平台允许商机品时，自动按询盘展示发布，已有包装资料保留在详情中。' : listingMode === 'inquiry' ? '按商机品正式发布，包装资料保留在详情中，运费由询价时确认。无须删除商品中已有的包装重量和尺寸。' : '完整物流会检查包装、物流属性和运费设置；全部留空也不能视为完整。资料不足可改选自动判断，保留已有包装资料。'}</p>{pausedJob && <p className="batch-help">暂停期间可调整销售方式，继续后仅用于剩余商品，已成功的商品不会重新发布。</p>}<p className="batch-help">{(currentJob?.metadata?.stockPolicy || state.settings.stockPolicy || 'minimum-order') === 'minimum-order' ? '未公开库存时，默认可售数量按起订量设置；保留手工库存。' : '使用已保存的库存和默认库存规则。'}</p></div>
          <div className="seller-group-picker"><label>商品间随机上架间隔（秒）</label><div className="inline-fields"><input aria-label="随机间隔最短秒数" type="number" min="0" max="300" step="0.5" disabled={Boolean(publishing) || busy} value={publishDelayMinSeconds} onChange={(event) => setPublishDelayMinSeconds(event.target.value)} /><span>至</span><input aria-label="随机间隔最长秒数" type="number" min="0" max="300" step="0.5" disabled={Boolean(publishing) || busy} value={publishDelayMaxSeconds} onChange={(event) => setPublishDelayMaxSeconds(event.target.value)} /></div><p className="batch-help">0 至 0 表示关闭；相同数值为固定间隔，最多 300 秒。开始或继续任务时会记住设置，暂停后可调整。验证码仍需人工完成。</p>{!delayValid && <p className="data-missing">最长时间须大于或等于最短时间，且都在 0 至 300 秒内。</p>}</div>
          {pausedJob
            ? <><button className="primary-button publish-button" disabled={busy} onClick={() => resume(pausedJob)}><Play size={18} />继续处理剩余 {Math.max(0, pausedJob.total - pausedJob.progress)} 件</button><button className="secondary-button pause-button" disabled={busy} onClick={() => cancel(pausedJob)}><X size={17} />取消任务</button></>
            : <button className="primary-button publish-button" disabled={busy || groupsLoading || !selected.length || Boolean(publishing)} onClick={publish}>{publishing || busy ? <LoaderCircle className="spin" size={18} /> : <CloudUpload size={18} />}{publishing ? '任务执行中' : `开始处理 ${selected.length} 件`}</button>}
          {publishing && <button className="secondary-button pause-button" disabled={busy || publishing.status === 'pause_requested'} onClick={() => pause(publishing)}><Pause size={17} />{publishing.status === 'pause_requested' ? '正在暂停' : '暂停任务'}</button>}
          {currentJob && <><PublishCounts job={currentJob} /><div className="compact-progress"><div><span>{currentJob.message}</span><b>{currentJob.progress}/{currentJob.total}</b></div><div className="progress"><i style={{ width: currentJob.total ? `${currentJob.progress / currentJob.total * 100}%` : '10%' }} /></div></div></>}
        </section></aside>
    </div>
    <JobHistory jobs={state.jobs.filter((job) => job.type === 'publish' && (job.metadata?.collectionFolderId === folderId || job.metadata?.productIds?.some((id) => state.products.some((product) => product.id === id && product.collectionFolderId === folderId))) && (platform === 'all' || job.metadata?.sourcePlatforms?.includes(platform)))} refresh={refresh} notify={notify} />
  </>;
}

function PublishCounts({ job }) {
  const counts = publishCounts(job);
  if (job.type !== 'publish') return null;
  if (!job.results && job.progress > 0) return <div className="publish-counts">已处理 {job.progress} 件</div>;
  return <div className="publish-counts" aria-live="polite"><span className="success">{job.metadata?.mode === 'draft' ? '草稿成功' : '成功'} <b>{counts.success}</b></span><span className="failure">失败 <b>{counts.failed}</b></span><span>剩余 <b>{counts.remaining}</b></span>{counts.skipped > 0 && <span>跳过 <b>{counts.skipped}</b></span>}</div>;
}

function JobHistory({ jobs, refresh, notify }) {
  const [viewingJob, setViewingJob] = useState(null);
  async function control(job, action) {
    try {
      await api(`/api/jobs/${job.id}/${action}`, { method: 'POST' });
      await refresh();
      notify(action === 'pause' ? '暂停请求已发送' : action === 'cancel' ? '任务已取消，已完成数据会保留' : '任务已继续执行');
    } catch (error) { notify(error.message, 'error'); }
  }
  return <section className="panel history-panel"><div className="section-title"><h2>最近任务</h2></div>
    {!jobs.length ? <div className="muted-row">暂无任务</div> : jobs.slice(0, 8).map((job) => <div className="history-entry" key={job.id}>
      <div className="history-row">
        <div className={`history-icon ${job.status}`}>{job.status === 'completed' ? <Check size={16} /> : job.status === 'failed' ? <CircleAlert size={16} /> : ['paused', 'cancelled'].includes(job.status) ? <Pause size={16} /> : <LoaderCircle className="spin" size={16} />}</div>
        <div><strong>{job.type === 'collect' ? `${sourcePlatformLabel({ sourcePlatform: job.metadata?.sourcePlatform })} ${job.metadata?.collectionMethod === 'image-search' ? '以图搜品采集' : '商品采集'}` : job.metadata?.mode === 'submit' ? '批量直接发布' : '批量保存草稿'}</strong><small>{new Date(job.createdAt).toLocaleString('zh-CN')}</small></div>
        <div className="history-progress"><span>{job.message}</span><PublishCounts job={job} /></div><b>{job.progress}/{job.total || '-'}</b>
        <div className="history-action">
          {job.type === 'publish' && job.status === 'paused' && <button className="icon-button" onClick={() => setViewingJob(job)} title="查看暂停画面" aria-label="查看暂停画面"><Eye size={16} /></button>}
          {['queued', 'running'].includes(job.status) && <button className="icon-button" onClick={() => control(job, 'pause')} title="暂停任务"><Pause size={16} /></button>}
          {job.status === 'pause_requested' && <button className="icon-button" disabled title="正在暂停"><LoaderCircle className="spin" size={16} /></button>}
          {job.status === 'paused' && <><button className="icon-button" onClick={() => control(job, 'resume')} title="继续任务"><Play size={16} /></button><button className="icon-button danger" onClick={() => control(job, 'cancel')} title="取消任务"><X size={16} /></button></>}
        </div>
      </div>
      {job.metadata?.failures?.length > 0 && <details className="collection-failures"><summary>失败链接（{job.metadata.failures.length}）</summary>{job.metadata.failures.map((failure, index) => <div key={index}><a href={failure.url} target="_blank" rel="noreferrer">{failure.source}</a><span>{failure.error}</span></div>)}</details>}
    </div>)}
    {viewingJob && <PublishPageView job={viewingJob} request={api} onClose={() => setViewingJob(null)} />}
  </section>;
}

function SettingsView({ state, refresh, notify, onMenu }) {
  const [form, setForm] = useState({ stockPolicy: state.settings.stockPolicy || 'minimum-order', defaultStock: state.settings.defaultStock ?? 100, priceMarkup: state.settings.priceMarkup ?? 0 });
  const [storage, setStorage] = useState(null);
  useEffect(() => { api('/api/storage').then(setStorage).catch(() => {}); }, []);
  async function save(event) {
    event.preventDefault();
    try { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ stockPolicy: form.stockPolicy, defaultStock: Number(form.defaultStock), priceMarkup: Number(form.priceMarkup) }) }); await refresh(); notify('默认规则已保存'); }
    catch (error) { notify(error.message, 'error'); }
  }
  return <><Header title="设置" subtitle="管理新采集商品的默认规则" onMenu={onMenu} /><SoftwareUpdate /><section className="panel settings-panel"><div className="section-title"><div><h2>采集与定价</h2><p>库存规则用于未公开库存的商品，手工填写的库存始终保留；加价规则仅用于新商品</p></div></div><form onSubmit={save} className="settings-form"><label><span>来源未公开库存时</span><select aria-label="来源未公开库存时" value={form.stockPolicy} onChange={(event) => setForm({ ...form, stockPolicy: event.target.value })}><option value="minimum-order">按商品起订量设置默认值</option><option value="fixed">使用固定默认库存</option></select></label><label><span>固定默认库存</span><input type="number" min="0" value={form.defaultStock} onChange={(event) => setForm({ ...form, defaultStock: event.target.value })} /></label><label><span>售价加价比例</span><div className="suffix-input"><input type="number" min="-99" step="0.1" value={form.priceMarkup} onChange={(event) => setForm({ ...form, priceMarkup: event.target.value })} /><b>%</b></div></label><button className="primary-button"><Save size={17} />保存规则</button></form></section><PublishingRiskSetting settings={state.settings} request={api} refresh={refresh} notify={notify} /><MarketplaceProcessing notify={notify} /><StorageCleanup refresh={refresh} notify={notify} onCleaned={() => api('/api/storage').then(setStorage)} /><section className="panel storage-panel"><div className="section-title"><div><h2>图片与视频存储目录</h2><p>以下是当前实际使用的本地目录，磁盘不足时可在这里定位并清理临时文件</p></div></div>{storage ? <div className="storage-list"><div><strong>商品工作区</strong><code>{storage.workspace}</code><small>{Math.round((storage.bytes.workspace || 0) / 1024)} KB</small></div><div><strong>采集/上架图片</strong><code>{storage.images}</code><small>{Math.round((storage.bytes.images || 0) / 1024 / 1024 * 10) / 10} MB</small></div><div><strong>视频文件</strong><code>{storage.videos}</code><small>{Math.round((storage.bytes.videos || 0) / 1024 / 1024 * 10) / 10} MB</small></div><div><strong>媒体上传目录</strong><code>{storage.media}</code><small>{Math.round((storage.bytes.media || 0) / 1024 / 1024 * 10) / 10} MB</small></div><p className="batch-help">删除图片或视频前请确认没有正在执行的上架任务。</p></div> : <div className="muted-row">正在读取存储目录…</div>}</section><section className="panel security-panel"><div className="security-icon"><Eye size={20} /></div><div><h3>浏览器登录数据</h3><p>账号密码不写入商品数据库。My Alibaba 登录状态仅保存在本机独立浏览器目录中。</p></div></section></>;
}

const NAV = [
  { id: 'source', label: '店铺采集', icon: LayoutDashboard },
  { id: 'single', label: '单个商品采集', icon: Package },
  { id: 'image', label: '以图搜品采集', icon: ScanSearch },
  { id: 'domestic', label: '1688 采集', icon: Store },
  { id: 'aliexpress', label: '速卖通采集', icon: Globe },
  { id: 'madeinchina', label: '中国制造网采集', icon: Store },
  { id: 'products', label: '商品工作台', icon: Boxes },
  { id: 'publish', label: '上架任务', icon: CloudUpload },
  { id: 'announcements', label: '公告', icon: Bell },
  { id: 'settings', label: '设置', icon: Settings }
];

export default function App() {
  const inbox = useAnnouncements();
  const [state, setState] = useState(EMPTY);
  const [view, setView] = useState('source');
  const [platform, setPlatform] = useState('all');
  const [notice, setNotice] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const refreshInFlight = useRef(null);
  const stateRevision = useRef('');
  const mounted = useRef(true);
  async function refresh() {
    // State includes captured product details. Keep only one request active so
    // StrictMode and the polling timer cannot queue repeated multi-megabyte
    // JSON parses and React renders in the Electron renderer.
    if (refreshInFlight.current) return refreshInFlight.current;
    const request = api(`/api/state?view=summary&revision=${encodeURIComponent(stateRevision.current)}`)
      .then((nextState) => {
        if (mounted.current) {
          stateRevision.current = nextState.revision;
          setState((previous) => nextState.unchanged
            ? { ...previous, jobs: nextState.jobs, browser: nextState.browser, collectorBrowser: nextState.collectorBrowser }
            : nextState);
        }
        return nextState;
      })
      .catch((error) => { if (mounted.current) setNotice({ text: error.message, type: 'error' }); throw error; })
      .finally(() => { if (refreshInFlight.current === request) refreshInFlight.current = null; });
    refreshInFlight.current = request;
    return request;
  }
  useEffect(() => {
    mounted.current = true;
    refresh().catch(() => {});
    const timer = setInterval(() => refresh().catch(() => {}), 1500);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  function notify(text, type = 'success') { setNotice({ text, type }); setTimeout(() => setNotice(null), 4200); }
  function navigate(id, nextPlatform) { setView(id); if (nextPlatform) setPlatform(nextPlatform); setMenuOpen(false); }
  const folderId = state.settings.activeCollectionFolderId || '';
  const props = { state, refresh, notify, platform, setPlatform, navigate, folderId, onMenu: () => setMenuOpen(true) };
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}><div className="brand"><img className="brand-logo" src="/brand.png" alt="抄得快" /><span><strong>抄得快</strong><small>国际站商品工作台</small></span><button className="icon-button close-nav" onClick={() => setMenuOpen(false)}><X size={18} /></button></div><nav>{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={19} /><span>{label}</span>{id === 'products' && state.products.length > 0 && <b>{state.products.length}</b>}{id === 'publish' && state.products.some((item) => item.selected) && <b>{state.products.filter((item) => item.selected).length}</b>}{id === 'announcements' && inbox.unread > 0 && <i className="unread-dot" aria-label="有未读公告" />}<ChevronRight size={15} /></button>)}</nav><div className="sidebar-foot"><span className={`system-dot ${state.browser.browserOpen ? 'online' : ''}`} /><div><strong>本地服务</strong><small>运行正常</small></div></div></aside>
    {menuOpen && <button className="nav-backdrop" onClick={() => setMenuOpen(false)} />}
    <main><AuthorizationConnection />{view === 'source' && <SourceView {...props} />}{COLLECTION_VIEWS[view] && <LinkCollectionView key={view} entry={view} {...props} />}{view === 'products' && <ProductsView {...props} />}{view === 'publish' && <PublishView {...props} />}{view === 'settings' && <SettingsView {...props} />}{view === 'announcements' && <><Header title="公告" onMenu={() => setMenuOpen(true)} /><AnnouncementsView inbox={inbox} /></>}</main><AnnouncementPopup inbox={inbox} />
    <Notice notice={notice} onClose={() => setNotice(null)} />
  </div>;
}
