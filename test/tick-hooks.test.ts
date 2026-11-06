/**
 * 每拍固定副作用（`src/assembly/tick-hooks.ts`，批次 3 下沉第一刀）。
 *
 * 为什么单独测：这两件事都被"吞错"保护着——吞错是对的，但吞错也意味着坏了没人知道。
 * 所以测试要同时证明两件事：正常时它们真的发生了；异常时它们真的只记日志、不让拍失败。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isTickAction, runTickHooks, type MorningReportRunner, type TickHooksDeps } from "../src/assembly/tick-hooks.js";
import { panelStateSnapshotPath } from "../src/orchestrator/intent/panel-snapshot.js";

const NOW = 1_790_000_000_000;
const HOUR = 3_600_000;
// 取一个本地小时恰好是 3 点/6 点的时刻（tz=0，纯算术）
function atHour(hour: number): number {
  return Math.floor(NOW / (24 * HOUR)) * 24 * HOUR + hour * HOUR;
}

let dir: string;
let lines: string[];
let drained: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tick-hooks-"));
  lines = [];
  drained = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<TickHooksDeps> = {}): TickHooksDeps {
  return {
    dataDir: dir,
    characterId: "assistant",
    repo: dir,
    tzOffsetMinutes: 0,
    log: (line) => lines.push(line),
    runtime: {
      state: { valence: 0.7, energy: 0.6, pressure: 0.1, maskIntegrity: 0.9 },
      snapshot: () => ({ mode: "NORMAL", turns: 7 }),
    },
    drainQueue: async () => {
      drained += 1;
    },
    ...over,
  };
}

describe("isTickAction", () => {
  it("只有 stateTick/tick 算一拍，其它动作不跑这些副作用", () => {
    expect(isTickAction("stateTick")).toBe(true);
    expect(isTickAction("tick")).toBe(true);
    expect(isTickAction("learn")).toBe(false);
    expect(isTickAction("proactive")).toBe(false);
  });
});

describe("runTickHooks", () => {
  it("一拍里既消费队列也写面板快照", async () => {
    await runTickHooks("stateTick", deps(), NOW);
    expect(drained).toBe(1);
    const path = panelStateSnapshotPath(dir, "assistant");
    expect(existsSync(path)).toBe(true);
    const snap = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(snap["turns"]).toBe(7);
    expect(snap["mode"]).toBe("NORMAL");
    expect(snap["valence"]).toBe(0.7);
    expect(lines).toEqual([]);
  });

  it("非拍动作什么都不做（不消费队列、不写快照）", async () => {
    await runTickHooks("learn", deps(), NOW);
    expect(drained).toBe(0);
    expect(existsSync(panelStateSnapshotPath(dir, "assistant"))).toBe(false);
  });

  it("队列消费失败只记日志，不让这一拍失败", async () => {
    await runTickHooks(
      "tick",
      deps({
        drainQueue: async () => {
          throw new Error("executor 未就绪");
        },
      }),
      NOW,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines.some((l) => l.includes("[queue] 重试失败") && l.includes("executor 未就绪"))).toBe(true);
  });

  it("快照写不出来只记日志，仍然完成这一拍", async () => {
    // 把 dataDir 本身做成一个文件 → mkdir/写入必然失败
    const blocked = join(dir, "blocked-file");
    writeFileSync(blocked, "not a dir", "utf8");
    await runTickHooks("tick", deps({ dataDir: blocked }), NOW);
    expect(lines.some((l) => l.includes("[panel] 状态快照写入失败"))).toBe(true);
  });

  it("不同动作名只跑一次副作用，不重复写", async () => {
    await runTickHooks("stateTick", deps(), NOW);
    await runTickHooks("proactive", deps(), NOW);
    expect(drained).toBe(1);
  });

  it("3 点那一拍留一份数据快照，同一天第二次不重复留", async () => {
    // 真实数据文件在场，快照才会真的落盘（文件缺失时 snapshotData 会 skipped，不算「留过」）
    for (const name of ["memory-assistant.ndjson", "knowledge-assistant.ndjson", "selftalk-assistant.json", "qq-assistant.json"]) {
      writeFileSync(joinPath(dir, name), "", "utf8");
    }
    const d = deps();
    await runTickHooks("stateTick", d, atHour(3));
    expect(lines.some((l) => l.includes("数据快照"))).toBe(true);
    expect(existsSync(joinPath(dir, "archive", "snapshots"))).toBe(true);
    const before = lines.length;
    await runTickHooks("stateTick", d, atHour(3) + 5 * 60_000);
    expect(lines.slice(before).some((l) => l.includes("数据快照"))).toBe(false);
  });

  it("6 点那一拍生成早报；marker 在就不重复生成", async () => {
    let calls = 0;
    const runner: MorningReportRunner = (input) => {
      calls += 1;
      writeFileSync(input.marker, "ran", "utf8");
    };
    const d = deps({ runMorningReport: runner });
    await runTickHooks("tick", d, atHour(6));
    expect(calls).toBe(1);
    expect(lines.some((l) => l.includes("早报已生成"))).toBe(true);
    await runTickHooks("tick", d, atHour(6) + 5 * 60_000);
    expect(calls).toBe(1);
  });

  it("早报生成失败只记日志，不影响这一拍", async () => {
    const d = deps({ runMorningReport: () => { throw new Error("脚本挂了"); } });
    await runTickHooks("tick", d, atHour(6));
    expect(lines.some((l) => l.includes("早报生成失败") && l.includes("脚本挂了"))).toBe(true);
  });

  it("既不是 3 点也不是 6 点：不数据快照、不生成早报", async () => {
    let calls = 0;
    const d = deps({ runMorningReport: () => {
      calls += 1;
    } });
    await runTickHooks("tick", d, atHour(10));
    expect(calls).toBe(0);
    expect(existsSync(joinPath(dir, "archive", "snapshots"))).toBe(false);
    expect(lines.some((l) => l.includes("数据快照"))).toBe(false);
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("装配下沉锁：入口不再自带每拍副作用（F275 → F301）", () => {
  it("每拍副作用由装配层动作包装调用；入口只递依赖、不内联副作用", () => {
    const main = read("scripts/autonomy/main.mjs");
    expect(main).not.toMatch(/await runTickHooks\(name,/);
    expect(main).not.toMatch(/void drainQueue\(\)\.catch/);
    expect(main).not.toMatch(/writePanelStateSnapshotFile\(/);
    // F301：入口把 tick-hooks 的依赖和"这一拍的时间"交给装配层包装函数
    expect(main).toMatch(/wrapActions\(\{/);
    expect(main).toMatch(/tickHooks: \{[\s\S]{0,200}?drainQueue[\s\S]{0,200}?\}/);
    expect(main).toMatch(/now: \(\) => Date\.now\(\)/);
    const wrapper = read("src/assembly/action-wrapper.ts");
    expect(wrapper).toMatch(/runTickHooks\(name, input\.tickHooks, input\.now\(\)\)/);
    expect(wrapper).toMatch(/refreshModel\(\)/);
  });

  it("时间必须由包装层调用时取（而不是入口传常量），否则快照/早报静默失真", () => {
    const wrapper = read("src/assembly/action-wrapper.ts");
    const main = read("scripts/autonomy/main.mjs");
    expect(wrapper).toMatch(/input\.now\(\)/);
    expect(main).toMatch(/now: \(\) => Date\.now\(\)/);
  });

  it("tick-hooks 文件在 layers.json 的装配点名单里（否则它会被判为未归层）", () => {
    const cfg = JSON.parse(read("spec/config/layers.json")) as { assembly: string[] };
    expect(cfg.assembly).toContain("src/assembly/tick-hooks.ts");
  });
});
