/**
 * 统一上下文 —— @flovven/web-core
 *
 * WebContext 是垫片层面向业务代码的唯一上下文抽象：
 * 路由处理器与中间件通过它读写请求与响应，不感知底层框架差异。
 */
import type { HttpMethod, JsonValue, QueryParams, RouteParams } from './types.js';

/** 统一请求视图 */
export interface WebRequestLike {
  readonly method: HttpMethod;
  readonly url: string;
  readonly path: string;
  readonly headers: Headers;
  readonly query: QueryParams;
  readonly params: RouteParams;
  readonly body: () => Promise<unknown>;
  /**
   * 原始请求体文本（签名/校验等场景需要原始字节语义）。
   * 由适配器能力决定：hono/elysia 原生支持，fastify 经 preParsing 预读，
   * koa 依赖 koa-bodyparser 的 rawBody。能力缺失时返回 undefined。
   */
  readonly rawBody?: () => Promise<string | undefined>;
}

/** 统一响应视图 */
export interface WebResponseLike {
  statusCode: number;
  headers: Headers;
  body: unknown;
}

/** 统一上下文（请求 + 响应） */
export interface WebContext {
  readonly request: WebRequestLike;
  readonly response: WebResponseLike;
  /** 设置响应状态码 */
  setStatus(status: number): this;
  /** 设置响应头 */
  setHeader(name: string, value: string): this;
  /** 输出 JSON */
  json(data: JsonValue): Promise<void>;
  /** 输出纯文本 */
  text(data: string): Promise<void>;
  /** 输出 HTML */
  html(data: string): Promise<void>;
  /** 通用输出（由适配器决定序列化方式） */
  send(data: unknown): Promise<void>;
}
