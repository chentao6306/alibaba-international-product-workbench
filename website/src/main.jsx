import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, ArrowUpRight, ArrowDown, Check, CheckCheck, ChevronDown, ChevronRight, Download, Folder, Layers3, LayoutGrid, ListFilter, Menu, Monitor, MousePointer2, Package, Plus, Search, ShieldCheck, Sparkles, Upload, X, Image, FileText, RefreshCw, Settings, CircleHelp, SlidersHorizontal, CheckCircle2, Copy, Globe, Clock3 } from 'lucide-react';
import { website } from './config.js';
import { parseRelease } from './release.js';
import './styles.css';

const brand = `${import.meta.env.BASE_URL}brand.svg`;
const features = [
  { id: 'collect', number: '01', icon: Search, title: '先找到好商品，再集中整理', label: '多源采集', text: '支持国际站、1688、速卖通商品采集。链接、图片和店铺采集入口集中在一起，告别来回切换与反复复制。', points: ['单品、店铺与以图搜品入口', '商品资料集中保存，按分组管理', '保留来源信息，随时回看核对'] },
  { id: 'edit', number: '02', icon: SlidersHorizontal, title: '改一次，让一批商品都就绪', label: '批量编辑', text: '从标题、类目和规格，到图片与详情描述，在一个工作台里完成。把自己的公司介绍保存成模板，让每件商品都有统一的表达。', points: ['主图与详情图上传、排序和水印', '维护多套公司详情模板', '修改前后对照，确认后保存'] },
  { id: 'publish', number: '03', icon: Upload, title: '任务有进度，结果看得清', label: '上架管理', text: '将选好的商品送入发布队列，按商品查看处理进度与结果。个别商品失败会记录原因，剩余任务继续处理。', points: ['支持保存草稿与提交上架', '按实际资料选择销售方式', '保留任务记录，失败商品可修正后重试'] },
];
const products = [
  { type: 'cup', name: 'Minimal Ceramic Coffee Cup Set', category: '家居用品 / 咖啡杯', price: '$8.60', color: 'cream' },
  { type: 'speaker', name: 'Portable Wireless Bluetooth Speaker', category: '消费电子 / 音箱', price: '$12.80', color: 'green' },
  { type: 'basket', name: 'Handwoven Natural Storage Basket', category: '家居用品 / 收纳篮', price: '$6.90', color: 'sand' },
];

function ProductArt({ type, className = '' }) {
  return <svg className={`product-art ${className}`} viewBox="0 0 160 140" fill="none" aria-hidden="true">
    <ellipse cx="82" cy="119" rx="48" ry="8" fill="#172e2b" opacity=".09" />
    {type === 'cup' && <>
      <path d="M107 49h10c29 0 29 40 1 40h-11" stroke="#b9b6a7" strokeWidth="12" />
      <path d="M107 49h10c22 0 22 32 0 32h-8" stroke="#e1ddcd" strokeWidth="9" />
      <path d="M37 39h76l-5 60c-1 23-64 23-65 0Z" fill="#d9d2bb" />
      <path d="M37 39h60l-1 60c0 10-36 15-49 5L43 96Z" fill="#eeeadb" />
      <ellipse cx="75" cy="39" rx="38" ry="10" fill="#f6f1e4" />
      <ellipse cx="75" cy="40" rx="31" ry="6" fill="#bbb099" />
      <path d="M54 55l3 43" stroke="white" opacity=".5" strokeWidth="5" strokeLinecap="round" />
    </>}
    {type === 'speaker' && <>
      <path d="M107 36c3-18 21-22 24-8 2 8-3 21-13 27" stroke="#567769" strokeWidth="5" />
      <rect x="42" y="29" width="80" height="85" rx="25" fill="#315d52" />
      <rect x="42" y="29" width="66" height="85" rx="25" fill="#537f6f" />
      {Array.from({ length: 10 }, (_, row) => Array.from({ length: 8 }, (_, col) => <circle key={`${row}-${col}`} cx={51 + col * 8} cy={44 + row * 6} r="1.2" fill="#253f38" opacity=".5" />))}
      <path d="M65 34h17" stroke="#a4c2b2" strokeWidth="2" strokeLinecap="round" /><circle cx="75" cy="103" r="2" fill="#c2dfce" />
    </>}
    {type === 'basket' && <>
      <path d="M45 57c-4-38 75-38 70 0" stroke="#a78a5d" strokeWidth="7" />
      <path d="M33 52h97l-8 60c-1 13-81 13-82 0Z" fill="#bd9d6c" />
      <ellipse cx="81" cy="52" rx="49" ry="10" fill="#dcc69f" /><ellipse cx="81" cy="52" rx="40" ry="5" fill="#866d49" />
      {[65, 75, 85, 95, 105, 114].map(y => <path key={y} d={`M40 ${y}q40 10 82 0`} stroke="#e0c49a" strokeWidth="4" />)}
      {[49, 61, 73, 85, 97, 109, 121].map(x => <path key={x} d={`M${x} 61v54`} stroke="#8d744d" strokeWidth="2" opacity=".6" />)}
    </>}
  </svg>;
}

function Logo({ light = false }) {
  return <a href="#top" className={`logo ${light ? 'logo-light' : ''}`} aria-label="抄得快，返回首页"><img src={brand} width="36" height="36" alt="" /><span>抄得快<span className="logo-caption">国际站商品工作台</span></span></a>;
}

function AppPreview({ mode = 'collect', large = false }) {
  return <div className={`app-preview ${large ? 'preview-large' : ''}`} aria-label="商品工作台功能演示，使用示例数据">
    <div className="window-bar"><span className="window-dots"><i /><i /><i /></span><span>抄得快 · 商品工作台</span><span className="demo-label">功能演示</span></div>
    <div className="preview-inner">
      <aside className="preview-sidebar"><img src={brand} alt="" /><div className="preview-nav"><LayoutGrid /><Package /><div className="preview-nav-active"><Layers3 /></div><Upload /><Folder /></div><Settings className="preview-settings" /></aside>
      <div className="preview-workspace">
        <div className="preview-heading"><div><span className="preview-breadcrumb">工作空间 <ChevronRight size={10} /> 我的商品</span><h3>{mode === 'publish' ? '上架任务' : mode === 'edit' ? '批量修改' : '商品工作台'}</h3></div><span className="local-status"><i />本地服务正常</span></div>
        {mode === 'collect' && <>
          <div className="preview-tools"><span><Search size={12} />搜索商品名称或 ID</span><b><Plus size={12} />添加商品</b></div>
          <div className="preview-tabs"><span>全部商品 <b>3</b></span><span>我的分组</span><ListFilter size={13} /></div>
          <div className="preview-table"><div className="preview-table-head"><span>商品信息</span><span>价格</span><span>状态</span></div>
            {products.map(p => <div className="preview-product" key={p.type}><span className="mini-checkbox"><Check size={9} /></span><div className={`product-thumb ${p.color}`}><ProductArt type={p.type} /></div><div className="preview-product-info"><strong>{p.name}</strong><small>{p.category}</small></div><span className="preview-price">{p.price}</span><span className="ready-tag">待编辑</span></div>)}
          </div><div className="preview-bottom"><span>已选择 3 件商品</span><span className="preview-batch">批量编辑 <ArrowRight size={12} /></span></div>
        </>}
        {mode === 'edit' && <>
          <div className="editor-tabs"><span>基本信息</span><span className="selected">产品图片</span><span>详情模板</span></div>
          <div className="editor-caption">统一好形象，每件商品都出彩 <span>主图 / 详情图</span></div>
          <div className="preview-image-grid">{products.map(p => <div className={`product-thumb ${p.color}`} key={p.type}><ProductArt type={p.type} /><span>YOUR BRAND</span></div>)}</div>
          <div className="watermark-settings"><div><span>图片水印</span><b><Image size={13} />品牌 Logo</b></div><div><span>作用范围</span><b>主图和详情图 <ChevronDown size={13} /></b></div></div>
          <div className="preview-bottom"><span><CheckCircle2 size={12} />保留原始图片</span><span className="preview-batch">预览修改 <ArrowRight size={12} /></span></div>
        </>}
        {mode === 'publish' && <>
          <div className="publish-summary"><div><b>02</b><span>处理完成</span></div><div><b>01</b><span>等待处理</span></div><span className="queue-indicator"><i />队列演示</span></div>
          <div className="publish-list">{products.map((p, i) => <div key={p.type}><div className={`product-thumb ${p.color}`}><ProductArt type={p.type} /></div><div><strong>{p.name}</strong><small>{i < 2 ? '草稿已保存 · 可前往国际站确认' : '等待处理 · 可随时暂停任务'}</small></div>{i < 2 ? <CheckCircle2 className="success-icon" size={18} /> : <Clock3 size={18} />}</div>)}</div>
          <div className="preview-bottom"><span>逐件记录，进度清晰</span><span className="progress-track"><i /></span><b>2 / 3</b></div>
        </>}
      </div>
    </div>
  </div>;
}

function Modal({ title, children, onClose, wide = false }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current.showModal();
    return () => { document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  return <dialog ref={dialog} aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-content"><button type="button" className="close-modal icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={22} /></button><h2>{title}</h2>{children}</div>
  </dialog>;
}

function App() {
  const [menu, setMenu] = useState(false);
  const [feature, setFeature] = useState('collect');
  const [modal, setModal] = useState(null);
  const [release, setRelease] = useState(null);
  const [downloadState, setDownloadState] = useState('loading');
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const [downloadClicked, setDownloadClicked] = useState(false);
  const current = features.find(item => item.id === feature);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const timeout = setTimeout(() => controller.abort(), 10000);
    setDownloadState('loading');
    fetch(website.releaseEndpoint, { signal: controller.signal, cache: 'no-store' })
      .then(response => { if (!response.ok) throw new Error('获取版本失败'); return response.json(); })
      .then(data => { const next = parseRelease(data, window.location.origin); if (alive) { setRelease(next); setDownloadState(next ? 'ready' : 'empty'); } })
      .catch(() => { if (alive) { setRelease(null); setDownloadState('error'); } })
      .finally(() => clearTimeout(timeout));
    return () => { alive = false; clearTimeout(timeout); controller.abort(); };
  }, [retry]);
  useEffect(() => {
    if (!menu) return;
    const close = event => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [menu]);
  const showDownload = () => { setMenu(false); setDownloadClicked(false); setDownloadState('loading'); setRetry(value => value + 1); setModal('download'); };
  const size = release ? `${(release.size / 1024 / 1024).toFixed(1)} MB` : '';
  const closeModal = () => setModal(null);
  return <>
    <a className="skip-link" href="#main">跳转到主要内容</a>
    <header className="site-header"><div className="container nav-wrap"><Logo />
      <nav className={menu ? 'nav-links is-open' : 'nav-links'} aria-label="主导航" id="site-nav">
        <a href="#features" onClick={() => setMenu(false)}>产品功能</a><a href="#workflow" onClick={() => setMenu(false)}>使用流程</a><a href="#faq" onClick={() => setMenu(false)}>常见问题</a><button type="button" onClick={() => { setMenu(false); setModal('support'); }}>微信咨询 <ArrowUpRight size={13} /></button>
      </nav>
      <button className="button button-small button-dark nav-download" onClick={showDownload}>下载软件 <Download size={15} /></button>
      <button className="icon-button menu-toggle" aria-label={menu ? '关闭导航菜单' : '打开导航菜单'} aria-expanded={menu} aria-controls="site-nav" onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</button>
    </div></header>
    <main id="main">
      <section className="hero" id="top"><div className="container hero-layout">
        <div className="hero-copy"><div className="eyebrow"><span className="status-dot" />为国际站商家，少一点重复工作</div>
          <h1>好商品，<br />更快<span className="headline-accent">上架<svg viewBox="0 0 230 16" fill="none" aria-hidden="true"><path d="M3 11C64 0 158 0 226 8M13 15c63-8 139-8 202-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg></span>。</h1>
          <p className="hero-description">采集、编辑、发布，一站完成。<br />把重复操作交给抄得快，把时间留给生意。</p>
          <div className="hero-actions"><button className="button button-orange" onClick={showDownload}><Download size={19} />下载 Windows 版 <ArrowUpRight size={18} /></button><a className="text-link" href="#features">看看怎么用 <ArrowRight size={17} /></a></div>
          <div className="hero-meta"><Monitor size={14} /><span>Windows 10 / 11 · 64 位</span><span className="meta-divider" /><span>使用需授权</span></div>
          <div className="hero-note"><span className="note-check"><CheckCheck size={17} /></span><span>商品资料本地保存，工作进度随时接续</span></div>
        </div>
        <div className="hero-visual"><div className="visual-grid" /><div className="preview-label"><span><i />YOUR PRODUCT WORKSPACE</span><span>01 — 03</span></div><AppPreview large />
          <div className="floating-note"><span className="floating-icon"><CheckCheck size={23} /></span><div><strong>把重复，变成批量。</strong><span>图片、属性、详情，一起整理</span></div><Sparkles size={17} /></div>
          <div className="visual-caption"><span>从商品资料，到上架准备</span><span>一处管理 <ArrowUpRight size={14} /></span></div>
        </div>
      </div><div className="container platform-row"><span className="platform-description">熟悉的平台，<br /><strong>连成顺手的工作流。</strong></span><div className="platform-name alibaba">Alibaba<span>.com</span><small>国际站采集与发布</small></div><div className="platform-name marketplace">1688<small>商品采集</small></div><div className="platform-name aliexpress">AliExpress<small>商品采集</small></div><div className="platform-end"><Layers3 size={25} /><span>统一整理<br />集中管理</span></div></div></section>

      <section className="features-section section-pad" id="features"><div className="container">
        <div className="section-heading"><div><span className="kicker">一套工具，接起整个流程</span><h2>从发现好商品，<br />到准备好上架。</h2></div><p>少开几个窗口，少做几遍相同的事。<br />把每天的上新，安排得井井有条。</p></div>
        <div className="feature-layout"><div className="feature-controls" role="tablist" aria-label="选择功能演示">{features.map((item, index) => <button role="tab" aria-selected={feature === item.id} aria-controls="feature-panel" id={`tab-${item.id}`} tabIndex={feature === item.id ? 0 : -1} onKeyDown={event => { if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? features.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + features.length) % features.length; setFeature(features[next].id); document.getElementById(`tab-${features[next].id}`)?.focus(); } }} key={item.id} className={`feature-tab ${feature === item.id ? 'active' : ''}`} onClick={() => setFeature(item.id)}><span className="feature-number">{item.number}</span><span><b>{item.label}</b><small>{item.title}</small></span><ArrowUpRight size={21} /></button>)}</div>
          <div className="feature-panel" role="tabpanel" id="feature-panel" aria-labelledby={`tab-${feature}`} tabIndex={0}><div className="feature-panel-copy"><h3>{current.title}</h3><p>{current.text}</p><div className="feature-points">{current.points.map(p => <span key={p}><Check size={14} />{p}</span>)}</div></div><div className="feature-demo"><AppPreview mode={feature} /></div></div>
        </div>
      </div></section>

      <section className="details-section section-pad"><div className="container"><div className="section-heading"><div><span className="kicker">做好细节，才真正省事</span><h2>不止搬运，<br />更要变成你的商品。</h2></div><p>公司自己的图、自己的介绍、自己的风格。<br />让商品表达统一，也让日常维护更轻松。</p></div>
        <div className="detail-grid"><article className="detail-card template-card"><div className="card-top"><FileText size={23} /><span>01 / 详情模板</span></div><h3>一份好模板，<br />用在更多商品上。</h3><p>维护多套公司详情模板，批量替换、前置或追加，重复介绍不用从头再写。</p><div className="template-art"><div className="template-paper back-paper"><div /><div /><div /></div><div className="template-paper front-paper"><span className="paper-label">YOUR BRAND <span>↗</span></span><div className="paper-image"><ProductArt type="cup" /><span>Made for<br />everyday moments.</span></div><strong>Company Information</strong><i /><i /><div className="paper-bottom"><span /> <span /> <span /></div></div><span className="template-badge"><Check size={13} />已保存为我的模板</span></div></article>
          <article className="detail-card image-card"><div className="card-top"><Image size={23} /><span>02 / 图片管理</span></div><h3>每张图片，<br />都有你的品牌印记。</h3><p>上传自己的主图与详情图，设置文字或图片水印，也可移除本软件添加的水印。</p><div className="image-art"><div className="image-art-grid"><ProductArt type="speaker" /><span className="image-brand"><span>↗</span> YOUR BRAND</span></div><div className="image-toolbar"><span><MousePointer2 size={15} />选中图片</span><span><Image size={15} /><SlidersHorizontal size={15} /><Check size={15} /></span></div><span className="image-sticker">自己的图片<br /><b>自己的风格</b></span></div></article>
          <article className="detail-card task-card"><div className="card-top"><ShieldCheck size={23} /><span>03 / 持续工作</span></div><h3>工作有记录，<br />更新也从容。</h3><p>本地保存商品资料与任务进度。软件内检查新版本，下载更新，继续手上的工作。</p><div className="task-art"><div className="task-line"><span className="task-round"><Package size={18} /></span><div><b>商品资料</b><small>保存在本地工作台</small></div><CheckCircle2 size={18} /></div><div className="task-line"><span className="task-round"><Layers3 size={18} /></span><div><b>任务进度</b><small>逐件记录处理结果</small></div><CheckCircle2 size={18} /></div><div className="task-line update-line"><span className="task-round"><RefreshCw size={18} /></span><div><b>软件更新</b><small>在设置中查看新版本</small></div><ArrowUpRight size={18} /></div><span className="task-art-note">READY FOR YOUR NEXT WORKDAY</span></div></article></div>
      </div></section>

      <section className="workflow-section section-pad" id="workflow"><div className="container"><div className="workflow-heading"><div><span className="kicker">轻松开始，顺手使用</span><h2>从安装到上新，<br />走好这四步。</h2></div><button className="text-link light-link" onClick={() => setModal('guide')}>查看入门指南 <ArrowUpRight size={18} /></button></div><div className="steps">{[
        ['01', Download, '安装并登录', '下载 Windows 客户端，使用已授权的国际站账号登录。'],
        ['02', Search, '采集好商品', '选择采集入口，将需要的商品添加到本地工作台。'],
        ['03', SlidersHorizontal, '整理与确认', '编辑类目、规格、价格和图片，补齐发布所需资料。'],
        ['04', Upload, '开始上架', '选择商品与销售方式，保存草稿或提交，查看每件商品的结果。'],
      ].map(([number, Icon, title, description]) => <article className="step" key={number}><div className="step-top"><span>{number}</span><Icon size={23} /></div><h3>{title}</h3><p>{description}</p></article>)}</div><div className="workflow-footer"><span><CircleHelp size={16} />首次使用，建议先用一件商品保存草稿，核对后再批量处理。</span><span>一步一步，把生意做好。</span></div></div></section>

      <section className="faq-section section-pad" id="faq"><div className="container faq-layout"><div><span className="kicker">你可能还想知道</span><h2>开始之前，<br />解答几个问题。</h2><p>关于安装、授权与日常使用。</p><button className="text-link" onClick={() => setModal('support')}>授权与使用帮助 <ArrowUpRight size={17} /></button></div><div className="faq-list">{[
        ['支持哪些电脑？需要安装浏览器吗？', '抄得快支持 Windows 10 / 11 64 位系统。正式安装包内置浏览器，采集和发布通过软件内的浏览器完成，无需依赖电脑上另装的浏览器。'],
        ['下载后就能直接使用吗？', '下载和安装后，需要有效的软件授权，并使用与授权一致的 Alibaba 国际站账号登录。账号开通、授权期限和服务费用，请向提供软件的服务人员确认。'],
        ['可以从哪些平台采集，发布到哪里？', '支持阿里巴巴国际站、1688、速卖通的商品采集，整理后面向阿里巴巴国际站发布。不同来源的数据完整度可能不同，发布前应核对类目、规格、图片与必填属性。'],
        ['只能发布商机品吗？', '可以选择自动判断、询盘展示或填写完整物流资料。重量尺寸、物流属性、运费设置等资料齐全后可走完整物流流程；最终商品类型与发布结果由国际站的账号权限、交易条件和平台校验决定。'],
        ['一件商品失败，会影响后面的任务吗？', '单件商品遇到资料或控件错误时，系统记录原因并继续处理后续商品。你可以修正失败商品后再重试；需要时也可手动暂停。验证码等验证操作需要人工完成。'],
        ['更新软件会丢失商品资料吗？', '软件更新设计为保留本地商品资料、模板、授权与任务进度。可以在设置中检查和下载更新；安装时需退出软件，重要资料建议定期备份。'],
      ].map(([q, a], index) => <details key={q} open={index === 0 ? true : undefined}><summary><span>{q}</span><Plus size={18} /></summary><p>{a}</p></details>)}</div></div></section>

      <section className="download-section" id="download"><div className="container"><div className="download-banner"><div className="download-grid" /><div><span className="kicker">下一次上新，从这里开始</span><h2>少一点繁琐。<br />多一点生意。</h2><p>让抄得快，成为你的日常商品工作台。</p></div><div className="download-banner-actions"><button className="button button-orange" onClick={showDownload}><Download size={20} />下载 Windows 版 <ArrowUpRight size={19} /></button><span>Windows 10 / 11 · 64 位{release ? ` · v${release.version}` : ''}</span><button className="release-link" onClick={() => setModal('release')}>查看版本说明 <ArrowRight size={13} /></button></div><span className="banner-mark" aria-hidden="true">↗</span></div></div></section>
    </main>
    <footer className="site-footer"><div className="container footer-top"><div><Logo /><p>把时间留给生意。</p></div><div className="footer-links"><div><b>探索产品</b><a href="#features">产品功能</a><a href="#workflow">使用流程</a><a href="#faq">常见问题</a></div><div><b>开始使用</b><button onClick={showDownload}>下载客户端</button><button onClick={() => setModal('guide')}>入门指南</button><button onClick={() => setModal('support')}>授权与帮助</button></div><div className="footer-platform"><b>为国际站商家而做</b><span><Globe size={14} />跨平台采集 · 国际站发布</span><span><Monitor size={14} />Windows 桌面客户端</span></div></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} 抄得快</span><span>独立第三方工具，与 Alibaba 集团无隶属关系。</span><button onClick={() => setModal('privacy')}>隐私说明</button></div></footer>

    {modal === 'download' && <Modal title="开始使用抄得快" onClose={closeModal}><p className="modal-intro">你的商品工作台，准备就绪。</p><div className="download-product"><img src={brand} width="56" height="56" alt="" /><div><b>抄得快 Windows 版</b><span>Windows 10 / 11 · 64 位</span></div><Monitor size={24} /></div>
      {downloadState === 'ready' ? <><div className="release-meta"><span>版本 {release.version}</span><span>{size}</span></div><a className="button button-orange modal-primary" href={website.downloadEndpoint} onClick={() => setDownloadClicked(true)}><Download size={18} />下载安装包 <ArrowDown size={18} /></a>{downloadClicked && <p className="download-feedback" role="status">已请求下载，请在浏览器的下载列表中查看进度。</p>}</> : <div className="download-empty" role="status"><p>{downloadState === 'loading' ? '正在获取最新版本…' : downloadState === 'empty' ? '安装包暂未开放下载，请稍后再来。' : '暂时无法获取安装包，请检查网络后重试。'}</p>{downloadState !== 'loading' && <button className="button button-outline" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />重新检查</button>}</div>}
      <div className="download-tips"><b>安装前，了解这几件事</b><p><Check size={14} />使用需有效软件授权与国际站账号。</p><p><Check size={14} />升级安装前，请先退出正在运行的软件。</p><p><Check size={14} />macOS、手机暂不支持运行此安装包。</p></div><button className="text-link" onClick={() => setModal('guide')}>第一次使用？看看安装指南 <ArrowRight size={15} /></button></Modal>}
    {modal === 'guide' && <Modal title="抄得快入门指南" onClose={closeModal} wide><p className="modal-intro">第一次使用，从一件商品开始。</p><ol className="guide-list"><li><b>下载并安装</b><p>下载 Windows 64 位安装包，关闭正在运行的抄得快后打开安装程序，按提示选择安装目录。</p></li><li><b>准备授权并登录</b><p>向提供软件的服务人员确认账号授权。填写国际站账号、密码和软件授权码，按提示在内嵌浏览器完成登录与验证。</p></li><li><b>采集与核对</b><p>从单品或店铺采集入口添加商品。到商品工作台核对类目、属性、SKU、价格、图片和详情。完整物流还需要包装资料、物流属性及运费设置。</p></li><li><b>先保存草稿，再批量处理</b><p>选择一件商品保存草稿，在国际站核对内容。确认后再按需要选择更多商品，提交上架并查看结果。</p></li></ol><div className="guide-note"><ShieldCheck size={20} /><p>平台验证码由你手动完成。商品资料应真实准确，并符合国际站类目与发布规则。</p></div><button className="button button-orange" onClick={showDownload}>获取安装包 <Download size={17} /></button></Modal>}
    {modal === 'support' && <Modal title="微信联系，开始使用" onClose={closeModal}>
      <p className="modal-intro">咨询软件功能、开通授权，或获取使用帮助。</p>
      <div className="wechat-card"><img src={`${import.meta.env.BASE_URL}${website.supportQr}`} width="270" height="270" alt="客服微信二维码，微信号 Chen_Tao6306" /><p>打开微信扫一扫，或保存二维码后在微信中识别。</p></div>
      <div className="contact-line"><span>客服微信</span><b>{website.supportWechat}</b><button className="icon-button" aria-label="复制客服微信" onClick={async () => { try { await navigator.clipboard.writeText(website.supportWechat); setCopied('已复制'); } catch { setCopied('请长按微信号或选中文字复制'); } }}><Copy size={16} /></button></div>
      {copied && <p className="download-feedback" role="status">{copied}</p>}
      <div className="support-note"><ShieldCheck size={21} /><p>授权开通需提供国际站登录账号。请妥善保管密码，不要通过聊天发送密码。</p></div>
      <button className="button button-outline" onClick={() => setModal('guide')}>先查看使用指南 <ArrowRight size={16} /></button>
    </Modal>}
    {modal === 'release' && <Modal title="软件版本说明" onClose={closeModal}>{downloadState === 'ready' ? <><div className="release-heading"><span className="ready-tag">v{release.version}</span><span>{size} · Windows 64 位</span></div><h3 className="release-title">{release.title}</h3><p className="release-notes">{release.notes || '此版本暂未提供详细更新说明。'}</p><button className="button button-orange" onClick={showDownload}>下载此版本 <Download size={16} /></button></> : <><p className="modal-intro">{downloadState === 'loading' ? '正在获取版本信息…' : '当前暂无可获取的版本说明。'}</p><button className="button button-outline" onClick={() => setRetry(value => value + 1)}>重新检查 <RefreshCw size={16} /></button></>}</Modal>}
    {modal === 'privacy' && <Modal title="隐私说明" onClose={closeModal} wide><div className="privacy-copy"><h3>浏览这个网站</h3><p>本网站不设置注册表单，不收集你的国际站账号或密码，也未接入第三方广告及访问统计脚本。访问网站和下载安装包时，托管服务器可能记录必要的网络访问日志。</p><h3>使用桌面软件</h3><p>商品资料、详情模板与任务记录保存在电脑本地。软件授权和更新功能需要连接服务端；执行采集及发布时，会连接对应的电商平台。国际站密码不提交给软件授权服务器。</p><h3>保护你的资料</h3><p>请从可信入口下载安装包，妥善保管账号和授权码，定期备份重要本地资料。有关软件使用与账号授权的问题，请联系向你提供软件的服务人员。</p></div></Modal>}
  </>;
}

createRoot(document.getElementById('root')).render(<App />);
