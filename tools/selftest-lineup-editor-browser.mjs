// Run manually after build:ui. The browser uses isolated accounts and a fake game client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lineup-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_PROTO_BUNDLE = path.join(directory, 'no-game-protocol.js');
const output = path.resolve('output/playwright');
fs.mkdirSync(output, { recursive: true });

const { getConfig } = await import('../src/config.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
GameClient.prototype.connect = async () => { throw new Error('浏览器验收禁止连接真实游戏'); };
const config = getConfig();
const owned = config.tables.HeroCfg.data.filter(hero => ['BLUE', 'PURPLE', 'ORANGE', 'RED'].includes(hero.quality)).slice(0, 12);
assert(owned.length >= 6, '需要本机英雄配置与素材');
const seats = config.tables.FormationTypePositionCfg.data.filter(row => row.id === 1).map(row => ({ x: row.position[0], y: row.position[1] }));
const formation = { presetId: 1, heroPositions: seats.map((pos, index) => ({ heroId: owned[index].id, pos })), petUid: '0' };
const accountId = 'lineup-browser-fixture';
saveStore({ version: 1, activeId: accountId, accounts: [{
  id: accountId, label: '阵容界面隔离验收', url: 'ws://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: false },
}] });
const settings = defaultSettings();
settings.login.autoReconnect = false;
settings.progression.mainline = true;
settings.progression.trials = true;
settings.lineups = { presets: [{ id: 'qa-lineup', name: '主线突击', formation }], mainlinePresetId: '', trialPresets: [] };
saveAutomationSettings(accountId, settings, { revision: 0 });
const requests = [], gameWrites = [], challengePayloads = [], pageErrors = [];
const client = new EventEmitter();
Object.assign(client, {
  connected: true, serverClockOffsetMs: 0, stopping: false,
  async request(name) {
    requests.push(name);
    if (name === 'GetFormationRequest') return { formation: structuredClone(formation) };
    if (name === 'AllHeroRequest') return { heroes: owned.map((hero, index) => ({ heroId: hero.id, level: 60 + index, power: 10000 + index * 1234 })) };
    if (name === 'MyFormationPresetRequest') return { ids: config.tables.FormationTypeUnlockCfg.data.slice(0, 10).map(row => row.id) };
    if (name === 'AllPetRequest') return { pets: config.tables.PetBreedCfg.data.slice(0, 3).map((pet, index) => ({ petId: pet.petId, uid: String(9007199254741000n + BigInt(index)), star: 2, level: 30 })) };
    throw new Error('验收未声明的游戏读取 ' + name);
  },
  async sendWatch(name) { gameWrites.push(name); throw new Error('阵容编辑验收不允许游戏写入 ' + name); },
  send(name) { gameWrites.push(name); throw new Error('阵容编辑验收不允许游戏写入 ' + name); },
  stop() { this.connected = false; this.stopping = true; },
  interleaveRead(work) { return work(); },
});
const player = { playerId: '9007199254741801', worldId: 1000001, level: 100, nickname: '界面验收船长', mainlineStage: 9999 };
const app = createConsole({ port: 0, protocol: {}, resourceUpdates: false });
let browser;
try {
  await app.listen();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  await fetch(base + '/api/settings?account=' + accountId);
  const session = app.sessions.get(accountId); session.client = client; session.player = player; session.paused = false;
  const accountSnapshot = await fetch(base + '/api/accounts').then(response => response.json());
  const status = accountSnapshot.accounts[0].status;
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(file => fs.existsSync(file));
  assert(executablePath, '未找到浏览器，可用 CW_BROWSER_TEST_EXECUTABLE 指定');
  browser = await chromium.launch({ executablePath, headless: true });

  async function openPage(viewport, mobile = false) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const respond = data => route.fulfill({ json: data });
      if (url.pathname === '/api/overview') return respond({ player, account: { title: '阵容界面隔离验收' }, status, resources: [] });
      if (url.pathname === '/api/world/overview') return respond({
        width: 1000, height: 1000, checkedAt: Math.floor(Date.now() / 1000),
        layers: {}, regions: [], routes: [], points: [], fleets: [], notes: [],
      });
      if (url.pathname === '/api/equipment') return respond({ locked: true, requiredLevel: 1 });
      if (url.pathname === '/api/equipment/crafting') return respond({ state: 'locked', buildCosts: [], recipes: [] });
      if (url.pathname === '/api/fleets/formation') return respond({ locked: true, docks: [] });
      if (url.pathname === '/api/lineups') return respond({ targets: [{ key: 'mainline', title: '主线', reason: '隔离验收', current: null, recommended: [], near: [] }] });
      if (url.pathname === '/api/trials') return respond(config.tables.TrialRaidCfg.data.map(raid => ({
        raidId: raid.raidId, name: raid.title, next: { id: raid.raidId * 1000 + 1, level: 1, power: 1000 }, task: { running: false },
      })));
      if (url.pathname === '/api/trials/tasks') return respond({});
      if (['/api/trials/challenge', '/api/trials/start', '/api/stages/start'].includes(url.pathname)) {
        challengePayloads.push({ path: url.pathname, ...route.request().postDataJSON() });
        return respond({ running: false, reason: '受控挑战入口验收', wins: 0, failures: 0 });
      }
      return route.continue();
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#account-picker-title').filter({ hasText: '阵容界面隔离验收' }).waitFor();
    const tab = page.locator('#tabs [data-tab="lineups"]');
    if (mobile) {
      const navFits = await page.locator('#tabs > button').evaluateAll(buttons => {
        const boxes = buttons.map(button => button.getBoundingClientRect());
        return boxes.every(box => box.top === boxes[0].top && box.width > 0 && box.left >= 0 && box.right <= innerWidth);
      });
      assert(navFits, '手机底部导航所有页签均在同一行内可见');
      await tab.tap();
    } else await tab.click();
    const panel = page.locator('#tab-lineups');
    await panel.locator('#saved-lineup-view').getByRole('button', { name: '编辑阵容 主线突击', exact: true }).waitFor();
    await panel.locator('#lineup-view').getByText('隔离验收', { exact: true }).waitFor();
    assert.equal(await tab.getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);
    assert.equal(await page.locator('#tab-heroes #saved-lineup-view, #tab-heroes #lineup-view').count(), 0);
    assert.equal(await page.locator('#tab-heroes #formation-view').count(), 1);
    return { context, page };
  }

  const desktop = await openPage({ width: 1440, height: 1000 });
  const page = desktop.page;
  const modal = page.locator('#saved-lineup-dialog');
  const editorRequests = () => requests.filter(name => name === 'GetFormationRequest').length;
  const openEditor = async (targetPage, name) => {
    await targetPage.getByRole('button', { name: '编辑阵容 ' + name, exact: true }).click();
    await targetPage.locator('#saved-lineup-dialog[open][data-lineup-mode="editor"] .lineup-hero').first().waitFor();
    const bounds = await targetPage.locator('#saved-lineup-dialog').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: innerWidth, height: innerHeight };
    });
    assert(bounds.top >= 0 && bounds.bottom <= bounds.height + 1);
    assert(bounds.left >= 0 && bounds.right <= bounds.width + 1);
  };
  const saveEditor = async (targetPage, touch = false) => {
    const response = targetPage.waitForResponse(result => result.url().includes('/api/lineup-presets/save') && result.request().method() === 'POST');
    const save = targetPage.getByRole('button', { name: '保存阵容', exact: true });
    if (touch) await save.tap();
    else await save.click();
    assert.equal((await response).status(), 200);
    await targetPage.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
  };
  const assertViewer = async (targetPage, name) => {
    await targetPage.locator('#saved-lineup-dialog[open][data-lineup-mode="viewer"]').waitFor();
    assert.equal(await targetPage.locator('#saved-lineup-viewer input, #saved-lineup-viewer select, #saved-lineup-viewer [draggable="true"]').count(), 0);
    assert.equal(await targetPage.getByRole('button', { name: '保存阵容', exact: true }).count(), 0);
    assert((await targetPage.locator('#saved-lineup-viewer').textContent()).includes(name));
  };

  const beforeView = editorRequests();
  const revisionBeforeView = loadAutomationSettings(accountId).revision;
  await page.getByRole('button', { name: '查看阵容 主线突击', exact: true }).click();
  await assertViewer(page, '主线突击');
  assert.equal(editorRequests(), beforeView, '查看保存阵容不读取游戏阵容');
  assert.equal(loadAutomationSettings(accountId).revision, revisionBeforeView);
  await page.screenshot({ path: path.join(output, 'lineup-viewer-desktop.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '查看阵容 主线突击', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('#saved-lineup-view .lineup-editor, .saved-lineup-bindings').count(), 0);
  console.log('通过：保存阵容可离线只读查看，Esc关闭并返回焦点');

  await openEditor(page, '主线突击');
  assert.equal(await page.locator('.lineup-formation-choice').count(), 24);
  assert.equal(await page.locator('.lineup-slot').count(), seats.length);
  await page.waitForFunction(() => [...document.querySelectorAll('.lineup-portrait img')].some(image => image.complete && image.naturalWidth > 0));
  await page.getByLabel('阵容名称', { exact: true }).fill('关闭保留草稿');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  await openEditor(page, '主线突击');
  assert.equal(await page.getByLabel('阵容名称', { exact: true }).inputValue(), '关闭保留草稿');
  await page.getByLabel('阵容名称', { exact: true }).fill('桌面验证阵容');
  await page.locator('.lineup-hero').nth(6).click();
  await page.locator('.lineup-slot').first().click();
  await page.getByLabel('出战海兽', { exact: true }).selectOption({ index: 1 });
  await saveEditor(page);
  const saved = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(saved.name, '桌面验证阵容');
  assert(saved.formation.heroPositions.some(item => item.heroId === owned[6].id));
  assert.equal(saved.formation.petUid, '9007199254741000');
  console.log('通过：编辑弹窗关闭保留草稿，成功保存后关闭并更新列表');

  await openEditor(page, '桌面验证阵容');
  await page.screenshot({ path: path.join(output, 'lineup-editor-desktop.png'), animations: 'disabled' });
  const sourceSlot = page.locator('.lineup-slot').first(), targetSlot = page.locator('.lineup-slot').nth(1);
  const sourcePosition = await sourceSlot.getAttribute('data-lineup-position');
  const targetPosition = await targetSlot.getAttribute('data-lineup-position');
  const heroAt = (value, position) => value.formation.heroPositions.find(item => [item.pos.x, item.pos.y].join(',') === position)?.heroId;
  const sourceHero = heroAt(saved, sourcePosition), targetHero = heroAt(saved, targetPosition);
  await sourceSlot.scrollIntoViewIfNeeded();
  const from = await sourceSlot.boundingBox(), to = await targetSlot.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await saveEditor(page);
  const dragged = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(heroAt(dragged, sourcePosition), targetHero);
  assert.equal(heroAt(dragged, targetPosition), sourceHero);
  console.log('通过：弹窗内Pointer拖拽交换位置并经HTTP保存');

  await page.locator('#tabs [data-tab="settings"]').click();
  await page.locator('[data-config-tab="world"]').click();
  await page.locator('[data-config-group="progression"]').click();
  for (const field of ['mainline', 'trials']) {
    const disclosure = page.locator('.config-disclosure[aria-controls="config-field-progression-' + field + '-children"]');
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  }
  const bindingSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
  await page.locator('[data-lineup-binding="mainline"]').selectOption('qa-lineup');
  assert.equal((await bindingSave).status(), 200);
  const trialBindingSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
  await page.locator('[data-lineup-binding="trial:1"]').selectOption('qa-lineup');
  assert.equal((await trialBindingSave).status(), 200);
  const bound = loadAutomationSettings(accountId).settings.lineups;
  assert.equal(bound.mainlinePresetId, 'qa-lineup');
  assert(bound.trialPresets.some(item => item.raidId === '1' && item.presetId === 'qa-lineup'));
  await page.locator('[data-lineup-view="mainline"]').click();
  await assertViewer(page, '桌面验证阵容');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(output, 'lineup-settings-desktop.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '管理自定义阵容', exact: true }).click();
  await page.locator('#tab-lineups').getByRole('button', { name: '编辑阵容 桌面验证阵容', exact: true }).waitFor();
  assert.equal(await page.locator('#tabs [aria-current="page"]').getAttribute('data-tab'), 'lineups');
  console.log('通过：推关与试炼配置可选择并查看阵容，管理入口直达阵容页');

  await page.locator('#tabs [data-tab="stages"]').click();
  await page.locator('#stage-lineup-control select').selectOption('qa-lineup');
  await page.locator('#stage-lineup-control button').click();
  await assertViewer(page, '桌面验证阵容');
  await page.keyboard.press('Escape');
  const stageStart = page.waitForResponse(response => response.url().includes('/api/stages/start'));
  await page.locator('#stage-start').click();
  await stageStart;
  await page.locator('select[data-lineup-mode="trial:1"]').selectOption('qa-lineup');
  const trialRow = page.locator('[data-trial-task="1"]').locator('xpath=ancestor::*[contains(@class,"progression-row")]');
  await trialRow.getByRole('button', { name: '查看所选阵容', exact: true }).click();
  await assertViewer(page, '桌面验证阵容');
  await page.keyboard.press('Escape');
  const trialChallenge = page.waitForResponse(response => response.url().includes('/api/trials/challenge'));
  await trialRow.getByRole('button', { name: /挑战一次/ }).click();
  await trialChallenge;
  assert(challengePayloads.some(item => item.path === '/api/stages/start' && item.lineupId === 'qa-lineup'));
  assert(challengePayloads.some(item => item.path === '/api/trials/challenge' && item.lineupId === 'qa-lineup'));
  await page.locator('#tab-stages').screenshot({ path: path.join(output, 'lineup-challenge-desktop.png'), animations: 'disabled' });
  console.log('通过：主线和试炼对应入口选择、查看并发送所选阵容ID');

  const updated = loadAutomationSettings(accountId); updated.settings.lineups.presets[0].name = '主线突击';
  saveAutomationSettings(accountId, updated.settings, { revision: updated.revision });
  const mobile = await openPage({ width: 390, height: 844 }, true);
  await mobile.page.getByRole('button', { name: '编辑阵容 主线突击', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog[open][data-lineup-mode="editor"] .lineup-hero').first().waitFor();
  await mobile.page.getByRole('button', { name: '关闭阵容编辑器', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
  await mobile.page.getByRole('button', { name: '查看阵容 主线突击', exact: true }).tap();
  await assertViewer(mobile.page, '主线突击');
  await mobile.page.getByRole('button', { name: '关闭阵容查看', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
  console.log('通过：手机连续触摸打开、关闭编辑和查看弹窗');
  await openEditor(mobile.page, '主线突击');
  await mobile.page.getByLabel('阵容名称', { exact: true }).fill('手机验证阵容');
  await mobile.page.locator('.lineup-hero').nth(7).tap();
  await mobile.page.locator('.lineup-slot').first().tap();
  await saveEditor(mobile.page, true);
  assert.equal(loadAutomationSettings(accountId).settings.lineups.presets[0].name, '手机验证阵容');
  assert.equal(heroAt(loadAutomationSettings(accountId).settings.lineups.presets[0], sourcePosition), owned[7].id);
  await openEditor(mobile.page, '手机验证阵容');
  const metrics = await mobile.page.locator('.lineup-editor').evaluate(element => ({
    width: element.getBoundingClientRect().width, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    slots: [...element.querySelectorAll('.lineup-slot')].map(slot => ({ width: slot.getBoundingClientRect().width, height: slot.getBoundingClientRect().height })),
    rosterTouchAction: getComputedStyle(element.querySelector('.lineup-hero')).touchAction,
    portraitTouchAction: getComputedStyle(element.querySelector('.lineup-hero .lineup-portrait')).touchAction,
  }));
  assert(metrics.width <= metrics.viewport && metrics.scrollWidth <= metrics.viewport + 1);
  assert(metrics.slots.every(slot => slot.width >= 44 && slot.height >= 44));
  assert.equal(metrics.rosterTouchAction, 'pan-y'); assert.equal(metrics.portraitTouchAction, 'none');
  const touchSource = mobile.page.locator('.lineup-slot').first(), touchTarget = mobile.page.locator('.lineup-slot').nth(1);
  const beforeTouch = loadAutomationSettings(accountId).settings.lineups.presets[0];
  await touchSource.scrollIntoViewIfNeeded();
  const touchFrom = await touchSource.boundingBox(), touchTo = await touchTarget.boundingBox();
  const touchSession = await mobile.context.newCDPSession(mobile.page);
  const start = { x: touchFrom.x + touchFrom.width / 2, y: touchFrom.y + touchFrom.height / 2 };
  const end = { x: touchTo.x + touchTo.width / 2, y: touchTo.y + touchTo.height / 2 };
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (let step = 1; step <= 12; step++) {
    await touchSession.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12 }],
    });
    // Give the drag a human-paced duration so Chromium does not classify it as a fling.
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchSession.detach();
  await saveEditor(mobile.page, true);
  const afterTouch = loadAutomationSettings(accountId).settings.lineups.presets[0];
  assert.equal(heroAt(afterTouch, sourcePosition), heroAt(beforeTouch, targetPosition));
  assert.equal(heroAt(afterTouch, targetPosition), heroAt(beforeTouch, sourcePosition));
  await openEditor(mobile.page, '手机验证阵容');
  await mobile.page.screenshot({ path: path.join(output, 'lineup-editor-mobile.png'), animations: 'disabled' });
  await mobile.page.getByRole('button', { name: '关闭阵容编辑器', exact: true }).tap();
  await mobile.page.locator('#saved-lineup-dialog').waitFor({ state: 'detached' });
  await mobile.page.getByRole('button', { name: '查看阵容 手机验证阵容', exact: true }).tap();
  await assertViewer(mobile.page, '手机验证阵容');
  await mobile.page.screenshot({ path: path.join(output, 'lineup-viewer-mobile.png'), animations: 'disabled' });
  console.log('通过：390px手机弹窗编辑、触摸换位、保存和只读查看，无横向溢出');
  assert.deepEqual(gameWrites, []); assert.deepEqual(pageErrors, []);
  console.log('阵容浏览器验收通过，截图目录 ' + output);
  await desktop.context.close(); await mobile.context.close();
} finally {
  if (browser) await browser.close();
  app.server.closeAllConnections(); await app.close();
  const resolved = path.resolve(directory);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
