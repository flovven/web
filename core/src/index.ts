/**
 * @flovven/web-core —— gyre 统一 Web 框架垫片层核心抽象
 *
 * 设计要点：
 *  - 业务只面向 WebApp / WebContext / WebMiddleware 编程，不感知底层框架；
 *  - 切换框架 = 更换适配器（@flovven/web-adapter-<framework>），业务零改动；
 *  - 适配器接口刻意保持「薄」：只要求注册路由、挂中间件、启动服务三项，
 *    上下文转换按需可选（toContext），避免对框架能力做过度抽象。
 */
export * from './types.js';
export * from './context.js';
export * from './middleware.js';
export * from './middleware/sign.js';
export * from './router.js';
export * from './adapter.js';
export * from './app.js';
