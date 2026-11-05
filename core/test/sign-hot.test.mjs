/**
 * sign 配置热更新（密钥轮换 / 多密钥宽限校验）全链路测试
 *
 * 覆盖：
 *  - SignConfigStore：快照不可变性、update/rotate 语义、宽限期推导、resolveKey、订阅通知
 *  - 服务端 verifySign({ keys }) / signResponse({ keys })：新密钥立即生效、旧密钥宽限内可验签、
 *    宽限到期失效、未知 kid 拒绝、多密钥并存、enabled:false 关闭
 *  - 客户端 ClientSignStore + 动态传输：x-req-kid / x-res-kid 轮换、未知 kid 抛错
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignConfigStore,
  SignConfigStore,
  verifySign,
  signResponse,
  signPayload,
  verifyPayload,
} from '@flovven/web-core';
import { WebApp } from '@flovven/web-core';
import { HonoAdapter } from '@flovven/web-adapter-hono';
import {
  createClientSignStore,
  createDynamicSignTransport,
  createDynamicResponseVerifyTransport,
} from '../../client/dist/sign.js';

const APP = 'hot-app';

async function startServer(store, extra = {}) {
  const app = new WebApp(new HonoAdapter());
  app.use(verifySign({ keys: store, ...extra }));
  app.use(signResponse({ keys: store }));
  app.post('/api/user', async (ctx) => {
    const body = await ctx.request.body();
    await ctx.json({ ok: true, received: body });
  });
  app.get('/api/slow', async (ctx) => {
    // 处理中触发密钥轮换，验证进行中的请求不受影响
    if (typeof extra.rotateDuringRequest === 'function') extra.rotateDuringRequest();
    await new Promise((r) => setTimeout(r, 30));
    await ctx.json({ ok: true, slow: true });
  });
  const { serve } = await import('@hono/node-server');
  const native = app.build();
  const server = serve({ fetch: native.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((res, rej) => {
    server.once('listening', res);
    server.once('error', rej);
  });
  const port = server.address().port;
  return { port, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

/** 用给定 client store 构造调用器（签名 + 响应验签都走热更新传输） */
function buildClient(port, clientStore, opts = {}) {
  const signT = createDynamicSignTransport({ keys: clientStore });
  const verifyT = createDynamicResponseVerifyTransport({
    keys: clientStore,
    throwOnInvalid: opts.throwOnInvalid ?? true,
  });
  return async (path, { method = 'POST', body, rawSend } = {}) => {
    const req = {
      url: `http://127.0.0.1:${port}${path}`,
      method,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: body ? new TextEncoder().encode(JSON.stringify(body)) : null,
    };
    let out;
    await signT(req, async (r2) => {
      const res = rawSend
        ? await rawSend(r2)
        : await (async () => {
            const r = await fetch(r2.url, {
              method: r2.method,
              headers: r2.headers,
              body: r2.body ?? undefined,
            });
            return { status: r.status, headers: r.headers, body: new Uint8Array(await r.arrayBuffer()) };
          })();
      out = await verifyT(r2, async () => res);
      return out;
    });
    return out;
  };
}

function decode(res) {
  return JSON.parse(new TextDecoder().decode(res.body));
}

// ============================================================================
// SignConfigStore 单元语义
// ============================================================================

test('store: snapshot 不可变，update 后旧快照仍可验签', () => {
  const store = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'k1', kid: 'k1' });
  const first = store.snapshot();
  assert.equal(first.revision, 1);
  assert.equal(first.kid, 'k1');

  store.update({ salt: 'k2', kid: 'k2', graceSec: 0 });
  const second = store.snapshot();
  assert.equal(second.revision, 2);
  assert.equal(second.kid, 'k2');

  // 旧快照对象保持原值（进行中的请求读的就是它）
  assert.equal(first.kid, 'k1');
  assert.equal(first.salt, 'k1');
  const payload = 'p';
  assert.ok(verifyPayload('hmac-sha256', payload, signPayload('hmac-sha256', payload, first.salt), first.salt));
});

test('store: rotate 后旧主密钥进入宽限期，expiresAt = now + graceSec', () => {
  const store = new SignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'old', kid: 'old' });
  const before = Date.now();
  store.rotate({ salt: 'new', kid: 'new', graceSec: 60 });
  const snap = store.snapshot();
  assert.equal(snap.kid, 'new');
  assert.equal(snap.grace.length, 1);
  assert.equal(snap.grace[0].kid, 'old');
  assert.equal(snap.grace[0].salt, 'old');
  assert.ok(snap.grace[0].expiresAt >= before + 60000 - 5);
  assert.ok(snap.grace[0].expiresAt <= Date.now() + 60000 + 5);

  // keys() 顺序：主密钥在前，宽限旧密钥在后
  const keys = store.keys();
  assert.deepEqual(keys.map((k) => k.kid), ['new', 'old']);
  assert.equal(store.resolveKey('old').salt, 'old');
  assert.equal(store.resolveKey().kid, 'new');
  assert.equal(store.resolveKey('nope'), undefined);
});

test('store: graceSec=0 时轮换即失效，旧密钥不可解析', () => {
  const store = createSignConfigStore({ method: 'hmac-sha256', salt: 'old', kid: 'old' });
  store.update({ salt: 'new', kid: 'new' });
  assert.equal(store.snapshot().grace.length, 0);
  assert.equal(store.resolveKey('old'), undefined);
  assert.deepEqual(store.keys().map((k) => k.kid), ['new']);
});

test('store: 已过期的宽限密钥被剔除；未给 expiresAt 的显式 grace 按 graceSec 推导', () => {
  const store = createSignConfigStore({
    method: 'hmac-sha256',
    salt: 'cur',
    kid: 'cur',
    graceSec: 30,
    grace: [
      { kid: 'expired', method: 'hmac-sha256', salt: 'e', expiresAt: Date.now() - 1000 },
      { kid: 'legacy', method: 'md5', salt: 'l' },
    ],
  });
  const snap = store.snapshot();
  assert.deepEqual(snap.grace.map((k) => k.kid), ['legacy']);
  assert.ok(snap.grace[0].expiresAt > Date.now());
  assert.equal(store.resolveKey('expired'), undefined);
  assert.equal(store.resolveKey('legacy').method, 'md5');
});

test('store: subscribe 接收变更通知，close 后不再通知', () => {
  const store = createSignConfigStore({ method: 'hmac-sha256', salt: 's1' });
  const seen = [];
  const off = store.subscribe((snap) => seen.push(snap.revision));
  store.update({ salt: 's2' });
  store.rotate({ salt: 's3', graceSec: 10 });
  assert.deepEqual(seen, [2, 3]);
  off();
  store.update({ salt: 's4' });
  assert.deepEqual(seen, [2, 3]);
  const seen2 = [];
  store.subscribe((s) => seen2.push(s.revision));
  store.close();
  store.update({ salt: 's5' });
  assert.deepEqual(seen2, []);
});

test('store: load 支持同步/异步配置回调热替换', async () => {
  const store = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'a', kid: 'a' });
  await store.load(() => ({ app: APP, method: 'hmac-sha256', salt: 'b', kid: 'b', graceSec: 5 }));
  assert.equal(store.snapshot().kid, 'b');
  assert.equal(store.snapshot().grace.length, 1);

  await store.load(async () => ({ app: APP, method: 'md5', salt: 'c', kid: 'c', graceSec: 5 }));
  assert.equal(store.snapshot().method, 'md5');
  assert.equal(store.snapshot().kid, 'c');
  // 上一代宽限密钥（b）在窗口内仍保留，形成多密钥并存
  assert.ok(store.keys().some((k) => k.kid === 'b'));
  assert.deepEqual(store.keys().map((k) => k.kid), ['c', 'b', 'a']);
});

// ============================================================================
// 服务端 × 客户端全链路
// ============================================================================

test('e2e: 热更新后新密钥立即生效（旧客户端密钥失败）', async () => {
  const serverStore = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'k1', kid: 'k1' });
  const clientStore = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 'k2', kid: 'k2' });
  const { port, close } = await startServer(serverStore);
  try {
    const call = buildClient(port, clientStore);
    const bad = await call('/api/user', { body: { a: 1 } });
    assert.equal(bad.status, 401);
    assert.equal(decode(bad).reason, 'unknown key id');

    // 服务端热更新到 k2（k1 无宽限，立即失效）
    serverStore.update({ salt: 'k2', kid: 'k2' });
    const ok = await call('/api/user', { body: { a: 1 } });
    assert.equal(ok.status, 200);
    assert.equal(decode(ok).ok, true);
  } finally {
    await close();
  }
});

test('e2e: 密钥轮换宽限期内旧密钥仍可验签，新密钥同时可用', async () => {
  const serverStore = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'old', kid: 'old' });
  const oldClient = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 'old', kid: 'old' });
  const newClient = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 'new', kid: 'new' });
  const { port, close } = await startServer(serverStore);
  try {
    // 轮换：new 立即生效，old 宽限 60s
    serverStore.rotate({ salt: 'new', kid: 'new', graceSec: 60 });

    const oldCall = buildClient(port, oldClient, { throwOnInvalid: false });
    const newCall = buildClient(port, newClient);

    const r1 = await oldCall('/api/user', { body: { v: 'old' } });
    assert.equal(r1.status, 200, '宽限期内旧 kid 应通过');

    const r2 = await newCall('/api/user', { body: { v: 'new' } });
    assert.equal(r2.status, 200, '新 kid 应立即通过');

    // 未签名请求仍被拒绝
    const directRes = await fetch(`http://127.0.0.1:${port}/api/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 }),
    });
    assert.equal(directRes.status, 401, '未签名请求被拒');
  } finally {
    await close();
  }
});

test('e2e: 宽限期结束后旧密钥被拒绝', async () => {
  const serverStore = createSignConfigStore({
    app: APP,
    method: 'hmac-sha256',
    salt: 'old',
    kid: 'old',
    graceSec: 10,
  });
  const oldClient = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 'old', kid: 'old' });
  const { port, close } = await startServer(serverStore);
  try {
    serverStore.rotate({ salt: 'new', kid: 'new', graceSec: 10 });
    const call = buildClient(port, oldClient, { throwOnInvalid: false });
    assert.equal((await call('/api/user', { body: { v: 1 } })).status, 200, '宽限内通过');

    // 手动把宽限到期时间提前到过去（模拟窗口流逝）
    const snap = serverStore.snapshot();
    serverStore.update({
      graceSec: 0,
      grace: snap.grace.map((k) => ({ ...k, expiresAt: Date.now() - 1 })),
    });
    const after = await call('/api/user', { body: { v: 1 } });
    assert.equal(after.status, 401);
    assert.equal(decode(after).reason, 'unknown key id');
    assert.equal(serverStore.resolveKey('old'), undefined);
  } finally {
    await close();
  }
});

test('e2e: 轮换同时更换算法，旧算法密钥在宽限内仍可验签', async () => {
  const serverStore = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 's1', kid: 'v1' });
  const oldClient = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 's1', kid: 'v1' });
  const newClient = createClientSignStore({ app: APP, method: 'md5', salt: 's2', kid: 'v2' });
  const { port, close } = await startServer(serverStore);
  try {
    serverStore.rotate({ method: 'md5', salt: 's2', kid: 'v2', graceSec: 60 });

    const r1 = await buildClient(port, oldClient, { throwOnInvalid: false })('/api/user', { body: { x: 1 } });
    assert.equal(r1.status, 200, '旧算法旧 kid 宽限内通过');
    const r2 = await buildClient(port, newClient)('/api/user', { body: { x: 1 } });
    assert.equal(r2.status, 200, '新算法新 kid 通过');
  } finally {
    await close();
  }
});

test('e2e: 无 kid 头时按 tryGraceKeys 决定是否尝试宽限密钥', async () => {
  const serverStore = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'old' });
  // 客户端不发 kid（匿名单密钥）
  const clientStore = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 'old' });
  const { port, close } = await startServer(serverStore);
  try {
    serverStore.rotate({ salt: 'new', graceSec: 60 });
    const call = buildClient(port, clientStore, { throwOnInvalid: false });
    const pass = await call('/api/user', { body: { n: 1 } });
    assert.equal(pass.status, 200, 'tryGraceKeys 默认 true，宽限密钥兜底通过');
  } finally {
    await close();
  }

  // tryGraceKeys:false：仅尝试主密钥，旧签名被拒
  const strictStore = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'old' });
  const strictServer = await startServer(strictStore, { tryGraceKeys: false });
  try {
    strictStore.rotate({ salt: 'new', graceSec: 60 });
    const call = buildClient(strictServer.port, clientStore, { throwOnInvalid: false });
    const deny = await call('/api/user', { body: { n: 1 } });
    assert.equal(deny.status, 401);
    assert.equal(decode(deny).reason, 'invalid signature');
  } finally {
    await strictServer.close();
  }
});

test('e2e: enabled=false 时热关闭签名，请求直接放行', async () => {
  const serverStore = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'k', kid: 'k' });
  const { port, close } = await startServer(serverStore);
  try {
    const plain = await fetch(`http://127.0.0.1:${port}/api/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 }),
    });
    assert.equal(plain.status, 401);

    serverStore.update({ enabled: false });
    const plain2 = await fetch(`http://127.0.0.1:${port}/api/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 }),
    });
    assert.equal(plain2.status, 200, '关闭签名后无头请求放行');

    serverStore.update({ enabled: true });
    const plain3 = await fetch(`http://127.0.0.1:${port}/api/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 }),
    });
    assert.equal(plain3.status, 401, '重新开启后恢复校验');
  } finally {
    await close();
  }
});

test('e2e: 请求处理期间轮换密钥，进行中的请求不受影响', async () => {
  const serverStore = createSignConfigStore({ app: APP, method: 'hmac-sha256', salt: 'a', kid: 'a' });
  const clientStore = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 'a', kid: 'a' });
  let rotated = false;
  const { port, close } = await startServer(serverStore, {
    rotateDuringRequest: () => {
      if (rotated) return;
      rotated = true;
      // 服务端与客户端同时热更新
      serverStore.rotate({ salt: 'b', kid: 'b', graceSec: 60 });
      clientStore.rotate({ salt: 'b', kid: 'b', graceSec: 60 });
    },
  });
  try {
    const call = buildClient(port, clientStore);
    const res = await call('/api/slow', { method: 'GET' });
    assert.equal(res.status, 200, '处理中热更新不影响当前请求');
    assert.equal(decode(res).slow, true);
    assert.equal(serverStore.snapshot().kid, 'b');

    // 轮换后新请求照常通过
    const after = await call('/api/slow', { method: 'GET' });
    assert.equal(after.status, 200);
  } finally {
    await close();
  }
});

test('client: 响应验签按 x-res-kid 选密钥（含宽限），未知 kid 抛错', async () => {
  const clientStore = createClientSignStore({
    app: APP,
    method: 'hmac-sha256',
    salt: 'cur',
    kid: 'cur',
    graceSec: 60,
    grace: [{ kid: 'old', method: 'hmac-sha256', salt: 'old' }],
  });
  const verifyT = createDynamicResponseVerifyTransport({ keys: clientStore, throwOnInvalid: true });
  const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
  const mkRes = (signSalt, kid) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce1234567890';
    const payload = APP + ts + nonce + '200' + Buffer.from(body).toString('base64');
    const sig = String(signPayload('hmac-sha256', payload, signSalt));
    return {
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'x-res-app': APP,
        'x-res-timestamp': ts,
        'x-res-nonce': nonce,
        'x-res-sign': sig,
        'x-res-kid': kid,
      }),
      body,
    };
  };
  const req = { url: 'http://example.com/api', method: 'GET', headers: new Headers(), body: null };

  // 主密钥 kid 通过
  const okCur = await verifyT(req, async () => mkRes('cur', 'cur'));
  assert.equal(okCur.status, 200);
  // 宽限期内旧 kid 通过
  const okOld = await verifyT(req, async () => mkRes('old', 'old'));
  assert.equal(okOld.status, 200);
  // 未知 kid：throwOnInvalid 时抛出
  await assert.rejects(() => verifyT(req, async () => mkRes('ghost', 'ghost')), /unknown key id/);
  // 未知 kid：非严格模式放行
  const lenient = createDynamicResponseVerifyTransport({ keys: clientStore });
  const passed = await lenient(req, async () => mkRes('ghost', 'ghost'));
  assert.equal(passed.status, 200);
});


test('client store: 轮换后旧 kid 在宽限内可解析，过期后不可解析', () => {
  const store = createClientSignStore({ app: APP, method: 'hmac-sha256', salt: 'x1', kid: 'x1' });
  store.rotate({ salt: 'x2', kid: 'x2', graceSec: 60 });
  assert.equal(store.resolveKey('x1').salt, 'x1');
  assert.equal(store.resolveKey('x2').salt, 'x2');
  assert.deepEqual(store.keys().map((k) => k.kid), ['x2', 'x1']);

  store.update({ graceSec: 0, grace: store.snapshot().grace.map((k) => ({ ...k, expiresAt: Date.now() - 1 })) });
  assert.equal(store.resolveKey('x1'), undefined);
  assert.equal(store.snapshot().grace.length, 0);
});
