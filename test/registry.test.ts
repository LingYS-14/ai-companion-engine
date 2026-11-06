import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("注册表检查（S7 PIPELINE-2）", () => {
  it("check_registry 全绿：owner/readers、timeBase 数据流、七键和、diff", () => {
    const r = spawnSync(process.execPath, [join(root, "tools/audit/check_registry.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status, `${r.stdout}
${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("timeBase 数据流 11 键一致");
    // diff 双栏必须被真的写出来（否则 §2.5 只是一句口号）
    const diff = readFileSync(join(root, "spec/config/registry-diff.md"), "utf8");
    expect(diff).toContain("| 键 | engine.json | v54.overlay.json | 变化 |");
    expect(diff).toContain("| ACT_R_DECAY |");
  });

  it("DECAY_RATE 的 timeBase 以公式为准（per-day），不是附录的 per-hour", () => {
    const engine = JSON.parse(readFileSync(join(root, "spec/config/engine.json"), "utf8"));
    const k = engine.knobs.DECAY_RATE;
    expect(k.timeBase).toBe("per-day");
    expect(k.unit).toBe("1/天");
  });
});
