/**
 * F301：动作包装（先刷新凭据 → 固定副作用 → 动作）搬进装配层。
 *
 * 锁四件事：
 * 1. 非函数项被丢掉（`createPortActions` 里可能有常量）；
 * 2. 顺序是 refreshModel → tick hooks → 动作，且每个动作都刷新凭据；
 * 3. 参数与返回值原样传递，抛错原样冒出（不能吞）；
 * 4. 只有心跳拍会跑固定副作用（名字不是 stateTick/tick 时 hooks 直接返回，
 *    这里用一个假的 tickHooks 依赖验证"传到 runTickHooks 的名字就是动作名"）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wrapActions, type ActionWrapperInput } from "../src/assembly/action-wrapper.js";
import type { TickHooksDeps } from "../src/assembly/tick-hooks.js";

const REPO = process.cwd();

function fakeHooks(overrides: Partial<TickHooksDeps> = {}): TickHooksDeps {
  return {
    dataDir: "C:/tmp/data",
    characterId: "assistant",
    repo: REPO,
    tzOffsetMinutes: 480,
    log: () => undefined,
    runtime: {} as never,
    drainQueue: async () => undefined,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ActionWrapperInput> = {}): ActionWrapperInput {
  return {
    actions: {},
    refreshModel: async () => undefined,
    tickHooks: fakeHooks(),
    now: () => 1_793_500_000_000,
    ...overrides,
  };
}

describe("wrapActions", () => {
  it("只保留函数项；相同名字被保留", () => {
    const wrapped = wrapActions(
      baseInput({
        actions: { stateTick: async () => "tick", version: 3, learn: async () => "learn" },
      }),
    );
    expect(Object.keys(wrapped).sort()).toEqual(["learn", "stateTick"]);
  });

  it("顺序：先刷新凭据，再跑固定副作用，最后才是动作", async () => {
    const order: string[] = [];
    const wrapped = wrapActions(
      baseInput({
        actions: {
          stateTick: async () => {
            order.push("action");
            return "ok";
          },
        },
        refreshModel: async () => {
          order.push("refresh");
        },
        // 用非心跳名字观察 hooks 是否被调用：runTickHooks 对非 tick 动作直接返回，
        // 所以这里改成 tick 名字并用假的 drainQueue 记录。
        tickHooks: fakeHooks({
          drainQueue: async () => {
            order.push("hooks");
          },
        }),
      }),
    );
    await wrapped["stateTick"]?.({});
    expect(order).toEqual(["refresh", "hooks", "action"]);
  });

  it("非心跳动作：仍然刷新凭据，但不跑固定副作用", async () => {
    const order: string[] = [];
    const wrapped = wrapActions(
      baseInput({
        actions: {
          learn: async () => {
            order.push("action");
            return "ok";
          },
        },
        refreshModel: async () => {
          order.push("refresh");
        },
        tickHooks: fakeHooks({
          drainQueue: async () => {
            order.push("hooks");
          },
        }),
      }),
    );
    await wrapped["learn"]?.();
    expect(order).toEqual(["refresh", "action"]);
  });

  it("参数与返回值原样传递（含 sync 函数）", async () => {
    const wrapped = wrapActions(
      baseInput({
        actions: { syncAction: (a: unknown, b: unknown) => ({ a, b }) },
      }),
    );
    await expect(wrapped["syncAction"]?.(1, "x")).resolves.toEqual({ a: 1, b: "x" });
  });

  it("动作抛错原样冒给 loop（不吞）", async () => {
    const wrapped = wrapActions(
      baseInput({
        actions: {
          stateTick: async () => {
            throw new Error("动作失败");
          },
        },
      }),
    );
    await expect(wrapped["stateTick"]?.()).rejects.toThrow("动作失败");
  });

  it("刷新凭据失败也冒出来（这一拍应当记失败而不是照跑）", async () => {
    const wrapped = wrapActions(
      baseInput({
        actions: { stateTick: async () => "ok" },
        refreshModel: async () => {
          throw new Error("凭据读取失败");
        },
      }),
    );
    await expect(wrapped["stateTick"]?.()).rejects.toThrow("凭据读取失败");
  });
});

describe("接线锁（F301）", () => {
  const read = (path: string): string => readFileSync(join(REPO, path), "utf8");

  it("入口用 wrapActions，不再手写 rawActions/fromEntries", () => {
    const main = read("scripts/autonomy/main.mjs");
    expect(main).toContain("wrapActions({");
    expect(main).not.toContain("rawActions");
    expect(main).not.toContain('runTickHooks(name,');
  });

  it("装配层负责调用 tick-hooks 与 refreshModel", () => {
    const module = read("src/assembly/action-wrapper.ts");
    expect(module).toContain("runTickHooks");
    expect(module).toContain("refreshModel");
  });
});
