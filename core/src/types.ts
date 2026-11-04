/**
 * 基础类型定义 —— @flovven/web-core
 */

/** 支持的 HTTP 方法，ALL 表示匹配任意方法 */
export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'ALL';

/** 路径参数（路由模板中的 :id 等） */
export interface RouteParams {
  [key: string]: string | undefined;
}

/** 查询参数 */
export interface QueryParams {
  [key: string]: string | string[] | undefined;
}

/** JSON 可序列化值 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 监听选项 */
export interface ListenOptions {
  port: number;
  host?: string;
  onListen?: (addr: { port: number; host: string }) => void;
}
