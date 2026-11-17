import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PAGE } from '../src/page.mjs';

const script = fs.readFileSync(new URL('../src/account-backup-ui.js', import.meta.url), 'utf8');
assert.ok(PAGE.includes(script), '实际页面载入账号备份脚本');
for (const id of ['import-accounts', 'import-accounts-file', 'account-export-dialog', 'account-export-only', 'account-export-settings']) {
  assert.ok(PAGE.includes('id="' + id + '"'), '实际页面包含 ' + id);
}
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
function fixture() {
  const nodes = new Map();
  const env = { nodes, calls: [], downloads: [], flushes: 0, reloads: [], dialogs: [], saveOK: true,
    confirm: '', refreshed: 0, configReads: 0, preview: { created: 1, updated: 1, settingsCount: 2, token: 'fixture-token' } };
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, disabled: false, open: false, value: '',
      classList: { toggle() {} }, focus() {}, click() { this.clicked = true; },
      showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  new Function('env', `
    const $ = env.node;
    const accounts = [{id:'first',title:'测试主号'},{id:'second',title:'测试小号'}];
    const configFlush = async () => {env.flushes++;return env.saveOK;};
    const call = async (path, options) => {
      const body=JSON.parse(options.body);env.calls.push({path,body});
      if(env.callError)throw new Error(env.callError);
      return path.endsWith('/preview')?env.preview:{...env.preview,ok:true};
    };
    const fetch = async (path, options) => {
      env.calls.push({path,body:JSON.parse(options.body)});
      if(env.gate)await env.gate;
      return {ok:!env.fetchError,json:async()=>({error:env.fetchError}),blob:async()=>({})};
    };
    const URL={createObjectURL:()=>'blob:fixture',revokeObjectURL:()=>{env.revoked=true;}};
    const document={body:{appendChild(){}},createElement:()=>({click(){env.downloads.push(this.download);},remove(){}})};
    const setTimeout=work=>work();
    const accountDialog=async (title,message)=>{env.dialogs.push({title,message});return env.confirm;};
    const loadAccounts=async reload=>{env.reloads.push(reload);if(env.reloadError)throw new Error(env.reloadError);};
    const renderAccounts=()=>env.refreshed++;
    const configLoad=async()=>env.configReads++;
    const loginSettingsAccountChanged=()=>{};
    const refreshSavedLineups=async()=>{};
    ${script}
    env.api={exportAccounts,downloadAccounts,importAccounts};
  `)(env);
  return env;
}
const file = text => ({ size: Buffer.byteLength(text), text: async () => text });
const backup = file('{"version":1,"accounts":[]}');

await test('单账号和全部账号打开导出方式选择，再按选择下载JSON', async () => {
  const env = fixture();
  env.api.exportAccounts('second');
  assert.equal(env.node('account-export-dialog').open, true);
  assert.match(env.node('account-export-scope').textContent, /测试小号/);
  await env.node('account-export-only').onclick();
  assert.deepEqual(env.calls[0].body, { id: 'second', includeSettings: false });
  assert.match(env.downloads[0], /^account-/);
  assert.equal(env.flushes, 0);
  env.node('export-accounts').onclick();
  assert.match(env.node('account-export-scope').textContent, /全部 2/);
  await env.node('account-export-settings').onclick();
  assert.deepEqual(env.calls[1].body, { all: true, includeSettings: true });
  assert.match(env.downloads[1], /^accounts-with-settings-/);
  assert.equal(env.flushes, 1);
  assert.equal(env.revoked, true);
});
await test('配置未保存或下载失败时保留弹窗和重试入口', async () => {
  const env = fixture(); env.saveOK = false;
  env.api.exportAccounts();
  await env.api.downloadAccounts(true);
  assert.equal(env.calls.length, 0);
  assert.equal(env.node('account-export-dialog').open, true);
  assert.match(env.node('account-export-error').textContent, /尚未保存/);
  env.saveOK = true; env.fetchError = '磁盘无法读取';
  await env.api.downloadAccounts(true);
  assert.match(env.node('account-export-error').textContent, /磁盘无法读取/);
  assert.equal(env.node('account-export-settings').disabled, false);
});
await test('下载在途阻止重复请求、关闭与Escape', async () => {
  const env = fixture(); let finish;
  env.gate = new Promise(resolve => { finish = resolve; });
  env.api.exportAccounts();
  const pending = env.api.downloadAccounts(false);
  await env.api.downloadAccounts(false);
  let prevented = false;
  env.node('account-export-dialog').oncancel({ preventDefault() { prevented = true; } });
  env.node('account-export-close').onclick();
  assert.equal(prevented, true); assert.equal(env.node('account-export-dialog').open, true);
  assert.equal(env.calls.length, 1);
  finish(); await pending;
  assert.equal(env.node('account-export-dialog').open, false);
});
await test('导入显示覆盖说明、携带确认版本并刷新账号与配置', async () => {
  const env = fixture();
  env.node('import-accounts').onclick(); assert.equal(env.node('import-accounts-file').clicked, true);
  await env.node('import-accounts-file').onchange({ target: { files: [backup] } });
  assert.equal(env.calls.length, 2);
  assert.match(env.dialogs[0].message, /新增 1 个账号、更新 1/);
  assert.match(env.dialogs[0].message, /2 份配置将替换/);
  assert.equal(env.calls[1].body.confirm, true); assert.equal(env.calls[1].body.token, 'fixture-token');
  assert.deepEqual(env.reloads, [false]);
  assert.equal(env.configReads, 1);
  assert.match(env.node('account-transfer-notice').textContent, /导入完成/);
  assert.equal(env.node('import-accounts-file').value, '');
});
await test('仅账号导入保持游戏配置，取消只做预览且可重选同一文件', async () => {
  const env = fixture(); env.preview.settingsCount = 0; env.confirm = null;
  await env.api.importAccounts(backup);
  assert.match(env.dialogs[0].message, /本机游戏配置保持不变/);
  assert.equal(env.calls.length, 1); assert.equal(env.configReads, 0);
  assert.match(env.node('account-transfer-notice').textContent, /已取消/);
  env.confirm = ''; await env.api.importAccounts(backup);
  assert.equal(env.calls.length, 3); assert.equal(env.configReads, 0);
});
await test('非法JSON、超限文件和未保存配置在发送前阻止导入', async () => {
  for (const kind of ['json', 'size', 'save']) {
    const env = fixture(); if (kind === 'save') env.saveOK = false;
    await env.api.importAccounts(kind === 'json' ? file('not-json') : kind === 'size' ? { size: 10 * 1024 * 1024 + 1 } : backup);
    assert.equal(env.calls.length, 0); assert.equal(env.node('import-accounts').disabled, false);
    assert.match(env.node('account-transfer-notice').textContent, /导入失败/);
  }
});
await test('支持带BOM的JSON，服务端失败保留错误且恢复入口', async () => {
  const env = fixture(); env.callError = '文件版本不支持';
  await env.api.importAccounts(file('\uFEFF{"version":2}'));
  assert.equal(env.calls[0].body.document.version, 2);
  assert.match(env.node('account-transfer-notice').textContent, /文件版本不支持/);
  assert.equal(env.node('import-accounts').disabled, false);
});
await test('保存成功后刷新失败明确告知已导入，避免误报写入失败', async () => {
  const env = fixture(); env.reloadError = '网络中断';
  await env.api.importAccounts(backup);
  assert.match(env.node('account-transfer-notice').textContent, /账号已导入，但页面刷新失败/);
});
console.log(`账号备份 UI 自检 ${passed}/${passed} 通过`);
