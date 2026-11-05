/**
 * @flovven/web-client
 * 声明式 HTTP 客户端（对齐 bufgot/web/client 的 feign/balancer/sign）。
 */
export {
  createClient,
  FeignClient,
  type FeignClientOptions,
  type CallOptions,
} from './client.js';
export { defaultBalancer, RoundRobin, FirstBalancer, RandomBalancer, WeightedRandom, type Balancer } from './balancer.js';
export { JSONCodec, TextCodec, BytesCodec, type Codec } from './codec.js';
export { HTTPError, decodeErrorMessage } from './errors.js';
export { parseMapping, applyPathParams, collectQuery, buildUrl, type MappingInput, type MethodMapping } from './mapping.js';
export {
  createSignTransport,
  createResponseVerifyTransport,
  createDynamicSignTransport,
  createDynamicResponseVerifyTransport,
  ClientSignStore,
  createClientSignStore,
  signPayload,
  type ClientSignOptions,
  type ClientSignConfig,
  type ClientSignSnapshot,
  type SignKey,
  type SignConfigSource,
  type SignConfigProvider,
  type ResponseVerifyOptions,
  type SignMethod,
} from './sign.js';
export type {
  DiscovererLike,
  Instance,
  InstanceLike,
  RespMeta,
  HeadersLike,
  ReqLike,
  ResLike,
  Send,
  Transport,
  FetchLike,
  FetchResponseLike,
  MetaResult,
} from './types.js';