import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PERSONA_BUDGET, parsePersona, personaLine, renderPersona } from "../src/dialogue/persona.js";
import { loadPersonaFile } from "../src/plugin/persona.js";

const TMP_ROOT = new URL("../.tmp-probe/", import.meta.url).pathname.replace(/^\//, "");
// mkdtempSync 只建最后一级目录：父目录必须自己保证存在，否则换个干净工作区就 ENOENT
mkdirSync(TMP_ROOT, { recursive: true });

const CARD = {
  name: "苏晚",
  description: "二十四岁，旧书店店员。说话慢，习惯先听再说。",
  speech: "短句为主，少用感叹号；被夸时会先否认一句。",
  taboos: ["不自称 AI", "不主动提自己的年龄"],
  opening: "第一次见面时她正在整理一排旧书，抬头看了你一眼。",
  habits: ["说话时会把书签在指间转来转去。"],
  inner: ["她其实怕客人只买书、不记得她。"],
  sorePoints: ["被当成「自动售货机」时，她会安静下来。"],
  seedMemories: ["她说过店里的猫叫「三月」。"],
};

describe("人格卡（persona）", () => {
  it("解析完整卡片：字段逐个落位", () => {
    const p = parsePersona(CARD);
    expect(p.name).toBe("苏晚");
    expect(p.speech).toContain("短句");
    expect(p.taboos).toHaveLength(2);
    expect(p.seedMemories?.[0]).toContain("三月");
  });

  it("最小卡片（只有必填两项）也能解析，可选字段不出现而不是填空串", () => {
    const p = parsePersona({ name: "甲", description: "乙" });
    expect(p.speech).toBeUndefined();
    expect(p.taboos).toBeUndefined();
  });

  it("缺 name 或 description 直接报错——没有这两项的人格卡注入只是噪声", () => {
    expect(() => parsePersona({ description: "乙" })).toThrow(/name/);
    expect(() => parsePersona({ name: "甲", description: "  " })).toThrow(/description/);
    expect(() => parsePersona([])).toThrow(/JSON 对象/);
    expect(() => parsePersona(null)).toThrow(/JSON 对象/);
  });

  it("taboos 不是字符串数组时报错（避免把对象塞进提示）", () => {
    expect(() => parsePersona({ name: "甲", description: "乙", taboos: [{ x: 1 }] })).toThrow(/taboos/);
  });

  it("深度三层：habits / inner / sorePoints 逐项解析", () => {
    const p = parsePersona({
      name: "某人",
      description: "描述",
      habits: ["转笔"],
      inner: ["其实不想被看见"],
      sorePoints: ["被当成工具"],
    });
    expect(p.habits).toEqual(["转笔"]);
    expect(p.inner).toEqual(["其实不想被看见"]);
    expect(p.sorePoints).toEqual(["被当成工具"]);
  });

  it("深度三层不是字符串数组时报错（三个字段共用一条校验）", () => {
    for (const field of ["habits", "inner", "sorePoints"] as const) {
      expect(() => parsePersona({ name: "某人", description: "描述", [field]: "不是数组" })).toThrow(
        `人格卡字段「${field}」必须是字符串数组`,
      );
      expect(() => parsePersona({ name: "某人", description: "描述", [field]: [1] })).toThrow(
        `人格卡字段「${field}」必须是字符串数组`,
      );
    }
  });

  it("渲染时三层各有自己的指令，且 inner 明确要求「别直接念」", () => {
    const text = renderPersona(
      parsePersona({
        name: "某人",
        description: "描述",
        habits: ["转笔"],
        inner: ["其实不想被看见"],
        sorePoints: ["被当成工具"],
      }),
    );
    expect(text).toContain("小动作与偏好");
    expect(text).toContain("转笔");
    expect(text).toContain("心里其实");
    expect(text).toContain("别直接念出来");
    expect(text).toContain("会被真的伤到的地方");
    expect(text).toContain("不是发火");
  });

  it("多余字段被忽略（允许作者写备注，不因未知键失败）", () => {
    const p = parsePersona({ name: "甲", description: "乙", version: 3, note: "草稿" });
    expect(p.name).toBe("甲");
  });

  it("渲染成系统提示：含名字、说话方式、边界，且明确「背景不是记忆」", () => {
    const text = renderPersona(parsePersona(CARD));
    expect(text.startsWith("【角色设定】苏晚")).toBe(true);
    expect(text).toContain("说话方式：");
    expect(text).toContain("不碰的边界：");
    expect(text).toContain("别当成记忆引用");
  });

  it("超预算时截断而不是报错（宁可少一句设定）", () => {
    const p = parsePersona({
      name: "甲",
      description: "乙".repeat(PERSONA_BUDGET),
    });
    const text = renderPersona(p);
    expect(text.length).toBeLessThanOrEqual(PERSONA_BUDGET);
    expect(text.endsWith("…")).toBe(true);
  });

  it("从文件读：合法 JSON 成功，坏 JSON 报错并带上路径", () => {
    const dir = mkdtempSync(join(TMP_ROOT, "persona-"));
    try {
      const ok = join(dir, "ok.json");
      writeFileSync(ok, JSON.stringify(CARD), "utf8");
      expect(loadPersonaFile(ok, parsePersona).name).toBe("苏晚");

      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ 不是 json", "utf8");
      expect(() => loadPersonaFile(bad, parsePersona)).toThrow(/合法 JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("一行摘要：未配置时明说 none，配置后报名字与条数", () => {
    expect(personaLine(null)).toContain("[persona] none");
    const line = personaLine(parsePersona(CARD));
    expect(line).toContain("name=苏晚");
    expect(line).toContain("taboos=2");
    expect(line).toContain("seeds=1");
  });
});

  it("F326：随包人格卡已删除，空路径读成 null（回退 B 仍能读临时卡）", () => {
    // 方案 A：装配层不再传 personaFile；loadPersonaFile 的 API 保留给回退 B，
    // 但"没路径"必须是安静的 null，不是异常（否则重启/工具面会崩）。
    expect(loadPersonaFile(null, parsePersona)).toBeNull();
    expect(loadPersonaFile(undefined, parsePersona)).toBeNull();

    const dir = mkdtempSync(join(TMP_ROOT, "persona-null-"));
    try {
      const cardPath = join(dir, "card.json");
      writeFileSync(cardPath, JSON.stringify(CARD), "utf8");
      const p = loadPersonaFile(cardPath, parsePersona);
      expect(p?.name).toBe("苏晚");
      expect(renderPersona(p!).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

describe("人格卡的阶段语气覆盖（F37）", () => {
  it("解析合法 stageStyle", () => {
    const p = parsePersona({ ...CARD, stageStyle: { stranger: "客气但不冷淡", beloved: "独占欲露出来" } });
    expect(p.stageStyle?.stranger).toBe("客气但不冷淡");
    expect(p.stageStyle?.beloved).toBe("独占欲露出来");
  });

  it("阶段名不认识时抛错并列出可用阶段", () => {
    expect(() => parsePersona({ ...CARD, stageStyle: { "陌生人": "x" } })).toThrow(/stranger/);
  });

  it("不是对象时报错", () => {
    expect(() => parsePersona({ ...CARD, stageStyle: ["stranger"] })).toThrow(/必须是对象/);
  });

  it("没写 stageStyle 时不产生覆盖（不改变所有角色的默认梯度）", () => {
    expect(parsePersona(CARD).stageStyle).toBeUndefined();
  });
});
