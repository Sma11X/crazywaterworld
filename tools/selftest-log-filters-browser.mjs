// 使用隔离账号和真实网页验证日志筛选；不连接游戏、不读取用户账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-log-filters-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('日志验收禁止连接游戏'); };
const longTitle = '远航舰队的超长账号备注 · 第一海域与基地生产测试';
saveStore({ version: 1, activeId: 'logs-a', accounts: ['logs-a', 'logs-b'].map((id, index) => ({
  id, label: index ? '远航舰队' : longTitle, url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
})) });
const app = createConsole({ port: 0, protocol: {} });
const output = path.resolve('output/log-filters'); fs.mkdirSync(output, { recursive: true });
let browser;
const errors = [];
const streams = new Set();
app.server.on('request', (request, response) => { if (request.url.startsWith('/api/events')) streams.add(response); });
try {
  const base = await app.listen();
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#account-picker-title').filter({ hasText: longTitle }).waitFor();
  const a = app.sessions.get('logs-a'), b = app.sessions.get('logs-b');
  app.emit(a, 'info', '工厂完成木板生产', { category: 'production' });
  app.emit(b, 'warn', '城战舰队等待维修', { category: 'alliance' });
  app.emit(null, 'info', '系统资源检查完成');
  await page.locator('#logs-open').click();
  await page.locator('#log .row').filter({ hasText: '城战舰队等待维修' }).waitFor();
  assert.equal(await page.locator('#log-account').inputValue(), 'all');
  assert(await page.locator('#log-clear').isDisabled());
  assert.match(await page.locator('#log .row').filter({ hasText: '工厂完成木板生产' }).locator('.log-account').textContent(), /logs-a/);
  assert.match(await page.locator('#log .row').filter({ hasText: '城战舰队等待维修' }).locator('.log-account').textContent(), /logs-b/);
  await page.locator('#log-tabs [data-log-group="基地与资源"]').click();
  assert.equal(await page.locator('#log .row:visible').count(), 1);
  assert.match(await page.locator('#log .row:visible').textContent(), /木板生产/);
  await page.locator('#log-issues').click();
  assert(await page.locator('#log-empty').isVisible());
  await page.locator('#log-tabs [data-log-group="世界与联盟"]').click();
  assert.equal(await page.locator('#log .row:visible').count(), 1);
  await page.locator('#log-account').selectOption('logs-a');
  assert(await page.locator('#log-empty').isVisible());
  await page.locator('#log-account').selectOption('logs-b');
  assert.equal(await page.locator('#log .row:visible').count(), 1);
  await page.locator('#log-category').selectOption('production');
  assert.equal(await page.locator('#log-tabs [aria-selected=true]').getAttribute('data-log-group'), '基地与资源');
  await page.locator('#log-tabs [data-log-group=all]').click();
  await page.locator('#log-all').click();
  await page.locator('#log-account').selectOption('system');
  assert(await page.locator('#log .row:visible').count() > 0);
  assert(await page.locator('#log .row:visible').evaluateAll(rows => rows.every(row => !row.dataset.account)));
  console.log('通过：分类页签、功能、等级和账号组合筛选，账号与分类标识清晰显示');

  await page.locator('#log-account').selectOption('all');
  await page.locator('#log-tabs [data-log-group=all]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#log-tabs [aria-selected=true]').getAttribute('data-log-group'), '系统');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#log-tabs [aria-selected=true]').getAttribute('data-log-group'), '日常与活动');
  await page.keyboard.press('Home');
  await page.locator('#logs-close').click();
  const subscriptions = streams.size;
  await page.evaluate(() => selectLoadedAccount('logs-b'));
  await page.locator('#logs-open').click();
  assert.equal(streams.size, subscriptions, '顶部切号不创建重复订阅');
  assert.equal(await page.locator('#log-account').inputValue(), 'all');
  assert.equal(await page.locator('#log .row').filter({ hasText: '工厂完成木板生产' }).count(), 1);
  console.log('通过：页签支持方向键与首尾导航，顶部切号保留日志和独立筛选');

  const batch = { batch: 'same-batch', factory: '木材厂', product: '木板', category: 'production' };
  app.emit(a, 'info', '甲排产', batch); app.emit(b, 'info', '乙排产', batch);
  app.emit(a, 'info', '甲等待', { waitKey: 'same-wait', category: 'production' });
  app.emit(b, 'info', '乙等待', { waitKey: 'same-wait', category: 'production' });
  app.emit(a, 'warn', '甲等待错误', { waitKey: 'same-wait', category: 'production' });
  app.emit(a, 'info', '甲等待再次检查', { waitKey: 'same-wait', category: 'production' });
  await page.locator('#log .row').filter({ hasText: '甲等待再次检查' }).waitFor();
  assert.equal(await page.locator('#log [data-batch=same-batch]').count(), 2);
  assert.equal(await page.locator('#log [data-wait-key=same-wait]').count(), 3);
  assert.match(await page.locator('#log [data-account=logs-a][data-wait-key=same-wait].info .log-message').textContent(), /累计 2 次/);
  assert.match(await page.locator('#log [data-account=logs-b][data-wait-key=same-wait] .log-message').textContent(), /乙等待/);
  console.log('通过：同名排产与等待日志按账号和等级隔离合并');

  await page.route('**/api/log-fixture-error*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试账号请求失败' }) }));
  await page.evaluate(() => call('/api/log-fixture-error?account=logs-a').catch(() => {}));
  assert.equal(await page.locator('#log .row').filter({ hasText: '测试账号请求失败' }).count(), 1);
  assert.equal(await page.locator('#log .row').filter({ hasText: '测试账号请求失败' }).getAttribute('data-account'), 'logs-a');
  assert.equal(await page.evaluate(() => current), 'logs-b');
  await page.unroute('**/api/log-fixture-error*');
  const identities = await page.evaluate(() => {
    accounts.push({ id: 'same-prefix-a', title: '同名账号' }, { id: 'same-prefix-b', title: '同名账号' });
    const labels = ['same-prefix-a', 'same-prefix-b'].map(logAccountLabel);
    accounts.splice(-2); return labels;
  });
  assert.notEqual(...identities);
  console.log('通过：跨账号请求错误归属明确，同名且编号前缀相同的账号仍可区分');

  await page.locator('#log-account').selectOption('logs-a');
  await page.locator('#log-clear').click();
  await page.waitForFunction(() => !document.querySelector('#log [data-account="logs-a"]'));
  assert.equal(a.log.length, 0);
  assert(b.log.length > 0);
  assert.equal(await page.evaluate(() => current), 'logs-b', '日志筛选不切换正在操作的账号');
  await page.locator('#log-account').selectOption('all');
  assert(await page.locator('#log [data-account=logs-b]').count() > 0);
  assert(await page.locator('#log .row').filter({ hasText: '系统资源检查完成' }).isVisible());
  app.emit(a, 'info', '清空后重新生产', { category: 'production' });
  await page.locator('#log .row').filter({ hasText: '清空后重新生产' }).waitFor();
  await page.evaluate(() => appendLog({ id: 1, t: 1, account: 'logs-a', level: 'info', message: '已清空迟到日志' }));
  assert.equal(await page.getByText('已清空迟到日志', { exact: true }).count(), 0);
  console.log('通过：清空使用筛选账号，保留其他账号及系统日志，并拒绝迟到旧记录');

  const store = loadStore(); store.accounts[0].label = '已修改的账号备注'; saveStore(store);
  await page.locator('#logs-close').click(); await page.evaluate(() => loadAccounts(false));
  await page.locator('#logs-open').click();
  assert.match(await page.locator('#log [data-account=logs-a] .log-account').textContent(), /已修改的账号备注/);
  const xss = app.emit(a, 'info', '<img src=x onerror=alert(1)>', { category: 'production' });
  await page.locator('#log .log-message').filter({ hasText: xss.message }).waitFor();
  assert.equal(await page.locator('#log img').count(), 0);
  // 多窗口：清空推送到全部账号视图，断线后的重放不复活旧记录。
  const second = await browser.newPage(); await second.goto(base);
  await second.locator('#account-picker-title').filter({ hasText: '已修改的账号备注' }).waitFor();
  await second.locator('#logs-open').click();
  await second.locator('#log-account').selectOption('logs-b');
  await second.locator('#log-clear').click();
  await page.waitForFunction(() => !document.querySelector('#log [data-account="logs-b"]'));
  for (const response of streams) response.destroy();
  app.emit(b, 'info', '重连后收到乙账号新日志', { category: 'alliance' });
  await page.locator('#log .log-message').filter({ hasText: '重连后收到乙账号新日志' }).waitFor();
  assert.equal(await page.locator('#log .log-message').filter({ hasText: '城战舰队等待维修' }).count(), 0);
  await second.close();
  console.log('通过：备注刷新、文本安全渲染、多窗口清空与SSE重连回放');

  await page.evaluate(() => {
    const now = Date.now();
    for (let index = 0; index < 450; index++) appendLog({ id: 10000 + index, t: now + index, account: index % 2 ? 'logs-a' : 'logs-b', category: 'production', level: 'info', message: '缓存容量检查' + index });
  });
  assert.equal(await page.locator('#log .row').count(), 400);
  assert.equal(await page.locator('#log-top-count').textContent(), '400');
  await page.locator('#log-account').selectOption('logs-a');
  assert.equal(await page.locator('#log .row:visible').count(), 200);
  assert.equal(await page.locator('#log-count').textContent(), '200');
  const scrolled = await page.evaluate(() => {
    logEl.scrollTop = 1000;
    const row = [...logEl.children].find(item => !item.hidden && item.getBoundingClientRect().bottom > logEl.getBoundingClientRect().top);
    const before = row.getBoundingClientRect().top;
    appendLog({ id: 10500, t: Date.now() + 1000, account: 'logs-a', category: 'production', level: 'info', message: '浏览历史期间的新记录' });
    return Math.abs(row.getBoundingClientRect().top - before);
  });
  assert(scrolled <= 1, '新日志不应打断正在查看的历史位置');
  await page.locator('#log-account').selectOption('all');
  await page.evaluate(() => { seen.clear(); clear(logEl); updateLogSummary(); });
  app.emit(a, 'info', '工厂完成木板生产', { category: 'production' });
  app.emit(b, 'warn', '城战舰队等待维修', { category: 'alliance' });
  app.emit(null, 'info', '系统资源检查完成');
  const renamed = loadStore(); renamed.accounts[0].label = longTitle; saveStore(renamed);
  await page.locator('#logs-close').click(); await page.evaluate(() => loadAccounts(false));
  await page.locator('#logs-open').click();
  await page.locator('#log .row').filter({ hasText: '系统资源检查完成' }).waitFor();
  console.log('通过：列表与计数上限400条，账号计数正确，新日志保持历史滚动位置');

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width > 768 ? 1000 : 844 });
    await page.screenshot({ path: path.join(output, 'logs-' + width + '.png'), animations: 'disabled' });
    const layout = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
      return { dialog: rect('journal-dialog'), log: rect('log'), account: rect('log-account'), clear: rect('log-clear'), width: innerWidth, height: innerHeight };
    });
    assert(layout.dialog.left >= -1 && layout.dialog.right <= layout.width + 1, JSON.stringify(layout));
    assert(layout.account.right <= layout.dialog.right && layout.clear.right <= layout.dialog.right, JSON.stringify(layout));
    assert(layout.log.height >= 100 && layout.log.bottom <= layout.height + 1, JSON.stringify(layout));
    assert.equal(await page.locator('#log').evaluate(node => node.scrollWidth > node.clientWidth), false, '长账号名称和日志不能横向溢出');
    assert(await page.locator('#log .log-account').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), '账号标识必须完整换行，不能在标签内截断');
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(output, 'logs-dark.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  assert.equal(connections, 0);
  console.log('通过：320–1440px布局和深色截图检查，全程无页面异常与游戏连接');
} finally {
  await browser?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
