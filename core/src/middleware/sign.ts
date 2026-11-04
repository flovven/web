/**
 * 服务端签名中间件 —— @flovven/web-core
 *
 * 与 @flovven/web-client 的签名传输配对，闭合验签闭环：
 *   - verifySign    ：校验请求 x-req-* 签名，失败短路（默认 401）
 *   - signResponse  ：为响应添加 x-res-* 签名，供客户端验签
 *
 * 算法与 client 完全一致：
 *   payload(req)  = app + ts + nonce + UPPER(method) + path + base64(body)
 *   payload(res)  = app + ts + nonce + statusCode + base64(body)
 *   其中 path = pathname + search（与 client 的 new URL().pathname+search 对齐）
 * 支持 md5 / hmac-sha256 / ed25519（verify 用公钥、sign 用私钥）。
 */
import { createHash, createHmac, sign as ed25519Sign, verify as ed25519Verify, timingSafeEqual } from 'node:crypto';
import type { WebContext } from '../context.js';
import type { WebMiddleware } from '../middleware.js';

export type SignMethod = 'md5' | 'hmac-sha256' | 'ed25519';

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

/** 计算签名（client/server 共用同一语义，服务端验签走 verifyPayload） */
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
      if (!saltOrKey) throw new Error('sign: ed25519 requires private key (salt)');
      return ed25519Sign(null, Buffer.from(payload, 'utf8'), saltOrKey as Buffer);
    }
    default:
      throw new Error(`sign: unsupported method ${String(method)}`);
  }
}

/** 校验签名（常量时间比较，ed25519 用公钥验签） */
export function verifyPayload(
  method: SignMethod,
  payload: string,
  signature: string,
  saltOrKey?: string | Buffer,
): boolean {
  try {
    switch (method) {
      case 'md5': {
        const key = (saltOrKey ?? '') as string | Buffer;
        const expect = createHash('md5').update(payload + key.toString()).digest('hex');
        return safeEqualStr(expect, signature);
      }
      case 'hmac-sha256': {
        const key = (saltOrKey ?? '') as string | Buffer;
        const expect = createHmac('sha256', key).update(payload).digest('hex');
        return safeEqualStr(expect, signature);
      }
      case 'ed25519': {
        if (!saltOrKey) return false;
        const publicKey = saltOrKey as Buffer;
        return ed25519Verify(
          null,
          Buffer.from(payload, 'utf8'),
          publicKey,
          Buffer.from(signature, 'base64'),
        );
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * 请求归一 path：与 client 的 new URL(url).pathname + search 保持一致。
 * ctx.request.url 可能是绝对或相对形式，统一归一。
 */
export function normalizePath(url: string): string {
  const u = new URL(url, 'http://flovven-sign.local');
  return u.pathname + u.search;
}

/** 服务端请求验签选项 */
export interface VerifySignOptions {
  /** 期望的应用标识（不设则不校验 x-req-app 取值） */
  app?: string;
  method: SignMethod;
  /** md5/hmac-sha256 的盐；ed25519 时传公钥（Buffer） */
  salt?: string | Buffer;
  /** 缺签名头时的策略：required 直接拒绝 / optional 放行，默认 required */
  mode?: 'required' | 'optional';
  /** 时间窗秒数（默认 300），校验 x-req-timestamp 新鲜度；<=0 不校验 */
  windowSec?: number;
  /** 校验失败/缺头时的自定义响应，默认 401 {"message":"unauthorized"} */
  onFail?: (ctx: WebContext, reason: string) => Promise<void> | void;
}

/** 请求验签中间件：校验 x-req-app/timestamp/nonce/sign */
export function verifySign(opts: VerifySignOptions): WebMiddleware {
  const { method, salt, windowSec = 300 } = opts;
  const mode = opts.mode ?? 'required';

  const fail = async (ctx: WebContext, reason: string): Promise<void> => {
    if (opts.onFail) {
      await opts.onFail(ctx, reason);
      return;
    }
    ctx.setStatus(401);
    await ctx.json({ ok: false, message: 'unauthorized', reason });
  };

  return async (ctx, next) => {
    const h = ctx.request.headers;
    const app = h.get('x-req-app');
    const ts = h.get('x-req-timestamp');
    const nonce = h.get('x-req-nonce');
    const signHeader = h.get('x-req-sign');
    if (!app || !ts || !nonce || !signHeader) {
      if (mode === 'optional') {
        await next();
        return;
      }
      await fail(ctx, 'missing sign headers');
      return;
    }
    if (opts.app && app !== opts.app) {
      await fail(ctx, 'app mismatch');
      return;
    }
    if (windowSec > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const tsNum = Number(ts);
      if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > windowSec) {
        await fail(ctx, 'timestamp expired');
        return;
      }
    }

    const raw = ctx.request.rawBody ? await ctx.request.rawBody() : undefined;
    const bodyB64 = raw ? Buffer.from(raw, 'utf8').toString('base64') : '';
    const payload =
      app + ts + nonce + ctx.request.method.toUpperCase() + normalizePath(ctx.request.url) + bodyB64;
    const ok = verifyPayload(method, payload, signHeader, salt);
    if (!ok) {
      await fail(ctx, 'invalid signature');
      return;
    }
    await next();
  };
}

/** 服务端响应签名选项 */
export interface SignResponseOptions {
  app: string;
  method: SignMethod;
  /** md5/hmac-sha256 的盐；ed25519 时传私钥（Buffer） */
  salt?: string | Buffer;
  nonceLen?: number;
  now?: () => Date;
  /**
   * 响应体字节编码，默认 JSON.stringify（对齐 @flovven/web-client 的
   * createResponseVerifyTransport 行为与主流 adapter 的 JSON 输出）。
   * body 为 undefined 时按空串处理。
   */
  bodyEncoder?: (body: unknown) => string;
  /** 跳过签名的判断（如静态资源），返回 true 则不签名 */
  skip?: (ctx: WebContext) => boolean | Promise<boolean>;
}

/**
 * 响应签名中间件：在 next() 之后为响应追加 x-res-* 签名头
 *
 * 同时暴露 `responseStage` 响应阶段钩子：fastify/elysia 等无法在洋葱
 * 回卷时读响应体的框架，由适配器在 onSend / onAfterHandle 时机单独调用，
 * 此时 ctx.response.body 应为实际发送字节（或等价原始对象），保证签名
 * 与客户端验签用的响应字节一致。
 */
export function signResponse(opts: SignResponseOptions): WebMiddleware {
  const nonceLen = opts.nonceLen ?? 16;
  const now = opts.now ?? (() => new Date());
  // string 视为已序列化字节原样参与签名；其余按 JSON 序列化
  const encoder =
    opts.bodyEncoder ??
    ((body: unknown): string =>
      body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));

  const applySign = async (ctx: WebContext): Promise<void> => {
    if (opts.skip && (await opts.skip(ctx))) return;
    const ts = String(Math.floor(now().getTime() / 1000));
    const nonce = randomNonce(nonceLen);
    const bodyStr = encoder(ctx.response.body);
    const bodyB64 = bodyStr === '' ? '' : Buffer.from(bodyStr, 'utf8').toString('base64');
    const payload = opts.app + ts + nonce + String(ctx.response.statusCode) + bodyB64;
    const sig = signPayload(opts.method, payload, opts.salt);
    const sigStr = Buffer.isBuffer(sig) ? sig.toString('base64') : String(sig);
    ctx.setHeader('x-res-app', opts.app);
    ctx.setHeader('x-res-timestamp', ts);
    ctx.setHeader('x-res-nonce', nonce);
    ctx.setHeader('x-res-sign', sigStr);
  };

  const mw: WebMiddleware = async (ctx, next) => {
    await next();
    await applySign(ctx);
  };
  mw.responseStage = applySign;
  return mw;
}