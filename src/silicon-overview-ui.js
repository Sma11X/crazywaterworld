let siliconOwner = null, siliconData = null, siliconLoading = false, siliconSerial = 0;
let siliconReceivedAt = 0, siliconLastAttempt = 0, siliconTimers = [], siliconSelections = new Map();
let siliconAction = null;
const siliconNumber = value => Number.isSafeInteger(value) && value >= 0 ? fmt(value) : '未同步';
const siliconConnected = () => !!current && snapshot.connected && !snapshot.paused && !disconnected.has(current);
const siliconVisible = () => !document.hidden && !$('tab-overview').classList.contains('hidden');
const siliconStale = () => siliconReceivedAt && Date.now() - siliconReceivedAt > 90000;
bindConsoleSlice('silicon', { siliconOwner, siliconData, siliconLoading, siliconReceivedAt, siliconLastAttempt }, state => {
  siliconOwner = state.siliconOwner;
  siliconData = state.siliconData;
  siliconLoading = state.siliconLoading;
  siliconReceivedAt = state.siliconReceivedAt;
  siliconLastAttempt = state.siliconLastAttempt;
});

function siliconDuration(seconds) {
  const value = Math.max(0, Math.ceil(seconds)), days = Math.floor(value / 86400), hours = Math.floor(value % 86400 / 3600);
  if (days) return days + '天 ' + hours + '小时';
  if (hours) return hours + '小时 ' + Math.floor(value % 3600 / 60) + '分';
  return Math.floor(value / 60) + '分 ' + value % 60 + '秒';
}
function siliconTimerText(endAt, label, finished) {
  if (!endAt) return label + '：时间未同步';
  if (siliconStale()) return label + '：待同步';
  const remaining = endAt - siliconData.checkedAt - Math.max(0, (Date.now() - siliconReceivedAt) / 1000);
  return remaining > 0 ? label + ' ' + siliconDuration(remaining) : finished;
}
function siliconTimer(endAt, label, finished) {
  const node = el('span', 'silicon-countdown', siliconTimerText(endAt, label, finished));
  siliconTimers.push({ node, endAt, label, finished });
  if (endAt) node.title = new Date(endAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '（北京时间）';
  return node;
}
function resetSiliconOverview() {
  siliconAction = null; $('silicon-action-dialog').close(); $('silicon-feedback').hidden = true;
  siliconSerial++; setConsoleValue('silicon', 'siliconOwner', null); setConsoleValue('silicon', 'siliconData', null); setConsoleValue('silicon', 'siliconLoading', false);
  setConsoleValue('silicon', 'siliconReceivedAt', 0); setConsoleValue('silicon', 'siliconLastAttempt', 0); siliconTimers = []; siliconSelections.clear();
  for (const id of ['silicon-summary', 'silicon-fleets', 'silicon-mines', 'silicon-notes']) clear($(id));
  $('silicon-overview').setAttribute('aria-busy', 'false');
}
function siliconAccountChanged() {
  if (typeof siliconSettingsAccountChanged === 'function') siliconSettingsAccountChanged();
  if (siliconOwner !== null && (siliconOwner !== current || !siliconConnected())) resetSiliconOverview();
  updateSiliconControls();
  if (!siliconConnected()) $('silicon-status').textContent = !current ? '请选择账号查看硅矿' : snapshot.paused ? '账号已暂停，连接后可读取硅矿' : '连接账号后读取硅矿';
  else if (!siliconData && !siliconLoading) $('silicon-status').textContent = '等待读取硅矿';
}
function siliconFacts(root, entries) {
  const list = el('dl', 'silicon-facts');
  for (const [label, value] of entries) list.append(el('dt', '', label), el('dd', '', value));
  root.append(list);
}
function siliconFeedback(text, warning = false) {
  const node = $('silicon-feedback'); node.hidden = false; node.textContent = text; node.classList.toggle('warn', warning);
}
function updateSiliconControls() {
  const busy = siliconAction !== null || siliconLoading || (typeof siliconSettingsEditor !== 'undefined' && siliconSettingsEditor.saving);
  $('silicon-refresh').disabled = busy || !siliconConnected();
  for (const button of document.querySelectorAll('[data-silicon-action]')) {
    button.disabled = busy || !siliconConnected() || !!siliconStale() || !!button.dataset.unavailable;
    button.title = button.dataset.unavailable || (siliconStale() ? '信息已过期，请先刷新硅矿' : '');
  }
  if (typeof paintSiliconSettingsState === 'function') paintSiliconSettingsState();
}
function siliconActionButton(label, intent, unavailable = '') {
  const button = smallButton(label); button.type = 'button'; button.dataset.siliconAction = intent.kind;
  button.dataset.unavailable = unavailable; button.onclick = () => openSiliconAction(intent);
  return button;
}
function siliconRetreatButton(fleetId) {
  const fleet = siliconData.fleets.find(row => row.id === fleetId);
  return siliconActionButton('撤回舰队', { kind: 'retreat', fleetId, gridId: fleet?.mineId },
    fleet?.retreatAllowed === true ? '' : fleet?.retreatAllowed === false ? '首奖后才能撤回' : '采矿状态未同步，请先刷新');
}
function closeSiliconAction() {
  if (siliconAction?.phase !== 'sending') siliconAction = null;
  $('silicon-action-dialog').close(); updateSiliconControls();
}
async function openSiliconAction(intent) {
  if (!siliconConnected() || siliconAction || siliconLoading || siliconStale() || (typeof siliconSettingsEditor !== 'undefined' && siliconSettingsEditor.saving)) return;
  const action = { account: current, intent, phase: 'preview', quote: null, fleetId: null };
  siliconAction = action; updateSiliconControls();
  $('silicon-action-title').textContent = intent.kind === 'dispatch' ? '派遣舰队采矿' : '撤回采矿舰队';
  clear($('silicon-action-body')).append(el('p', 'dim', '正在核对矿位、舰队和费用…'));
  $('silicon-action-confirm').disabled = true; $('silicon-action-dialog').showModal(); $('silicon-action-cancel').focus();
  try {
    const quote = await call('/api/silicon/preview?account=' + encodeURIComponent(action.account), { method: 'POST', body: JSON.stringify(intent) });
    if (siliconAction !== action || current !== action.account || !siliconConnected()) return;
    action.phase = 'ready'; action.quote = quote;
    const root = clear($('silicon-action-body'));
    root.append(el('p', '', quote.mineName + (quote.index !== null ? ' · ' + (quote.index + 1) + '号矿位' : '')));
    root.append(el('p', 'silicon-action-cost', intent.kind === 'dispatch' ? '本次消耗 ' + siliconNumber(quote.cost) + ' 汽油 · 库存 ' + siliconNumber(quote.fuel) : '撤回不消耗汽油或钻石'));
    if (quote.reason) root.append(el('p', 'warn', quote.reason));
    const choices = el('fieldset', 'silicon-action-fleets'); choices.append(el('legend', '', intent.kind === 'dispatch' ? '选择舰队' : '本次撤回'));
    for (const fleet of quote.fleets) {
      const label = el('label', 'silicon-action-fleet'), input = el('input'); input.type = 'radio'; input.name = 'silicon-shortcut-fleet'; input.value = fleet.id;
      input.disabled = !fleet.available; label.classList.toggle('is-unavailable', !fleet.available);
      const body = el('span'); body.append(el('strong', '', fleet.name), el('span', 'dim', '战力 ' + siliconNumber(fleet.power) + ' · 耐久 ' + siliconNumber(fleet.durability) + '/' + siliconNumber(fleet.maxDura)));
      if (fleet.reason) body.append(el('small', 'warn', fleet.reason));
      input.onchange = () => { action.fleetId = fleet.id; $('silicon-action-confirm').disabled = !quote.token || Date.now() >= quote.expiresAt; };
      if (fleet.available && !action.fleetId) { input.checked = true; action.fleetId = fleet.id; }
      label.append(input, body); choices.append(label);
    }
    root.append(choices);
    if (quote.automatic) root.append(el('p', 'warn', '硅矿自动化仍开启，后续会继续按配置调度，撤回后可能再次派遣。'));
    root.append(el('p', 'dim', intent.kind === 'dispatch' ? '仅派遣这支舰队采集所选空位，继续遵守汽油保留量、日预算和舰队占用限制。' : '只撤回本次选择的舰队，自动化配置保持当前设置。'));
    const expiry = el('p', 'warn'); expiry.id = 'silicon-action-expiry'; expiry.hidden = true; root.append(expiry);
    $('silicon-action-confirm').textContent = intent.kind === 'dispatch' ? '确认派遣' : '确认撤回';
    $('silicon-action-confirm').disabled = !quote.token || !action.fleetId;
  } catch (error) {
    if (siliconAction !== action || current !== action.account) return;
    action.phase = 'error'; clear($('silicon-action-body')).append(el('p', 'warn', '无法准备操作：' + error.message));
  }
}
async function submitSiliconAction() {
  const action = siliconAction;
  if (!action || action.phase !== 'ready' || !action.quote?.token || !action.fleetId || !siliconConnected() || action.account !== current) return;
  if (Date.now() >= action.quote.expiresAt) { $('silicon-action-confirm').disabled = true; return; }
  action.phase = 'sending'; $('silicon-action-confirm').disabled = true; $('silicon-action-dialog').close(); updateSiliconControls();
  siliconFeedback('正在' + (action.intent.kind === 'dispatch' ? '派遣舰队采矿' : '撤回舰队') + '，等待服务器确认…');
  try {
    const result = await call('/api/silicon/action?account=' + encodeURIComponent(action.account), { method: 'POST', body: JSON.stringify({ confirm: true, token: action.quote.token, fleetId: action.fleetId }) });
    if (siliconAction !== action || current !== action.account || !siliconConnected()) return;
    siliconFeedback(result.ok ? (action.intent.kind === 'dispatch' ? '派遣已确认。' : '撤回已确认。')
      : (result.status === 'unknown' ? '操作结果待确认，已保留任务记录，不会自动重发。' : '操作未完成：' + (result.reason || result.error || '请刷新后重试')), !result.ok);
  } catch (error) {
    if (siliconAction === action && current === action.account) siliconFeedback('未取得操作结果：' + error.message + '。请刷新硅矿核对状态，不会自动重发。', true);
  } finally {
    if (siliconAction === action) { siliconAction = null; updateSiliconControls(); if (current === action.account && siliconConnected()) await refreshSiliconOverview(); }
  }
}
function paintSiliconMine(mine) {
  const card = el('article', 'silicon-mine'); card.dataset.tier = mine.tier;
  const heading = el('div', 'silicon-mine-heading'), title = el('h3', '', mine.name), crystal = el('span', 'silicon-crystal');
  crystal.setAttribute('aria-hidden', 'true'); title.prepend(crystal);
  heading.append(title, el('span', 'dim', mine.personal ? '个人矿位' : '公共矿位')); card.append(heading);
  if (mine.reason) card.append(el('p', 'warn', '矿位未同步：' + mine.reason));
  else {
    card.append(el('p', 'silicon-mine-count', (mine.personal ? '我的采集 ' : '已占 ') + mine.occupied + ' / ' + mine.positionCount + ' · 空位 ' + mine.empty));
    const grid = el('div', 'silicon-slots'), detail = el('div', 'silicon-position-detail');
    grid.setAttribute('aria-label', mine.name + '矿位');
    const show = index => {
      siliconSelections.set(mine.gridId, index);
      for (const button of grid.children) button.setAttribute('aria-pressed', String(Number(button.dataset.slot) === index));
      clear(detail);
      const position = mine.positions.find(row => row.displayIndex === index), player = position?.player;
      detail.append(el('strong', '', (index + 1) + '号矿位 · ' + (player ? ({ self: '我的舰队', ally: '同盟', other: '其他玩家' })[player.relation] : '空闲')));
      if (player) {
        siliconFacts(detail, [['玩家', player.nickname], ['战力', siliconNumber(player.power)], ['联盟编号', String(player.guildIdx)], ['本次占矿已采', player.rewardTimes + ' 次']]);
        if (player.fleetId) detail.append(el('p', 'dim', player.fleetId.replace('远征船', '号舰队') + ' · ' + (player.rewardTimes > 0 ? '已满足首奖撤回条件' : '首奖后可撤回')), siliconRetreatButton(player.fleetId));
      } else {
        detail.append(el('p', 'dim', mine.personal ? '可供自己的舰队采集，不参与抢占。' : '当前无人占领，可选择舰队采集。'));
        detail.append(siliconActionButton('派遣采集', { kind: 'dispatch', gridId: mine.gridId, index }, !siliconData.reward ? '奖励额度未同步' : siliconData.reward.remaining <= 0 ? '本周期奖励额度已用完' : ''));
      }
      updateSiliconControls();
    };
    // 异常的大容量也不生成数千个按钮；真实矿位总数仍完整显示。
    const shown = Math.min(mine.positionCount, 96);
    for (let index = 0; index < shown; index++) {
      const player = mine.positions.find(row => row.displayIndex === index)?.player;
      const relation = player?.relation || 'empty', label = ({ self: '我的', ally: '同盟', other: '占领', empty: '空闲' })[relation];
      const button = el('button', 'silicon-slot'); button.type = 'button'; button.dataset.relation = relation; button.dataset.slot = String(index);
      button.dataset.siliconFocus = mine.gridId + ':' + index;
      button.setAttribute('aria-label', mine.name + ' ' + (index + 1) + '号矿位：' + (player ? player.nickname + '，' + label + '，战力 ' + siliconNumber(player.power) : label));
      button.setAttribute('aria-pressed', 'false'); button.append(el('span', '', String(index + 1)), el('small', '', label));
      button.onclick = () => show(index); grid.append(button);
    }
    card.append(grid);
    if (shown < mine.positionCount) card.append(el('p', 'dim', '展示前 ' + shown + ' 个矿位'));
    detail.setAttribute('aria-live', 'polite'); card.append(detail);
    const selected = siliconSelections.get(mine.gridId) ?? mine.positions.find(row => row.player.relation === 'self')?.displayIndex;
    if (selected !== undefined && selected < shown) show(selected);
    else detail.append(el('p', 'dim', '点击矿位查看玩家与战力'));
  }
  if (mine.rewards.length) {
    const rewards = el('div', 'silicon-rewards'); rewards.append(el('span', 'dim', '每轮可能产出'));
    const list = el('ul');
    for (const reward of mine.rewards) list.append(el('li', '', reward.name + ' ×' + reward.num));
    rewards.append(list); card.append(rewards);
  }
  return card;
}
function paintSiliconOverview(data) {
  siliconTimers = [];
  const focus = document.activeElement?.dataset.siliconFocus;
  const summary = clear($('silicon-summary')), fleets = clear($('silicon-fleets')), mines = clear($('silicon-mines'));
  if (data.reward || data.fights || data.fleets.length || data.mines.length) {
    for (const [label, value, note] of [
      ['本周期已领', data.reward ? data.reward.claimed + ' / ' + data.reward.max + ' 次' : '未同步', '三天共享额度，非今日收益'],
      ['剩余奖励', data.reward ? data.reward.remaining + ' 次' : '未同步', '全部舰队共享'],
      ['今日抢占', data.fights ? data.fights.used + ' / ' + data.fights.max + ' 次' : '未同步', '玩家共享次数'],
    ]) {
      const item = el('div', 'silicon-stat'); item.append(el('span', 'dim', label), el('strong', '', value), el('small', 'dim', note)); summary.append(item);
    }
    const reset = el('div', 'silicon-stat'); reset.append(el('span', 'dim', '奖励重置'), siliconTimer(data.reward?.resetAt, '剩余', '已到重置时间，等待同步'));
    reset.append(el('small', 'dim', data.reward ? new Date(data.reward.resetAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + '（北京时间）' : '时间未同步')); summary.append(reset);
  }
  if (!data.fleetsSynced && data.mines.length) fleets.append(el('p', 'dim', '舰队状态未同步'));
  for (const fleet of data.fleets) {
    const card = el('article', 'silicon-fleet'), heading = el('div', 'silicon-fleet-heading');
    heading.append(el('h3', '', fleet.name), el('span', fleet.mining ? 'silicon-mining-status' : 'dim', fleet.status)); card.append(heading);
    card.append(el('p', 'silicon-fleet-location', fleet.mineName ? fleet.mineName + (fleet.slot ? ' · ' + fleet.slot + '号位' : '') : fleet.mining ? '采矿位置待同步' : '当前未占领硅矿'));
    if (fleet.timerKind) card.append(siliconTimer(fleet.endAt, ({ reward: '下次产奖', arrival: '预计抵达', repair: '维修剩余' })[fleet.timerKind], ({ reward: '产奖时间已到，等待服务器结算', arrival: '抵达时间已到，等待同步', repair: '维修时间已到，等待同步' })[fleet.timerKind]));
    siliconFacts(card, [['战力', siliconNumber(fleet.power)], ['耐久', siliconNumber(fleet.durability) + ' / ' + siliconNumber(fleet.maxDura)]]);
    if (fleet.collected !== null) card.append(el('p', 'dim', '本次占矿已采 ' + fleet.collected + ' 次 · ' + (fleet.retreatAllowed === null ? '撤回状态待同步' : fleet.retreatAllowed ? '已满足首奖撤回条件' : '首奖后可撤回')));
    if (fleet.mining) card.append(siliconRetreatButton(fleet.id));
    fleets.append(card);
  }
  for (const mine of data.mines) mines.append(paintSiliconMine(mine));
  if (data.reason) mines.prepend(el('p', 'silicon-empty dim', data.reason));
  $('silicon-notes').textContent = [...data.notes, ...(data.mines.length ? ['每队每 15 分钟产奖；产出列表为可能奖励，实际所得以服务器为准。'] : [])].join(' ');
  if (focus) [...$('silicon-mines').querySelectorAll('[data-silicon-focus]')].find(node => node.dataset.siliconFocus === focus)?.focus({ preventScroll: true });
}
async function refreshSiliconOverview() {
  if (!siliconConnected() || siliconLoading || siliconAction) return;
  const account = current, serial = ++siliconSerial; setConsoleValue('silicon', 'siliconOwner', account); setConsoleValue('silicon', 'siliconLoading', true); setConsoleValue('silicon', 'siliconLastAttempt', Date.now());
  $('silicon-refresh').disabled = true; $('silicon-status').textContent = '正在同步硅矿…'; $('silicon-overview').setAttribute('aria-busy', 'true');
  try {
    const data = await call('/api/silicon/overview');
    if (account !== current || serial !== siliconSerial || !siliconConnected()) return;
    setConsoleValue('silicon', 'siliconData', data); setConsoleValue('silicon', 'siliconReceivedAt', Date.now()); paintSiliconOverview(data);
    if (typeof refreshSiliconSettings === 'function') void refreshSiliconSettings();
    $('silicon-status').textContent = (data.notes.length || data.mines.some(mine => mine.reason) ? '部分信息未同步 · ' : '更新 ') + new Date(data.checkedAt * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    if (data.reason && !data.mines.length) $('silicon-status').textContent = data.reason;
  } catch (error) {
    if (account === current && serial === siliconSerial) {
      $('silicon-status').textContent = '同步失败：' + error.message + (siliconData ? '；下方为上次同步结果' : '');
      if (siliconData) setConsoleValue('silicon', 'siliconReceivedAt', Date.now() - 90001);
    }
  } finally {
    if (serial === siliconSerial) { setConsoleValue('silicon', 'siliconLoading', false); setConsoleValue('silicon', 'siliconLastAttempt', Date.now()); updateSiliconControls(); $('silicon-overview').setAttribute('aria-busy', 'false'); }
  }
}
function maybeRefreshSilicon() {
  siliconAccountChanged();
  if (typeof maybeRefreshSiliconSettings === 'function') maybeRefreshSiliconSettings();
  if (siliconVisible() && siliconConnected() && !siliconLoading && !siliconAction && Date.now() - siliconLastAttempt >= 30000) void refreshSiliconOverview();
}
setInterval(() => {
  maybeRefreshSilicon();
  if (siliconAction?.phase === 'ready' && Date.now() >= siliconAction.quote.expiresAt) {
    $('silicon-action-confirm').disabled = true;
    const expiry = $('silicon-action-expiry'); expiry.hidden = false; expiry.textContent = '本次确认已过期，请取消后重新选择。';
  }
  if (!siliconVisible() || !siliconData) return;
  siliconTimers = siliconTimers.filter(timer => timer.node.isConnected);
  for (const timer of siliconTimers) timer.node.textContent = siliconTimerText(timer.endAt, timer.label, timer.finished);
}, 1000);
$('silicon-refresh').onclick = refreshSiliconOverview;
$('silicon-action-cancel').onclick = closeSiliconAction;
$('silicon-action-dialog').oncancel = event => { event.preventDefault(); closeSiliconAction(); };
$('silicon-action-confirm').onclick = submitSiliconAction;
