/**
 * 统一适配器接口 —— @gyre/web-core
 *
 * WebAdapter 是垫片层的核心：每个 Web 框架（hono / fastify / elysia / koa2）
 * 对应一个独立适配包（@gyre/web-adapter-<framework>），实现本接口后将
 * 统一路由 / 中间件 / 上下文桥接到框架原生能力。
 */
import type { WebContext } from './context.js';
import type { WebMiddleware } from './middleware.js';
import type { WebRoute } from './router.js';
import type { ListenOptions } from './types.js';

/** 适配器创建选项（框架原生配置透传） */
export interface AdapterOptions {
  [key: string]: unknown;
}

/** 框架适配器 */
export interface WebAdapter<NativeApp = unknown> {
  /** 适配框架名，如 'hono' / 'fastify' / 'elysia' / 'koa2' */
  readonly name: string;

  /** 创建框架原生应用实例 */
  create(options?: AdapterOptions): NativeApp;

  /** 将统一路由注册到框架原生应用 */
  registerRoute(app: NativeApp, route: WebRoute): void;

  /** 将统一中间件挂载到框架原生应用 */
  useMiddleware(app: NativeApp, middleware: WebMiddleware): void;

  /** 启动 HTTP 服务 */
  listen(app: NativeApp, options: ListenOptions): Promise<void> | void;

  /**
   * 将框架原生请求对象包装为统一 WebContext。
   * 若框架原生上下文与 WebContext 形状差异较大，适配器需实现本方法；
   * 若框架已自带兼容上下文（如 hono 的 Context 与 Web API 对齐），可省略。
   */
  toContext?(raw: unknown): WebContext;
}
