import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const CFG_PATH = join(ROOT, "spec", "config", "decision-gates.json");

interface GateEntry {
  id: string;
  file: string;
  role: "owner" | "legacy" | "safety" | "tool-layer";
  owns: string | null;
  decides: string;
  marker: string;
  status?: string;
  note: string;
}

interface GatesCfg {
  version: number;
  why: string;
  gates: GateEntry[];
  ownership: Record<string, string>;
  invariants: string[];
}

function load(): GatesCfg {
  return JSON.parse(readFileSync(CFG_PATH, "utf8")) as GatesCfg;
}

describe("决策门归属表（审计 P1-7）", () => {
  const cfg = load();

  it("形状：版本、五条门、每条都有决定/标记/说明", () => {
    expect(cfg.version).toBe(1);
    expect(cfg.why.length).toBeGreaterThan(20);
    expect(Array.isArray(cfg.gates)).toBe(true);
    expect(cfg.gates.length).toBe(5);
    const ids = cfg.gates.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of cfg.gates) {
      expect(g.id.trim().length).toBeGreaterThan(2);
      expect(g.decides.trim().length).toBeGreaterThan(10);
      expect(g.marker.trim().length).toBeGreaterThan(5);
      expect(g.note.trim().length).toBeGreaterThan(10);
      expect(["owner", "legacy", "safety", "tool-layer"]).toContain(g.role);
    }
  });

  it("每条声明的文件真实存在；未删除的门要有标记，已删除的门绝不能复活", () => {
    for (const g of cfg.gates) {
      const path = join(ROOT, g.file);
      expect(existsSync(path), `${g.id} 的文件不存在：${g.file}`).toBe(true);
      const text = readFileSync(path, "utf8");
      if (g.status === "deleted") {
        // 回归判据反向：删掉的门如果又被写回来，这条测试必须红。
        expect(text, `${g.id} 已标删除，但 ${g.file} 里又出现了它的标记：${g.marker}`).not.toContain(g.marker);
      } else {
        expect(text, `${g.id} 的标记在 ${g.file} 里找不到：${g.marker}`).toContain(g.marker);
      }
    }
  });

  it("只有一个门拥有 speak 决定权（审计 L3 的核心裁决）", () => {
    const owners = cfg.gates.filter((g) => g.owns !== null);
    expect(owners.map((g) => g.owns)).toEqual(["speak"]);
    expect(cfg.ownership.speak).toBe(owners[0]?.id);
    const speakOwners = cfg.gates.filter((g) => g.owns === "speak");
    expect(speakOwners.length).toBe(1);
    expect(speakOwners[0]?.role).toBe("owner");
  });

  it("legacy 门只许减少：插件机械门已经从 to-delete 走到 deleted", () => {
    const legacy = cfg.gates.filter((g) => g.role === "legacy");
    expect(legacy.length).toBe(1);
    expect(legacy[0]?.status).toBe("deleted");
    expect(legacy[0]?.owns).toBeNull();
  });

  it("工具层的 reply 判定已登记为待搬大脑（D3），不是默认合规", () => {
    const reply = cfg.gates.find((g) => g.id === "qq-reply-filter");
    expect(reply?.role).toBe("tool-layer");
    expect(reply?.status).toBe("to-move-to-brain");
    expect(cfg.ownership.reply).toBe("qq-reply-filter");
  });

  it("温和刹车的过渡判定已登记：有归属、有退役条件，不是又一扇无名的门", () => {
    const gate = cfg.gates.find((g) => g.id === "proactive-brakes-fallback");
    expect(gate?.role).toBe("safety");
    expect(gate?.status).toBe("transitional");
    expect(gate?.owns).toBeNull();
    // 退役条件必须写在表里：P3 睡眠状态机上线后移除 minGap/maxPerDay
    expect(gate?.note).toContain("P3");
    expect(gate?.decides).toContain("30 分钟");
  });

  it("不变量写清楚了：新判定必须先登记，否则测试失败", () => {
    const text = cfg.invariants.join("\n");
    expect(text).toContain("speak");
    expect(text).toContain("登记");
    // 现状下 src/ 里若出现第五处「要不要说」的门，这条测试无法自动发现（只能评审+这张表）。
    // 这里断言的是：表本身声明了这条义务，避免它悄悄消失。
    expect(cfg.invariants.length).toBeGreaterThanOrEqual(3);
  });
});
