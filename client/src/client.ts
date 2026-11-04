/**
 * Feign 风格声明式 HTTP 客户端（对齐 bufgot/client/feign）。
 *
 * 用法：
 * ```ts
 * interface UserService {
 *   get(req: { id: number }): Promise<User>;      // GET /api/users/{id}?...
 *   create(req: CreateUserReq): Promise<User>;      // POST /api/users，整个入参为 body
 *   del(req: { id: number }): Promise<MetaResult<void>>; // 配 meta:true 拿响应头
 * }
 *
 * const svc = createClient<UserService>({
 *   serviceName: 'user-service',
 *   discoverer: nacosDiscovery,          // @flovven/discovery 实现，鸭子类型
 *   mappings: {
 *     get: 'GET /api/users/{id}',
 *     create: { method: 'POST', path: '/api/users' },
 *     del: { method: 'DELETE', path: '/api/users/{id}', meta: true },
 *   },
 *   transport: createSignTransport({ appId: 'app', method: 'hmac-sha256', salt: 's' }),
 * });
 * ```
 */
import type {
  DiscovererLike,
  FetchLike,
  FetchResponseLike,
  HeadersLike,
  Instance,
  InstanceLike,
  MetaResult,
  ReqLike,
  ResLike,
  Send,
  Transport,
} from './types.js';
import { JSONCodec, type Codec } from './codec.js';
import { HTTPError, decodeErrorMessage } from './errors.js';
import { defaultBalancer, type Balancer } from './balancer.js';
import { buildUrl, collectQuery, parseMapping, applyPathParams, type MappingInput } from './mapping.js';
import { encodeText, decodeText } from './text.js';

/** 调用时可选的附加参数（第二参） */
export interface CallOptions {
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 手动取消信号 */
  signal?: AbortSignal;
  /** 单次调用覆盖超时（毫秒），0 表示不设 */
  timeoutMs?: number;
}

export interface FeignClientOptions {
  /** 服务发现键（如 "user-service"），与 baseUrl 同时设置时发现结果优先 */
  serviceName?: string;
  /** 服务发现器：直接传 @flovven/discovery 实现或 resolve 函数 */
  discoverer?: DiscovererLike | null;
  /** 负载均衡器，默认 RoundRobin */
  balancer?: Balancer;
  /** 静态 base URL，如 http://localhost:8080 */
  baseUrl?: string;
  /** url scheme，仅 discovery 模式使用，默认 http */
  scheme?: 'http' | 'https';
  /** 方法名 -> "METHOD /path" 或对象映射 */
  mappings: Record<string, MappingInput>;
  /** 编解码器，默认 JSON */
  codec?: Codec;
  /** 全局请求超时（毫秒），0 不设 */
  timeoutMs?: number;
  /** 传输中间件（签名/日志/重试等） */
  transport?: Transport;
  /** 自定义错误解码器：非 2xx 时先调用，返回 Error 则抛出，返回 undefined 继续走默认 HTTPError */
  decodeError?: (res: ResLike) => Error | null | undefined | void;
  /** 注入 fetch 实现（默认 globalThis.fetch） */
  fetchFn?: FetchLike;
  /** 时钟注入（签名测试用） */
  now?: () => Date;
}

/** 归一化后的 discoverer */
type NormalizedDiscoverer = (serviceName: string) => Promise<readonly Instance[]>;

function normalizeDiscoverer(d?: DiscovererLike | null): NormalizedDiscoverer | null {
  if (!d) return null;
  const fn =
    typeof d === 'function'
      ? d
      : (name: string) => (d as { resolve(name: string): unknown }).resolve(name);
  return async (name: string) => {
    const list = (await fn(name)) as unknown as readonly InstanceLike[] | null | undefined;
    return (list ?? []).map(toInstance);
  };
}

function toInstance(raw: InstanceLike): Instance {
  return {
    id: raw.id,
    host: raw.ip,
    port: raw.port,
    raw,
  };
}

function joinHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** 创建声明式服务客户端。返回的对象为 Proxy：方法名在 mappings 中命中即
 * 执行对应 HTTP 调用，类型由泛型 T 决定。
 */
export function createClient<T extends object>(options: FeignClientOptions): T {
  if (!options || !options.mappings) {
    throw new Error('feign: options.mappings is required');
  }
  const client = new FeignClient(options);
  return new Proxy({} as T, {
    get(_target, prop, _receiver) {
      if (typeof prop !== 'string') return undefined;
      if (!Object.prototype.hasOwnProperty.call(options.mappings, prop)) {
        return undefined;
      }
      return (...args: unknown[]) => client.invoke(prop, args);
    },
  });
}

/** 核心执行引擎（内部类，供 Proxy 复用） */
export class FeignClient {
  private readonly options: FeignClientOptions;
  private readonly codec: Codec;
  private readonly balancer: Balancer;
  private readonly discoverer: NormalizedDiscoverer | null;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;

  constructor(options: FeignClientOptions) {
    this.options = options;
    this.codec = options.codec ?? JSONCodec;
    this.balancer = options.balancer ?? defaultBalancer();
    this.discoverer = normalizeDiscoverer(options.discoverer);
    this.fetchFn = options.fetchFn ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    if (typeof this.fetchFn !== 'function') {
      throw new Error('feign: global fetch is not available (Node >= 18 required) or pass fetchFn');
    }
    this.now = options.now ?? (() => new Date());
  }

  /** 供 Proxy 调用的入口 */
  async invoke(name: string, args: unknown[]) {
    const mappingRaw = this.options.mappings[name];
    if (mappingRaw === undefined) {
      throw new Error(`feign: no mapping for method ${name}`);
    }
    const mapping = parseMapping(mappingRaw);
    const input = typeof args[0] === 'object' && args[0] !== null ? (args[0] as Record<string, unknown>) : undefined;
    const callOpts = (typeof args[1] === 'object' && args[1] !== null ? args[1] : {}) as CallOptions;

    const path = applyPathParams(mapping.path, input);
    const base = await this.resolveBase(path);
    const isBodyMethod = mapping.method !== 'GET' && mapping.method !== 'HEAD';
    const query = isBodyMethod ? {} : collectQuery(mapping.path, input);
    const url = buildUrl(base, path, query);

    let body: Uint8Array | null = null;
    let contentType: string | null = null;
    if (isBodyMethod && input !== undefined) {
      const encoded = await this.codec.encode(input);
      body = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
      contentType = this.codec.contentType;
    }

    const headers = HeaderMapLike.from(callOpts.headers);
    headers.set('accept', this.codec.contentType);
    if (contentType) headers.set('content-type', contentType);

    const req: ReqLike = {
      url,
      method: mapping.method,
      headers,
      body,
    };

    const res = await this.sendWithTimeout(req, callOpts);
    return this.handleResponse(res, mapping.meta === true);
  }

  private async resolveBase(path: string): Promise<string> {
    const { baseUrl, scheme } = this.options;
    if (this.discoverer) {
      const serviceName = this.options.serviceName ?? '';
      if (!serviceName) throw new Error('feign: serviceName is required when discoverer is set');
      const list = await this.discoverer(serviceName);
      if (list.length === 0) throw new Error(`feign: no instance for service ${serviceName}`);
      const inst = this.balancer.pick(list);
      const proto = (scheme ?? 'http').replace(/^(\w+):\/\/$/, '$1');
      return `${proto}://${joinHostPort(inst.host, inst.port)}`;
    }
    if (!baseUrl) throw new Error('feign: neither discoverer nor baseUrl is configured');
    return baseUrl.replace(/\/+$/, '');
  }

  private async sendWithTimeout(req: ReqLike, callOpts: CallOptions): Promise<ResLike> {
    const timeout = callOpts.timeoutMs ?? this.options.timeoutMs ?? 0;
    const controller = callOpts.signal ? undefined : new AbortController();
    let timer: NodeJS.Timeout | undefined;
    if (timeout > 0) {
      timer = setTimeout(() => controller?.abort(new Error(`feign: request timeout after ${timeout}ms`)), timeout);
    }

    const base: Send = async (r) => {
      const init = {
        method: r.method,
        headers: headerRecord(r.headers),
        body: r.body ? decodeText(new Uint8Array(r.body)) : null,
        signal: callOpts.signal ?? controller?.signal,
      };
      const resp = await this.fetchFn(r.url, init);
      const buf = await resp.arrayBuffer();
      return {
        status: resp.status,
        statusText: resp.statusText,
        headers: headerMapFromFetch(resp),
        body: new Uint8Array(buf),
      };
    };

    try {
      const finalSend = this.options.transport ? (r: ReqLike) => this.options.transport!(r, base) : base;
      return await finalSend(req);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleResponse(res: ResLike, meta: boolean) {
    const metaObj = {
      statusCode: res.status,
      status: res.statusText,
      headers: headerRecord(res.headers),
    };
    if (res.status >= 400) {
      if (this.options.decodeError) {
        const custom = this.options.decodeError(res) as Error | null | undefined;
        if (custom) throw custom;
      }
      throw new HTTPError(
        res.status,
        res.statusText,
        metaObj.headers,
        res.body,
        decodeErrorMessage(res.body) ?? undefined,
      );
    }
    let result: unknown;
    if (res.status === 204 || res.body.length === 0) {
      result = undefined;
    } else {
      result = await this.codec.decode(res.body);
    }
    return meta ? (({ result, meta: metaObj }) as unknown as MetaResult<unknown>) : result;
  }
}

/** headers 工具 */
const HeaderMapLike = {
  from(init?: Record<string, string> | null): HeadersLike {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(init ?? {})) {
      if (v !== undefined) m.set(k.toLowerCase(), v);
    }
    return {
      get(name: string) {
        return m.get(name.toLowerCase()) ?? null;
      },
      set(name: string, value: string) {
        m.set(name.toLowerCase(), value);
      },
      has(name: string) {
        return m.has(name.toLowerCase());
      },
      entries() {
        return Array.from(m.entries());
      },
    };
  },
};

function headerRecord(h: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

/** 将 fetch 响应头包装为 HeadersLike（尽量枚举） */
function headerMapFromFetch(resp: FetchResponseLike): HeadersLike {
  const m = new Map<string, string>();
  const h = resp.headers as unknown as {
    forEach?(cb: (v: string, k: string) => void): void;
    entries?(): Iterable<[string, string]>;
    get(name: string): string | null;
  };
  if (h && typeof h.forEach === 'function') {
    h.forEach((v, k) => m.set(k.toLowerCase(), v));
  } else if (h && typeof h.entries === 'function') {
    for (const [k, v] of h.entries()) m.set(k.toLowerCase(), v);
  }
  return {
    get(name: string) {
      const hit = m.get(name.toLowerCase());
      if (hit !== undefined) return hit;
      return h.get ? h.get(name) : null;
    },
    set(name: string, value: string) {
      m.set(name.toLowerCase(), value);
    },
    has(name: string) {
      return m.has(name.toLowerCase()) || (h.get ? h.get(name) !== null : false);
    },
    entries() {
      return Array.from(m.entries());
    },
  };
}