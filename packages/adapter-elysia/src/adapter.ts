/**
 * elysia 适配器 —— @gyre/web-adapter-elysia
 *
 * 桥接说明（骨架阶段，安装 elysia 依赖后启用真实桥接）：
 *  - import { Elysia } from 'elysia'，NativeApp 类型为 Elysia；
 *  - registerRoute: app.route(method, path, handler) 或 app.get/post/...；
 *  - useMiddleware: app.onBeforeHandle / app.derive 包装统一中间件；
 *  - elysia 使用 Bun 风格上下文，需通过 toContext 包装为统一 WebContext。
 */
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebMiddleware,
  WebRoute,
} from '@gyre/web-core';

/** elysia 原生应用类型（安装 elysia 后替换为 import('elysia').Elysia） */
export type NativeElysiaApp = unknown;

export class ElysiaAdapter implements WebAdapter<NativeElysiaApp> {
  readonly name = 'elysia';

  create(_options?: AdapterOptions): NativeElysiaApp {
    // TODO(adapter): return new Elysia(options);
    throw new Error('ElysiaAdapter.create 未实现：请先安装 elysia 依赖后启用桥接');
  }

  registerRoute(_app: NativeElysiaApp, _route: WebRoute): void {
    // TODO(adapter): app.route(method, path, async (handler) => { ... })
  }

  useMiddleware(_app: NativeElysiaApp, _middleware: WebMiddleware): void {
    // TODO(adapter): app.onBeforeHandle(async (ctx) => { ... })
  }

  async listen(_app: NativeElysiaApp, _options: ListenOptions): Promise<void> {
    // TODO(adapter): await app.listen(port)
  }
}
