/**
 * 统一应用门面 —— @gyre/web-core
 *
 * WebApp 是业务代码的唯一编程入口：
 *   1. 选择适配器（决定底层框架）
 *   2. 注册中间件与路由（统一 API）
 *   3. listen 启动
 * 切换底层框架只需替换适配器，业务代码零改动。
 */
import type { WebAdapter } from './adapter.js';
import type { WebContext } from './context.js';
import type { WebMiddleware } from './middleware.js';
import type { RouteHandler, WebRoute, WebRouter } from './router.js';
import type { HttpMethod, ListenOptions } from './types.js';

export class WebApp<NativeApp = unknown> implements WebRouter {
  private readonly routes: WebRoute[] = [];
  private readonly middlewares: WebMiddleware[] = [];
  private nativeApp: NativeApp | undefined;

  constructor(private readonly adapter: WebAdapter<NativeApp>) {}

  /** 注册全局中间件 */
  use(middleware: WebMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /** 注册统一路由 */
  route(route: WebRoute): this {
    this.routes.push(route);
    return this;
  }

  get(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): this {
    return this.route({ method: 'GET', path, handler, middlewares });
  }

  post(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): this {
    return this.route({ method: 'POST', path, handler, middlewares });
  }

  put(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): this {
    return this.route({ method: 'PUT', path, handler, middlewares });
  }

  patch(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): this {
    return this.route({ method: 'PATCH', path, handler, middlewares });
  }

  delete(path: string, handler: RouteHandler, middlewares?: WebMiddleware[]): this {
    return this.route({ method: 'DELETE', path, handler, middlewares });
  }

  /** 构建底层框架应用（惰性创建） */
  build(): NativeApp {
    if (this.nativeApp) {
      return this.nativeApp;
    }
    const app = this.adapter.create();
    for (const mw of this.middlewares) {
      this.adapter.useMiddleware(app, mw);
    }
    for (const r of this.routes) {
      this.adapter.registerRoute(app, r);
    }
    this.nativeApp = app;
    return app;
  }

  /** 启动服务 */
  async listen(options: ListenOptions): Promise<void> {
    const app = this.build();
    await this.adapter.listen(app, options);
  }

  /** 暴露适配器名（便于日志/诊断） */
  get adapterName(): string {
    return this.adapter.name;
  }

  /** 便捷引用：供业务代码标注依赖时使用 */
  static readonly contextSymbol: unique symbol = Symbol('gyre.web.context');
}

/** 业务侧可通过本类型引用统一上下文，避免硬依赖框架类型 */
export type { WebContext };
