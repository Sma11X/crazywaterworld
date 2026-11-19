import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWechatQrSession } from './wechat/qr-session.mjs';
import { getWechatLoginCode } from './wechat/code-client.mjs';
import { createWechatDevice } from './wechat/device.mjs';
import { exchangeWechatGameCode, WECHAT_GAME_APPID } from './wechat/game-auth.mjs';

const activePhases = new Set(['starting', 'waiting', 'scanned', 'authorizing', 'captured']);
async function nativeLoginCode(buffer, { identityKey, ...options }) {
  const device = createWechatDevice(identityKey);
  try { return await getWechatLoginCode(buffer, { ...options, device }); }
  finally { device.appDeviceId.fill(0); device.sessDevice.fill(0); }
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

// One temporary scan per console. Only the final game credential can be saved;
// authorization cookies, login buffer, protocol keys and wx.login code stay in
// memory and are released as soon as the exchange ends or the user cancels.
export function createWechatLogin({ createQr = createWechatQrSession, getCode = nativeLoginCode,
  exchange = exchangeWechatGameCode, fetcher = fetch, now = Date.now, startTimeoutMs = 60000,
  authorizationTimeoutMs = 120000, capturedTimeoutMs = 600000, pollDelayMs = 250 } = {}) {
  let current = null, closed = false;
  const snapshot = s => ({ id: s?.id ?? null, phase: s?.phase ?? 'cancelled', qrImage: s?.qrImage ?? null,
    expiresAt: s?.expiresAt ?? null, error: s?.error ?? null });
  const live = s => current === s && !closed && activePhases.has(s.phase) && !s.controller.signal.aborted;
  function dispose(s) { s.qr?.close(); s.qr = null; s.qrImage = null; }
  function finish(s, phase, error = null) {
    clearTimeout(s.timer); s.timer = null; s.phase = phase; s.error = error;
    s.controller.abort(new Error('微信扫码会话已结束'));
    dispose(s);
    if (phase !== 'captured') s.credential = null;
  }
  function deadline(s, expiresAt) {
    clearTimeout(s.timer); s.expiresAt = expiresAt;
    s.timer = setTimeout(() => { if (current === s && activePhases.has(s.phase)) finish(s, 'expired', '本次登录已过期，请重新扫码'); }, Math.max(0, expiresAt - now()));
    s.timer.unref?.();
  }
  function selected(id) {
    if (id !== undefined && (typeof id !== 'string' || !current || current.id !== id)) throw Error('扫码会话已变化，请重新获取二维码');
    const s = current;
    if (s && activePhases.has(s.phase) && s.expiresAt <= now()) finish(s, 'expired', '本次登录已过期，请重新扫码');
    return s;
  }
  async function authorize(s) {
    try {
      while (live(s)) {
        const status = await abortable(s.qr.poll({ signal: s.controller.signal }), s.controller.signal);
        if (!live(s)) return;
        if (status.phase === 'expired') { finish(s, 'expired', '二维码已过期，请重新获取'); return; }
        if (status.phase === 'authorized') {
          s.phase = 'authorizing'; s.qrImage = null; deadline(s, now() + authorizationTimeoutMs);
          const buffer = await abortable(s.qr.getLoginBuffer({ signal: s.controller.signal }), s.controller.signal);
          if (!live(s)) return;
          const code = await abortable(getCode(buffer, { appId: WECHAT_GAME_APPID, identityKey: s.qr.identityKey, signal: s.controller.signal }), s.controller.signal);
          if (!live(s)) return;
          const credential = await abortable(exchange(code, { fetcher, signal: s.controller.signal }), s.controller.signal);
          if (!live(s)) return;
          if (credential?.source !== 'wechat' || !credential?.login?.eworldParams?.openId) throw Error('游戏凭据无效');
          s.credential = credential; s.phase = 'captured'; s.error = null;
          dispose(s);
          // Choosing a role has its own lifetime; a late successful scan must
          // not leave the user only a few seconds to save the account.
          deadline(s, now() + capturedTimeoutMs);
          return;
        }
        if (!['waiting', 'scanned'].includes(status.phase)) throw Error('微信授权状态无效');
        s.phase = status.phase;
        await delay(pollDelayMs, undefined, { signal: s.controller.signal });
      }
    } catch {
      if (live(s)) finish(s, 'error', s.phase === 'authorizing' ? '微信游戏授权失败，请重新扫码或稍后重试' : '微信扫码连接失败，请检查网络后重新获取二维码');
    }
  }
  async function initialize(s) {
    try {
      const pending = Promise.resolve().then(() => createQr({ fetcher, signal: s.controller.signal, now }));
      // An injected/slow transport may finish after cancellation. Dispose its
      // late session instead of retaining cookies or resurrecting the QR.
      pending.then(qr => { if (!live(s)) qr.close(); }, () => {});
      const qr = await abortable(pending, s.controller.signal);
      if (!live(s)) { qr.close(); return snapshot(s); }
      if (!/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(qr.qrImage ?? '')
        || !Number.isFinite(qr.expiresAt) || qr.expiresAt <= now()) { qr.close(); throw Error('二维码无效'); }
      s.qr = qr; s.qrImage = qr.qrImage; s.phase = 'waiting'; deadline(s, qr.expiresAt);
      s.job = authorize(s);
    } catch {
      if (live(s)) finish(s, 'error', '微信二维码获取失败，请检查网络后重试');
    }
    return snapshot(s);
  }
  return {
    start() {
      if (closed) return Promise.reject(Error('控制台已关闭'));
      const previous = selected();
      if (previous && activePhases.has(previous.phase)) return previous.startPromise.then(() => snapshot(selected(previous.id)));
      const s = { id: randomUUID(), phase: 'starting', qrImage: null, credential: null, error: null,
        expiresAt: now() + startTimeoutMs, controller: new AbortController(), timer: null, qr: null, job: null };
      current = s; deadline(s, s.expiresAt); s.startPromise = initialize(s); return s.startPromise;
    },
    status(id) { return snapshot(selected(id)); },
    takeCredential(id) {
      const s = selected(id);
      if (s?.phase !== 'captured' || !s.credential) throw Error('尚未取得有效游戏凭据，请完成微信扫码');
      return structuredClone(s.credential);
    },
    async cancel(id) { const s = selected(id); if (s) { finish(s, 'cancelled'); await s.job; } return snapshot(s); },
    async close() { closed = true; if (current) { finish(current, 'cancelled'); await current.job; } },
  };
}
