/**
 * 统一中间件 —— @flovven/web-core
 *
 * 中间件与路由处理器共享同一 WebContext。
 * 调用 next() 进入下一层；不调用则短路返回（可作守卫/鉴权）。
 */
import type { WebContext } from './context.js';

/** 下一层处理函数 */
export type Next = () => Promise<void>;

/**
 * 统一中间件：洋葱模型
 *
 * 可选属性 `responseStage`：响应阶段钩子。部分框架（fastify onSend /
 * elysia onAfterHandle）不允许在洋葱回卷时读取响应体，适配器可利用
 * 该钩子在 handler 执行完毕、响应体可读的时机单独调用中间件的响应段。
 * 洋葱模型框架（hono/koa）无需该钩子，直接执行中间件主体。
 */
export interface WebMiddleware {
  (ctx: WebContext, next: Next): Promise<void>;
  /** 可选响应阶段钩子（handler 已执行、响应体可读时调用） */
  responseStage?: (ctx: WebContext) => Promise<void> | void;
}
