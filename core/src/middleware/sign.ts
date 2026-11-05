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
 *
 * 热更新（对齐 bufgot/web/middleware/sign 的 DynamicxxxConfig 与
 * ferrite-web 的 sign::dynamic_config）：
 *   - SignConfigStore 保存一份不可变配置快照，update/rotate 时整体替换引用；
 *   - 中间件在每个请求入口只取一次快照（读时快照），后续 update 不影响进行中的请求；
 *   - 密钥轮换期支持多密钥并存：新密钥立即可签发/验签，旧密钥在宽限窗口内仍可验签，
 *     过期后自动失效；客户端通过 x-req-kid / x-res-kid 指明所用密钥。
 */
import { createHash, createHmac, sign as ed25519Sign, verify as ed25519Verify, timingSafeEqual } from 'node:crypto';
import type { WebContext } from '../context.js';
import type { WebMiddleware } from '../middleware.js';

export type SignMethod = 'md5' | 'hmac-sha256' | 'ed25519';

const NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DEFAULT_METHOD: SignMethod = 'hmac-sha256';
const DEFAULT_KID_HEADER = 'x-req-kid';
const DEFAULT_RES_KID_HEADER = 'x-res-kid';

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

// ============================================================================
// 密钥热更新：配置快照与存储
// ============================================================================

/** 单把签名密钥 */
export interface SignKey {
  /** 密钥标识，写入 x-req-kid / x-res-kid；缺省表示匿名密钥（仅能兜底匹配） */
  kid?: string;
  method: SignMethod;
  /** md5/hmac-sha256 的盐；ed25519 时验签传公钥、签名传私钥 */
  salt?: string | Buffer;
  /** 宽限截止时间（毫秒时间戳）；不设或 <=0 表示长期有效 */
  expiresAt?: number;
  /** 显式停用（仍在快照中但不参与签发/验签） */
  enabled?: boolean;
}

/** 可热更新的签名配置输入 */
export interface SignConfigInput {
  /** 期望的应用标识（校验 x-req-app / 签发 x-res-app） */
  app?: string;
  /** 主密钥算法 */
  method?: SignMethod;
  /** 主密钥（md5/hmac-sha256 的盐；ed25519 私钥/公钥 Buffer） */
  salt?: string | Buffer;
  /** 主密钥标识 */
  kid?: string;
  /** 轮换宽限秒数：>0 时被替换下来的主密钥自动进入宽限期，默认 0（立即失效） */
  graceSec?: number;
  /** 额外可验签的旧密钥；未给 expiresAt 时按 graceSec 推导 */
  grace?: SignKey[];
  /** false 时跳过签发/验签（等价于全局关闭签名） */
  enabled?: boolean;
}

/** 不可变配置快照：中间件每次请求只取一次，生命周期内不受后续 update 影响 */
export interface SignConfigSnapshot {
  readonly revision: number;
  readonly app?: string;
  readonly method: SignMethod;
  readonly salt?: string | Buffer;
  readonly kid?: string;
  readonly grace: readonly SignKey[];
  readonly graceSec: number;
  readonly enabled: boolean;
  /** 快照生成时间（毫秒时间戳） */
  readonly updatedAt: number;
}

/** 配置来源：静态配置 / 快照 / 同步或异步回调 / 存储实例 */
export type SignConfigProvider = () =>
  | SignConfigInput
  | SignConfigSnapshot
  | SignConfigStore
  | Promise<SignConfigInput | SignConfigSnapshot | SignConfigStore>;

export type SignConfigSource = SignConfigInput | SignConfigSnapshot | SignConfigProvider | SignConfigStore;

function isSnapshot(v: unknown): v is SignConfigSnapshot {
  return (
    typeof v === 'object' &&
    v !== null &&
    'revision' in (v as Record<string, unknown>) &&
    'updatedAt' in (v as Record<string, unknown>) &&
    'grace' in (v as Record<string, unknown>)
  );
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return typeof (v as PromiseLike<unknown>)?.then === 'function';
}

function saltKeyOf(salt: string | Buffer | undefined): string {
  if (salt === undefined) return '';
  return Buffer.isBuffer(salt) ? `buf:${salt.toString('base64')}` : `str:${salt}`;
}

function keyIdOf(k: { kid?: string; method: SignMethod; salt?: string | Buffer }): string {
  return `${k.method}|${k.kid ?? ''}|${saltKeyOf(k.salt)}`;
}

function isExpired(k: SignKey, now: number): boolean {
  return typeof k.expiresAt === 'number' && k.expiresAt > 0 && k.expiresAt <= now;
}

function usableKey(k: SignKey, now: number): boolean {
  return k.enabled !== false && !isExpired(k, now);
}

/** 去掉重复（同 kid + 同算法 + 同密钥材料）与已过期项 */
function normalizeGrace(list: readonly SignKey[], now: number): SignKey[] {
  const seen = new Set<string>();
  const out: SignKey[] = [];
  for (const k of list) {
    if (!usableKey(k, now)) continue;
    const id = keyIdOf(k);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...k });
  }
  return out;
}

/**
 * 由上一份快照 + 新输入推导出新快照。
 * 主密钥发生变化且 graceSec > 0 时，旧主密钥自动转入宽限期。
 */
function buildSnapshot(
  base: SignConfigSnapshot | undefined,
  input: SignConfigInput,
  revision: number,
  now: number,
): SignConfigSnapshot {
  const method = input.method ?? base?.method ?? DEFAULT_METHOD;
  const salt = 'salt' in input ? input.salt : base?.salt;
  const kid = 'kid' in input ? input.kid : base?.kid;
  const graceSec = input.graceSec ?? base?.graceSec ?? 0;
  const enabled = input.enabled ?? base?.enabled ?? true;
  const app = input.app ?? base?.app;

  const rotated =
    base !== undefined &&
    (base.method !== method || base.kid !== kid || saltKeyOf(base.salt) !== saltKeyOf(salt));

  const grace: SignKey[] = [];
  if (rotated && base && graceSec > 0) {
    grace.push({
      kid: base.kid,
      method: base.method,
      salt: base.salt,
      expiresAt: now + graceSec * 1000,
    });
  }
  if (base) {
    for (const k of base.grace) {
      if (usableKey(k, now) && !grace.some((g) => keyIdOf(g) === keyIdOf(k))) grace.push(k);
    }
  }
  for (const k of input.grace ?? []) {
    const item: SignKey = {
      ...k,
      expiresAt: k.expiresAt ?? (graceSec > 0 ? now + graceSec * 1000 : undefined),
    };
    // 显式给出的宽限密钥优先于快照中结转的同名密钥（可提前/延后其失效时间）
    const id = keyIdOf(item);
    const idx = grace.findIndex((g) => keyIdOf(g) === id);
    if (idx >= 0) grace[idx] = item;
    else grace.push(item);
  }

  return Object.freeze({
    revision,
    app,
    method,
    salt,
    kid,
    grace: Object.freeze(normalizeGrace(grace, now)),
    graceSec,
    enabled,
    updatedAt: now,
  });
}

/**
 * 签名配置热更新存储（对齐 ferrite `DynamicSignConfig` / bufgot `DynamicSignConfig`）。
 *
 * 通过整体替换不可变快照实现「无锁读」：`snapshot()` 返回的对象在后续
 * `update()` / `rotate()` 之后依然有效，因此进行中的请求始终使用入口处的配置。
 */
export class SignConfigStore {
  #snapshot: SignConfigSnapshot;
  #listeners = new Set<(snap: SignConfigSnapshot) => void>();
  #closed = false;

  constructor(initial: SignConfigInput = {}) {
    this.#snapshot = buildSnapshot(undefined, initial, 1, Date.now());
  }

  /** 当前快照版本号（每次 update/rotate 自增） */
  get revision(): number {
    return this.#snapshot.revision;
  }

  /** 读取当前快照（只读，后续 update 不影响已取出的快照） */
  snapshot(): SignConfigSnapshot {
    return this.#snapshot;
  }

  /**
   * 热替换配置：未显式给出的字段沿用上一份快照。
   * 主密钥变化且 `graceSec > 0` 时，旧主密钥自动进入宽限期。
   */
  update(next: SignConfigInput): SignConfigSnapshot {
    const now = Date.now();
    this.#snapshot = buildSnapshot(this.#snapshot, next, this.#snapshot.revision + 1, now);
    this.#emit();
    return this.#snapshot;
  }

  /**
   * 密钥轮换：以新密钥替换主密钥，旧主密钥按 graceSec 继续可验签。
   * 等价于 `update({ method, salt, kid, graceSec })`。
   */
  rotate(next: { method?: SignMethod; salt?: string | Buffer; kid?: string; graceSec?: number }): SignConfigSnapshot {
    return this.update(next);
  }

  /**
   * 从外部配置源拉取并热替换（同步返回或 Promise 均可）。
   * 常用于配置中心推送回调里调用。
   */
  async load(source: SignConfigSource): Promise<SignConfigSnapshot> {
    const resolved = await resolveSignSource(source);
    return this.update(resolved.input);
  }

  /** 当前可用于签发/验签的全部密钥：主密钥在前，宽限期旧密钥在后 */
  keys(now: number = Date.now()): SignKey[] {
    const snap = this.#snapshot;
    const active: SignKey = { kid: snap.kid, method: snap.method, salt: snap.salt };
    return [active, ...snap.grace.filter((k) => usableKey(k, now))];
  }

  /** 按 kid 选密钥（含宽限期）；未给 kid 时返回主密钥 */
  resolveKey(kid?: string, now: number = Date.now()): SignKey | undefined {
    const snap = this.#snapshot;
    if (kid === undefined || kid === '') {
      return { kid: snap.kid, method: snap.method, salt: snap.salt };
    }
    if (snap.kid === kid) return { kid: snap.kid, method: snap.method, salt: snap.salt };
    return snap.grace.find((k) => k.kid === kid && usableKey(k, now));
  }

  /** 订阅配置变更，返回退订函数 */
  subscribe(listener: (snap: SignConfigSnapshot) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 释放订阅者（应用退出时调用；此后 update 不再通知） */
  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  #emit(): void {
    if (this.#closed) return;
    for (const fn of this.#listeners) {
      try {
        fn(this.#snapshot);
      } catch {
        // 监听器异常不影响配置替换
      }
    }
  }
}

/** 创建签名配置热更新存储 */
export function createSignConfigStore(initial: SignConfigInput = {}): SignConfigStore {
  return new SignConfigStore(initial);
}

interface ResolvedSignConfig {
  snapshot: SignConfigSnapshot;
  input: SignConfigInput;
  /** 主密钥 + 宽限期密钥（已剔除过期/停用项） */
  candidates: SignKey[];
}

async function resolveSignSource(source: SignConfigSource): Promise<ResolvedSignConfig> {
  let value: unknown = source;
  if (typeof value === 'function') {
    value = (value as SignConfigProvider)();
    if (isPromiseLike(value)) value = await value;
  }
  if (value instanceof SignConfigStore) value = value.snapshot();
  if (isSnapshot(value)) {
    const snap = value as SignConfigSnapshot;
    const input: SignConfigInput = {
      app: snap.app,
      method: snap.method,
      salt: snap.salt,
      kid: snap.kid,
      graceSec: snap.graceSec,
      grace: [...snap.grace],
      enabled: snap.enabled,
    };
    return {
      snapshot: snap,
      input,
      candidates: [
        { kid: snap.kid, method: snap.method, salt: snap.salt },
        ...snap.grace.filter((k) => usableKey(k, Date.now())),
      ],
    };
  }
  const now = Date.now();
  const snap = buildSnapshot(undefined, (value ?? {}) as SignConfigInput, 0, now);
  return {
    snapshot: snap,
    input: (value ?? {}) as SignConfigInput,
    candidates: [
      { kid: snap.kid, method: snap.method, salt: snap.salt },
      ...snap.grace.filter((k) => usableKey(k, now)),
    ],
  };
}

/** 从中间件选项中解析出本次请求使用的配置（只调用一次 = 读时快照） */
async function resolveRequestConfig(opts: {
  keys?: SignConfigSource;
  app?: string;
  method?: SignMethod;
  salt?: string | Buffer;
}): Promise<ResolvedSignConfig> {
  if (opts.keys !== undefined) {
    const resolved = await resolveSignSource(opts.keys);
    return {
      ...resolved,
      snapshot: Object.freeze({
        ...resolved.snapshot,
        app: resolved.snapshot.app ?? opts.app,
      }),
    };
  }
  const now = Date.now();
  const input: SignConfigInput = {
    app: opts.app,
    method: opts.method ?? DEFAULT_METHOD,
    salt: opts.salt,
  };
  const snap = buildSnapshot(undefined, input, 0, now);
  return {
    snapshot: snap,
    input,
    candidates: [{ kid: snap.kid, method: snap.method, salt: snap.salt }],
  };
}

// ============================================================================
// 中间件
// ============================================================================

/** 服务端请求验签选项 */
export interface VerifySignOptions {
  /** 期望的应用标识（不设则不校验 x-req-app 取值） */
  app?: string;
  /** 固定算法；使用 keys 热更新时可省略，按快照中密钥自带算法验签 */
  method?: SignMethod;
  /** md5/hmac-sha256 的盐；ed25519 时传公钥（Buffer） */
  salt?: string | Buffer;
  /**
   * 热更新密钥来源：SignConfigStore / 快照 / 同步或异步回调。
   * 每个请求入口读取一次，进行中的请求不受后续更新影响。
   */
  keys?: SignConfigSource;
  /** 密钥标识请求头名，默认 x-req-kid */
  kidHeader?: string;
  /** 请求未带 kid 时，是否依次尝试主密钥与宽限期旧密钥，默认 true */
  tryGraceKeys?: boolean;
  /** 缺签名头时的策略：required 直接拒绝 / optional 放行，默认 required */
  mode?: 'required' | 'optional';
  /** 时间窗秒数（默认 300），校验 x-req-timestamp 新鲜度；<=0 不校验 */
  windowSec?: number;
  /** 校验失败/缺头时的自定义响应，默认 401 {"message":"unauthorized"} */
  onFail?: (ctx: WebContext, reason: string) => Promise<void> | void;
}

/** 请求验签中间件：校验 x-req-app/timestamp/nonce/sign[ + kid] */
export function verifySign(opts: VerifySignOptions): WebMiddleware {
  const { windowSec = 300 } = opts;
  const mode = opts.mode ?? 'required';
  const kidHeader = (opts.kidHeader ?? DEFAULT_KID_HEADER).toLowerCase();
  const tryGraceKeys = opts.tryGraceKeys ?? true;

  const fail = async (ctx: WebContext, reason: string): Promise<void> => {
    if (opts.onFail) {
      await opts.onFail(ctx, reason);
      return;
    }
    ctx.setStatus(401);
    await ctx.json({ ok: false, message: 'unauthorized', reason });
  };

  return async (ctx, next) => {
    // 读时快照：本次请求全程使用入口处的配置，热更新只影响后续请求
    const cfg = await resolveRequestConfig(opts);
    if (!cfg.snapshot.enabled) {
      await next();
      return;
    }

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
    const expectApp = cfg.snapshot.app ?? opts.app;
    if (expectApp && app !== expectApp) {
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

    const now = Date.now();
    const kid = h.get(kidHeader) ?? undefined;
    let candidates: SignKey[];
    if (kid) {
      // 指定 kid 时严格按密钥选择（主密钥或宽限期内的旧密钥）
      const matched = cfg.candidates.filter((k) => k.kid === kid && usableKey(k, now));
      if (matched.length === 0) {
        await fail(ctx, 'unknown key id');
        return;
      }
      candidates = matched;
    } else {
      candidates = tryGraceKeys
        ? cfg.candidates.filter((k) => usableKey(k, now))
        : cfg.candidates.slice(0, 1);
    }
    if (candidates.length === 0) {
      await fail(ctx, 'no usable key');
      return;
    }

    const raw = ctx.request.rawBody ? await ctx.request.rawBody() : undefined;
    const bodyB64 = raw ? Buffer.from(raw, 'utf8').toString('base64') : '';
    const payload =
      app + ts + nonce + ctx.request.method.toUpperCase() + normalizePath(ctx.request.url) + bodyB64;

    // 多密钥宽限校验：任一可用密钥验签成功即通过
    const ok = candidates.some((k) => verifyPayload(k.method, payload, signHeader, k.salt));
    if (!ok) {
      await fail(ctx, 'invalid signature');
      return;
    }
    await next();
  };
}

/** 服务端响应签名选项 */
export interface SignResponseOptions {
  app?: string;
  method?: SignMethod;
  /** md5/hmac-sha256 的盐；ed25519 时传私钥（Buffer） */
  salt?: string | Buffer;
  /** 热更新密钥来源：SignConfigStore / 快照 / 同步或异步回调 */
  keys?: SignConfigSource;
  /** 密钥标识响应头名，默认 x-res-kid */
  kidHeader?: string;
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
  const kidHeader = (opts.kidHeader ?? DEFAULT_RES_KID_HEADER).toLowerCase();
  // string 视为已序列化字节原样参与签名；其余按 JSON 序列化
  const encoder =
    opts.bodyEncoder ??
    ((body: unknown): string =>
      body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));

  const applySign = async (ctx: WebContext): Promise<void> => {
    if (opts.skip && (await opts.skip(ctx))) return;
    // 读时快照：签名所用密钥取自响应阶段入口时的配置
    const cfg = await resolveRequestConfig(opts);
    const snap = cfg.snapshot;
    if (!snap.enabled) return;
    const ts = String(Math.floor(now().getTime() / 1000));
    const nonce = randomNonce(nonceLen);
    const bodyStr = encoder(ctx.response.body);
    const bodyB64 = bodyStr === '' ? '' : Buffer.from(bodyStr, 'utf8').toString('base64');
    const payload = (snap.app ?? opts.app ?? '') + ts + nonce + String(ctx.response.statusCode) + bodyB64;
    const sig = signPayload(snap.method, payload, snap.salt);
    const sigStr = Buffer.isBuffer(sig) ? sig.toString('base64') : String(sig);
    ctx.setHeader('x-res-app', snap.app ?? opts.app ?? '');
    ctx.setHeader('x-res-timestamp', ts);
    ctx.setHeader('x-res-nonce', nonce);
    ctx.setHeader('x-res-sign', sigStr);
    if (snap.kid) ctx.setHeader(kidHeader, snap.kid);
  };

  const mw: WebMiddleware = async (ctx, next) => {
    await next();
    await applySign(ctx);
  };
  mw.responseStage = applySign;
  return mw;
}
