/**
 * koa2 适配器 —— @gyre/web-adapter-koa
 *
 * 桥接说明（骨架阶段，安装 koa 依赖后启用真实桥接）：
 *  - import Koa from 'koa'; import Router from '@koa/router'；
 *  - NativeApp 类型为 { app: Koa; router: Router }（koa 路由需独立注册）；
 *  - registerRoute: router[method](path, handler)，最终 app.use(router.routes())；
 *  - useMiddleware: app.use(mw)（koa 中间件与洋葱模型天然一致）；
 *  - koa 的 ctx（ctx.request / ctx.response）通过 toContext 包装为统一 WebContext。
 */
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebMiddleware,
  WebRoute,
} from '@gyre/web-core';

/** koa 原生应用类型（安装 koa 依赖后替换为 import('koa').Koa） */
export type NativeKoaApp = unknown;

export class KoaAdapter implements WebAdapter<NativeKoaApp> {
  readonly name = 'koa2';

  create(_options?: AdapterOptions): NativeKoaApp {
    // TODO(adapter): const app = new Koa(options); const router = new Router(); return app;
    throw new Error('KoaAdapter.create 未实现：请先安装 koa 依赖后启用桥接');
  }

  registerRoute(_app: NativeKoaApp, _route: WebRoute): void {
    // TODO(adapter): router[route.method.toLowerCase()](route.path, handler)
  }

  useMiddleware(_app: NativeKoaApp, _middleware: WebMiddleware): void {
    // TODO(adapter): app.use(middleware)
  }

  async listen(_app: NativeKoaApp, _options: ListenOptions): Promise<void> {
    // TODO(adapter): await app.listen(port)
  }
}
