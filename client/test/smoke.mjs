/**
 * @flovven/web-client 冒烟测试：起真实 HTTP server 验证
 * - baseUrl 模式（GET 路径参数 + query、POST body、meta、4xx）
 * - discovery + 默认 RoundRobin / FirstBalancer
 * - 签名请求（服务端校验 x-req-*）与响应验签（x-res-*）
 */
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  createClient,
  createSignTransport,
  createResponseVerifyTransport,
  HTTPError,
  RoundRobin,
  FirstBalancer,
} from '../dist/index.js';

const APP = 'smoke-app';
const SALT = 'smoke-salt';

/** 起一个 echo 风格测试 server */
function startServer(port, opts = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const pathname = req.url.split('?')[0];

      if (pathname === '/err') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 400, message: 'bad' }));
        return;
      }

      const out = {
        url: req.url,
        host: typeof req.headers.host === 'string' ? req.headers.host : '',
        headers: req.headers,
        echo: req.method === 'GET' || req.method === 'HEAD' ? null : body,
      };

      if (opts.verifyRequest) {
        const app = req.headers['x-req-app'];
        const ts = req.headers['x-req-timestamp'];
        const nonce = req.headers['x-req-nonce'];
        const sign = req.headers['x-req-sign'];
        assert.ok(app && ts && nonce && sign, 'sign headers present');
        assert.equal(app, APP);
        const payload =
          app + ts + nonce + req.method.toUpperCase() + req.url + Buffer.from(body).toString('base64');
        const expect =
          opts.verifyRequest.method === 'md5'
            ? createHash('md5').update(payload + SALT).digest('hex')
            : createHmac('sha256', SALT).update(payload).digest('hex');
        assert.equal(sign, expect, 'request signature mismatch');
      }

      if (opts.signResponse) {
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = 'rspnonceabcdef';
        const resBody = Buffer.from(JSON.stringify(out), 'utf8');
        const payload = APP + ts + nonce + '200' + resBody.toString('base64');
        const sig =
          opts.signResponse.method === 'md5'
            ? createHash('md5').update(payload + SALT).digest('hex')
            : createHmac('sha256', SALT).update(payload).digest('hex');
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-res-app': APP,
          'x-res-timestamp': ts,
          'x-res-nonce': nonce,
          'x-res-sign': sig,
        });
        res.end(resBody);
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** transport 组合：t1 最外层，tLast 最内层 */
function compose(...transports) {
  return (req, next) => {
    let send = next;
    for (let i = transports.length - 1; i >= 0; i--) {
      const t = transports[i];
      const prev = send;
      send = (r) => t(r, prev);
    }
    return send(req);
  };
}

const servers = [];

async function main() {
  const s1 = await startServer(9011);
  const s2 = await startServer(9012);
  servers.push(s1, s2);

  // 1. baseUrl 模式：GET 路径参数 + query
  const client = createClient({
    baseUrl: 'http://127.0.0.1:9011',
    mappings: {
      getUser: 'GET /api/users/{id}',
      createUser: 'POST /api/users',
      delUser: { method: 'DELETE', path: '/api/users/{id}', meta: true },
      getErr: 'GET /err',
    },
  });
  const got = await client.getUser({ id: 42, verbose: '1', page: '2' });
  assert.equal(got.url, '/api/users/42?verbose=1&page=2', 'path+query');

  const created = await client.createUser({ name: 'tony', age: 30 });
  assert.equal(created.url, '/api/users');
  assert.equal(created.echo, JSON.stringify({ name: 'tony', age: 30 }));

  const del = await client.delUser({ id: 7 });
  assert.equal(del.meta.statusCode, 200);
  assert.ok(del.meta.headers['content-type']);

  await assert.rejects(() => client.getErr({}), HTTPError);
  console.log('ok: baseUrl GET/POST/meta/4xx');

  // 2. discovery + RoundRobin 轮询
  const discoverer = async () => [
    { id: 'a', ip: '127.0.0.1', port: 9011, weight: 1, healthy: true },
    { id: 'b', ip: '127.0.0.1', port: 9012, weight: 1, healthy: true },
  ];
  const svc = createClient({
    serviceName: 'svc',
    discoverer,
    balancer: new RoundRobin(),
    mappings: { ping: 'GET /ping' },
  });
  let a = 0;
  let b = 0;
  for (let i = 0; i < 4; i++) {
    const r = await svc.ping({});
    if (r.host.startsWith('127.0.0.1:9011')) a++;
    else b++;
  }
  assert.equal(a, 2, 'roundrobin a hits');
  assert.equal(b, 2, 'roundrobin b hits');

  const svc2 = createClient({
    serviceName: 'svc',
    discoverer,
    balancer: new FirstBalancer(),
    mappings: { ping: 'GET /ping' },
  });
  const r2 = await svc2.ping({});
  assert.equal(r2.host, '127.0.0.1:9011');
  console.log('ok: discovery + RoundRobin/First');

  // 3. 签名请求 + 响应验签
  const s3 = await startServer(9013, {
    verifyRequest: { method: 'hmac-sha256' },
    signResponse: { method: 'hmac-sha256' },
  });
  servers.push(s3);
  const signClient = createClient({
    baseUrl: 'http://127.0.0.1:9013',
    transport: compose(
      createSignTransport({ app: APP, method: 'hmac-sha256', salt: SALT }),
      createResponseVerifyTransport({
        app: APP,
        method: 'hmac-sha256',
        salt: SALT,
        throwOnInvalid: true,
      }),
    ),
    mappings: { ping: 'POST /sping' },
  });
  const sr = await signClient.ping({ a: 1 });
  assert.equal(sr.url, '/sping');
  assert.equal(sr.echo, JSON.stringify({ a: 1 }));
  console.log('ok: sign request + response verify');

  console.log('SMOKE PASS: 全部通过');
}

main()
  .catch((e) => {
    console.error('SMOKE FAILED:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const s of servers) s.close();
  });