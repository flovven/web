/**
 * 统一中间件 —— @gyre/web-core
 *
 * 中间件与路由处理器共享同一 WebContext。
 * 调用 next() 进入下一层；不调用则短路返回（可作守卫/鉴权）。
 */
import type { WebContext } from './context.js';

/** 下一层处理函数 */
export type Next = () => Promise<void>;

/** 统一中间件签名：洋葱模型 */
export type WebMiddleware = (ctx: WebContext, next: Next) => Promise<void>;
