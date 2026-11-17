// 这里只逐项保存同一份挂机配置；不启动挂机、不发送游戏操作。
let siliconSettingsEditor = { owner: null, data: null, loading: false, saving: false, error: null, checkedAt: 0 };
let siliconSettingsWasVisible = false;

function siliconSettingsMainBusy() {
  return configEditor.owner === current && (configEditor.loading || configEditor.busy || configEditor.saving || configIsDirty());
}
function siliconSettingsAccountChanged() {
  if (siliconSettingsEditor.owner !== current) {
    siliconSettingsEditor = { owner: current, data: null, loading: false, saving: false, error: null, checkedAt: 0 };
    paintSiliconSettings();
  }
}
function paintSiliconSettingsState() {
  const editor = siliconSettingsEditor, data = editor.data, mainBusy = siliconSettingsMainBusy();
  const disabled = !current || !data || editor.loading || editor.saving || !!editor.error || mainBusy || !!siliconAction;
  for (const control of $('silicon-settings').querySelectorAll('[data-silicon-setting],#silicon-auto-enabled')) {
    control.disabled = disabled; control.toggleAttribute('data-disabled', disabled);
    control.querySelector('[data-slot=switch-thumb]')?.toggleAttribute('data-disabled', disabled);
  }
  setTaskSwitch($('silicon-auto-enabled'), data?.settings.enabled === true);
  $('silicon-auto-state').textContent = !data ? '尚未读取' : !data.settings.enabled ? '已关闭' : data.running ? '已开启 · 随挂机执行' : '已开启 · 等待启动挂机';
  const status = $('silicon-settings-status');
  status.classList.toggle('warn', !!editor.error);
  status.textContent = !current ? '请选择账号' : editor.saving ? '正在保存…' : editor.loading ? '正在读取配置…'
    : editor.error?.fields?.revision ? '配置已在其他页面更新，请重新读取后再操作。'
    : editor.error ? editor.error.message + '；请重新读取配置后再操作。'
    : mainBusy ? '挂机配置正在编辑或保存，请先完成该处更改。'
    : data ? '修改后自动保存 · 与挂机配置同步' : '等待读取配置';
  $('silicon-settings-reload').disabled = !current || editor.loading || editor.saving || !!siliconAction;
  $('silicon-settings').setAttribute('aria-busy', String(editor.loading || editor.saving));
}
function siliconSettingsSwitch(fleet, key, label) {
  const row = el('div', 'silicon-settings-control'), text = el('label', '', label);
  const button = $('silicon-switch-template').content.firstElementChild.cloneNode(true);
  button.id = 'silicon-config-' + fleet.id + '-' + key; button.type = 'button';
  button.dataset.siliconSetting = fleet.id + '.' + key; text.htmlFor = button.id;
  button.setAttribute('aria-label', fleet.id.replace('远征船', '号舰队') + ' · ' + label);
  setTaskSwitch(button, fleet[key]);
  button.onclick = () => saveSiliconSetting(key, !fleet[key], fleet.id);
  row.append(text, button); return row;
}
function paintSiliconSettings() {
  const focus = document.activeElement?.dataset.siliconSetting, data = siliconSettingsEditor.data;
  const root = clear($('silicon-settings-fleets'));
  if (data) {
    for (const item of data.fleets) {
      const fleet = data.settings.fleets.find(row => row.id === item.value); if (!fleet) continue;
      const row = el('div', 'silicon-settings-fleet'); row.dataset.fleetId = fleet.id;
      row.append(el('h4', '', fleet.id.replace('远征船', '号舰队')), siliconSettingsSwitch(fleet, 'enabled', '自动参与'));
      const field = el('div', 'silicon-settings-control'), label = el('label', '', '目标矿级'), select = el('select');
      select.id = 'silicon-config-' + fleet.id + '-tier'; label.htmlFor = select.id;
      select.dataset.siliconSetting = fleet.id + '.tier'; select.setAttribute('aria-label', fleet.id.replace('远征船', '号舰队') + ' · 目标矿级');
      for (const [value, text] of [['BLUE', '初等'], ['PURPLE', '中等'], ['ORANGE', '高等']]) { const option = el('option', '', text); option.value = value; select.append(option); }
      select.value = fleet.tier; select.onchange = () => saveSiliconSetting('tier', select.value, fleet.id);
      field.append(label, select); row.append(field, siliconSettingsSwitch(fleet, 'emptyOnly', '只占空位'));
      const note = fleet.tier === 'BLUE' ? '初等矿始终不攻击占领者。' : fleet.emptyOnly ? '只采集空位，不抢占或追击。' : '允许按高级配置抢占，仍受战力、名单和预算限制。';
      row.append(el('p', 'dim', note));
      if (fleet.huntEnabled) row.append(el('p', 'dim', '已配置追杀策略，撤退规则见高级配置。'));
      root.append(row);
    }
    if (!data.fleets.length) root.append(el('p', 'dim', data.fleetAvailability.known ? '当前没有已建成的远征舰队。' : '舰队名单尚未同步，连接并刷新硅矿后可逐队配置。'));
    else if (data.fleetAvailability.stale) root.append(el('p', 'dim silicon-settings-offline', '离线配置：舰队名单为上次同步结果。'));
  }
  paintSiliconSettingsState();
  if (focus) [...root.querySelectorAll('[data-silicon-setting]')].find(node => node.dataset.siliconSetting === focus)?.focus({ preventScroll: true });
}
async function refreshSiliconSettings() {
  const editor = siliconSettingsEditor;
  if (!current || editor.owner !== current || editor.loading || editor.saving || siliconAction) return;
  editor.loading = true; editor.error = null; paintSiliconSettingsState();
  try {
    const data = await call('/api/silicon/settings?account=' + encodeURIComponent(editor.owner));
    if (editor !== siliconSettingsEditor || editor.owner !== current) return;
    const changed = JSON.stringify(data) !== JSON.stringify(editor.data); editor.data = data;
    if (changed) paintSiliconSettings();
  } catch (error) { if (editor === siliconSettingsEditor) editor.error = error; }
  finally { editor.loading = false; editor.checkedAt = Date.now(); if (editor === siliconSettingsEditor) paintSiliconSettingsState(); }
}
function syncSiliconSettingsToMain(account, before, data) {
  if (configEditor.owner !== account || configEditor.loading || configEditor.busy || configEditor.saving || configIsDirty()
    || configEditor.data?.revision !== before.revision || configEditor.data?.baseRevision !== before.baseRevision) return;
  configEditor.data = { ...configEditor.data, settings: { ...configEditor.data.settings, silicon: structuredClone(data.settings) },
    revision: data.revision, baseRevision: data.baseRevision, savedAt: data.savedAt };
  configEditor.baseline = { ...configEditor.baseline, silicon: structuredClone(data.settings) };
  configEditor.draft = { ...configEditor.draft, silicon: structuredClone(data.settings) };
  configEditor.previewSummary = null; configRender(); configUpdateState();
}
async function saveSiliconSetting(key, value, fleetId) {
  const editor = siliconSettingsEditor;
  if (!current || editor.owner !== current || !editor.data || editor.loading || editor.saving || editor.error || siliconAction || siliconSettingsMainBusy()) { paintSiliconSettings(); return; }
  const before = editor.data;
  editor.saving = true; paintSiliconSettingsState(); updateSiliconControls();
  try {
    const data = await call('/api/silicon/settings?account=' + encodeURIComponent(editor.owner), { method: 'POST', body: JSON.stringify({
      key, value, ...(fleetId ? { fleetId } : {}), revision: before.revision, baseRevision: before.baseRevision, confirm: true,
    }) });
    if (editor !== siliconSettingsEditor || editor.owner !== current) return;
    editor.data = data; loopSettingsRevision = data.revision;
    syncSiliconSettingsToMain(editor.owner, before, data);
  } catch (error) { if (editor === siliconSettingsEditor) editor.error = error; }
  finally {
    editor.saving = false; editor.checkedAt = Date.now();
    if (editor === siliconSettingsEditor) { paintSiliconSettings(); updateSiliconControls(); }
  }
}
function maybeRefreshSiliconSettings() {
  const visible = siliconVisible(), editor = siliconSettingsEditor;
  if (visible && current && !editor.error && (!siliconSettingsWasVisible || Date.now() - editor.checkedAt >= 30000)) void refreshSiliconSettings();
  siliconSettingsWasVisible = visible;
  paintSiliconSettingsState();
}
function siliconSettingsMainSaved(account) {
  if (siliconSettingsEditor.owner === account) siliconSettingsEditor.checkedAt = 0;
}
$('silicon-auto-enabled').onclick = () => saveSiliconSetting('enabled', !siliconSettingsEditor.data?.settings.enabled);
$('silicon-settings-reload').onclick = refreshSiliconSettings;
