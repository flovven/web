/**
 * hono 适配器 —— @gyre/web-adapter-hono
 *
 * 桥接说明（骨架阶段，安装 hono 依赖后启用真实桥接）：
 *  - import { Hono } from 'hono'，并放开下方 NativeApp 类型为 Hono；
 *  - registerRoute: app.on(route.method, route.path, handler)；
 *  - useMiddleware: 用 app.use('*', mw) 包装统一中间件；
 *  - hono 的 Context 与 Web API（Request/Response）天然对齐，
 *    可直接通过 toContext 或原生 ctx 双向转换。
 */
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebMiddleware,
  WebRoute,
} from '@gyre/web-core';

/** hono 原生应用类型（安装 hono 后替换为 import('hono').Hono） */
export type NativeHonoApp = unknown;

export class HonoAdapter implements WebAdapter<NativeHonoApp> {
  readonly name = 'hono';

  create(_options?: AdapterOptions): NativeHonoApp {
    // TODO(adapter): return new Hono();
    throw new Error('HonoAdapter.create 未实现：请先安装 hono 依赖后启用桥接');
  }

  registerRoute(_app: NativeHonoApp, _route: WebRoute): void {
    // TODO(adapter): app.on(route.method, route.path, async (c) => { ... })
  }

  useMiddleware(_app: NativeHonoApp, _middleware: WebMiddleware): void {
    // TODO(adapter): app.use('*', async (c, next) => { ... })
  }

  async listen(_app: NativeHonoApp, _options: ListenOptions): Promise<void> {
    // TODO(adapter): app.fire() / app.serve(options)
  }
}
