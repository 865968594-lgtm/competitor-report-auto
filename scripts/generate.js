const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const fs = require('fs');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://llm-proxy.futuoa.com',
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

  console.log('🤖 Generating report with Claude...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: '你是一名专业的马来西亚零售券商竞品分析师。根据提供的新闻数据，整理竞品动态并输出结构化JSON。只输出JSON，不要任何其他文字。',
    messages: [{
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
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return JSON.parse((match ? match[1] : text).trim());
}

function buildHTML(data) {
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

  const sidebarLinks = data.competitors.map(c =>
    `<a href="#${c.key}" class="sidebar-link ${cfg[c.key].linkClass}">${cfg[c.key].label}<span class="count">${c.items.length}</span></a>`
  ).join('\n');

  const sections = data.competitors.map(c => {
    const cards = c.items.length === 0
      ? `<div class="no-update">过去14天内暂无新动态</div>`
      : c.items.map(item => {
          const tag = tagMap[item.type] || tagMap.notice;
          const linkRow = item.link ? `<span class="label">链接</span><span class="value"><a href="${item.link}" target="_blank">${item.link}</a></span>` : '';
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
.sidebar { width: 220px; height: 100vh; position: fixed; top: 0; left: 0; background: #1a1a2e; color: white; overflow-y: auto; z-index: 100; }
.page-wrapper { margin-left: 220px; flex: 1; min-width: 0; }
.sidebar-logo { padding: 20px 16px 14px; font-size: 13px; font-weight: 700; color: white; border-bottom: 1px solid rgba(255,255,255,0.1); line-height: 1.4; }
.sidebar-logo span { display: block; font-size: 10px; font-weight: 400; color: rgba(255,255,255,0.4); margin-top: 3px; }
.sidebar-link { display: flex; align-items: center; padding: 7px 14px; font-size: 12.5px; color: rgba(255,255,255,0.65); text-decoration: none; border-left: 3px solid transparent; transition: all 0.15s; }
.sidebar-link:hover { color: white; background: rgba(255,255,255,0.07); }
.sidebar-link .count { margin-left: auto; font-size: 10px; opacity: 0.5; }
.webull-link  { border-left-color: #0066cc; }
.rakuten-link { border-left-color: #cc0000; }
.mplus-link   { border-left-color: #006633; }
.header { background: #1a1a2e; color: white; padding: 28px 40px; }
.header h1 { font-size: 22px; font-weight: 600; }
.header .meta { margin-top: 8px; font-size: 13px; color: #aaa; }
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
.card-meta .label { color: #888; font-weight: 500; }
.card-meta .value { color: #333; }
.card-meta a { color: #0066cc; text-decoration: none; }
.moomoo-badge { margin-top: 10px; padding: 8px 12px; border-radius: 6px; font-size: 12px; }
.moomoo-yes { background: #d1e7dd; color: #0a3622; }
.moomoo-no  { background: #fdecea; color: #c62828; }
.moomoo-na  { background: #fff8e1; color: #e65100; }
.no-update { color: #888; font-size: 13px; padding: 12px 16px; background: white; border-radius: 8px; border: 1px dashed #ddd; }
footer { text-align: center; font-size: 12px; color: #aaa; padding: 24px; border-top: 1px solid #e0e0e0; margin-top: 20px; }
</style>
</head>
<body>
<nav class="sidebar">
  <div class="sidebar-logo">MY 竞品动态观测<span>每双周自动更新</span></div>
  ${sidebarLinks}
</nav>
<div class="page-wrapper">
  <div class="header">
    <h1>MY 竞品动态观测</h1>
    <div class="meta">本期更新时间：${data.updateDate} &nbsp;|&nbsp; 更新周期：每双周 &nbsp;|&nbsp; 关注竞品：Webull MY · Rakuten Trade · M+</div>
  </div>
  <div class="container">
    ${sections}
  </div>
  <footer>Auto-generated · 每月 9 日 &amp; 23 日自动更新</footer>
</div>
</body>
</html>`;
}

async function main() {
  console.log('🚀 Starting report generation...');
  const data = await generateReportData();
  const html = buildHTML(data);
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/index.html', html, 'utf8');
  console.log(`✅ Report saved (${(html.length / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
