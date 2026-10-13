# @gyre/web

> Node.js 统一 Web 框架垫片层（TypeScript）
>
> 一次编写业务代码，自由切换 hono / fastify / elysia / koa2。

`@gyre/web` 是 gyre GitHub 组织（Node.js 版 bufgot 生态）的 Web 层基础库，定位与 Go 版 `bufgot/web` 一致：在业务代码与具体 Web 框架之间加一层**薄适配垫片**，让路由、中间件、上下文以统一抽象暴露，底层框架可随时替换。

## 设计思路

### 1. 三层结构：业务 → 垫片层 → 框架

```
┌─────────────────────────────────────────────┐
│  业务代码（只依赖 @gyre/web-core）            │
│  WebApp.get('/ping', handler)               │
├─────────────────────────────────────────────┤
│  垫片层：统一抽象（路由 / 中间件 / 上下文）    │
│  WebAdapter 接口                            │
├─────────────────────────────────────────────┤
│  适配包：@gyre/web-adapter-{hono,fastify,   │
│  elysia,koa}                                │
├─────────────────────────────────────────────┤
│  具体框架：hono / fastify / elysia / koa2   │
└─────────────────────────────────────────────┘
```

- **核心抽象包 `@gyre/web-core`**：只定义接口与门面，零运行时依赖。业务代码只面向它编程。
- **适配包 `@gyre/web-adapter-<framework>`**：每框架一个独立包，实现 `WebAdapter` 接口，把统一 API 桥接到框架原生能力。框架依赖以 `peerDependencies` 声明（可选），未安装时适配器仅提供骨架（TODO 桩）。

### 2. 核心接口

| 抽象 | 文件 | 职责 |
| --- | --- | --- |
| `WebContext` | `packages/core/src/context.ts` | 统一请求/响应视图：method、path、params、query、headers、body，及 `json/text/html/send` 输出 |
| `WebRoute` / `WebRouter` | `packages/core/src/router.ts` | 统一路由描述与方法链（get/post/put/patch/delete） |
| `WebMiddleware` | `packages/core/src/middleware.ts` | 统一中间件签名 `(ctx, next) => Promise<void>`，洋葱模型 |
| `WebAdapter` | `packages/core/src/adapter.ts` | 框架适配器接口：`create` / `registerRoute` / `useMiddleware` / `listen`，`toContext` 按需可选 |
| `WebApp` | `packages/core/src/app.ts` | 业务编程门面：注册路由与中间件，`listen` 启动，切换适配器即切换框架 |

设计取舍：

- **薄适配**：适配器只要求「注册路由、挂中间件、启动服务」三项必做，上下文转换按需可选，避免对框架能力过度抽象而沦为「又一个框架」。
- **框架原生能力可透传**：`AdapterOptions` 透传框架原生配置，需要框架特有能力时可通过适配包暴露的 `nativeApp` 逃生口直连，垫片层不设限。
- **上下文一致性**：`WebContext` 基于 Web 标准（`Headers` 等）建模，hono 天然对齐；fastify / elysia / koa2 通过 `toContext` 包装。

### 3. 适配包组织

```
packages/
├── core/                  # @gyre/web-core 统一抽象（零依赖）
├── adapter-hono/          # @gyre/web-adapter-hono
├── adapter-fastify/       # @gyre/web-adapter-fastify
├── adapter-elysia/        # @gyre/web-adapter-elysia
└── adapter-koa/           # @gyre/web-adapter-koa
```

npm workspace 管理，各包独立构建（`tsc` 项目引用），根 `package.json` 一键 build / typecheck。

## 快速开始

```bash
npm install          # 安装 typescript 等开发依赖
npm run typecheck    # 全量类型检查（含 5 个子包）
npm run build        # 构建全部子包
```

### 用法示例（安装 hono 依赖并启用桥接后）

```ts
import { WebApp } from '@gyre/web-core';
import { HonoAdapter } from '@gyre/web-adapter-hono';

const app = new WebApp(new HonoAdapter());

app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.path}`);
  await next();
});

app.get('/ping', async (ctx) => {
  await ctx.json({ ok: true });
});

app.listen({ port: 3000 });
// 切换框架：把 HonoAdapter 换成 FastifyAdapter / ElysiaAdapter / KoaAdapter 即可
```

## 目录结构

```
web/
├── package.json            # workspace 根
├── tsconfig.json           # 项目引用（build 模式）
├── tsconfig.base.json      # 公共编译配置
├── tsconfig.build.json     # 纯检查配置
├── .gitignore
├── README.md
└── packages/
    ├── core/src/           # context / router / middleware / adapter / app / types
    ├── adapter-hono/src/
    ├── adapter-fastify/src/
    ├── adapter-elysia/src/
    └── adapter-koa/src/
```

## Roadmap

- [x] 项目骨架与统一抽象接口
- [ ] 安装各框架依赖，完成 4 个适配器真实桥接
- [ ] `toContext` 统一上下文转换器（fastify / elysia / koa2）
- [ ] 框架切换的集成测试矩阵
- [ ] 与 gyre 生态其它基础库（log / config / sign 等）对齐

## 许可证

待补充（License TBD）。
