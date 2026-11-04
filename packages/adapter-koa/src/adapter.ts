/**
 * koa2 适配器 —— @flovven/web-adapter-koa
 *
 * 将统一 WebAdapter 接口桥接到 koa：
 *  - create: new Koa()，路由使用 @koa/router
 *  - registerRoute: router[method](path, handler)，统一 handler 转换为 koa 的 ctx 输出
 *  - useMiddleware: app.use(mw)，koa 洋葱模型与统一 WebMiddleware 天然一致
 *  - listen: app.listen(port)
 *  - toContext: 将 koa 的 ctx（ctx.request / ctx.response）包装为统一 WebContext
 */
import Koa from 'koa';
import Router from '@koa/router';
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebContext,
  WebMiddleware,
  WebRoute,
} from '@flovven/web-core';

/** koa 原生应用类型：Koa 实例 + 独立路由 */
export interface NativeKoaApp {
  app: Koa;
  router: Router;
}

/** 供 toContext 使用的 koa 原生 Context 类型 */
export type NativeKoaContext = Koa.ParameterizedContext;

export class KoaAdapter implements WebAdapter<NativeKoaApp> {
  readonly name = 'koa2';

  create(_options?: AdapterOptions): NativeKoaApp {
    const app = new Koa();
    const router = new Router();
    return { app, router };
  }

  registerRoute(app: NativeKoaApp, route: WebRoute): void {
    const handler = route.handler;
    const routeMiddlewares = route.middlewares ?? [];
    const method = route.method.toLowerCase() as Lowercase<WebRoute['method']>;
    const wrapped = async (c: NativeKoaContext) => {
      const ctx = this.buildContext(c);
      for (const mw of routeMiddlewares) {
        await mw(ctx, async () => {});
      }
      await handler(ctx);
      this.respond(c, ctx);
    };
    (app.router as unknown as Record<string, (path: string, ...mws: unknown[]) => Router>)[method]?.(route.path, wrapped);
  }

  useMiddleware(app: NativeKoaApp, middleware: WebMiddleware): void {
    app.app.use(async (c: NativeKoaContext, next) => {
      const ctx = this.buildContext(c);
      await middleware(ctx, next);
      // 洋葱回卷：统一将共享响应状态写回 koa（幂等，覆盖短路由与响应签名 head 的场景）
      this.respond(c, ctx);
    });
  }

  async listen(app: NativeKoaApp, options: ListenOptions): Promise<void> {
    app.app.use(app.router.routes()).use(app.router.allowedMethods());
    await new Promise<void>((resolve) => {
      const server = app.app.listen(options.port, options.host ?? '0.0.0.0', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : options.port;
        const host = typeof addr === 'object' && addr ? addr.address : (options.host ?? '0.0.0.0');
        options.onListen?.({ port, host: String(host) });
        resolve();
      });
    });
  }

  /**
   * 按请求共享的响应状态：koa 洋葱模型中 useMiddleware 与路由 handler 各自
   * buildContext 会得到多个 WebContext，只有共享 statusCode/headers/body
   * 才能让响应签名中间件（await next() 之后）读到 handler 写入的响应体。
   */
  private responseState(c: NativeKoaContext): { code: number; headers: Headers; body: unknown } {
    const KEY = '__flovven_response_state__';
    const state = c.state as Record<string, unknown>;
    let st = state[KEY] as { code: number; headers: Headers; body: unknown } | undefined;
    if (!st) {
      st = { code: 200, headers: new Headers(), body: undefined };
      state[KEY] = st;
    }
    return st;
  }

  /** 将 koa 原生 Context 包装为统一 WebContext */
  private buildContext(c: NativeKoaContext): WebContext {
    const st = this.responseState(c);
    // koa 未显式设置响应码时 ctx.status 为 404，统一按 200 兜底（幂等，仅在初始态生效）
    const koaStatus = c.response.status;
    if (koaStatus && koaStatus !== 404) {
      st.code = koaStatus;
    }
    const response = {
      get statusCode(): number {
        return st.code;
      },
      set statusCode(v: number) {
        st.code = v;
      },
      get headers(): Headers {
        return st.headers;
      },
      set headers(_v: Headers) {
        // headers 始终指向共享状态，忽略外部整体赋值
      },
      get body(): unknown {
        return st.body;
      },
      set body(v: unknown) {
        st.body = v;
      },
    };
    // 惰性读取原始请求体：koa 未装 body-parser 时原生流只能消费一次，
    // 首次读取后缓存到 c.request（请求级共享），后续 buildContext 复用
    const readRaw = async (): Promise<string> => {
      const existing = (c.request as unknown as { rawBody?: string }).rawBody;
      if (existing !== undefined) return existing;
      const parsed = (c.request as unknown as { body?: unknown }).body;
      if (parsed !== undefined) {
        // 已由 body-parser 解析：无法还原字节，回退 JSON 序列化（字符串原样）
        const s = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        return s ?? '';
      }
      const chunks: Buffer[] = [];
      for await (const ch of c.req as unknown as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
      }
      const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      (c.request as unknown as { rawBody?: string }).rawBody = text;
      return text;
    };
    const ctx: WebContext = {
      request: {
        method: (c.request.method ?? 'GET').toUpperCase() as WebContext['request']['method'],
        url: c.request.url,
        path: c.request.path,
        headers: new Headers(c.request.headers as Record<string, string>),
        query: (c.request.query ?? {}) as WebContext['request']['query'],
        params: (c.params ?? {}) as WebContext['request']['params'],
        body: async (): Promise<unknown> => {
          const raw = await readRaw();
          if (!raw) return undefined;
          const parsed = (c.request as unknown as { body?: unknown }).body;
          if (parsed !== undefined) return parsed;
          try {
            const obj: unknown = JSON.parse(raw);
            (c.request as unknown as { body?: unknown }).body = obj;
            return obj;
          } catch {
            (c.request as unknown as { body?: unknown }).body = raw;
            return raw;
          }
        },
        rawBody: (): Promise<string | undefined> => readRaw().then((s) => (s === '' ? undefined : s)),
      },
      response,
      setStatus(code) {
        response.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        response.headers.set(name, value);
        return this;
      },
      async json(data) {
        response.body = data;
      },
      async text(data) {
        response.body = data;
      },
      async html(data) {
        response.body = data;
      },
      async send(data) {
        response.body = data;
      },
    };
    return ctx;
  }

  /** 将统一 WebContext 的响应结果写回 koa ctx */
  private respond(c: NativeKoaContext, ctx: WebContext): void {
    c.response.status = ctx.response.statusCode;
    for (const [k, v] of ctx.response.headers.entries()) {
      c.response.set(k, v);
    }
    if (ctx.response.body !== undefined) {
      c.response.body = ctx.response.body;
    }
  }
}
