/**
 * hono 适配器 —— @flovven/web-adapter-hono
 *
 * 将统一 WebAdapter 接口桥接到 hono：
 *  - create: new Hono()
 *  - registerRoute: app.on(method, path, handler)，统一 handler 转换为 hono 原生 Context 响应
 *  - useMiddleware: app.use('*', mw)，hono 洋葱模型与统一 WebMiddleware 一致
 *  - listen: 通过 @hono/node-server 的 serve 启动
 *  - toContext: hono 的 Context 天然基于 Web API（Request/Response），直接映射
 */
import { Hono } from 'hono';
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebContext,
  WebMiddleware,
  WebRoute,
} from '@flovven/web-core';

/** hono 原生应用类型 */
export type NativeHonoApp = Hono;

/** 供 toContext 使用的 hono 原生 Context 类型 */
export type NativeHonoContext = import('hono').Context;

export class HonoAdapter implements WebAdapter<NativeHonoApp> {
  readonly name = 'hono';

  create(_options?: AdapterOptions): NativeHonoApp {
    return new Hono();
  }

  registerRoute(app: NativeHonoApp, route: WebRoute): void {
    const handler = route.handler;
    const routeMiddlewares = route.middlewares ?? [];
    const wrapped = async (c: NativeHonoContext) => {
      const ctx = this.toContext(c);
      for (const mw of routeMiddlewares) {
        await mw(ctx, async () => {});
      }
      await handler(ctx);
      return this.toHonoResponse(c, ctx);
    };
    app.on(route.method as never, route.path, wrapped);
  }

  useMiddleware(app: NativeHonoApp, middleware: WebMiddleware): void {
    app.use('*', async (c, next) => {
      const ctx = this.toContext(c);
      await middleware(ctx, next);
      return this.toHonoResponse(c, ctx);
    });
  }

  async listen(app: NativeHonoApp, options: ListenOptions): Promise<void> {
    const { serve } = await import('@hono/node-server');
    await new Promise<void>((resolve, reject) => {
      const server = serve(
        { fetch: app.fetch, port: options.port, hostname: options.host ?? '0.0.0.0' },
        (info) => {
          options.onListen?.({ port: info.port, host: info.address });
          resolve();
        },
      );
      server.on('error', reject);
    });
  }

  /** 将 hono 原生 Context 包装为统一 WebContext */
  toContext(raw: unknown): WebContext {
    const c = raw as NativeHonoContext;
    const st = this.responseState(c);
    const status = { code: st.code };
    const response = {
      get statusCode(): number {
        return st.code;
      },
      set statusCode(v: number) {
        st.code = v;
      },
      headers: c.res.headers,
      get body(): unknown {
        return st.body;
      },
      set body(v: unknown) {
        st.body = v;
      },
    };
    const ctx: WebContext = {
      request: {
        method: c.req.method.toUpperCase() as WebContext['request']['method'],
        url: c.req.url,
        path: c.req.path,
        headers: c.req.raw.headers,
        query: c.req.query(),
        params: c.req.param(),
        body: () => c.req.json(),
        rawBody: () => Promise.resolve(c.req.text()),
      },
      response,
      setStatus(code) {
        st.code = code;
        status.code = code;
        return this;
      },
      setHeader(name, value) {
        c.header(name, value);
        return this;
      },
      async json(data) {
        st.body = data;
      },
      async text(data) {
        st.body = data;
      },
      async html(data) {
        st.body = data;
      },
      async send(data) {
        st.body = data;
      },
    };
    return ctx;
  }

  /** 将统一 WebContext 的响应结果转为 hono 的 Response 输出 */
  private toHonoResponse(c: NativeHonoContext, ctx: WebContext): Response {
    if (ctx.response.body !== undefined) {
      return c.json(ctx.response.body, ctx.response.statusCode as never);
    }
    return c.body(null, ctx.response.statusCode as never);
  }

  /**
   * 按请求共享的响应状态：hono 中间件与路由各自 toContext 会得到多个
   * WebContext，只有共享 statusCode/body 才能让响应签名中间件读到 handler 写入的响应体。
   */
  private responseState(c: NativeHonoContext): { code: number; body: unknown } {
    const KEY = '__flovven_response_state__';
    let st = c.get(KEY as never) as { code: number; body: unknown } | undefined;
    if (!st) {
      st = { code: 200, body: undefined };
      c.set(KEY as never, st);
    }
    return st;
  }
}
