/**
 * 属性测试脚手架（D14）：不引 fast-check，去掉一个依赖面。
 *
 * 为什么自写：仓库的测试栈是 vitest + 零额外运行时依赖；v5.4-P1 的 A33–A40 要求的是
 * 「输入域上找反例、失败时能复现」，不是完整的 shrinking 引擎。这里给确定性种子 +
 * 失败时打印 seed/用例，复现方式写在错误信息里。
 */

export interface Rnd {
  next(): number;
  int(min: number, max: number): number;
  bool(): boolean;
  pick<T>(xs: readonly T[]): T;
}

export interface Gen<T> {
  readonly gen: (rnd: Rnd) => T;
}

/** mulberry32：32 位确定性 PRNG，同 seed 同序列 */
function makeRnd(seed: number): Rnd {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    bool: () => next() < 0.5,
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
  };
}

export const int = (min: number, max: number): Gen<number> => ({ gen: (r) => r.int(min, max) });
export const float = (min: number, max: number): Gen<number> => ({ gen: (r) => min + r.next() * (max - min) });
export const bool = (): Gen<boolean> => ({ gen: (r) => r.bool() });
export const constant = <T>(v: T): Gen<T> => ({ gen: () => v });
export const pick = <T>(xs: readonly T[]): Gen<T> => ({ gen: (r) => r.pick(xs) });
export const oneOf = <T>(...gs: readonly Gen<T>[]): Gen<T> => ({ gen: (r) => r.pick(gs).gen(r) });
export const arrayOf = <T>(g: Gen<T>, min = 0, max = 8): Gen<T[]> => ({
  gen: (r) => {
    const n = r.int(min, max);
    const out: T[] = [];
    for (let i = 0; i < n; i += 1) out.push(g.gen(r));
    return out;
  },
});
export const record = <T extends Record<string, unknown>>(shape: { [K in keyof T]: Gen<T[K]> }): Gen<T> => ({
  gen: (r) => {
    const out = {} as T;
    for (const k of Object.keys(shape) as (keyof T)[]) out[k] = shape[k].gen(r) as T[keyof T];
    return out;
  },
});

export interface ForAllOptions {
  /** 用例数，默认 100 */
  readonly runs?: number;
  /** 固定种子；默认 0x5eed，失败时把同一 seed 传回来即可复现 */
  readonly seed?: number;
  readonly label?: string;
}

/** 在输入域上找反例；抛错信息带 seed / 第几个用例 / 反例本体 */
export function forAll<T>(g: Gen<T>, body: (v: T, rnd: Rnd) => void, opts: ForAllOptions = {}): void {
  const runs = opts.runs ?? 100;
  const seed = opts.seed ?? 0x5eed;
  const label = opts.label ?? "forAll";
  for (let i = 0; i < runs; i += 1) {
    const rnd = makeRnd((seed + i * 0x9e3779b9) >>> 0);
    const value = g.gen(rnd);
    try {
      body(value, rnd);
    } catch (err) {
      const detail = (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
      throw new Error(
        `${label} 在第 ${i + 1}/${runs} 个用例失败（seed=${seed}）；复现：forAll(..., { seed: ${seed} })\n反例：${detail}\n原因：${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}
