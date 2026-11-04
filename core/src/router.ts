/**
 * 统一路由 —— @flovven/web-core
 */
import type { WebContext } from './context.js';
import type { WebMiddleware } from './middleware.js';
import type { HttpMethod } from './types.js';

/** 路由处理器 */
export type RouteHandler = (ctx: WebContext) => Promise<void>;

/** 统一路由描述：适配器据此注册到底层框架 */
export interface WebRoute {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  middlewares?: WebMiddleware[];
}

/** 统一路由器（WebApp 实现本接口） */
export interface WebRouter {
  route(route: WebRoute): void;
  get(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): void;
  post(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): void;
  put(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): void;
  patch(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): void;
  delete(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): void;
}
