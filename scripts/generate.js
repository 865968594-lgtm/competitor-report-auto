const { spawnSync } = require('child_process');
const fs = require('fs');

function getDateStr(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

const endDate = getDateStr(0);
const startDate = getDateStr(14);

const prompt = `你是一名专业的马来西亚零售券商竞品分析师。

请搜索 ${startDate} 至 ${endDate} 期间以下三个竞品的最新动态：
1. Webull MY（Webull Malaysia）
2. Rakuten Trade Malaysia
3. M+（Malacca Securities Malaysia）

请对每个竞品分别执行多次搜索（英文+中文关键词），例如：
- "Webull Malaysia promotion 2026", "Webull MY new feature"
- "Rakuten Trade Malaysia campaign", "Rakuten Trade new update"
- "Malacca Securities M+ promotion", "M+ Malaysia broker"

重点关注：新上线功能、促销活动（开户奖励等）、重要通知（费率调整/公告）。

搜索完成后，生成一个完整的独立HTML页面（内含所有CSS，无外部依赖）。

页面设计要求：
- 左侧固定导航栏（宽220px，深色#1a1a2e背景），含三个竞品的锚点跳转链接，显示各自动态数量
- 顶部标题栏：标题"MY 竞品动态观测"，副标题"本期更新时间：${endDate} | 更新周期：每双周 | 关注竞品：Webull MY · Rakuten Trade · M+"
- 每个竞品独立section（含颜色标识：Webull蓝#0066cc / Rakuten红#cc0000 / M+绿#006633）
- 每条动态用卡片展示，包含：类型标签（活动/新功能/重要通知）、标题、描述、上线日期、来源、moomoo对比说明
- moomoo对比：✅绿色背景（已支持）/ ❌红色背景（暂无）/ 🔸黄色背景（不适用）
- 如某竞品无新动态，显示"过去14天内暂无新动态"灰色虚线框

只输出完整HTML代码，不要任何说明文字，不要markdown代码块标记。`;

console.log(`🚀 Generating competitor report for ${startDate} – ${endDate}`);

const result = spawnSync(
  'claude',
  ['-p', prompt, '--allowedTools', 'WebSearch,WebFetch'],
  {
    env: { ...process.env },
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8',
    timeout: 300000,
  }
);

if (result.error) {
  console.error('Failed to run claude CLI:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error('claude CLI error:', result.stderr);
  process.exit(1);
}

let html = result.stdout.trim();

// Strip markdown code fences if present
const fenceMatch = html.match(/```(?:html)?\s*([\s\S]*?)\s*```/);
if (fenceMatch) html = fenceMatch[1].trim();

// Find start of HTML document
const doctypeIdx = html.indexOf('<!DOCTYPE');
const htmlTagIdx = html.indexOf('<html');
const startIdx = Math.min(
  doctypeIdx === -1 ? Infinity : doctypeIdx,
  htmlTagIdx === -1 ? Infinity : htmlTagIdx
);
if (startIdx !== Infinity) html = html.substring(startIdx);

if (!html.includes('<html')) {
  console.error('Output does not look like HTML:\n', html.substring(0, 500));
  process.exit(1);
}

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html, 'utf8');
console.log(`✅ Report saved to dist/index.html (${(html.length / 1024).toFixed(1)} KB)`);
