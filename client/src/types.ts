/**
 * @flovven/web-client 核心类型定义。
 *
 * 鸭子类型设计（对齐 bufgot/client/feign）：不强制依赖 @flovven/discovery，
 * 只要传入对象具备 `resolve(serviceName)` 形状即可直接作为 discoverer 使用。
 */

/** 上游实例（client 内部统一形态） */
export interface Instance {
  /** 注册中心实例 ID（可选） */
  id?: string;
  /** 主机地址（IPv4 / IPv6 / 主机名） */
  host: string;
  /** 监听端口 */
  port: number;
  /** 完整 metadata 引用（保留 discovery 返回的额外信息） */
  raw?: unknown;
}

/** 与 discovery 返回的 ResolvedInstance / ServiceInstance 形状兼容的最小结构 */
export interface InstanceLike {
  id?: string;
  ip: string;
  port: number;
  metadata?: Record<string, string>;
  weight?: number;
  healthy?: boolean;
}

/** 解析函数形态：直接传入 discovery.resolve（已 bind 或箭头函数包裹） */
export type ResolveFn = (
  serviceName: string,
) => Promise<readonly InstanceLike[] | null | undefined>;

/** 发现器对象形态：直接传入 @flovven/discovery 的 ServiceDiscovery 实现 */
export interface DiscovererObject {
  resolve(serviceName: string): Promise<readonly InstanceLike[] | null | undefined>;
}

/** 兼容接受两种形态 */
export type DiscovererLike = DiscovererObject | ResolveFn;

/** 响应元信息（对齐 Go feign.RespMeta） */
export interface RespMeta {
  statusCode: number;
  status: string;
  headers: Record<string, string>;
}

/** 带元信息的结果包装：mapping 配置 `meta: true` 时返回 */
export interface MetaResult<T> {
  data: T;
  meta: RespMeta;
}

/** 小写归一化的大写安全 Header 集合 */
export interface HeadersLike {
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  /** 已归一化的键值对列表 */
  entries(): ReadonlyArray<readonly [string, string]>;
}

/** 内部请求对象（transport 链上传递） */
export interface ReqLike {
  url: string;
  method: string;
  headers: HeadersLike;
  /** 请求体原始字节，无体为 null */
  body: Uint8Array | null;
}

/** 内部响应对象（transport 链返回） */
export interface ResLike {
  status: number;
  statusText: string;
  headers: HeadersLike;
  /** 响应体原始字节 */
  body: Uint8Array;
}

/** 底层发送函数（最内层由 fetch 实现） */
export type Send = (req: ReqLike) => Promise<ResLike>;

/** 传输中间件：签名、日志、重试等均可包装在 Send 链上 */
export type Transport = (req: ReqLike, next: Send) => Promise<ResLike>;

/** 可注入的 fetch 实现（用于测试或自定义 agent） */
export interface FetchLike {
  (input: string, init: FetchInitLike): Promise<FetchResponseLike>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** 生成随机 nonce（与 bufgot 对齐：字母数字、默认 16 位） */
export function generateNonce(length = 16): string {
  const charset =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const out = new Array<string>(length);
  for (let i = 0; i < length; i++) {
    out[i] = charset[Math.floor(Math.random() * charset.length)];
  }
  return out.join('');
}

/** 默认 Header 实现：key 大小写不敏感 */
export class HeaderMap implements HeadersLike {
  private m = new Map<string, string>();

  static from(init?: Record<string, string> | HeadersLike | null): HeaderMap {
    const h = new HeaderMap();
    if (!init) return h;
    if (init instanceof HeaderMap) {
      for (const [k, v] of init.entries()) h.set(k, v);
    } else if (typeof (init as HeadersLike).entries === 'function') {
      for (const [k, v] of (init as HeadersLike).entries()) h.set(k, v);
    } else {
      for (const [k, v] of Object.entries(init as Record<string, string>)) {
        if (v !== undefined) h.set(k, v);
      }
    }
    return h;
  }

  get(name: string): string | null {
    return this.m.get(name.toLowerCase()) ?? null;
  }

  set(name: string, value: string): void {
    this.m.set(name.toLowerCase(), value);
  }

  has(name: string): boolean {
    return this.m.has(name.toLowerCase());
  }

  entries(): ReadonlyArray<readonly [string, string]> {
    return Array.from(this.m.entries());
  }

  toRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.m) out[k] = v;
    return out;
  }
}

/** 构造一个 ReqLike 的便捷函数（内部使用） */
export function newReq(
  url: string,
  method: string,
  headers?: HeadersLike | Record<string, string> | null,
  body?: Uint8Array | null,
): ReqLike {
  return {
    url,
    method,
    headers: HeaderMap.from(headers ?? undefined),
    body: body ?? null,
  };
}