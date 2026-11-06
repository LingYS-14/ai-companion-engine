import { describe, expect, it } from "vitest";

import {
  DREAM_CONF_HINT,
  DREAM_CONF_MAX,
  DREAM_RETENTION_NIGHTS,
  DREAM_TEXT_MAX,
  buildDreamPrompt,
  buildShadowRecord,
  parseDreamText,
  selectDreamSeeds,
  trimShadowLines,
  validateDreamShadow,
  type DreamSeed,
  type DreamSeedRecord,
} from "../src/maintenance/dream.js";

const NOW = 1_760_000_000_000;

function record(partial: Partial<DreamSeedRecord> & { id: string }): DreamSeedRecord {
  return {
    content: `内容-${partial.id}`,
    source: "player",
    created_at: NOW - 1_000,
    vividness: 0.5,
    access_count: 1,
    ...partial,
  };
}

function seed(partial: Partial<DreamSeed> & { id: string }): DreamSeed {
  return {
    content: `内容-${partial.id}`,
    source: "player",
    created_at: NOW - 1_000,
    ...partial,
  };
}

describe("selectDreamSeeds：选种", () => {
  it("过滤已遗忘/被压制/来源 dream/空 id/空正文", () => {
    const picked = selectDreamSeeds({
      nowMs: NOW,
      records: [
        record({ id: "a" }),
        record({ id: "b", forgotten: true }),
        record({ id: "c", suppressed_by_stronger: true }),
        record({ id: "d", source: "dream" }),
        record({ id: "   " }),
        record({ id: "e", content: "   " }),
      ],
    });
    expect(picked.seeds.map((entry) => entry.id)).toEqual(["a"]);
    expect(picked.reason).toBe("no-material");
    expect(picked.lowData).toBe(true);
  });

  it("真实互动优先，其次 vividness / access_count / created_at", () => {
    const picked = selectDreamSeeds({
      nowMs: NOW,
      limit: 3,
      records: [
        record({ id: "selftalk-1", source: "selftalk", vividness: 0.99 }),
        record({ id: "real-low", source: "qq_contact_verified", vividness: 0.1 }),
        record({ id: "real-high", source: "player", vividness: 0.2 }),
        record({ id: "real-mid", source: "player", vividness: 0.2, access_count: 9 }),
      ],
    });
    expect(picked.seeds.map((entry) => entry.id)).toEqual(["real-mid", "real-high", "real-low"]);
    expect(picked.reason).toBe("ok");
    expect(picked.lowData).toBe(false);
  });

  it("真实互动不足 2 条时最多补 1 条非真实互动，并标记 lowData", () => {
    const picked = selectDreamSeeds({
      nowMs: NOW,
      limit: 5,
      records: [
        record({ id: "real-1" }),
        record({ id: "talk-1", source: "selftalk" }),
        record({ id: "talk-2", source: "selftalk" }),
        record({ id: "talk-3", source: "selftalk" }),
      ],
    });
    expect(picked.lowData).toBe(true);
    expect(picked.fillerCount).toBe(1);
    expect(picked.seeds.map((entry) => entry.id)).toEqual(["real-1", "talk-1"]);
    expect(picked.reason).toBe("no-material");
  });

  it("空候选池返回 no-material 且不算低料", () => {
    expect(selectDreamSeeds({ nowMs: NOW, records: [] })).toEqual({
      seeds: [],
      lowData: false,
      fillerCount: 0,
      reason: "no-material",
    });
  });

  it("limit 只接受 3–5 的整数，默认最多 4 条", () => {
    expect(() => selectDreamSeeds({ nowMs: NOW, records: [], limit: 2 })).toThrow(RangeError);
    expect(() => selectDreamSeeds({ nowMs: NOW, records: [], limit: 6 })).toThrow(RangeError);
    expect(() => selectDreamSeeds({ nowMs: NOW, records: [], limit: 3.5 })).toThrow(RangeError);
    const many = Array.from({ length: 8 }, (_, index) =>
      record({ id: `r${String(index)}`, vividness: 1 - index * 0.1 }),
    );
    expect(selectDreamSeeds({ nowMs: NOW, records: many }).seeds).toHaveLength(4);
  });

  it("realSources 可覆盖真实互动的来源口径", () => {
    const picked = selectDreamSeeds({
      nowMs: NOW,
      limit: 3,
      realSources: ["web"],
      records: [
        record({ id: "web-1", source: "web", vividness: 0.1 }),
        record({ id: "web-2", source: "web", vividness: 0.9 }),
        record({ id: "player-1", source: "player", vividness: 0.99 }),
      ],
    });
    expect(picked.seeds.map((entry) => entry.id)).toEqual(["web-2", "web-1", "player-1"]);
    expect(picked.reason).toBe("ok");
  });
});

describe("buildDreamPrompt：提示词", () => {
  it("含人格、夜间重放与记忆片段，且不出现内部 id", () => {
    const messages = buildDreamPrompt({
      personaName: "AI助手",
      seeds: [seed({ id: "mem-1", content: "他说今晚的月亮像水" })],
      nightKey: "2026-11-01",
    });
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("AI助手");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("他说今晚的月亮像水");
    expect(user).toContain("2026-11-01");
    expect(user).not.toContain("mem-1");
  });

  it("种子正文超过 120 字会被截断", () => {
    const long = "月".repeat(150);
    const messages = buildDreamPrompt({
      personaName: "AI助手",
      seeds: [seed({ id: "m", content: long })],
      nightKey: "2026-11-01",
    });
    const user = messages[1]?.content ?? "";
    expect(user).toContain(`${"月".repeat(120)}…`);
    expect(user).not.toContain("月".repeat(121));
  });
});

describe("parseDreamText：解析", () => {
  it("去空白与成对引号，非字符串按空串", () => {
    expect(parseDreamText("  「她站在水边」 \n")).toBe("她站在水边");
    expect(parseDreamText('"月亮"')).toBe("月亮");
    expect(parseDreamText(42)).toBe("");
    expect(parseDreamText(null)).toBe("");
  });
});

describe("validateDreamShadow：校验", () => {
  it("种子可用、文本合规时通过", () => {
    const result = validateDreamShadow({
      records: [record({ id: "a" }), record({ id: "b", source: "qq_contact_verified" }), record({ id: "c" })],
      seedIds: ["a", "b", "c"],
      text: "水面上有一盏灯，我走过去",
      error: null,
    });
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("悬空/重复/自引用/已遗忘/被压制/来源 dream 都留下原因码", () => {
    const result = validateDreamShadow({
      records: [
        record({ id: "forgotten", forgotten: true }),
        record({ id: "suppressed", suppressed_by_stronger: true }),
        record({ id: "dream-1", source: "dream" }),
        record({ id: "a" }),
      ],
      seedIds: ["dangling", "forgotten", "suppressed", "dream-1", "dream:me", "a", "a"],
      text: "梦",
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "seed-dangling",
        "seed-forgotten",
        "seed-suppressed",
        "seed-dream",
        "seed-self",
        "seed-id-duplicate",
      ]),
    );
  });

  it("空文本/超长/断言式/置信越界/模型失败都判不合格", () => {
    const base = {
      records: [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })],
      seedIds: ["a", "b", "c"],
    } as const;
    expect(validateDreamShadow({ ...base, text: "我学到了很多" }).reasons).toContain("text-assertive");
    expect(validateDreamShadow({ ...base, text: "月".repeat(DREAM_TEXT_MAX + 1) }).reasons).toContain(
      "text-too-long",
    );
    expect(validateDreamShadow({ ...base, text: "   " }).reasons).toContain("text-empty");
    expect(validateDreamShadow({ ...base, text: "梦", confidenceHint: 0.9 }).reasons).toContain("confidence");
    expect(validateDreamShadow({ ...base, text: "梦", error: "timeout" }).reasons).toContain("model-error");
  });
});

describe("buildShadowRecord：影子记录", () => {
  it("landingShape 置信不超过 0.4、derivation_chain 等于种子、text 允许 null", () => {
    const recordValue = buildShadowRecord({
      nightKey: "2026-11-01",
      ranAtMs: NOW,
      model: "deepseek-chat",
      seedIds: ["a", "b", "c"],
      text: "水面上的灯",
      validation: { ok: true, reasons: [] },
      lowData: false,
      tokens: { prompt: 100, completion: 20 },
      durationMs: 1234,
      budget: { used: 1, left: 7 },
      confidenceHint: 0.9,
    });
    expect(recordValue.v).toBe(1);
    expect(recordValue.confidenceHint).toBe(DREAM_CONF_MAX);
    expect(recordValue.landingShape).toEqual({
      source: "dream",
      confidence: DREAM_CONF_MAX,
      encode_ctx: { kind: "dream" },
      derivation_chain: ["a", "b", "c"],
    });

    const failed = buildShadowRecord({
      nightKey: "2026-11-01",
      ranAtMs: NOW,
      model: "unknown",
      seedIds: [],
      text: null,
      validation: { ok: false, reasons: ["model-error"] },
      lowData: false,
      tokens: { prompt: 0, completion: 0 },
      durationMs: 5,
      budget: { used: 1, left: 7 },
      error: "timeout",
    });
    expect(failed.text).toBeNull();
    expect(failed.error).toBe("timeout");
    expect(failed.confidenceHint).toBe(DREAM_CONF_HINT);
  });
});

describe("trimShadowLines：保留最近 14 夜", () => {
  it("30 行只留最后 14 行", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line-${String(index)}`);
    const kept = trimShadowLines(lines);
    expect(kept).toHaveLength(DREAM_RETENTION_NIGHTS);
    expect(kept[0]).toBe("line-16");
    expect(kept.at(-1)).toBe("line-29");
    expect(() => trimShadowLines(lines, 0)).toThrow(RangeError);
  });
});
