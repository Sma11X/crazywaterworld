import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-silicon-settings-'));
process.env.CW_DATA_DIR = directory; process.env.CW_CONFIG_PACK = path.join(directory, 'config.json'); process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const { siliconFixture } = await import('./fixtures/silicon.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { observeOwnedFleets } = await import('../src/fleet-catalog.mjs');
const f = siliconFixture();
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(f.config.tables).map(([name, table], i) => [i, name, table])));
saveStore({ activeId: 'one', accounts: ['one', 'two', 'legacy'].map(id => ({ id, label: id, url: 'wss://invalid.invalid', login: {}, automation: { paused: true, enabled: false } })) });
const settings = defaultSettings();
Object.assign(settings.silicon, { petrolReserve: 12345, dailyPetrolLimit: 5000, windows: ['08:00-23:00'] });
Object.assign(settings.silicon.fleets[0], { huntEnabled: true, huntPlayers: ['指定目标'], safePlayers: ['朋友'], safeGuilds: ['7'], huntRetreat: 'afterReward', autoRepair: true, maxPowerRatio: 75 });
settings.resources.keepAccelerators = 13;
saveAutomationSettings('one', settings, { revision: 0 });
const app = createConsole({ port: 0, protocol: f.protocol }), base = await app.listen();
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('通过：' + name); };
async function api(route, body, account = 'one') {
  const response = await fetch(base + '/api/' + route + '?account=' + account, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const change = (view, key, value, fleetId) => ({ key, value, ...(fleetId === undefined ? {} : { fleetId }), revision: view.revision, baseRevision: view.baseRevision, confirm: true });
try {
  await test('未连接也能读取和配置总开关，不虚构已建成舰队、不登录、不开始挂机', async () => {
    const view = ok(await api('silicon/settings')); assert.deepEqual(view.fleets, []); assert.equal(view.fleetAvailability.known, false);
    const saved = ok(await api('silicon/settings', change(view, 'enabled', true)));
    assert.equal(saved.settings.enabled, true); assert.equal(saved.running, false); assert.equal(app.sessions.get('one').client, null);
    assert.equal((await api('silicon/settings', change(saved, 'enabled', true, '1远征船'))).status, 400);
  });
  await test('概览真实舰队读取补齐快捷名单，仅展示服务器确认已建成队伍', async () => {
    const session = app.sessions.get('one'); session.client = f.client; session.player = f.player; session.paused = false;
    const third = f.state.fleets.pop();
    ok(await api('silicon/overview'));
    assert.deepEqual(ok(await api('silicon/settings')).fleets.map(row => row.value), ['1远征船', '2远征船']);
    f.state.fleets.push(third);
  });
  await test('四类字段窄更新，保留全部高级设置、其他舰队与其他账号', async () => {
    const before = ok(await api('settings')), other = ok(await api('settings', undefined, 'two')), expected = structuredClone(before.settings);
    let view = ok(await api('silicon/settings'));
    for (const [key, value, fleetId] of [['enabled', true, '1远征船'], ['tier', 'BLUE', '1远征船'], ['tier', 'PURPLE', '1远征船'], ['emptyOnly', false, '1远征船'], ['emptyOnly', true, '1远征船'], ['enabled', false, '1远征船'], ['enabled', false]]) {
      const saved = ok(await api('silicon/settings', change(view, key, value, fleetId)));
      (fleetId ? expected.silicon.fleets.find(row => row.id === fleetId) : expected.silicon)[key] = value;
      assert.equal(saved.revision, view.revision + 1); assert.deepEqual(ok(await api('settings')).settings, expected);
      assert.deepEqual(loadAutomationSettings('one').settings, expected); view = saved;
    }
    assert.deepEqual(ok(await api('settings', undefined, 'two')), other); assert.equal(f.client.writes.length, 0);
  });
  await test('拒绝非法键、类型、未建成舰队和伪造完整配置', async () => {
    const view = ok(await api('silicon/settings')), payload = change(view, 'enabled', true);
    for (const body of [null, [], { ...payload, key: '__proto__' }, { ...payload, key: 'autoRepair' }, { ...payload, settings: {} },
      { ...payload, fleetId: '3远征船' }, { ...payload, fleetId: null }, { ...payload, fleetId: '4远征船' }, { ...payload, confirm: false },
      { ...payload, value: 'true' }, { ...payload, value: 1 }, { ...payload, revision: String(view.revision) },
      change(view, 'tier', 'BLUE'), change(view, 'tier', 'OTHER', '1远征船'), change(view, 'emptyOnly', null, '1远征船')]) {
      assert.equal((await api('silicon/settings', body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(ok(await api('silicon/settings')), view);
  });
  await test('双向版本冲突不覆盖；其他配置页和快捷页使用同一份数据', async () => {
    const before = ok(await api('settings')), quick = ok(await api('silicon/settings'));
    ok(await api('silicon/settings', change(quick, 'enabled', true)));
    before.settings.silicon.petrolReserve++;
    let conflict = await api('settings', { settings: before.settings, revision: before.revision, baseRevision: before.baseRevision });
    assert.equal(conflict.status, 400); assert(conflict.data.fields.revision);
    const all = ok(await api('settings')), stale = ok(await api('silicon/settings'));
    all.settings.silicon.petrolReserve++;
    ok(await api('settings', { settings: all.settings, revision: all.revision, baseRevision: all.baseRevision }));
    conflict = await api('silicon/settings', change(stale, 'enabled', false));
    assert.equal(conflict.status, 400); assert(conflict.data.fields.revision);
    assert.deepEqual(ok(await api('silicon/settings')).settings, all.settings.silicon);
  });
  await test('零版本同时校验旧挂机基线，未知账号不会回退写入当前账号', async () => {
    const before = ok(await api('silicon/settings', undefined, 'legacy'));
    ok(await api('loop/task', { key: 'weekOrderSubmit', enabled: true, confirm: true }, 'legacy'));
    const result = await api('silicon/settings', change(before, 'enabled', true), 'legacy');
    assert.equal(result.status, 400); assert(result.data.fields.revision);
    assert.equal((await api('silicon/settings', change(before, 'enabled', true), 'missing')).status, 400);
  });
  await test('暂停及生产同步仍可预配置，关闭不撤回、不改变主挂机状态', async () => {
    const session = app.sessions.get('one'); session.paused = true; session.syncingProduction = true; f.client.connected = false;
    let changes = 0; f.client.on('automationSettingsChanged', () => changes++);
    f.occupy('1远征船', 5000, 0, 2);
    const before = JSON.stringify(f.state), view = ok(await api('silicon/settings'));
    assert.equal(view.fleetAvailability.stale, true);
    ok(await api('silicon/settings', change(view, 'enabled', false, '1远征船')));
    assert.equal(changes, 1); assert.equal(JSON.stringify(f.state), before); assert.equal(f.client.writes.length, 0);
    assert.equal(session.loop.running, false); assert.equal(session.paused, true); assert.equal(session.preferences.silicon.fleets[0].enabled, false);
    session.syncingProduction = false; session.paused = false; f.client.connected = true;
  });
  await test('快捷配置保存使旧手动确认失效，必须重新预览', async () => {
    const session = app.sessions.get('one'); f.returnFleet('1远征船'); observeOwnedFleets(session, f.state.fleets, { complete: true });
    const quote = ok(await api('silicon/preview', { kind: 'dispatch', gridId: 5000, index: 0 })); assert(quote.token);
    const current = ok(await api('silicon/settings'));
    ok(await api('silicon/settings', change(current, 'tier', 'BLUE', '1远征船')));
    const result = await api('silicon/action', { token: quote.token, fleetId: '1远征船', confirm: true });
    assert.equal(result.status, 400); assert.equal(f.client.writes.length, 0);
  });
  console.log('硅矿快捷配置 HTTP ' + passed + '/' + passed + ' 通过');
} finally {
  for (const session of app.sessions.values()) session.client = null;
  app.server.closeAllConnections(); await app.close();
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir())); assert(path.basename(directory).startsWith('cw-silicon-settings-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
