/**
 * 客户端签名传输（对齐 bufgot/client/sign.SignTransport）。
 *
 * 请求头：x-req-app / x-req-timestamp / x-req-nonce / x-req-sign(/ x-req-kid)
 * payload = app + ts + nonce + UPPER(method) + path + base64(body)
 * 支持算法：md5 / hmac-sha256 / ed25519
 *
 * 热更新（对齐 bufgot/client/sign/hot.go 的 DynamicSignTransport /
 * DynamicVerifyTransport）：通过 ClientSignStore 或配置回调，每次请求发出 /
 * 响应回收时读取一次快照，密钥轮换期旧密钥在宽限窗口内仍可用于验签，
 * 由 x-req-kid / x-res-kid 指明所用密钥。
 */
import { createHmac, createHash, sign as signEd25519, timingSafeEqual } from 'node:crypto';
import type { HeadersLike, ReqLike, ResLike, Send, Transport } from './types.js';

export type SignMethod = 'md5' | 'hmac-sha256' | 'ed25519';

const DEFAULT_KID_HEADER = 'x-req-kid';
const DEFAULT_RES_KID_HEADER = 'x-res-kid';

export interface ClientSignOptions {
  /** 应用标识（对应 x-req-app）；使用 keys 热更新时可省略 */
  app?: string;
  /** 签名算法；使用 keys 热更新时可省略 */
  method?: SignMethod;
  /** md5/hmac-sha256 时的盐；ed25519 时的私钥（Buffer） */
  salt?: string | Buffer;
  /** 热更新密钥来源：ClientSignStore / 快照 / 同步或异步回调 */
  keys?: SignConfigSource;
  /** 密钥标识请求头名，默认 x-req-kid */
  kidHeader?: string;
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

// ============================================================================
// 密钥热更新：配置快照与存储（与服务端 @flovven/web-core 语义对齐）
// ============================================================================

/** 单把签名密钥 */
export interface SignKey {
  kid?: string;
  method: SignMethod;
  /** md5/hmac-sha256 的盐；ed25519 时签名用私钥、验签用公钥 */
  salt?: string | Buffer;
  /** 宽限截止时间（毫秒时间戳）；不设或 <=0 表示长期有效 */
  expiresAt?: number;
  /** 显式停用 */
  enabled?: boolean;
}

/** 可热更新的客户端签名配置 */
export interface ClientSignConfig {
  app: string;
  method: SignMethod;
  salt?: string | Buffer;
  /** 主密钥标识，写入 x-req-kid / 用于匹配 x-res-kid */
  kid?: string;
  /** 轮换宽限秒数：>0 时旧主密钥在窗口内仍可验签，默认 0（立即失效） */
  graceSec?: number;
  /** 额外可验签的旧密钥；未给 expiresAt 时按 graceSec 推导 */
  grace?: SignKey[];
  /** false 时跳过签发/验签 */
  enabled?: boolean;
}

/** 不可变配置快照（每次请求读取一次，后续 update 不影响已取出的快照） */
export interface ClientSignSnapshot {
  readonly app: string;
  readonly method: SignMethod;
  readonly salt?: string | Buffer;
  readonly kid?: string;
  readonly grace: readonly SignKey[];
  readonly graceSec: number;
  readonly enabled: boolean;
  readonly revision: number;
  readonly updatedAt: number;
  /** 当前可用于签发/验签的密钥：主密钥在前 */
  readonly keys: readonly SignKey[];
}

/** 配置来源：静态配置 / 快照 / 同步或异步回调 / 存储实例 */
export type SignConfigProvider = () =>
  | ClientSignConfig
  | ClientSignSnapshot
  | ClientSignStore
  | Promise<ClientSignConfig | ClientSignSnapshot | ClientSignStore>;

export type SignConfigSource = ClientSignConfig | ClientSignSnapshot | SignConfigProvider | ClientSignStore;

function isSnapshot(v: unknown): v is ClientSignSnapshot {
  return (
    typeof v === 'object' &&
    v !== null &&
    'revision' in (v as Record<string, unknown>) &&
    Array.isArray((v as Record<string, unknown>).keys)
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

function usableKey(k: SignKey, now: number): boolean {
  if (k.enabled === false) return false;
  if (typeof k.expiresAt === 'number' && k.expiresAt > 0 && k.expiresAt <= now) return false;
  return true;
}

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

function buildClientSnapshot(
  base: ClientSignSnapshot | undefined,
  input: Partial<ClientSignConfig>,
  revision: number,
  now: number,
): ClientSignSnapshot {
  const app = input.app ?? base?.app ?? '';
  const method = input.method ?? base?.method ?? 'hmac-sha256';
  const salt = 'salt' in input ? input.salt : base?.salt;
  const kid = 'kid' in input ? input.kid : base?.kid;
  const graceSec = input.graceSec ?? base?.graceSec ?? 0;
  const enabled = input.enabled ?? base?.enabled ?? true;

  const rotated =
    base !== undefined &&
    (base.method !== method || base.kid !== kid || saltKeyOf(base.salt) !== saltKeyOf(salt));

  const grace: SignKey[] = [];
  if (rotated && base && graceSec > 0) {
    grace.push({ kid: base.kid, method: base.method, salt: base.salt, expiresAt: now + graceSec * 1000 });
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

  const active: SignKey = { kid, method, salt };
  const keys = [active, ...normalizeGrace(grace, now)];
  return Object.freeze({
    app,
    method,
    salt,
    kid,
    grace: Object.freeze(normalizeGrace(grace, now)),
    graceSec,
    enabled,
    revision,
    updatedAt: now,
    keys: Object.freeze(keys),
  });
}

/**
 * 客户端签名配置热更新存储（对齐 bufgot `DynamicClientSignConfig`）。
 * `snapshot()` 返回的空对象在后续 `update()` / `rotate()` 之后依然有效。
 */
export class ClientSignStore {
  #snapshot: ClientSignSnapshot;
  #listeners = new Set<(snap: ClientSignSnapshot) => void>();

  constructor(initial: ClientSignConfig) {
    this.#snapshot = buildClientSnapshot(undefined, initial, 1, Date.now());
  }

  get revision(): number {
    return this.#snapshot.revision;
  }

  snapshot(): ClientSignSnapshot {
    return this.#snapshot;
  }

  /** 热替换配置：未给出的字段沿用上一份快照，主密钥变化且 graceSec>0 时旧密钥转入宽限期 */
  update(next: Partial<ClientSignConfig>): ClientSignSnapshot {
    const now = Date.now();
    this.#snapshot = buildClientSnapshot(this.#snapshot, next, this.#snapshot.revision + 1, now);
    for (const fn of this.#listeners) {
      try {
        fn(this.#snapshot);
      } catch {
        // 监听器异常不影响配置替换
      }
    }
    return this.#snapshot;
  }

  /** 密钥轮换：新密钥立即生效，旧密钥按 graceSec 继续可验签 */
  rotate(next: { method?: SignMethod; salt?: string | Buffer; kid?: string; graceSec?: number }): ClientSignSnapshot {
    return this.update(next);
  }

  /** 按 kid 选密钥（含宽限期）；未给 kid 时返回主密钥 */
  resolveKey(kid?: string, now: number = Date.now()): SignKey | undefined {
    const snap = this.#snapshot;
    if (kid === undefined || kid === '') return snap.keys[0];
    return snap.keys.find((k) => k.kid === kid && usableKey(k, now));
  }

  keys(now: number = Date.now()): SignKey[] {
    return this.#snapshot.keys.filter((k) => usableKey(k, now));
  }

  /** 订阅配置变更，返回退订函数 */
  subscribe(listener: (snap: ClientSignSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** 创建客户端签名配置热更新存储 */
export function createClientSignStore(initial: ClientSignConfig): ClientSignStore {
  return new ClientSignStore(initial);
}

interface ResolvedClientSignConfig {
  snapshot: ClientSignSnapshot;
  /** 主密钥（用于签发） */
  active: SignKey;
  /** 主密钥 + 宽限期密钥（用于验签匹配） */
  keys: SignKey[];
}

async function resolveSignSource(source: SignConfigSource): Promise<ResolvedClientSignConfig> {
  let value: unknown = source;
  if (typeof value === 'function') {
    value = (value as SignConfigProvider)();
    if (isPromiseLike(value)) value = await value;
  }
  if (value instanceof ClientSignStore) value = value.snapshot();
  const now = Date.now();
  const snap = isSnapshot(value)
    ? (value as ClientSignSnapshot)
    : buildClientSnapshot(undefined, (value ?? {}) as ClientSignConfig, 0, now);
  const keys = snap.keys.filter((k) => usableKey(k, now));
  return { snapshot: snap, active: keys[0] ?? { method: snap.method, salt: snap.salt, kid: snap.kid }, keys };
}

async function resolveOptions(opts: ClientSignOptions): Promise<ResolvedClientSignConfig> {
  if (opts.keys !== undefined) {
    const resolved = await resolveSignSource(opts.keys);
    if (opts.app && resolved.snapshot.app !== opts.app) {
      return {
        ...resolved,
        snapshot: Object.freeze({ ...resolved.snapshot, app: opts.app }),
      };
    }
    return resolved;
  }
  const now = Date.now();
  const snap = buildClientSnapshot(
    undefined,
    { app: opts.app ?? '', method: opts.method ?? 'hmac-sha256', salt: opts.salt },
    0,
    now,
  );
  return { snapshot: snap, active: snap.keys[0], keys: [snap.keys[0]] };
}

/** 创建签名 Transport：包装底层 Send，在请求头注入 x-req-* 签名信息 */
export function createSignTransport(opts: ClientSignOptions): Transport {
  const nonceLen = opts.nonceLen ?? 16;
  const now = opts.now ?? (() => new Date());
  const kidHeader = (opts.kidHeader ?? DEFAULT_KID_HEADER).toLowerCase();
  return async (req: ReqLike, next: Send) => {
    // 读时快照：热更新只影响后续请求
    const cfg = await resolveOptions(opts);
    if (!cfg.snapshot.enabled) return next(req);

    const app = cfg.snapshot.app || opts.app || '';
    const ts = String(Math.floor(now().getTime() / 1000));
    const nonce = randomNonce(nonceLen);
    const payload = buildPayload({ app, ts, nonce, method: req.method, url: req.url, body: req.body });
    const sig = signPayload(cfg.active.method, payload, cfg.active.salt);

    const headers = req.headers;
    setReqHeader(headers, 'x-req-app', app);
    setReqHeader(headers, 'x-req-timestamp', ts);
    setReqHeader(headers, 'x-req-nonce', nonce);
    setReqHeader(headers, 'x-req-sign', Buffer.isBuffer(sig) ? sig.toString('base64') : String(sig));
    if (cfg.active.kid) setReqHeader(headers, kidHeader, cfg.active.kid);

    return next(req);
  };
}

/** 支持热更新的签名 Transport（等价于给 createSignTransport 传 keys） */
export function createDynamicSignTransport(
  opts: { keys: SignConfigSource; nonceLen?: number; now?: () => Date; kidHeader?: string },
): Transport {
  return createSignTransport(opts);
}

function setReqHeader(headers: HeadersLike, name: string, value: string): void {
  if (headers && typeof headers.set === 'function') {
    headers.set(name, value);
  }
}

export interface ResponseVerifyOptions {
  /** 期望的应用标识（x-res-app 与之一致才验签，不设则不校验） */
  app?: string;
  method?: SignMethod;
  salt?: string | Buffer;
  /** 热更新密钥来源：ClientSignStore / 快照 / 同步或异步回调 */
  keys?: SignConfigSource;
  /** 密钥标识响应头名，默认 x-res-kid */
  kidHeader?: string;
  /** 校验失败是否抛出，默认 false 仅记录 */
  throwOnInvalid?: boolean;
}

/**
 * 响应验签 Transport：校验 x-res-* 头。
 * 验签 payload：app + ts + nonce + statusCode + base64(body)
 * 按 x-res-kid 选择密钥，宽限期内的旧密钥仍可通过。
 */
export function createResponseVerifyTransport(opts: ResponseVerifyOptions): Transport {
  const { throwOnInvalid = false } = opts;
  const kidHeader = (opts.kidHeader ?? DEFAULT_RES_KID_HEADER).toLowerCase();
  return async (req: ReqLike, next: Send): Promise<ResLike> => {
    const res = await next(req);
    const cfg = await resolveOptionsForVerify(opts);
    if (!cfg.snapshot.enabled) return res;

    const h = res.headers;
    if (typeof h?.get !== 'function') return res;
    const resApp = h.get('x-res-app');
    const ts = h.get('x-res-timestamp');
    const nonce = h.get('x-res-nonce');
    const expected = h.get('x-res-sign');
    if (!resApp || !ts || !nonce || !expected) return res; // 服务端未签名，跳过

    const now = Date.now();
    const kid = h.get(kidHeader) ?? undefined;
    const key = kid
      ? cfg.keys.find((k) => k.kid === kid && usableKey(k, now))
      : cfg.active;
    if (!key || !usableKey(key, now)) {
      if (throwOnInvalid) throw new Error(`sign: unknown key id ${String(kid)}`);
      return res;
    }

    const bodyB64 = res.body ? Buffer.from(res.body).toString('base64') : '';
    const payload = resApp + ts + nonce + String(res.status) + bodyB64;
    const sig = signPayload(key.method, payload, key.salt);
    const sigStr = Buffer.isBuffer(sig) ? sig.toString('base64') : String(sig);
    // 常量时间比较
    const a = Buffer.from(sigStr, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok && throwOnInvalid) {
      throw new Error('sign: response signature verification failed');
    }
    return res;
  };
}

/** 支持热更新的响应验签 Transport（等价于给 createResponseVerifyTransport 传 keys） */
export function createDynamicResponseVerifyTransport(
  opts: { keys: SignConfigSource; throwOnInvalid?: boolean; kidHeader?: string },
): Transport {
  return createResponseVerifyTransport(opts);
}

async function resolveOptionsForVerify(opts: ResponseVerifyOptions): Promise<ResolvedClientSignConfig> {
  if (opts.keys !== undefined) return resolveSignSource(opts.keys);
  const now = Date.now();
  const snap = buildClientSnapshot(
    undefined,
    { app: opts.app ?? '', method: opts.method ?? 'hmac-sha256', salt: opts.salt },
    0,
    now,
  );
  return { snapshot: snap, active: snap.keys[0], keys: [snap.keys[0]] };
}
