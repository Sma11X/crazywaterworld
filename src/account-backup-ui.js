let accountTransferBusy = false;
let accountExportId = null;

function accountTransferNotice(message, failed = false) {
  const notice = $('account-transfer-notice');
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle('warn', failed);
}

function exportAccounts(id) {
  if (accountTransferBusy) return;
  accountExportId = id || null;
  $('account-export-scope').textContent = id
    ? '导出「' + (accounts.find(account => account.id === id)?.title || '所选账号') + '」'
    : '导出全部 ' + accounts.length + ' 个账号';
  $('account-export-error').hidden = true;
  $('account-export-dialog').showModal();
  $('account-export-only').focus();
}

async function downloadAccounts(includeSettings) {
  if (accountTransferBusy) return;
  const id = accountExportId;
  accountTransferBusy = true;
  for (const name of ['account-export-only', 'account-export-settings', 'account-export-close']) $(name).disabled = true;
  $('account-export-error').hidden = true;
  try {
    if (includeSettings && !await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示后再导出');
    const response = await fetch('/api/accounts/export', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(id ? { id } : { all: true }), includeSettings }) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '账号导出失败');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = (id ? 'account-' : 'accounts-') + (includeSettings ? 'with-settings-' : '')
      + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    $('account-export-dialog').close();
    accountTransferNotice('已导出' + (id ? '所选账号' : '全部账号') + (includeSettings ? '及配置' : '（仅账号）') + '。');
  } catch (error) {
    $('account-export-error').textContent = error.message;
    $('account-export-error').hidden = false;
  } finally {
    accountTransferBusy = false;
    for (const name of ['account-export-only', 'account-export-settings', 'account-export-close']) $(name).disabled = false;
  }
}

async function importAccounts(file) {
  if (!file || accountTransferBusy) return;
  accountTransferBusy = true;
  $('import-accounts').disabled = true;
  let imported = false;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('账号文件不能超过 10 MB');
    let backup;
    try { backup = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch { throw new Error('文件不是有效 JSON，请选择本工具导出的账号文件'); }
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示后再导入');
    accountTransferNotice('正在检查账号文件…');
    const preview = await call('/api/accounts/import/preview', { method: 'POST', body: JSON.stringify({ document: backup }) });
    const message = '将新增 ' + preview.created + ' 个账号、更新 ' + preview.updated + ' 个已有账号的凭据。'
      + (preview.settingsCount ? '文件中的 ' + preview.settingsCount + ' 份配置将替换对应账号的本机配置。' : '本机游戏配置保持不变。')
      + '新账号不会自动开始挂机，已有账号保持当前运行状态。';
    if (await accountDialog('确认导入账号', message) === null) { accountTransferNotice('已取消导入。'); return; }
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示后再导入');
    accountTransferNotice('正在导入账号…');
    const result = await call('/api/accounts/import', { method: 'POST', body: JSON.stringify({ document: backup, token: preview.token, confirm: true }) });
    imported = true;
    await loadAccounts(false);
    renderAccounts();
    if (result.settingsCount) {
      await configLoad();
      loginSettingsAccountChanged();
      await refreshSavedLineups();
    }
    accountTransferNotice('导入完成：新增 ' + result.created + ' 个账号，更新 ' + result.updated + ' 个账号，恢复 ' + result.settingsCount + ' 份配置。');
  } catch (error) {
    accountTransferNotice((imported ? '账号已导入，但页面刷新失败，请刷新页面：' : '导入失败：') + error.message, true);
  } finally {
    accountTransferBusy = false;
    $('import-accounts').disabled = false;
    $('import-accounts-file').value = '';
  }
}

$('export-accounts').onclick = () => exportAccounts();
$('account-export-only').onclick = () => downloadAccounts(false);
$('account-export-settings').onclick = () => downloadAccounts(true);
$('account-export-close').onclick = () => { if (!accountTransferBusy) $('account-export-dialog').close(); };
$('account-export-dialog').oncancel = event => { if (accountTransferBusy) event.preventDefault(); };
$('import-accounts').onclick = () => { if (!accountTransferBusy) $('import-accounts-file').click(); };
$('import-accounts-file').onchange = event => importAccounts(event.target.files?.[0]);
