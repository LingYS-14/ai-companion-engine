/**
 * 模块契约的机检（v5.2 §2 + P0-1/P0-5）。
 *
 * `src/contracts/modules.ts` 声称自己的 `reads` / `writes` 是「CI lint 的输入」，
 * 但在 2026-10-30 之前**没有任何消费者**：文件 283 行、fan-in 0，只有 `lint:writers`
 * 用文本包含去数 `id: "x"` 出现过几次。于是它既没拦住 P0-1（状态字段多写者），
 * 也没拦住 P0-5（读未登记字段），还挂着一句「实现放在 src/engine/modules/*」——那个目录不存在。
 *
 * 这个文件就是把它变成真契约的那一半：字段名对照 `initialSState()` 的**真实键**校验，
 * 写者按「每个 s.* 恰好一个 writer」数，模块 id 对照真实源码路径。
 * 另一半是 `tools/lint/writers.mjs` 继续做文本级结构检查（它跑在 gate 里，不依赖 dist）。
 *
 * 注意：`taintMap` 不走「恰好一个 writer」——污点由 `src/memory/taint.ts` 的账本管，
 * 状态里的 `taintMap` 只是它的镜像（v5.2 A11 两层拆分）。所以下面的豁免是显式的、有理由的，
 * 而不是把失败改成跳过。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTRACTS, type ModuleContract, type ModuleId } from "../src/contracts/modules.js";
import { initialSState } from "../src/engine/state.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 契约里必须出现的八个模块（顺序即 v5.2 §2 的编排顺序） */
const EXPECTED_IDS: readonly ModuleId[] = [
  "orchestrator",
  "state",
  "psychology",
  "memory",
  "learning",
  "firewall",
  "dialogue",
  "render",
];

/** 每个模块在源码里的落点：契约说它有实现，就必须真有文件 */
const SOURCE_OF: Record<ModuleId, string> = {
  orchestrator: "src/orchestrator/turn.ts",
  state: "src/engine/state.ts",
  psychology: "src/psychology/wonder.ts",
  memory: "src/memory/store.ts",
  learning: "src/learning/bandit.ts",
  firewall: "src/firewall/guard.ts",
  dialogue: "src/dialogue/composer.ts",
  render: "src/dialogue/render.ts",
};

/** d.* 是关系层字段，真实载体是 `src/plugin/runtime.ts` 的 bond 记录 */
const D_FIELDS = new Set(["d.bondProgress", "d.stageDepth", "d.attachment"]);

/** 不适用「恰好一个 writer」的字段（原因写在文件头，不在这里加注释了事） */
const MULTI_WRITER_ALLOWED = new Set(["s.taintMap"]);

function byField(field: string): readonly ModuleContract[] {
  return CONTRACTS.filter((m) => m.writes.includes(field));
}

describe("模块契约：结构", () => {
  it("八个模块 id 齐全、唯一、顺序与 v5.2 §2 一致", () => {
    expect(CONTRACTS.map((m) => m.id)).toEqual([...EXPECTED_IDS]);
  });

  it("每个模块都有源码落点（契约不是空头文件）", () => {
    for (const [id, rel] of Object.entries(SOURCE_OF)) {
      expect(existsSync(join(ROOT, rel)), `${id} 声明的源码不存在：${rel}`).toBe(true);
    }
  });

  it("failureMode 只有 degrade / throw，invariants 是数组", () => {
    for (const m of CONTRACTS) {
      expect(["degrade", "throw"]).toContain(m.failureMode);
      expect(Array.isArray(m.invariants)).toBe(true);
    }
  });
});

describe("模块契约：字段引用对得上真实 schema", () => {
  const sFields = new Set(Object.keys(initialSState()).map((k) => `s.${k}`));

  it("每个 s.* 都是 initialSState() 真实的键（P0-5：不许引用不存在的字段）", () => {
    for (const m of CONTRACTS) {
      for (const field of [...m.reads, ...m.writes]) {
        if (!field.startsWith("s.")) continue;
        expect(sFields.has(field), `${m.id} 引用了不存在的字段 ${field}`).toBe(true);
      }
    }
  });

  it("每个 d.* 都在已知的关系字段表里", () => {
    for (const m of CONTRACTS) {
      for (const field of [...m.reads, ...m.writes]) {
        if (!field.startsWith("d.")) continue;
        expect(D_FIELDS.has(field), `${m.id} 引用了未知的 d.* 字段 ${field}`).toBe(true);
      }
    }
  });

  it("只有 mark / mode / s.* / d.* 这四种形状", () => {
    for (const m of CONTRACTS) {
      for (const field of [...m.reads, ...m.writes]) {
        const ok = field === "mark" || field === "mode" || field.startsWith("s.") || field.startsWith("d.");
        expect(ok, `${m.id} 的字段引用形状不对：${field}`).toBe(true);
      }
    }
  });
});

describe("模块契约：P0-1 每个状态字段恰好一个 writer", () => {
  it("除显式豁免外，每个 s.* 恰好一个模块声明写入", () => {
    for (const field of Object.keys(initialSState()).map((k) => `s.${k}`)) {
      if (MULTI_WRITER_ALLOWED.has(field)) continue;
      const writers = byField(field).map((m) => m.id);
      expect(writers, `${field} 的 writer 数应为 1，实际 ${String(writers.length)}：${writers.join("+")}`).toHaveLength(1);
    }
  });

  it("s.* 与 d.* 的写者只能是 state（其它模块只读）", () => {
    for (const m of CONTRACTS) {
      if (m.id === "state") continue;
      const risky = m.writes.filter((f) => f.startsWith("s.") || f.startsWith("d."));
      expect(risky, `${m.id} 不该写状态字段：${risky.join(",")}`).toEqual([]);
    }
  });

  it("mark 只有一个 writer（firewall），其它模块只读", () => {
    expect(byField("mark").map((m) => m.id)).toEqual(["firewall"]);
  });
});
