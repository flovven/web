/**
 * elysia 适配器 —— @flovven/web-adapter-elysia
 *
 * 将统一 WebAdapter 接口桥接到 elysia：
 *  - create: new Elysia(options)
 *  - registerRoute: app.route({ method, path, handler })，统一 handler 转换为 elysia 的返回值输出
 *  - useMiddleware: app.onBeforeHandle(mw)，elysia 前置钩子桥接统一中间件
 *  - listen: app.listen({ port, hostname })
 *  - toContext: 将 elysia 的上下文（Context）包装为统一 WebContext
 */
import { createServer } from 'node:http';

/** 读取 Node IncomingMessage 的原始 body */
function readBody(req: import('node:http').IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}
import { Elysia, type Context } from 'elysia';
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebContext,
  WebMiddleware,
  WebRoute,
} from '@flovven/web-core';

/** elysia 原生应用类型 */
export type NativeElysiaApp = Elysia;

/** 供 toContext 使用的 elysia 原生 Context 类型 */
export type NativeElysiaContext = Context;

export class ElysiaAdapter implements WebAdapter<NativeElysiaApp> {
  readonly name = 'elysia';

  create(options?: AdapterOptions): NativeElysiaApp {
    const app = new Elysia((options ?? {}) as never);
    // elysia 在请求链路中可能自行消费 request body（handler 无 body 推断时
    // 不消费，有推断时消费）。若 onRequest 直接读 c.request.text()，会消费
    // 原始 body，导致 elysia 后续解析 body 失败（ParseError -> 400）。这里
    // 用 clone 预读副本缓存到 c.set，原始 body 留给 elysia 自己消费；
    // 统一中间件（验签）与 handler 的 rawBody/body 均从该缓存恢复。
    app.onRequest(async (c) => {
      const set = c.set as unknown as Record<string, unknown>;
      const clone = c.request.clone();
      set['__flovven_raw_body'] = await clone.text();
    });
    return app;
  }

  registerRoute(app: NativeElysiaApp, route: WebRoute): void {
    const handler = route.handler;
    const routeMiddlewares = route.middlewares ?? [];
    const method = route.method.toLowerCase() as Lowercase<WebRoute['method']>;
    const wrapped = async (c: NativeElysiaContext) => {
      const ctx = this.buildContext(c);
      for (const mw of routeMiddlewares) {
        await mw(ctx, async () => {});
      }
      await handler(ctx);
      return this.toElysiaResponse(c, ctx);
    };
    (app as unknown as Record<string, (path: string, ...handlers: unknown[]) => Elysia>)[method]?.(route.path, wrapped);
  }

  useMiddleware(app: NativeElysiaApp, middleware: WebMiddleware): void {
    // 响应阶段中间件（如响应签名）：elysia 的 onBeforeHandle 在 handler 之前
    // 执行，无法读到响应体，注册到 onAfterHandle（handler 已执行、可读响应）。
    const responseStage = middleware.responseStage;
    if (responseStage) {
      app.onAfterHandle(async (c: NativeElysiaContext) => {
        const ctx = this.buildContext(c);
        await responseStage(ctx);
        for (const [k, v] of ctx.response.headers.entries()) {
          (c.set.headers as Record<string, string>)[k] = v;
        }
      });
      return;
    }
    app.onBeforeHandle(async (c: NativeElysiaContext) => {
      const ctx = this.buildContext(c);
      await middleware(ctx, async () => {});
      for (const [k, v] of ctx.response.headers.entries()) {
        (c.set.headers as Record<string, string>)[k] = v;
      }
      if (ctx.response.body !== undefined) {
        c.set.status = ctx.response.statusCode as never;
        return ctx.response.body;
      }
      c.set.status = ctx.response.statusCode as never;
    });
  }

  async listen(app: NativeElysiaApp, options: ListenOptions): Promise<void> {
    // elysia 的 WebStandard adapter 不支持 listen，用 Node http server 桥接 app.fetch
    await new Promise<void>((resolve) => {
      const server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
          const headers = new Headers(req.headers as Record<string, string>);
          const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
          const resp = await app.fetch(new Request(url, { method: req.method, headers, body }));
          res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()));
          const buf = Buffer.from(await resp.arrayBuffer());
          res.end(buf);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
      server.listen(options.port, options.host ?? '0.0.0.0', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : options.port;
        const host = typeof addr === 'object' && addr ? addr.address : (options.host ?? '0.0.0.0');
        options.onListen?.({ port, host: String(host) });
        resolve();
      });
    });
  }

  /**
   * 按请求共享的响应状态：elysia 的 onBeforeHandle / onAfterHandle / 路由
   * handler 各自 buildContext 会得到多个 WebContext，只有共享
   * statusCode/headers/body 才能让 onAfterHandle 响应签名读到 handler 写入
   * 的响应体。共享状态挂在 c.set 上（请求级对象，c.store 为全局共享不可用）。
   */
  private responseState(c: NativeElysiaContext): { code: number; headers: Headers; body: unknown } {
    const KEY = '__flovven_response_state__';
    const set = c.set as unknown as Record<string, unknown>;
    let st = set[KEY] as { code: number; headers: Headers; body: unknown } | undefined;
    if (!st) {
      st = {
        code: typeof c.set.status === 'number' ? (c.set.status as number) || 200 : 200,
        headers: new Headers(),
        body: undefined,
      };
      set[KEY] = st;
    }
    return st;
  }

  /** 将 elysia 原生 Context 包装为统一 WebContext */
  private buildContext(c: NativeElysiaContext): WebContext {
    const st = this.responseState(c);
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
    // 原生 Request.body 只可消费一次：优先读 onRequest 预读缓存（c.set），
    // 避免触碰已被 elysia 消费的 request body；缓存缺失时兜底直接读 text()。
    let rawBody: string | undefined;
    const readRawBody = async (): Promise<string | undefined> => {
      if (rawBody !== undefined) return rawBody;
      const cached = (c.set as unknown as Record<string, unknown>)['__flovven_raw_body'];
      if (typeof cached === 'string') {
        rawBody = cached;
        return rawBody;
      }
      const text = await c.request.text();
      rawBody = text;
      return text;
    };
    const ctx: WebContext = {
      request: {
        method: (c.request.method ?? 'GET').toUpperCase() as WebContext['request']['method'],
        url: c.request.url,
        path: new URL(c.request.url).pathname,
        headers: c.request.headers,
        query: c.query as WebContext['request']['query'],
        params: (c.params ?? {}) as WebContext['request']['params'],
        body: async () => {
          const text = await readRawBody();
          return text ? JSON.parse(text) : undefined;
        },
        rawBody: readRawBody,
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

  /** 将统一 WebContext 的响应结果转为 elysia 的返回值输出 */
  private toElysiaResponse(c: NativeElysiaContext, ctx: WebContext): unknown {
    c.set.status = ctx.response.statusCode as never;
    for (const [k, v] of ctx.response.headers.entries()) {
      (c.set.headers as Record<string, string>)[k] = v;
    }
    return ctx.response.body;
  }
}
