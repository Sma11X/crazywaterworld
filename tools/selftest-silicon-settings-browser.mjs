// 使用完整控制台和真实 HTTP 配置接口；游戏只使用本地协议夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-silicon-settings-browser-'));
process.env.CW_DATA_DIR = directory; process.env.CW_CONFIG_PACK = path.join(directory, 'config.json'); process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { siliconFixture } = await import('./fixtures/silicon.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { GameClient } = await import('../src/client.mjs');
GameClient.prototype.connect = async () => { throw Error('配置验收禁止建立真实游戏连接'); };
const f = siliconFixture();
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(f.config.tables).map(([name, table], i) => [i, name, table])));
saveStore({ activeId: 'one', accounts: ['one', 'two'].map(id => ({ id, label: '配置验收 ' + id, url: 'wss://invalid.invalid', login: {}, automation: { paused: true, enabled: false } })) });
const initial = defaultSettings(); initial.silicon.petrolReserve = 12345; initial.silicon.fleets[0].safePlayers = ['朋友'];
saveAutomationSettings('one', initial, { revision: 0 });
const app = createConsole({ port: 0, protocol: f.protocol }), base = await app.listen();
await fetch(base + '/api/settings?account=one'); const session = app.sessions.get('one');
session.client = f.client; session.player = f.player; session.paused = false;
const output = path.resolve('output/silicon-settings'); fs.mkdirSync(output, { recursive: true });
const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
let browser; const errors = [];
const saved = () => loadAutomationSettings('one');
const settled = page => page.waitForFunction(() => siliconSettingsEditor.data && !siliconSettingsEditor.loading && !siliconSettingsEditor.saving);
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const [name, width, theme] of [['desktop', 1440, 'light'], ['dark', 1440, 'dark'], ['mobile', 390, 'light'], ['small-mobile', 320, 'light']]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/world/overview?*', route => route.fulfill({ json: { checkedAt: Math.floor(Date.now() / 1000), scenario: 1, width: 1, height: 1, regions: [], owners: [], points: [], routes: [], fleets: [], cityWars: [], treasures: [], layers: {}, notes: [] } }));
    await page.route('**/api/overview?*', async route => { const status = await (await fetch(base + '/api/loop?account=one')).json(); await route.fulfill({ json: { player: { nickname: '测试船长', level: 36 }, resources: [], status } }); });
    await page.goto(base); await page.locator('.silicon-settings-fleet').nth(2).waitFor(); await settled(page);
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.evaluate(() => configLoad());
    const before = saved(), expectedEnabled = !before.settings.silicon.enabled;
    await page.locator('#silicon-auto-enabled').click(); await settled(page);
    assert.equal(saved().settings.silicon.enabled, expectedEnabled);
    assert.equal(await page.evaluate(() => configEditor.draft.silicon.enabled), expectedEnabled, '已加载的主配置页同步快捷保存');
    assert.equal(await page.evaluate(() => configIsDirty()), false);
    const first = page.locator('.silicon-settings-fleet').first();
    await first.getByRole('switch', { name: '1号舰队 · 自动参与' }).click(); await settled(page);
    await first.getByRole('combobox', { name: '1号舰队 · 目标矿级' }).selectOption('BLUE'); await settled(page);
    await first.getByRole('switch', { name: '1号舰队 · 只占空位' }).click(); await settled(page);
    assert.equal(saved().settings.silicon.fleets[0].tier, 'BLUE');
    assert.equal(saved().settings.silicon.petrolReserve, 12345); assert.deepEqual(saved().settings.silicon.fleets[0].safePlayers, ['朋友']);
    assert.deepEqual(await page.evaluate(() => configEditor.draft.silicon), saved().settings.silicon);
    // 在常规配置页编辑相同字段，再回到概览核对。
    await page.locator('a[href="#config-group-silicon"]').first().click();
    await page.waitForFunction(() => configVisible() && !configEditor.loading);
    await page.evaluate(() => { configSet('silicon.fleets.0.tier', 'PURPLE'); });
    await page.waitForFunction(() => !configIsDirty() && !configEditor.saving);
    await page.locator('[data-tab="overview"]').click();
    await page.waitForFunction(() => siliconSettingsEditor.data?.settings.fleets[0].tier === 'PURPLE'); await settled(page);
    assert.equal(await first.getByRole('combobox').inputValue(), 'PURPLE');
    assert.match(await page.locator('#silicon-settings').textContent(), /先关闭该队参与，再撤回/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' 页面不能横向溢出');
    const panel = page.locator('#silicon-settings');
    assert.deepEqual(await panel.evaluate(node => [...node.querySelectorAll('*')].filter(child => child.scrollWidth > child.clientWidth + 2 && getComputedStyle(child).display !== 'inline' && child.clientWidth > 0).map(child => child.outerHTML)), [], name + ' 快捷配置内容不能裁切');
    assert.equal(await page.locator('#silicon-auto-enabled').isDisabled(), false);
    await panel.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
    if (name === 'desktop') {
      // 另一窗口先保存，不允许用旧版本覆盖；明确重新读取后才能操作。
      const old = saved(), other = structuredClone(old.settings); other.silicon.petrolReserve = 12500;
      saveAutomationSettings('one', other, { revision: old.revision });
      await page.locator('#silicon-auto-enabled').click();
      await page.waitForFunction(() => siliconSettingsEditor.error?.fields?.revision);
      assert.match(await page.locator('#silicon-settings-status').textContent(), /重新读取/);
      assert.equal(await page.locator('#silicon-auto-enabled').isDisabled(), true);
      assert.equal(saved().settings.silicon.petrolReserve, 12500);
      await page.locator('#silicon-settings-reload').click(); await settled(page);
      assert.equal(await page.evaluate(() => siliconSettingsEditor.error), null);
      // 网络失败保持服务器值，重读后恢复；不自动重发保存。
      let attempts = 0;
      const fail = async route => { if (route.request().method() === 'POST') { attempts++; await route.fulfill({ status: 503, json: { error: '模拟保存失败' } }); } else await route.continue(); };
      await page.route('**/api/silicon/settings?*', fail);
      const value = saved().settings.silicon.enabled;
      await page.locator('#silicon-auto-enabled').click(); await page.waitForFunction(() => !!siliconSettingsEditor.error);
      assert.equal(saved().settings.silicon.enabled, value); assert.equal(attempts, 1);
      await page.unroute('**/api/silicon/settings?*', fail); await page.locator('#silicon-settings-reload').click(); await settled(page);
      // 主配置页有未保存草稿时，快捷控件不能覆盖。
      await page.evaluate(async () => { await configLoad(true); configSet('silicon.petrolReserve', 12345); configCancelSaveTimer(); paintSiliconSettingsState(); });
      assert.equal(await page.locator('#silicon-auto-enabled').isDisabled(), true); assert.match(await page.locator('#silicon-settings-status').textContent(), /先完成/);
      await page.evaluate(async () => { await configSave(null); await refreshSiliconSettings(); }); await settled(page);
      // 单次操作确认期间禁用配置，取消后恢复。
      const mine = page.locator('.silicon-mine[data-tier=BLUE]');
      await mine.locator('.silicon-slot').first().click(); await mine.getByRole('button', { name: '派遣采集' }).click();
      await page.waitForFunction(() => siliconAction?.phase === 'ready');
      assert.equal(await page.locator('#silicon-auto-enabled').isDisabled(), true);
      await page.locator('#silicon-action-cancel').click(); assert.equal(await page.locator('#silicon-auto-enabled').isDisabled(), false);
      // 发出保存后切换账号，迟到响应仍只属于原账号。
      let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
      const delay = async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); };
      await page.route('**/api/silicon/settings?*', delay);
      const otherBefore = loadAutomationSettings('two');
      await page.locator('#silicon-auto-enabled').click(); await started;
      await page.evaluate(async () => { stateActions.selectAccount('two'); siliconAccountChanged(); await refreshSiliconSettings(); });
      assert.equal(await page.locator('.silicon-settings-fleet').count(), 0); release();
      await page.waitForResponse(response => response.url().includes('/api/silicon/settings') && response.request().method() === 'POST');
      assert.equal(await page.evaluate(() => siliconSettingsEditor.owner), 'two');
      assert.equal(await page.locator('#silicon-auto-enabled').getAttribute('aria-checked'), 'false');
      assert.deepEqual(loadAutomationSettings('two'), otherBefore); assert.equal(app.sessions.get('two').client, null);
      await page.unroute('**/api/silicon/settings?*', delay);
    }
    assert.deepEqual(errors, []); await page.close(); console.log('通过：' + name + ' 快捷配置、双向同步、布局与截图');
  }
  assert.equal(f.client.writes.length, 0); assert.equal(session.loop.running, false);
  console.log('通过：版本冲突、保存失败、未存草稿、手动确认互斥和切号迟到响应；无游戏写操作');
} finally {
  await browser?.close(); session.client = null; app.server.closeAllConnections(); await app.close();
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir())); assert(path.basename(directory).startsWith('cw-silicon-settings-browser-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
