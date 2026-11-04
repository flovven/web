/**
 * 客户端签名传输（对齐 bufgot/client/sign.SignTransport）。
 *
 * 请求头：x-req-app / x-req-timestamp / x-req-nonce / x-req-sign
 * payload = app + ts + nonce + UPPER(method) + path + base64(body)
 * 支持算法：md5 / hmac-sha256 / ed25519
 */
import { createHmac, createHash, sign as signEd25519, timingSafeEqual } from 'node:crypto';
import type { HeadersLike, ReqLike, ResLike, Send, Transport } from './types.js';

export type SignMethod = 'md5' | 'hmac-sha256' | 'ed25519';

export interface ClientSignOptions {
  /** 应用标识（对应 x-req-app） */
  app: string;
  /** 签名算法 */
  method: SignMethod;
  /** md5/hmac-sha256 时的盐；ed25519 时的私钥（Buffer） */
  salt?: string | Buffer;
  /** nonce 长度，默认 16 */
  nonceLen?: number;
  /** 时钟注入（测试用） */
  now?: () => Date;
}

const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomNonce(len: number): string {
  const buf = new Uint8Array(len);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < len; i++) out += NONCE_CHARS[buf[i] % NONCE_CHARS.length];
  return out;
}

function buildPayload(opts: {
  app: string;
  ts: string;
  nonce: string;
  method: string;
  url: string;
  body: Uint8Array | null;
}): string {
  const u = new URL(opts.url);
  const path = u.pathname + u.search;
  const bodyB64 = opts.body ? Buffer.from(opts.body).toString('base64') : '';
  return opts.app + opts.ts + opts.nonce + opts.method.toUpperCase() + path + bodyB64;
}

export function signPayload(
  method: SignMethod,
  payload: string,
  saltOrKey?: string | Buffer,
): string | Buffer {
  switch (method) {
    case 'md5': {
      const key = (saltOrKey ?? '') as string | Buffer;
      return createHash('md5').update(payload + key.toString()).digest('hex');
    }
    case 'hmac-sha256': {
      const key = (saltOrKey ?? '') as string | Buffer;
      return createHmac('sha256', key).update(payload).digest('hex');
    }
    case 'ed25519': {
      if (!saltOrKey) throw new Error('feign/sign: ed25519 requires private key (salt)');
      const privateKey = saltOrKey as Buffer;
      return signEd25519(null, Buffer.from(payload, 'utf8'), privateKey);
    }
    default:
      throw new Error(`sign: unsupported method ${String(method)}`);
  }
}

/** 创建签名 Transport：包装底层 Send，在请求头注入 x-req-* 签名信息 */
export function createSignTransport(opts: ClientSignOptions): Transport {
  const nonceLen = opts.nonceLen ?? 16;
  const now = opts.now ?? (() => new Date());
  return async (req: ReqLike, next: Send) => {
    const app = opts.app;
    const ts = String(Math.floor(now().getTime() / 1000));
    const nonce = randomNonce(nonceLen);
    const payload = buildPayload({ app, ts, nonce, method: req.method, url: req.url, body: req.body });
    const sig = signPayload(opts.method, payload, opts.salt);

    const headers = req.headers;
    setReqHeader(headers, 'x-req-app', app);
    setReqHeader(headers, 'x-req-timestamp', ts);
    setReqHeader(headers, 'x-req-nonce', nonce);
    setReqHeader(headers, 'x-req-sign', Buffer.isBuffer(sig) ? sig.toString('base64') : String(sig));

    return next(req);
  };
}

function setReqHeader(headers: HeadersLike, name: string, value: string): void {
  if (headers && typeof headers.set === 'function') {
    headers.set(name, value);
  }
}

export interface ResponseVerifyOptions {
  app: string;
  method: SignMethod;
  salt?: string | Buffer;
  /** 校验失败是否抛出，默认 false 仅记录 */
  throwOnInvalid?: boolean;
}

/**
 * 响应验签 Transport：校验 x-res-* 头。
 * 验签 payload：app + ts + nonce + statusCode + base64(body)
 */
export function createResponseVerifyTransport(opts: ResponseVerifyOptions): Transport {
  const { app, method, salt, throwOnInvalid = false } = opts;
  return async (req: ReqLike, next: Send): Promise<ResLike> => {
    const res = await next(req);
    const h = res.headers;
    if (typeof h?.get !== 'function') return res;
    const resApp = h.get('x-res-app');
    const ts = h.get('x-res-timestamp');
    const nonce = h.get('x-res-nonce');
    const expected = h.get('x-res-sign');
    if (!resApp || !ts || !nonce || !expected) return res; // 服务端未签名，跳过

    const bodyB64 = res.body ? Buffer.from(res.body).toString('base64') : '';
    const payload = app + ts + nonce + String(res.status) + bodyB64;
    const sig = signPayload(method, payload, salt);
    const sigStr = Buffer.isBuffer(sig) ? sig.toString('base64') : String(sig);
    // 常量时间比较
    const a = Buffer.from(sigStr, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    const ok =
      a.length === b.length && timingSafeEqual(a, b);
    if (!ok && throwOnInvalid) {
      throw new Error('sign: response signature verification failed');
    }
    return res;
  };
}