/**
 * 编解码器（对齐 Go feign.Codec）。
 */
import { encodeText, decodeText } from './text.js';

export interface Codec {
  /** 用于请求 Content-Type 与响应 Accept */
  readonly contentType: string;
  /** 编码请求体 */
  encode(value: unknown): Uint8Array | Promise<Uint8Array>;
  /** 解码响应体为最终结果 */
  decode(bytes: Uint8Array): unknown | Promise<unknown>;
}

/** 默认 JSON 编解码器 */
export const JSONCodec: Codec = {
  contentType: 'application/json',
  encode(value: unknown): Uint8Array {
    return encodeText(JSON.stringify(value ?? null));
  },
  decode(bytes: Uint8Array): unknown {
    const text = decodeText(bytes);
    return text.length === 0 ? undefined : JSON.parse(text);
  },
};

/** 原样文本编解码器 */
export const TextCodec: Codec = {
  contentType: 'text/plain',
  encode(value: unknown): Uint8Array {
    return encodeText(typeof value === 'string' ? value : String(value));
  },
  decode(bytes: Uint8Array): unknown {
    return decodeText(bytes);
  },
};

/** 字节流编解码器（直接透传 Uint8Array） */
export const BytesCodec: Codec = {
  contentType: 'application/octet-stream',
  encode(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    throw new Error('feign: BytesCodec expects Uint8Array');
  },
  decode(bytes: Uint8Array): unknown {
    return bytes;
  },
};