/**
 * 服务端 sign 中间件 × client 签名传输 全链路 E2E
 * 覆盖：md5 / hmac-sha256 / ed25519 三种算法，
 *       正链路（验签通过 + 响应验签通过）、
 *       负例（篡改体 / 缺头 / app 不匹配 / 时间戳过期 / optional 模式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { WebApp } from '@flovven/web-core';
import { verifySign, signResponse } from '@flovven/web-core';
import { HonoAdapter } from '@flovven/web-adapter-hono';
import { createSignTransport, createResponseVerifyTransport } from '../../client/dist/sign.js';

const APP = 'featx-app';
const SALT = 's3cret-salt';

/** 启动 hono server 并暴露 close，避免 node --test 进程不退出 */
async function startServer(authMethod, saltKey, signSalt) {
  const app = new WebApp(new HonoAdapter());
  app.use(verifySign({ app: APP, method: authMethod, salt: saltKey }));
  app.use(signResponse({ app: APP, method: authMethod, salt: signSalt }));
  app.post('/api/user', async (ctx) => {
    const body = await ctx.request.body();
    await ctx.json({ ok: true, received: body, seq: 7 });
  });
  app.get('/api/ping', async (ctx) => {
    await ctx.json({ pong: true, at: 1730000000 });
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

function buildClient(port, method, salt, extra = {}) {
  const signT = createSignTransport({ app: APP, method, salt, ...(extra.now ? { now: extra.now } : {}) });
  const verifyT = createResponseVerifyTransport({ app: APP, method, salt, throwOnInvalid: true });
  const rawSend = async (req) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
    });
    const body = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, _raw: res, body };
  };
  return async (path, { method = 'POST', body } = {}) => {
    const url = `http://127.0.0.1:${port}${path}`;
    const req = {
      url,
      method,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: body ? new TextEncoder().encode(JSON.stringify(body)) : null,
    };
    let out;
    await signT(req, async (r2) => {
      const res = await rawSend(r2);
      out = await verifyT(r2, async () => res);
    });
    return out;
  };
}

async function stopServer(handle) {
  if (handle && typeof handle.close === 'function') {
    await handle.close();
  }
}

for (const method of ['md5', 'hmac-sha256']) {
  test(`full-chain sign roundtrip: ${method}`, async () => {
    const { port, close } = await startServer(method, SALT, SALT);
    const call = buildClient(port, method, SALT);
    const res = await call('/api/user', {
      body: { hello: 'marvis', 中文: '校验' },
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(new TextDecoder().decode(res.body));
    assert.equal(json.ok, true);
    assert.equal(json.seq, 7);
    assert.equal(json.received.hello, 'marvis');
    assert.ok(res.headers.get('x-res-app'));
    assert.ok(res.headers.get('x-res-timestamp'));
    assert.ok(res.headers.get('x-res-nonce'));
    assert.ok(res.headers.get('x-res-sign'));

    // GET 无 body 链路
    const ping = await call('/api/ping?full=1&v=2', { method: 'GET' });
    assert.equal(ping.status, 200);
    assert.ok(ping.headers.get('x-res-sign'));
    await close();
  });
}

test('full-chain sign/ed25519: 公钥验签请求 + 私钥签响应', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const { port, close } = await startServer('ed25519', publicKey, privateKey);
  const call = buildClient(port, 'ed25519', privateKey);
  const res = await call('/api/user', { method: 'POST', body: { hello: 'ed25519' } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-res-sign'));
  await close();
});

test('negative: 篡改 body 验签失败 401', async () => {
  const { port, close } = await startServer('hmac-sha256', SALT, SALT);
  const signT = createSignTransport({ app: APP, method: 'hmac-sha256', salt: SALT });
  const rawSend = async (req) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
    });
    return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) };
  };
  // 构造签名后篡改 body：签名对应原始 body，发送不同 body
  const url = `http://127.0.0.1:${port}/api/user`;
  let out;
  const payload = JSON.stringify({ a: 1 });
  await signT({ url, method: 'POST', headers: new Headers(), body: new TextEncoder().encode(payload) }, async (r2) => {
    // 篡改：发送不同 body
    const res = await rawSend({ ...r2, body: new TextEncoder().encode(JSON.stringify({ a: 999 })) });
    out = res;
  });
  assert.equal(out.status, 401);
  const json = JSON.parse(new TextDecoder().decode(out.body));
  assert.equal(json.reason, 'invalid signature');
  await close();
});

test('negative: 缺签名头 401（required 模式）', async () => {
  const { port, close } = await startServer('hmac-sha256', SALT, SALT);
  const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.reason, 'missing sign headers');
  await close();
});

test('negative: app 不匹配 401', async () => {
  const { port, close } = await startServer('hmac-sha256', SALT, SALT);
  const signT = createSignTransport({ app: 'wrong-app', method: 'hmac-sha256', salt: SALT });
  const rawSend = async (req) => {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined });
    return res;
  };
  await signT({ url: `http://127.0.0.1:${port}/api/user`, method: 'POST', headers: new Headers(), body: null }, async (r2) => {
    const res = await rawSend(r2);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.reason, 'app mismatch');
  });
  await close();
});

test('negative: 时间戳过期 401', async () => {
  const { port, close } = await startServer('hmac-sha256', SALT, SALT);
  const past = () => new Date(Date.now() - 10 * 60 * 1000); // 10 分钟前
  const call = buildClient(port, 'hmac-sha256', SALT, { now: past });
  const res = await call('/api/user', { method: 'POST', body: { a: 1 } });
  assert.equal(res.status, 401);
  const json = JSON.parse(new TextDecoder().decode(res.body));
  assert.equal(json.reason, 'timestamp expired');
  await close();
});

test('optional 模式：缺头放行、有头验签', async () => {
  const app = new WebApp(new HonoAdapter());
  app.use(verifySign({ method: 'hmac-sha256', salt: SALT, mode: 'optional' }));
  app.use(signResponse({ app: APP, method: 'hmac-sha256', salt: SALT }));
  app.get('/api/open', async (ctx) => {
    await ctx.json({ open: true });
  });
  const { serve } = await import('@hono/node-server');
  const native = app.build();
  const server = serve({ fetch: native.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((res, rej) => {
    server.once('listening', res);
    server.once('error', rej);
  });
  const port = server.address().port;
  // 无签名头 → 放行
  const plain = await fetch(`http://127.0.0.1:${port}/api/open`);
  assert.equal(plain.status, 200);
  // 带签名头 → 验签通过
  const call = buildClient(port, 'hmac-sha256', SALT);
  const signed = await call('/api/open', { method: 'GET' });
  assert.equal(signed.status, 200);
  await new Promise((r) => server.close(() => r(undefined)));
});