/**
 * 非 2xx 响应的统一错误类型（对齐 Go feign.HTTPError）。
 */
export class HTTPError extends Error {
  readonly statusCode: number;
  readonly status: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;

  constructor(
    statusCode: number,
    status: string,
    headers: Record<string, string>,
    body: Uint8Array,
    message?: string,
  ) {
    const msg = message ?? decodeErrorMessage(body) ?? status;
    super(`feign: unexpected status ${statusCode} ${status}: ${msg}`);
    this.name = 'HTTPError';
    this.statusCode = statusCode;
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/** 从错误响应体尽力提取可读 message：优先 {"message"|"error"|"msg"|"detail"} */
export function decodeErrorMessage(body: Uint8Array): string | null {
  if (body.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  for (const key of ['message', 'error', 'msg', 'detail']) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}