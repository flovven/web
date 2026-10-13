/**
 * fastify 适配器 —— @gyre/web-adapter-fastify
 *
 * 桥接说明（骨架阶段，安装 fastify 依赖后启用真实桥接）：
 *  - import Fastify from 'fastify'，NativeApp 类型为 FastifyInstance；
 *  - registerRoute: app.route({ method, url, handler })；
 *  - useMiddleware: app.addHook('preHandler', mw) 或 app.use()；
 *  - fastify 的 request/reply 需通过 toContext 包装为统一 WebContext。
 */
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebMiddleware,
  WebRoute,
} from '@gyre/web-core';

/** fastify 原生应用类型（安装 fastify 后替换为 import('fastify').FastifyInstance） */
export type NativeFastifyApp = unknown;

export class FastifyAdapter implements WebAdapter<NativeFastifyApp> {
  readonly name = 'fastify';

  create(_options?: AdapterOptions): NativeFastifyApp {
    // TODO(adapter): return Fastify(options);
    throw new Error('FastifyAdapter.create 未实现：请先安装 fastify 依赖后启用桥接');
  }

  registerRoute(_app: NativeFastifyApp, _route: WebRoute): void {
    // TODO(adapter): app.route({ method, url, handler: async (req, reply) => { ... } })
  }

  useMiddleware(_app: NativeFastifyApp, _middleware: WebMiddleware): void {
    // TODO(adapter): app.addHook('preHandler', async (req, reply) => { ... })
  }

  async listen(_app: NativeFastifyApp, _options: ListenOptions): Promise<void> {
    // TODO(adapter): await app.listen({ port, host })
  }
}
