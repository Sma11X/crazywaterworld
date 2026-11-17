// 使用生产总览标记、样式和硅矿脚本；本机 HTTP 仅返回虚构 protobuf 夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { overviewPage, templates } from '../src/ui/dist/console.mjs';
import { PAGE } from '../src/page.mjs';
import { siliconFixture } from './fixtures/silicon.mjs';
import { readSiliconOverview } from '../src/silicon-overview.mjs';
const f = siliconFixture();
f.occupy('1远征船', 5000, 2, 7); f.occupy('2远征船', 3000, 19, 0);
Object.assign(f.state.fleets[2], { state: 2, targetGridIdx: 4000, moveEndTs: Math.floor(Date.now() / 1000) + 310 });
f.state.fleets[0].power = 12345678; f.state.fleets[0].durability = 1560;
Object.assign(f.state.reward, { myRewardTimes: 42, maxRewardTimes: 130 }); f.state.fightTimes = 8;
f.state.mines[1].positionNum = 7; f.state.mines[2].positionNum = 16;
f.enemy(0, '海风船长', 32198765, 7, 4000); f.enemy(2, '<img src=x onerror=alert(1)>', 843210, 8, 4000);
f.enemy(0, '深蓝舰长', 42138900, 8); f.enemy(4, '星河船长', 21580000, 7);
for (const [index, rewards] of [
  [['白芯片宝箱', 4], ['绿芯片宝箱', 1]],
  [['白芯片宝箱', 5], ['绿芯片宝箱', 1], ['蓝芯片宝箱', 1]],
  [['白芯片宝箱', 5], ['绿芯片宝箱', 1], ['蓝芯片宝箱', 1], ['紫芯片宝箱', 1]],
].entries()) f.config.tables.ChipMineCfg.data[index].reward = rewards;
const fixtureView = await readSiliconOverview(f.client, f.protocol, f.config, f.player);
const css = PAGE.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = fs.readFileSync('src/silicon-overview-ui.js', 'utf8');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><main class="deck" style="padding-block:24px"><section id="tab-overview">${overviewPage()}</section></main>${templates()}<script>
const $=id=>document.getElementById(id),fmt=value=>Number(value).toLocaleString('zh-CN');
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
function clear(node){node.textContent='';return node;}
function smallButton(text){const button=$('ui-button').content.firstElementChild.cloneNode(true);button.textContent=text;return button;}
let current='first',snapshot={connected:true,paused:false};const disconnected=new Set();
async function call(url){const r=await fetch(url+'?account='+current);const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
${script}
maybeRefreshSilicon();
</script></body></html>`;
let payload = fixtureView, fail = false, requests = [], gate = null;
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/silicon/overview')) {
    requests.push(req.url); const result = structuredClone(payload), waiting = gate;
    if (waiting) await waiting;
    res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(fail ? { error: '模拟读取失败' } : result));
  } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
assert(executablePath, '未找到验收浏览器');
const output = path.resolve('output/silicon-overview'); fs.mkdirSync(output, { recursive: true });
let browser; const errors = [];
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const [name, width, theme] of [['desktop', 1440, 'light'], ['dark', 1440, 'dark'], ['mobile', 390, 'light'], ['small-mobile', 320, 'light']]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.locator('.silicon-mine').nth(2).waitFor();
    assert.equal(await page.locator('.silicon-mine[data-tier=BLUE] .silicon-slot').count(), 3);
    assert.equal(await page.locator('.silicon-mine[data-tier=ORANGE] .silicon-slot').count(), 16);
    assert.match(await page.locator('#silicon-summary').textContent(), /42 \/ 130/);
    const purple = page.locator('.silicon-mine[data-tier=PURPLE]');
    await purple.locator('.silicon-slot').nth(2).click();
    assert.match(await purple.locator('.silicon-position-detail').textContent(), /<img src=x onerror=alert\(1\)>/);
    assert.equal(await purple.locator('.silicon-position-detail img').count(), 0);
    await purple.locator('.silicon-slot').nth(0).focus(); await page.keyboard.press('Enter');
    assert.match(await purple.locator('.silicon-position-detail').textContent(), /海风船长/);
    await page.locator('#silicon-refresh').click(); await page.waitForFunction(() => !siliconLoading);
    assert.match(await purple.locator('.silicon-position-detail').textContent(), /海风船长/);
    const card = page.locator('[data-slot=card]').filter({ has: page.locator('#silicon-overview') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' 页面不能横向溢出');
    await card.screenshot({ path: path.join(output, name + '.png') });
    assert.deepEqual(await page.locator('#silicon-overview').evaluate(node => [...node.querySelectorAll('*')].filter(child => child.scrollWidth > child.clientWidth + 2 && getComputedStyle(child).display !== 'inline' && child.clientWidth > 0).map(child => ({ tag: child.tagName, className: child.className, width: child.clientWidth, scroll: child.scrollWidth }))), [], name + ' 卡片内容不能裁切');
    if (name === 'desktop') {
      await page.evaluate(() => { siliconData.checkedAt = Math.max(...siliconData.fleets.map(fleet => fleet.endAt || 0)) + 1; });
      await page.waitForFunction(() => document.querySelector('#silicon-fleets').textContent.includes('等待服务器结算'));
      await page.evaluate(() => { siliconReceivedAt = Date.now() - 91000; siliconLastAttempt = Date.now(); });
      await page.waitForFunction(() => document.querySelector('#silicon-fleets').textContent.includes('下次产奖：待同步'));
      const before = requests.length;
      await page.evaluate(() => { $('tab-overview').classList.add('hidden'); siliconLastAttempt = 0; maybeRefreshSilicon(); });
      assert.equal(requests.length, before); await page.evaluate(() => $('tab-overview').classList.remove('hidden'));
      let release; gate = new Promise(resolve => { release = resolve; });
      await page.evaluate(() => { void refreshSiliconOverview(); });
      while (requests.length === before) await new Promise(resolve => setTimeout(resolve, 10));
      await page.evaluate(() => { current = 'second'; siliconAccountChanged(); });
      assert.equal(await page.locator('.silicon-mine').count(), 0, '切换账号立即清除旧矿位');
      release(); gate = null;
      await page.waitForTimeout(60);
      assert.equal(await page.locator('.silicon-mine').count(), 0, '旧账号迟到响应不能覆盖新账号');
      await page.evaluate(() => { void refreshSiliconOverview(); }); await page.locator('.silicon-mine').nth(2).waitFor();
      fail = true; await page.locator('#silicon-refresh').click(); await page.waitForFunction(() => !siliconLoading);
      assert.match(await page.locator('#silicon-status').textContent(), /下方为上次同步结果/); fail = false;
      payload = { ...fixtureView, reason: '当前赛季尚未开放硅矿', reward: null, fights: null, mines: [], fleets: [], fleetsSynced: false, notes: [] };
      await page.locator('#silicon-refresh').click(); await page.waitForFunction(() => !siliconLoading);
      assert.equal(await page.locator('.silicon-slot').count(), 0); assert.match(await page.locator('#silicon-mines').textContent(), /尚未开放/);
      payload = fixtureView;
      await page.evaluate(() => { snapshot.paused = true; siliconAccountChanged(); });
      assert.equal(await page.locator('#silicon-refresh').isDisabled(), true);
    }
    await page.close(); console.log('通过：' + name + ' 矿位交互、键盘、响应式布局与截图');
  }
  assert.deepEqual(errors, []); assert.deepEqual(f.client.writes, []);
  console.log('通过：到期/过期状态、隐藏停刷、账号隔离、失败保留提示、未开放与暂停；零游戏写入');
  console.log('截图：' + output);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
