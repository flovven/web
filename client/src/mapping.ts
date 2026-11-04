/**
 * 方法映射与路径参数 / query 参数解析（对齐 Go feign.mapping）。
 *
 * TS 无 struct tag，参数语义约定：
 * - mapping 中的 `{name}` 占位符优先从输入对象对应键取值并做 URL 编码；
 * - GET/HEAD：输入对象中剩余字段作为 query 参数；
 * - 非 GET/HEAD：整个输入对象作为请求体（由 codec 编码）。
 */
export interface MethodMapping {
  method: string;
  path: string;
  /** 为 true 时返回 { data, meta }，否则直接返回解码结果 */
  meta?: boolean;
}

export type MappingInput = string | MethodMapping;

/** 解析 "METHOD /path" 或对象形态的 mapping */
export function parseMapping(input: MappingInput): MethodMapping {
  if (typeof input === 'object' && input !== null) {
    const { method, path, meta } = input;
    return { method: method.toUpperCase(), path, meta: !!meta };
  }
  const fields = input.trim().split(/\s+/);
  if (fields.length !== 2) {
    throw new Error(
      `feign: invalid mapping ${JSON.stringify(input)}, want "METHOD /path"`,
    );
  }
  const method = fields[0].toUpperCase();
  const path = fields[1];
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error(`feign: unsupported HTTP method "${fields[0]}"`);
  }
  if (!path.startsWith('/')) {
    throw new Error(`feign: path ${path} must start with /`);
  }
  return { method, path, meta: false };
}

/** 从输入对象中提取 {name} 占位符对应值 */
export function pathParams(
  tmpl: string,
  input: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tmpl)) !== null) {
    const key = m[1];
    const v = input[key];
    if (v !== undefined && v !== null) {
      out[key] = String(v);
    }
  }
  return out;
}

/** 填充 path 占位符（未匹配的占位符原样保留） */
export function applyPathParams(
  tmpl: string,
  input: Record<string, unknown> | null | undefined,
): string {
  const params = extractParams(tmpl, input);
  return tmpl.replace(/\{([^}]+)\}/g, (whole, key: string) => {
    const v = params[key];
    return v === undefined ? whole : encodeURIComponent(v);
  });
}

function extractParams(
  tmpl: string,
  input: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tmpl)) !== null) {
    const key = m[1];
    const v = input[key];
    if (v !== undefined && v !== null) out[key] = String(v);
  }
  return out;
}

/** 取输入对象中未被 path 占位符消费的字段（GET/HEAD 作 query） */
export function collectQuery(
  tmpl: string,
  input: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const consumed = new Set(extractParams(tmpl, input) ? Object.keys(extractParams(tmpl, input)) : []);
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (consumed.has(k)) continue;
    if (typeof v === 'object') continue;
    out[k] = String(v);
  }
  return out;
}

/** 组装完整 URL（base 已去尾斜杠，path 已填占位符） */
export function buildUrl(base: string, path: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return base + path + (qs ? `?${qs}` : '');
}