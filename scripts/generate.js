const OpenAI = require('openai');
const https = require('https');
const fs = require('fs');
const path = require('path');

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

function getDateStr(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function fetchGoogleNews(query) {
  return new Promise((resolve) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(data)) !== null && items.length < 6) {
          const item = match[1];
          const clean = s => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, '').trim();
          items.push({
            title: clean(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
            link: clean(item.match(/<link>([\s\S]*?)<\/link>/)?.[1]),
            pubDate: clean(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]),
            description: clean(item.match(/<description>([\s\S]*?)<\/description>/)?.[1]).substring(0, 200),
          });
        }
        resolve(items);
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
  });
}

async function generateReportData() {
  const endDate = getDateStr(0);
  const startDate = getDateStr(14);

  console.log('📰 Fetching competitor news...');
  const [webull1, webull2, rakuten1, rakuten2, mplus1, mplus2] = await Promise.all([
    fetchGoogleNews('Webull Malaysia 2026'),
    fetchGoogleNews('Webull MY promotion feature'),
    fetchGoogleNews('Rakuten Trade Malaysia 2026'),
    fetchGoogleNews('Rakuten Trade promotion new feature'),
    fetchGoogleNews('Malacca Securities M+ Malaysia 2026'),
    fetchGoogleNews('M+ broker Malaysia promotion'),
  ]);

  const formatNews = items => items.length
    ? items.map(n => `  - [${n.pubDate}] ${n.title}\n    ${n.description}${n.link ? '\n    链接：' + n.link : ''}`).join('\n')
    : '  （暂无相关新闻）';

  const newsContext = `
=== Webull MY 相关新闻 ===
${formatNews([...webull1, ...webull2])}

=== Rakuten Trade 相关新闻 ===
${formatNews([...rakuten1, ...rakuten2])}

=== M+ / Malacca Securities 相关新闻 ===
${formatNews([...mplus1, ...mplus2])}
`;

  console.log('🤖 Generating report with DeepSeek...');

  const response = await client.chat.completions.create({
    model: 'deepseek-chat',
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: '你是一名专业的马来西亚零售券商竞品分析师。根据提供的新闻数据，整理竞品动态并输出结构化JSON。只输出JSON，不要任何其他文字。',
      },
      {
        role: 'user',
        content: `以下是 ${startDate} 至 ${endDate} 期间三个马来西亚券商竞品的最新新闻：

${newsContext}

请基于以上新闻，整理竞品动态，输出以下JSON格式：
{
  "updateDate": "${endDate}",
  "startDate": "${startDate}",
  "competitors": [
    {
      "name": "Webull MY",
      "key": "webull",
      "items": [
        {
          "type": "campaign",
          "title": "标题",
          "description": "2-3句话详细描述",
          "date": "YYYY/MM/DD",
          "source": "来源说明",
          "link": "链接（没有则空字符串）",
          "moomooClass": "moomoo-yes",
          "moomooNote": "✅ moomoo MY 对比说明"
        }
      ]
    },
    { "name": "Rakuten Trade", "key": "rakuten", "items": [] },
    { "name": "M+", "key": "mplus", "items": [] }
  ]
}

type只能是：campaign（活动）/ feature（新功能）/ notice（重要通知）
moomooClass只能是：moomoo-yes / moomoo-no / moomoo-na
moomooNote开头用：✅ / ❌ / 🔸
如某竞品无新动态，items设为空数组。`,
      },
    ],
  });

  const text = response.choices[0].message.content || '';
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return JSON.parse((match ? match[1] : text).trim());
}

function buildHTML(data, historySidebar = '', historySections = '') {
  const tagMap = {
    campaign: { cls: 'tag-campaign', text: '活动' },
    feature:  { cls: 'tag-feature',  text: '新功能' },
    notice:   { cls: 'tag-notice',   text: '重要通知' },
  };
  const cfg = {
    webull:  { sectionClass: 'webull',  linkClass: 'webull-link',  label: '🔵 Webull MY' },
    rakuten: { sectionClass: 'rakuten', linkClass: 'rakuten-link', label: '🔴 Rakuten Trade' },
    mplus:   { sectionClass: 'mplus',   linkClass: 'mplus-link',   label: '🟢 M+' },
  };

  const periodId = 'period-current';

  const sidebarLinks = data.competitors.map(c =>
    `<a href="#${c.key}" class="sidebar-link ${cfg[c.key].linkClass}">${cfg[c.key].label}<span class="count">${c.items.length}</span></a>`
  ).join('\n');

  const sections = data.competitors.map(c => {
    const cards = c.items.length === 0
      ? `<div class="no-update">过去14天内暂无新动态</div>`
      : c.items.map(item => {
          const tag = tagMap[item.type] || tagMap.notice;
          let linkDisplay = item.link;
          try { const u = new URL(item.link); linkDisplay = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? '/…' : ''); } catch {}
          const linkRow = item.link ? `<span class="label">链接</span><span class="value"><a href="${item.link}" target="_blank">${linkDisplay} ↗</a></span>` : '';
          const sourceRow = item.source ? `<span class="label">来源</span><span class="value">${item.source}</span>` : '';
          return `<div class="card">
      <span class="card-tag ${tag.cls}">${tag.text}</span>
      <h3>${item.title}</h3>
      <p>${item.description}</p>
      <div class="card-meta">
        <span class="label">上线日期</span><span class="value">${item.date}</span>
        ${sourceRow}${linkRow}
      </div>
      <div class="moomoo-badge ${item.moomooClass}">${item.moomooNote}</div>
    </div>`;
        }).join('\n');

    return `<section id="${c.key}" class="competitor-section ${cfg[c.key].sectionClass}">
    <div class="competitor-title">${cfg[c.key].label}</div>
    ${cards}
  </section>`;
  }).join('\n\n');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MY竞品动态观测 ${data.updateDate}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, 'PingFang SC', sans-serif; background: #f5f5f5; color: #1a1a1a; display: flex; min-height: 100vh; }
.sidebar { width: 220px; height: 100vh; position: fixed; top: 0; left: 0; background: #1a1a2e; color: white; overflow-y: auto; z-index: 100; display: flex; flex-direction: column; }
.page-wrapper { margin-left: 220px; flex: 1; min-width: 0; }
.sidebar-logo { padding: 20px 16px 14px; font-size: 13px; font-weight: 700; color: white; border-bottom: 1px solid rgba(255,255,255,0.1); line-height: 1.4; }
.sidebar-logo span { display: block; font-size: 10px; font-weight: 400; color: rgba(255,255,255,0.4); margin-top: 3px; }
.sidebar-period-block { padding: 16px 16px 4px; }
.sidebar-period-label { font-size: 10px; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px; }
.sidebar-link { display: block; padding: 7px 14px; font-size: 12.5px; color: rgba(255,255,255,0.65); text-decoration: none; transition: all 0.15s; border-left: 3px solid transparent; }
.sidebar-link:hover, .sidebar-link.active { color: white; background: rgba(255,255,255,0.07); }
.webull-link   { border-left-color: #0066cc; }
.rakuten-link  { border-left-color: #cc0000; }
.mplus-link    { border-left-color: #006633; }
.cgs-link      { border-left-color: #8b4513; }
.kenanga-link  { border-left-color: #5b2d8e; }
.fsmone-link   { border-left-color: #e65100; }
.ibkr-link     { border-left-color: #1a237e; }
/* Header */
.header { background: #1a1a2e; color: white; padding: 28px 40px; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.header-left { flex: 1; min-width: 0; }
.header h1 { font-size: 22px; font-weight: 600; }
.header .meta { margin-top: 8px; font-size: 13px; color: #aaa; }
/* Search */
.search-container { position: relative; width: 360px; flex-shrink: 0; }
.search-input-wrap { position: relative; display: flex; align-items: center; }
.search-input { width: 100%; padding: 0 16px 0 40px; border-radius: 10px; border: 1.5px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.1); color: white; font-size: 14px; outline: none; box-sizing: border-box; height: 44px; transition: background 0.15s, border-color 0.15s; }
.search-input::placeholder { color: rgba(255,255,255,0.35); }
.search-input:focus { background: rgba(255,255,255,0.18); border-color: rgba(255,255,255,0.35); }
.search-icon { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); font-size: 15px; pointer-events: none; z-index: 1; }
.search-dropdown { position: absolute; top: calc(100% + 6px); left: 0; right: 0; background: #fff; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.18); z-index: 9999; max-height: 340px; overflow-y: auto; display: none; }
.search-dropdown.visible { display: block; }
.search-result-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f2f2f2; display: flex; flex-direction: column; gap: 4px; transition: background 0.12s; }
.search-result-item:last-child { border-bottom: none; }
.search-result-item:hover, .search-result-item.active { background: #f0f4ff; }
.search-result-title { font-size: 13px; font-weight: 600; color: #1a1a1a; line-height: 1.4; }
.search-result-meta { font-size: 11px; color: #888; }
.search-result-mark { background: #fff3a3; border-radius: 2px; padding: 0 1px; font-weight: 700; color: #1a1a1a; }
.search-no-results { padding: 16px 14px; text-align: center; color: #aaa; font-size: 13px; }
.card-jump-highlight { animation: jumpPulse 1.2s ease; }
@keyframes jumpPulse { 0%,100% { box-shadow: none; } 20%,60% { box-shadow: 0 0 0 3px #4f8ef7, 0 4px 20px rgba(79,142,247,0.3); } }
/* Filter bar */
.filter-bar { background: #fff; border-bottom: 1px solid #e8e8e8; padding: 10px 40px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.filter-btn { padding: 5px 14px; border-radius: 20px; border: 1.5px solid #e0e0e0; background: #fff; font-size: 12.5px; color: #555; cursor: pointer; transition: all 0.15s; font-family: inherit; }
.filter-btn:hover { border-color: #bbb; background: #f5f5f5; }
.filter-btn.active { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }
.filter-btn.active.f-campaign { background: #1565c0; border-color: #1565c0; }
.filter-btn.active.f-feature  { background: #880e4f; border-color: #880e4f; }
.filter-btn.active.f-notice   { background: #e65100; border-color: #e65100; }
.filter-label { font-size: 12px; color: #999; margin-right: 4px; }
.filter-count { font-size: 10px; margin-left: 4px; opacity: 0.75; }
@media (max-width: 768px) { .filter-bar { padding: 10px 16px; } }
/* Guidelines bar */
.guidelines-bar { background: #fff; border-bottom: 1px solid #e8e8e8; padding: 0 40px; }
.guidelines-toggle { display: flex; align-items: center; gap: 8px; padding: 10px 0; cursor: pointer; font-size: 12.5px; color: #555; user-select: none; list-style: none; border: none; background: none; width: 100%; text-align: left; }
.guidelines-toggle::-webkit-details-marker { display: none; }
.guidelines-toggle .gl-label { font-weight: 600; color: #333; }
.guidelines-toggle .gl-arrow { font-size: 10px; color: #aaa; transition: transform 0.2s; }
details.guidelines-open .gl-arrow { transform: rotate(180deg); }
.guidelines-body { padding: 0 0 14px 0; display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; }
.gl-card { background: #f8f9fc; border-radius: 8px; padding: 12px 14px; border-left: 3px solid #d0d0d0; }
.gl-card.gl-campaign { border-left-color: #4caf50; }
.gl-card.gl-product  { border-left-color: #2196f3; }
.gl-card.gl-notice   { border-left-color: #ff9800; }
.gl-card-title { font-size: 12px; font-weight: 700; color: #333; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.gl-card-tag { font-size: 10px; padding: 1px 6px; border-radius: 10px; font-weight: 600; }
.tag-campaign-gl { background: #e8f5e9; color: #2e7d32; }
.tag-product-gl  { background: #e3f2fd; color: #1565c0; }
.tag-notice-gl   { background: #fff3e0; color: #e65100; }
.gl-rule { font-size: 12px; color: #555; line-height: 1.6; }
.gl-rule .gl-yes { color: #2e7d32; }
.gl-rule .gl-no  { color: #c62828; }
/* Period group */
.period-group { margin-bottom: 32px; }
.period-header { display: flex; align-items: center; gap: 10px; padding: 14px 0 12px; margin-bottom: 4px; border-bottom: 2px solid #e8e8e8; }
.period-badge { background: #1a1a2e; color: white; font-size: 10px; padding: 3px 9px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.period-badge-history { background: #6c757d; color: white; }
.period-badge.old { background: #888; }
.period-label { font-size: 15px; font-weight: 700; color: #333; }
.period-toggle { margin-left: auto; background: white; border: 1px solid #ddd; border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; color: #666; }
.period-toggle:hover { background: #f5f5f5; }
/* Container */
.container { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
.competitor-section { margin-bottom: 40px; }
.competitor-title { font-size: 18px; font-weight: 700; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px; }
.webull  .competitor-title { background: #e8f4fd; color: #0066cc; border-left: 4px solid #0066cc; }
.rakuten .competitor-title { background: #fff0f0; color: #cc0000; border-left: 4px solid #cc0000; }
.mplus   .competitor-title { background: #f0fff4; color: #006633; border-left: 4px solid #006633; }
.card { background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
.card-tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; margin-bottom: 10px; }
.tag-feature  { background: #fce4ec; color: #880e4f; }
.tag-campaign { background: #e3f2fd; color: #1565c0; }
.tag-notice   { background: #fff3e0; color: #e65100; }
.card h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.card p  { font-size: 13px; line-height: 1.7; color: #444; margin-bottom: 10px; }
.card-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0f0f0; }
.card-meta .label { color: #888; font-weight: 500; white-space: nowrap; }
.card-meta .value { color: #333; }
.card-meta a { color: #0066cc; text-decoration: none; }
.moomoo-badge { margin-top: 10px; padding: 8px 12px; border-radius: 6px; font-size: 12px; }
.moomoo-yes { background: #d1e7dd; color: #0a3622; }
.moomoo-no  { background: #fdecea; color: #c62828; }
.moomoo-na  { background: #fff8e1; color: #e65100; }
.no-update { color: #888; font-size: 13px; padding: 12px 16px; background: white; border-radius: 8px; border: 1px dashed #ddd; }
footer { text-align: center; font-size: 12px; color: #aaa; padding: 24px; border-top: 1px solid #e0e0e0; margin-top: 20px; }
/* Mobile */
.hamburger { display: none; position: fixed; top: 12px; left: 12px; z-index: 200; background: #1a1a2e; border: none; border-radius: 6px; padding: 9px 11px; cursor: pointer; flex-direction: column; gap: 5px; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
.hamburger span { display: block; width: 20px; height: 2px; background: white; border-radius: 2px; }
.sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 99; }
.sidebar-overlay.visible { display: block; }
@media (max-width: 768px) {
  .sidebar { width: 0; overflow: hidden; transition: width 0.25s ease; }
  .sidebar.open { width: 220px; overflow-y: auto; }
  .page-wrapper { margin-left: 0; padding-top: 52px; }
  .hamburger { display: flex; }
  .guidelines-bar { padding: 0 16px; }
  .guidelines-body { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<button class="hamburger" id="hamburgerBtn" onclick="toggleSidebar()" aria-label="打开菜单">
  <span></span><span></span><span></span>
</button>
<div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>

<nav class="sidebar" id="sidebar">
  <div class="sidebar-logo">MY 竞品动态观测<span>每隔周二自动更新</span></div>
  <div class="sidebar-period-block">
    <div class="sidebar-period-label" style="color:rgba(255,255,255,0.7);font-weight:700">📌 本期</div>
    <div class="sidebar-period-label">📅 ${data.startDate}–${data.updateDate}</div>
    ${sidebarLinks}
    ${historySidebar}
  </div>
</nav>

<div class="page-wrapper">
  <div class="header">
    <div class="header-left">
      <h1>MY 竞品动态观测</h1>
      <div class="meta">本期更新时间：${data.updateDate} &nbsp;|&nbsp; 更新周期：每隔周二 &nbsp;|&nbsp; 关注竞品：Webull MY · Rakuten Trade · M+</div>
    </div>
    <div class="search-container">
      <div class="search-input-wrap">
        <span class="search-icon">🔍</span>
        <input type="text" id="globalSearch" class="search-input" placeholder="搜索关键词..." autocomplete="off">
      </div>
      <div class="search-dropdown" id="searchDropdown"></div>
    </div>
  </div>

  <div class="filter-bar" id="filterBar">
    <span class="filter-label">筛选：</span>
    <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">全部 <span class="filter-count" id="fc-all"></span></button>
    <button class="filter-btn f-campaign" data-filter="campaign" onclick="setFilter('campaign')">活动 <span class="filter-count" id="fc-campaign"></span></button>
    <button class="filter-btn f-feature"  data-filter="feature"  onclick="setFilter('feature')">产品更新 <span class="filter-count" id="fc-feature"></span></button>
    <button class="filter-btn f-notice"   data-filter="notice"   onclick="setFilter('notice')">重要通知 <span class="filter-count" id="fc-notice"></span></button>
  </div>

  <div class="guidelines-bar">
    <details id="guidelinesDetails" ontoggle="this.classList.toggle('guidelines-open',this.open)">
      <summary class="guidelines-toggle">
        <span class="gl-label">📋 内容筛选原则</span>
        <span style="flex:1"></span>
        <span style="font-size:11px;color:#aaa;margin-right:6px">点击展开查看收录标准</span>
        <span class="gl-arrow">▼</span>
      </summary>
      <div class="guidelines-body">
        <div class="gl-card gl-campaign">
          <div class="gl-card-title"><span class="gl-card-tag tag-campaign-gl">活动</span>用户激励类活动</div>
          <div class="gl-rule">
            <span class="gl-yes">✓ 收录：</span>开户奖励、存款奖励、交易返佣、限时促销等直接激励用户行为的活动<br>
            <span class="gl-no">✗ 不收录：</span>用户教育类（讲座、课程）、直播类活动
          </div>
        </div>
        <div class="gl-card gl-product">
          <div class="gl-card-title"><span class="gl-card-tag tag-product-gl">新功能</span>新功能 / 新品类</div>
          <div class="gl-rule">
            <span class="gl-yes">✓ 收录：</span>新功能上线、新支持品类（如新增期权品种、新市场、新资产类别）<br>
            <span class="gl-no">✗ 不收录：</span>App Store 常规版本升级、系统维护、bug 修复、性能优化
          </div>
        </div>
        <div class="gl-card gl-notice">
          <div class="gl-card-title"><span class="gl-card-tag tag-notice-gl">重要通知</span>品牌 / 产品重大影响</div>
          <div class="gl-rule">
            <span class="gl-yes">✓ 收录：</span>对产品运营、用户权益、品牌声誉有较大影响的通知（监管动态、安全事件、费率变更等）<br>
            <span class="gl-no">✗ 不收录：</span>常规运营公告、低影响维护通知
          </div>
        </div>
      </div>
    </details>
  </div>

  <div class="container">
    <div class="period-group" id="${periodId}">
      <div class="period-header">
        <span class="period-badge">本期</span>
        <span class="period-label">${data.startDate} – ${data.updateDate}</span>
        <button class="period-toggle" onclick="togglePeriod('${periodId}')">收起 ▲</button>
      </div>
      ${sections}
    </div>
    ${historySections}
  </div>
</div>

<script>
// ── Search ──────────────────────────────────────────────────────────────
const searchInput = document.getElementById('globalSearch');
const searchDropdown = document.getElementById('searchDropdown');
const COMP_LABEL = { webull: '🔵 Webull MY', rakuten: '🔴 Rakuten Trade', mplus: '🟢 M+' };
const searchIndex = [];

document.querySelectorAll('.card').forEach(function(card) {
  var h3 = card.querySelector('h3');
  if (!h3) return;
  var p = card.querySelector('p');
  var section = card.closest('.competitor-section');
  var periodEl = card.closest('.period-group');
  var compClass = section ? Array.from(section.classList).find(function(c){ return c !== 'competitor-section'; }) : '';
  var periodLabel = periodEl ? ((periodEl.querySelector('.period-label') || {}).textContent || '') : '';
  var tagEl = card.querySelector('.card-tag');
  searchIndex.push({
    title: h3.textContent.trim(),
    body: p ? p.textContent.trim() : '',
    tag: tagEl ? tagEl.textContent.trim() : '',
    comp: compClass || '',
    compLabel: COMP_LABEL[compClass] || compClass,
    period: periodLabel.trim(),
    el: card
  });
});

function escRe(s) { return s.replace(/[-[\\]{}()*+?.,\\\\^$|#\\s]/g, '\\\\$&'); }

function hlText(text, query) {
  if (!query) return text;
  var re = new RegExp('(' + escRe(query) + ')', 'gi');
  return text.replace(re, '<span class="search-result-mark">$1</span>');
}

function closeDropdown() {
  searchDropdown.classList.remove('visible');
  searchDropdown.innerHTML = '';
}

function jumpToCard(card) {
  closeDropdown();
  searchInput.value = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('card-jump-highlight');
  setTimeout(function(){ card.classList.remove('card-jump-highlight'); }, 1400);
}

var activeIdx = -1;

searchInput.addEventListener('input', function() {
  var query = this.value.trim();
  activeIdx = -1;
  if (!query) { closeDropdown(); return; }
  var q = query.toLowerCase();
  var results = searchIndex.filter(function(item) {
    return item.title.toLowerCase().indexOf(q) >= 0 ||
           item.body.toLowerCase().indexOf(q) >= 0 ||
           item.comp.toLowerCase().indexOf(q) >= 0 ||
           item.tag.toLowerCase().indexOf(q) >= 0;
  }).slice(0, 12);
  if (results.length === 0) {
    searchDropdown.innerHTML = '<div class="search-no-results">无匹配结果</div>';
    searchDropdown.classList.add('visible');
    return;
  }
  searchDropdown.innerHTML = results.map(function(r, i) {
    return '<div class="search-result-item" data-idx="' + i + '">' +
      '<div class="search-result-title">' + hlText(r.title, query) + '</div>' +
      '<div class="search-result-meta">' + (r.compLabel || r.comp) +
        (r.period ? ' · ' + r.period : '') + (r.tag ? ' · ' + r.tag : '') +
      '</div></div>';
  }).join('');
  var items = searchDropdown.querySelectorAll('.search-result-item');
  items.forEach(function(item, i) {
    item.addEventListener('mousedown', function(e) { e.preventDefault(); jumpToCard(results[i].el); });
  });
  searchDropdown.classList.add('visible');
});

searchInput.addEventListener('keydown', function(e) {
  var items = searchDropdown.querySelectorAll('.search-result-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
  else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); items[activeIdx].dispatchEvent(new MouseEvent('mousedown')); return; }
  else if (e.key === 'Escape') { closeDropdown(); return; }
  else { return; }
  items.forEach(function(el, i){ el.classList.toggle('active', i === activeIdx); });
  if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
});

document.addEventListener('click', function(e) {
  if (!e.target.closest('.search-container')) closeDropdown();
});

// ── Type filter ───────────────────────────────────────────────────────
var currentFilter = 'all';

// Count cards per type and update badges
(function() {
  var counts = { all: 0, campaign: 0, feature: 0, notice: 0 };
  document.querySelectorAll('.card').forEach(function(card) {
    var tag = card.querySelector('.card-tag');
    if (!tag) return;
    counts.all++;
    var t = tag.textContent.trim();
    if (t === '活动') counts.campaign++;
    else if (t === '新功能' || t === '产品更新') counts.feature++;
    else if (t === '重要通知') counts.notice++;
  });
  ['all','campaign','feature','notice'].forEach(function(k) {
    var el = document.getElementById('fc-' + k);
    if (el) el.textContent = '(' + counts[k] + ')';
  });
})();

function setFilter(type) {
  currentFilter = type;
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.filter === type);
  });
  document.querySelectorAll('.card').forEach(function(card) {
    if (type === 'all') { card.style.display = ''; return; }
    var tag = card.querySelector('.card-tag');
    var t = tag ? tag.textContent.trim() : '';
    var match = (type === 'campaign' && t === '活动') ||
                (type === 'feature'  && (t === '新功能' || t === '产品更新')) ||
                (type === 'notice'   && t === '重要通知');
    card.style.display = match ? '' : 'none';
  });
  // Hide competitor sections that have no visible cards
  document.querySelectorAll('.competitor-section').forEach(function(sec) {
    var visible = Array.from(sec.querySelectorAll('.card')).some(function(c) { return c.style.display !== 'none'; });
    sec.style.display = visible ? '' : 'none';
  });
}

// ── Mobile sidebar ────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('visible');
}
document.querySelectorAll('.sidebar-link').forEach(function(link) {
  link.addEventListener('click', function() {
    if (window.innerWidth <= 768) toggleSidebar();
  });
});

// ── Period toggle ─────────────────────────────────────────────────────
function togglePeriod(id) {
  var group = document.getElementById(id);
  var btn = group.querySelector('.period-toggle');
  var collapsed = btn.textContent.includes('展开');
  group.querySelectorAll('.competitor-section').forEach(function(s) {
    s.style.display = collapsed ? '' : 'none';
  });
  btn.textContent = collapsed ? '收起 ▲' : '展开 ▼';
}

// ── Sidebar active on scroll ──────────────────────────────────────────
window.addEventListener('scroll', function() {
  var y = window.scrollY + 120;
  ['webull', 'rakuten', 'mplus'].forEach(function(id) {
    var el = document.getElementById(id);
    var link = document.querySelector('.sidebar-link.' + id + '-link');
    if (!el || !link) return;
    var top = el.offsetTop, bottom = top + el.offsetHeight;
    if (y >= top && y < bottom) {
      document.querySelectorAll('.sidebar-link').forEach(function(l){ l.classList.remove('active'); });
      link.classList.add('active');
    }
  });
});
</script>
</body>
</html>`;
}

async function main() {
  console.log('🚀 Starting report generation...');
  const data = await generateReportData();

  // Load static history files
  const scriptDir = __dirname;
  const historySidebar = fs.existsSync(path.join(scriptDir, 'history-sidebar.html'))
    ? fs.readFileSync(path.join(scriptDir, 'history-sidebar.html'), 'utf8') : '';
  const historySections = fs.existsSync(path.join(scriptDir, 'history-sections.html'))
    ? fs.readFileSync(path.join(scriptDir, 'history-sections.html'), 'utf8') : '';

  const html = buildHTML(data, historySidebar, historySections);
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/index.html', html, 'utf8');
  console.log(`✅ Report saved (${(html.length / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
