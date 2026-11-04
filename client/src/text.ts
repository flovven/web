/**
 * 文本编解码工具：Node 18+ 全局 TextEncoder/TextDecoder（避免依赖 DOM lib 类型）。
 */
type TextEncoderCtor = new () => { encode(s: string): Uint8Array };
type TextDecoderCtor = new () => { decode(b: Uint8Array): string };

const TE: TextEncoderCtor =
  (globalThis as { TextEncoder?: TextEncoderCtor }).TextEncoder ??
  class {
    encode(s: string): Uint8Array {
      return new Uint8Array(Buffer.from(s, 'utf8'));
    }
  };

const TD: TextDecoderCtor =
  (globalThis as { TextDecoder?: TextDecoderCtor }).TextDecoder ??
  class {
    decode(b: Uint8Array): string {
      return Buffer.from(b).toString('utf8');
    }
  };

export function encodeText(s: string): Uint8Array {
  return new TE().encode(s);
}

export function decodeText(bytes: Uint8Array): string {
  return new TD().decode(bytes);
}