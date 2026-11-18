// Synthetic files only: recovery must never touch real account settings or usage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-recovery-'));
process.env.CW_DATA_DIR = directory;
const { SETTINGS_SCHEMA_VERSION, defaultSettings, loadAutomationSettings,
  loadRecoverableAutomationSettings, saveAutomationSettings } = await import('../src/automation-settings.mjs');
const moduleUrl = new URL('../src/automation-settings.mjs', import.meta.url).href;
let passed = 0, sequence = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const fixture = () => {
  const dir = path.join(directory, String(++sequence)); fs.mkdirSync(dir);
  return { dir, file: path.join(dir, 'automation-settings.json') };
};
const record = (revision = 4) => ({ revision, savedAt: '2026-11-18T00:00:00.000Z', settingsVersion: SETTINGS_SCHEMA_VERSION, settings: defaultSettings() });
const store = accounts => ({ version: SETTINGS_SCHEMA_VERSION, accounts });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const backups = dir => fs.readdirSync(dir).filter(name => name.includes('.corrupt-') && name.endsWith('.bak'));
const recover = file => loadRecoverableAutomationSettings('a', { file, expected: true });

try {
  await test('未配置新账号保持revision0，不创建文件或锁目录', () => {
    const { dir, file } = fixture();
    assert.equal(loadRecoverableAutomationSettings('a', { file }).revision, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
    const valid = store({ other: record() }); write(file, valid); const bytes = fs.readFileSync(file);
    assert.equal(loadRecoverableAutomationSettings('a', { file }).revision, 0);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('已配置账号缺文件时恢复关闭默认值，重启重复读取不再恢复', () => {
    const { dir, file } = fixture(), result = recover(file);
    assert.equal(result.revision, 1); assert.deepEqual(result.settings, defaultSettings());
    assert.equal(result.recovery.required, true); assert.equal(result.recovery.reason, 'missing');
    assert.match(result.recovery.message, /重新配置/); assert.equal(result.recovery.backupFile, undefined);
    const bytes = fs.readFileSync(file);
    assert.deepEqual(recover(file), result); assert.deepEqual(loadAutomationSettings('a', { file }), result);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('已配置账号条目缺失时备份文件并完整保留其他账号', () => {
    const { dir, file } = fixture(), other = record(7); other.settings.resources.diamondDailyLimit = 4321;
    write(file, store({ other })); const bytes = fs.readFileSync(file), result = recover(file);
    assert.equal(result.recovery.reason, 'missing'); assert.equal(backups(dir).length, 1);
    assert.deepEqual(fs.readFileSync(result.recovery.backupFile), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.other, other);
  });

  await test('非法JSON保留原始字节备份，严格读取仍报错，用量账本不变', () => {
    const { dir, file } = fixture(), original = Buffer.from('\ufeff{"accounts": {"a":  [broken\r\n');
    const usage = path.join(dir, 'automation-usage.json'), usageBytes = Buffer.from('{"reserved":120,"unknown":true}\n');
    fs.writeFileSync(file, original); fs.writeFileSync(usage, usageBytes);
    assert.throws(() => loadAutomationSettings('a', { file }));
    const result = recover(file); assert.equal(result.recovery.reason, 'corrupt');
    assert.equal(backups(dir).length, 1); assert.deepEqual(fs.readFileSync(result.recovery.backupFile), original);
    assert.deepEqual(result.settings, defaultSettings()); assert.deepEqual(fs.readFileSync(usage), usageBytes);
  });

  await test('单账号字段损坏只重置该账号并递增revision', () => {
    const { dir, file } = fixture(), bad = record(8), other = record(11);
    bad.settings.resources.allowDiamonds = 'invalid'; other.settings.resources.diamondDailyLimit = 4567;
    write(file, store({ a: bad, other })); const bytes = fs.readFileSync(file), result = recover(file);
    assert.equal(result.revision, 9); assert.equal(result.recovery.reason, 'corrupt');
    assert.deepEqual(result.settings, defaultSettings()); assert.equal(backups(dir).length, 1);
    assert.deepEqual(fs.readFileSync(result.recovery.backupFile), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.other, other);
  });

  await test('容器结构损坏可保留可读取的其他账号，损坏条目也标为待重配', () => {
    const { file } = fixture(), other = record(6);
    write(file, { accounts: { a: record(3), other, broken: null } });
    const result = recover(file), saved = JSON.parse(fs.readFileSync(file));
    assert.equal(result.revision, 4); assert.equal(result.recovery.reason, 'corrupt');
    assert.deepEqual(saved.accounts.other, other); assert.equal(saved.accounts.broken.recovery.required, true);
    assert.equal(loadAutomationSettings('broken', { file }).recovery.required, true);
    assert.equal(loadAutomationSettings('other', { file }).revision, 6);
  });

  await test('其他账号条目头损坏不重置正常当前账号', () => {
    const { dir, file } = fixture(), good = record(9); good.settings.resources.diamondDailyLimit = 8765;
    write(file, store({ a: good, broken: null }));
    const result = recover(file), saved = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(saved.accounts.a, good); assert.equal(result.recovery, undefined); assert.equal(result.revision, 9);
    assert.equal(saved.accounts.broken.recovery.required, true); assert.equal(backups(dir).length, 1);
    assert.deepEqual(recover(file), result); assert.equal(backups(dir).length, 1);
  });

  await test('恢复标记跨读取保留，合法保存才清除并继续递增revision', () => {
    const { file } = fixture(); write(file, store({ a: null }));
    const result = recover(file); assert.equal(result.recovery.reason, 'corrupt');
    const invalid = structuredClone(result.settings); invalid.resources.diamondDailyLimit = -1;
    assert.throws(() => saveAutomationSettings('a', invalid, { file, revision: result.revision }));
    assert.equal(recover(file).recovery.required, true);
    const settings = structuredClone(result.settings); settings.resources.diamondDailyLimit = 3000;
    assert.throws(() => saveAutomationSettings('a', settings, { file, revision: result.revision }), /恢复状态/);
    assert.throws(() => saveAutomationSettings('a', settings, { file, revision: result.revision, expectedRecoveryId: 'old-recovery' }), /恢复状态/);
    const saved = saveAutomationSettings('a', settings, { file, revision: result.revision, expectedRecoveryId: result.recovery.id });
    assert.equal(saved.revision, result.revision + 1); assert.equal(saved.recovery, undefined);
    assert.equal(recover(file).recovery, undefined); assert.equal(JSON.parse(fs.readFileSync(file)).accounts.a.recovery, undefined);
  });

  await test('有效旧版本正常迁移，读取不写文件、不触发恢复', () => {
    const { dir, file } = fixture(), old = record(); old.settingsVersion = 12;
    for (const row of old.settings.fleetSpeed.fleets) Object.assign(row, { repairMaxDiamonds: 0, marchMaxDiamonds: 1 });
    write(file, { version: 12, accounts: { a: old } }); const bytes = fs.readFileSync(file), result = recover(file);
    assert.equal(result.recovery, undefined); assert.equal(result.revision, 4);
    assert(result.settings.fleetSpeed.fleets.every(row => !Object.hasOwn(row, 'repairMaxDiamonds')));
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('未来容器或任一账号版本都停止，不能降级覆盖', () => {
    for (const variant of ['store', 'target', 'other']) {
      const { dir, file } = fixture(), value = store({ a: record(), other: record() });
      if (variant === 'store') value.version = SETTINGS_SCHEMA_VERSION + 1;
      else value.accounts[variant === 'target' ? 'a' : 'other'].settingsVersion = SETTINGS_SCHEMA_VERSION + 1;
      write(file, value); const bytes = fs.readFileSync(file);
      assert.throws(() => recover(file), error => error.code === 'SETTINGS_FUTURE_VERSION');
      assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
    }
  });

  await test('I/O读取和备份失败均不覆盖原文件', () => {
    const { dir, file } = fixture(); fs.writeFileSync(file, '{broken'); const bytes = fs.readFileSync(file);
    const originalRead = fs.readFileSync, originalOpen = fs.openSync;
    try {
      fs.readFileSync = function (target, ...args) {
        if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return originalRead.call(this, target, ...args);
      };
      assert.throws(() => recover(file), /未覆盖原文件/);
    } finally { fs.readFileSync = originalRead; }
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
    try {
      fs.openSync = function (target, ...args) {
        if (String(target).includes('.corrupt-')) throw Object.assign(new Error('backup denied'), { code: 'EACCES' });
        return originalOpen.call(this, target, ...args);
      };
      assert.throws(() => recover(file), /备份挂机配置失败/);
    } finally { fs.openSync = originalOpen; }
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('并发恢复在锁内复读，只写一次默认配置和备份', async () => {
    const { dir, file } = fixture(), bad = record(5); bad.settings.loop.rounds = -1;
    write(file, store({ a: bad })); const bytes = fs.readFileSync(file);
    const code = `import {loadRecoverableAutomationSettings} from ${JSON.stringify(moduleUrl)};const result=loadRecoverableAutomationSettings('a',{file:process.argv[1],expected:true});console.log(JSON.stringify({revision:result.revision,recovery:result.recovery}));`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { windowsHide: true, env: process.env });
      let out = '', err = ''; child.stdout.on('data', value => { out += value; }); child.stderr.on('data', value => { err += value; });
      child.on('error', reject); child.on('exit', status => status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    });
    const results = await Promise.all([run(), run(), run()]);
    assert(results.every(result => result.revision === 6));
    assert(results.every(result => result.recovery.backupFile === results[0].recovery.backupFile));
    assert.equal(backups(dir).length, 1); assert.deepEqual(fs.readFileSync(results[0].recovery.backupFile), bytes);
  });
  console.log('挂机配置恢复存储专项 ' + passed + '/' + passed + ' 通过');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
