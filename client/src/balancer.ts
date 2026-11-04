/**
 * 负载均衡器（对齐 Go feign.Balancer：RoundRobin / First / Random）。
 * 额外支持基于实例 weight 的加权随机。
 */
import type { Instance } from './types.js';

export interface Balancer {
  pick(instances: readonly Instance[]): Instance;
}

/** 默认轮询 */
export class RoundRobin implements Balancer {
  private counter = 0;

  pick(instances: readonly Instance[]): Instance {
    if (instances.length === 0) {
      throw new Error('feign: no instances to pick');
    }
    if (instances.length === 1) return instances[0];
    const idx = this.counter++ % instances.length;
    return instances[idx];
  }
}

/** 固定取第一个（确定性兜底） */
export class FirstBalancer implements Balancer {
  pick(instances: readonly Instance[]): Instance {
    if (instances.length === 0) {
      throw new Error('feign: no instances to pick');
    }
    return instances[0];
  }
}

/** 均匀随机 */
export class RandomBalancer implements Balancer {
  pick(instances: readonly Instance[]): Instance {
    if (instances.length === 0) {
      throw new Error('feign: no instances to pick');
    }
    return instances[Math.floor(Math.random() * instances.length)];
  }
}

/** 加权随机：按实例 weight 成正比选择（weight 缺省视为 1） */
export class WeightedRandom implements Balancer {
  pick(instances: readonly Instance[]): Instance {
    if (instances.length === 0) {
      throw new Error('feign: no instances to pick');
    }
    const weights = instances.map((inst) => {
      const w =
        inst && typeof (inst as { raw?: unknown }).raw === 'object'
          ? Number((inst.raw as { weight?: number })?.weight ?? 1)
          : 1;
      return Number.isFinite(w) && w > 0 ? w : 1;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < instances.length; i++) {
      r -= weights[i];
      if (r <= 0) return instances[i];
    }
    return instances[instances.length - 1];
  }
}

/** 构造默认 balancer（对齐 Go：RoundRobin） */
export function defaultBalancer(): Balancer {
  return new RoundRobin();
}