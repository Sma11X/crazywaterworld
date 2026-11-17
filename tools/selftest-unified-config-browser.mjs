// 隔离账号验证模块启停与配置共页；禁止连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-unified-config-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings, settingsUiRules } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('配置验收禁止连接游戏'); };
saveStore({ version: 1, activeId: 'config-a', accounts: ['config-a', 'config-b'].map((id, index) => ({
  id, label: '配置验收账号' + (index + 1), url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
})) });
const settings = defaultSettings();
settings.factory.enabled = true; settings.factory.produce = false; settings.factory.keepStock = 321;
settings.heroes.enabled = true; settings.loop.heroes = false; settings.heroes.level = false; settings.heroes.star = true;
settings.museum.runEnabled = true; settings.museum.enabled = settings.museum.upgrade = false;
settings.schedule.museumCollect = settings.schedule.museumExplore = false;
saveAutomationSettings('config-a', settings, { revision: 0 });
saveAutomationSettings('config-b', defaultSettings(), { revision: 0 });
const otherBefore = loadAutomationSettings('config-b');
const output = path.resolve('output/unified-config'); fs.mkdirSync(output, { recursive: true });
const app = createConsole({ port: 0, protocol: {} });
let browser;
const errors = [];
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
  const saved = () => page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  const openConfig = async () => {
    await page.locator('#account-picker-title').filter({ hasText: '配置验收账号' }).waitFor();
    await page.locator('#tabs [data-tab=settings]').click();
    await page.locator('#config-field-building-enabled').waitFor(); await saved();
  };
  const group = async id => {
    await page.evaluate(id => {
      const item = configEditor.groups.get(id);
      configActivate(item.category); configActivateGroup(id);
    }, id);
    await page.locator('#config-group-' + id).waitFor();
  };
  await page.goto(base); await openConfig();
  assert.equal(await page.locator('#tabs [data-tab=idle], #tab-idle').count(), 0);
  assert.equal(await page.locator('#tabs > button').count(), 7);
  assert.equal(await page.getByText('前往挂机启停', { exact: true }).count(), 0);
  for (const control of settingsUiRules().moduleControls) {
    const selector = '[data-config-key="' + control.key + '"]';
    assert.equal(await page.locator(selector).count(), 1, control.key + ' 唯一');
    assert.equal(await page.locator('#config-group-' + control.configTarget + ' ' + selector).count(), 1, control.key + ' 配置归属');
  }
  assert.equal(await page.locator('[data-config-key="loop.heroes"]').count(), 0);
  console.log('通过：32个模块开关各自归位，旧导航与跨页跳转移除');

  await page.locator('[data-config-family=production]').click();
  const factory = page.locator('#config-field-factory-enabled');
  await factory.click(); await page.locator('#config-field-factory-keepStock').fill('432'); await saved();
  assert.equal(await factory.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#config-field-factory-produce').getAttribute('aria-checked'), 'false');
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, false);
  assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 432);
  assert.equal(loadAutomationSettings('config-a').settings.factory.produce, false);
  await page.screenshot({ path: path.join(output, 'factory-desktop.png'), animations: 'disabled' });
  await page.reload(); await openConfig(); await page.locator('[data-config-family=production]').click();
  assert.equal(await factory.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), '432');
  await factory.focus(); await page.keyboard.press('Space'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, true);
  assert.equal(loadAutomationSettings('config-a').settings.factory.produce, false);
  console.log('通过：模块暂停与参数一同保存，刷新、键盘启用不改细项');

  await page.locator('[data-config-tab=heroes]').click();
  await page.locator('[data-config-group=heroes]').click();
  const hero = page.locator('#config-field-heroes-enabled');
  assert.equal(await hero.getAttribute('aria-checked'), 'false', '组合字段有一项关闭时显示暂停');
  await hero.click(); await saved();
  let stored = loadAutomationSettings('config-a').settings;
  assert.equal(stored.heroes.enabled, true); assert.equal(stored.loop.heroes, true);
  await hero.click(); await saved(); stored = loadAutomationSettings('config-a').settings;
  assert.equal(stored.heroes.enabled, false); assert.equal(stored.loop.heroes, false);
  assert.equal(stored.heroes.level, false); assert.equal(stored.heroes.star, true);
  await group('museum');
  assert.match(await page.locator('#config-field-museum-runEnabled-note').textContent(), /尚未选择执行动作/);
  await page.locator('#config-field-museum-enabled').click(); await saved();
  assert.equal(await page.locator('#config-field-museum-runEnabled-note').isVisible(), false);
  console.log('通过：英雄组合主控同时保存两层状态，博物馆未配置提示及时更新');

  assert.equal(await page.locator('[data-config-tab=runtime], #config-field-loop-rounds, #config-group-runtime').count(), 0);
  assert.deepEqual(await page.locator('[data-config-tab]').allTextContents(), ['基地', '世界', '英雄', '日常与活动']);
  await page.locator('#account-picker-trigger').click();
  await page.locator('#account-picker-list [role=option]').filter({ hasText: '配置验收账号2' }).click();
  await page.locator('#config-account-name').filter({ hasText: '配置验收账号2' }).waitFor(); await saved();
  assert.deepEqual(loadAutomationSettings('config-b'), otherBefore, '另一个账号不受编辑影响');
  await group('factory');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), String(otherBefore.settings.factory.keepStock));
  await page.locator('#account-picker-trigger').click();
  await page.locator('#account-picker-list [role=option]').filter({ hasText: '配置验收账号1' }).click();
  await page.locator('#config-account-name').filter({ hasText: '配置验收账号1' }).waitFor(); await saved();
  await group('factory');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), '432');
  console.log('通过：运行安排入口移除，切换账号隔离且保留已保存配置');

  // 外部页面改变版本后，组合开关的本地修改不能静默覆盖它。
  const external = loadAutomationSettings('config-a'); external.settings.factory.keepStock = 876;
  saveAutomationSettings('config-a', external.settings, { revision: external.revision });
  await factory.click();
  await page.locator('#config-state').filter({ hasText: '配置有冲突' }).waitFor();
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, true);
  assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 876);
  assert.equal(await factory.getAttribute('aria-checked'), 'false', '本地草稿仍保留供处理');
  console.log('通过：合并后的模块开关仍受配置版本冲突保护');

  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const mobile = await context.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(base); await mobile.locator('#account-picker-title').filter({ hasText: '配置验收账号1' }).waitFor();
  await mobile.locator('#tabs [data-tab=settings]').tap();
  await mobile.locator('#config-field-building-enabled').waitFor();
  await mobile.locator('[data-config-tab=world]').tap();
  await mobile.locator('#config-field-cityWar-enabled').waitFor();
  await mobile.screenshot({ path: path.join(output, 'world-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator('[data-config-tab=base]').tap();
  await mobile.locator('[data-config-family=production]').tap();
  await mobile.locator('#config-field-factory-enabled').tap();
  await mobile.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, false);
  await mobile.screenshot({ path: path.join(output, 'factory-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  for (const width of [320, 360, 390, 430, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    await mobile.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('#log-top-count').textContent = '99999';
      document.querySelector('#loop-every').value = '86400';
    });
    const layout = await mobile.evaluate(() => {
      const controls = ['loop-every', 'loop-toggle', 'account-pause', 'logs-open'].map(id => {
        const node = document.getElementById(id), box = node.getBoundingClientRect();
        return { id, top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, overflow: node.scrollWidth > node.clientWidth + 1 };
      });
      const bar = document.querySelector('.config-tabs').getBoundingClientRect();
      const tabs = [...document.querySelectorAll('[data-config-tab]')].map(node => {
        const box = node.getBoundingClientRect();
        return { top: box.top, left: box.left, right: box.right, visible: box.left >= bar.left && box.right <= bar.right + 1 && box.top >= bar.top && box.bottom <= bar.bottom + 1, overflow: node.scrollWidth > node.clientWidth + 1 };
      });
      return { controls, tabs, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(layout.overflow, false, width + 'px 页面无横向溢出');
    assert(layout.controls.every(item => Math.abs(item.top - layout.controls[0].top) <= 1 && item.height >= 40 && item.left >= 0 && item.right <= width && !item.overflow), JSON.stringify({ width, layout }));
    assert.equal(layout.tabs.length, 4);
    assert(layout.tabs.every(item => item.visible && !item.overflow && Math.abs(item.top - layout.tabs[0].top) <= 1), JSON.stringify({ width, layout }));
    assert.equal(await mobile.evaluate(() => [...document.querySelectorAll('.config-subtabs,.config-families')].filter(node => node.getClientRects().length).every(bar => {
      const bounds = bar.getBoundingClientRect();
      return [...bar.children].filter(node => node.getClientRects().length).every(node => {
        const box = node.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom + 1;
      });
    })), true, width + 'px 触屏子页签的按钮完整位于底座内');
    for (const category of ['daily', 'heroes', 'world', 'base']) {
      await mobile.locator('[data-config-tab=' + category + ']').tap();
      assert.equal(await mobile.locator('[data-config-tab=' + category + ']').getAttribute('aria-selected'), 'true');
    }
    await mobile.screenshot({ path: path.join(output, 'header-tabs-' + width + '.png'), animations: 'disabled' });
  }
  console.log('通过：320–768px 手机顶部四项操作同排，四个配置分类完整显示并可点击，大日志数和最大间隔不撑破布局');
  assert.deepEqual(errors, []); assert.equal(connections, 0);
  console.log('通过：360px手机导航、启停和参数无横向溢出，无脚本错误或游戏连接');
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
