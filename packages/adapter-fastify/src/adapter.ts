/**
 * fastify 适配器 —— @flovven/web-adapter-fastify
 *
 * 将统一 WebAdapter 接口桥接到 fastify：
 *  - create: Fastify(options)
 *  - registerRoute: app.route({ method, url, handler })，统一 handler 转换为 fastify 的 reply 输出
 *  - useMiddleware: app.addHook('preHandler', mw)，fastify 钩子模型桥接统一中间件
 *  - listen: app.listen({ port, host })
 *  - toContext: 将 fastify 的 request/reply 包装为统一 WebContext
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type {
  WebAdapter,
  AdapterOptions,
  ListenOptions,
  WebContext,
  WebMiddleware,
  WebRoute,
} from '@flovven/web-core';

/** fastify 原生应用类型 */
export type NativeFastifyApp = FastifyInstance;

/** 供 toContext 使用的 fastify 原生请求类型 */
export type NativeFastifyRequest = import('fastify').FastifyRequest;
/** 供 toContext 使用的 fastify 原生回复类型 */
export type NativeFastifyReply = import('fastify').FastifyReply;

export class FastifyAdapter implements WebAdapter<NativeFastifyApp> {
  readonly name = 'fastify';

  private preParsingInstalled = false;

  /** 响应阶段（如响应签名）中间件收集器：只注册一个 onSend 钩子串行执行 */
  private responseMiddlewareInstalled = false;
  private responseStages: WebMiddleware[] = [];

  create(options?: AdapterOptions): NativeFastifyApp {
    return Fastify((options ?? {}) as never) as unknown as NativeFastifyApp;
  }

  registerRoute(app: NativeFastifyApp, route: WebRoute): void {
    const handler = route.handler;
    const routeMiddlewares = route.middlewares ?? [];
    app.route({
      method: route.method as never,
      url: route.path,
      handler: async (req: NativeFastifyRequest, reply: NativeFastifyReply) => {
        const ctx = this.buildContext(req, reply);
        for (const mw of routeMiddlewares) {
          await mw(ctx, async () => {});
        }
        await handler(ctx);
        this.respond(reply, ctx);
      },
    });
  }

  useMiddleware(app: NativeFastifyApp, middleware: WebMiddleware): void {
    // preParsing 预读原始 body 并缓存回 req，供 WebContext.rawBody 使用（不改写 fastify 自身 body 解析）
    if (!this.preParsingInstalled) {
      this.preParsingInstalled = true;
      app.addHook('preParsing', async (req: NativeFastifyRequest, _reply: NativeFastifyReply, payload) => {
        const chunks: Buffer[] = [];
        for await (const c of payload) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const buf = chunks.length ? Buffer.concat(chunks) : undefined;
        (req as unknown as { __rawBody?: string }).__rawBody = buf ? buf.toString('utf8') : '';
        // fastify 对「无 content-type 且带 body」的请求（如 client 签名请求只带 x-req-* 头）
        // 会在 preHandler 之前直接 415，导致统一中间件（验签等）无法拦截。
        // 此处补默认 JSON content-type，使 body 解析与统一语义（ctx.request.body() JSON）一致。
        if (buf && !req.headers['content-type']) {
          req.headers['content-type'] = 'application/json; charset=utf-8';
        }
        // 必须返回流（fastify body parser 需要可读流），用原 chunks 重建避免二次消费
        return Readable.from(chunks);
      });
    }

    // 响应阶段中间件（如响应签名）：fastify 的 preHandler 在 handler 之前执行，
    // 无法在洋葱回卷读到响应体，注册到 onSend（handler 已执行、payload 可读）。
    // 注意：onSend 钩子必须使用 next 回调风格且全局只注册一个——fastify 4.29 中
    // 多个 async onSend 钩子会触发钩子链被重复执行（第二次 payload=undefined，
    // 导致 ERR_HTTP_HEADERS_SENT）。所有响应阶段中间件收集后串行执行。
    const responseStage = middleware.responseStage;
    if (responseStage) {
      this.responseStages.push(middleware);
      if (!this.responseMiddlewareInstalled) {
        this.responseMiddlewareInstalled = true;
        app.addHook('onSend', (req: NativeFastifyRequest, reply: NativeFastifyReply, payload, done) => {
          void (async () => {
            const ctx = this.buildContext(req, reply);
            // payload 即最终发送字节（string/Buffer），签名基于实际传输内容
            const bodyStr =
              typeof payload === 'string'
                ? payload
                : Buffer.isBuffer(payload)
                  ? payload.toString('utf8')
                  : String(payload ?? '');
            if (bodyStr) {
              ctx.response.body = bodyStr;
            }
            for (const mw of this.responseStages) {
              const stage = mw.responseStage;
              if (stage) {
                await stage(ctx);
              }
            }
            for (const [k, v] of ctx.response.headers.entries()) {
              if (v !== undefined) {
                reply.header(k, v);
              }
            }
            done(null, payload);
          })().catch((err) => done(err as never, payload));
        });
      }
      return;
    }

    app.addHook('preHandler', async (req: NativeFastifyRequest, reply: NativeFastifyReply) => {
      const ctx = this.buildContext(req, reply);
      await middleware(ctx, async () => {});
      if (ctx.response.body !== undefined) {
        // 中间件直接产出响应（短路）
        this.respond(reply, ctx);
        return reply;
      }
      // 仅同步 status/headers 到 reply，等待路由 handler 最终响应
      reply.code(ctx.response.statusCode);
      for (const [k, v] of ctx.response.headers.entries()) {
        reply.header(k, v);
      }
    });
  }

  async listen(app: NativeFastifyApp, options: ListenOptions): Promise<void> {
    await app.listen({ port: options.port, host: options.host ?? '0.0.0.0' });
    if (options.onListen) {
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : options.port;
      const host = typeof addr === 'object' && addr ? addr.address : (options.host ?? '0.0.0.0');
      options.onListen({ port, host: String(host) });
    }
  }

  /**
   * 按请求共享的响应状态：fastify 的 preHandler / onSend / 路由 handler 各自
   * buildContext 会得到多个 WebContext，只有共享 statusCode/headers/body
   * 才能让 onSend 响应签名读到 handler 写入的响应体。
   * 共享状态挂在 reply 上（请求级唯一）。
   */
  private responseState(reply: NativeFastifyReply): { code: number; headers: Headers; body: unknown } {
    const KEY = '__flovven_response_state__';
    const target = reply as unknown as Record<string, unknown>;
    let st = target[KEY] as { code: number; headers: Headers; body: unknown } | undefined;
    if (!st) {
      st = { code: reply.raw.statusCode ?? 200, headers: new Headers(), body: undefined };
      target[KEY] = st;
    }
    return st;
  }

  /** 将 fastify 原生 request/reply 包装为统一 WebContext */
  private buildContext(req: NativeFastifyRequest, reply: NativeFastifyReply): WebContext {
    const st = this.responseState(reply);
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
    const ctx: WebContext = {
      request: {
        method: (req.method ?? 'GET').toUpperCase() as WebContext['request']['method'],
        url: req.url,
        path: req.url.split('?')[0],
        headers: new Headers(req.headers as Record<string, string>),
        query: req.query as WebContext['request']['query'],
        params: (req.params ?? {}) as WebContext['request']['params'],
        body: () => req.body as Promise<unknown>,
        rawBody: () => Promise.resolve((req as unknown as { __rawBody?: string }).__rawBody),
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

  /** 将统一 WebContext 的响应结果写回 fastify reply */
  private respond(reply: NativeFastifyReply, ctx: WebContext): void {
    reply.code(ctx.response.statusCode);
    for (const [k, v] of ctx.response.headers.entries()) {
      reply.header(k, v);
    }
    if (ctx.response.body !== undefined) {
      reply.send(ctx.response.body);
      return;
    }
    reply.send();
  }
}
