/**
 * W1（task-94）：搜索结果 → L2 知识的映射与防火墙行为。
 *
 * 重点（spec v2.3 §5.2 / B1）：`source` 必须是裸 `"web"`，这样 `vetWrite` 的精确匹配
 * 才会把它判成 `quarantined` 并记污点；写成 `"web:<url>"` 等于绕过污点标记。
 */

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { createKnowledgeWritePort } from "../src/memory/knowledge-write.js";
import type { EngineConfig } from "../src/engine/config.js";
import {
  WEB_SOURCE,
  WEB_SOURCE_CREDIBILITY,
  distillHit,
  ingestHits,
} from "../src/web/ingest.js";
import type { WebSearchHit } from "../src/web/types.js";

const NOW = Date.parse("2026-11-01T12:00:00+08:00");
const cfg: EngineConfig = loadConfig();

function hit(over: Partial<WebSearchHit> = {}): WebSearchHit {
  return {
    title: "AI助手与往世乐土",
    url: "https://example.com/a",
    snippet: "一段摘要",
    siteName: "example",
    publishedAtMs: null,
    authority: 2,
    rerankScore: 2,
    summary: "更长的摘要正文",
    ...over,
  };
}

describe("distillHit", () => {
  it("内容格式固定：在网页上看到《标题》（url，站点，日期）：摘要", () => {
    const d = distillHit(hit(), "崩坏三", NOW);
    expect(d.content).toBe("在网页上看到《AI助手与往世乐土》（https://example.com/a，example，日期未知）：更长的摘要正文");
    expect(d.tag).toBe("web:https://example.com/a");
    expect(d.knowledgeType).toBe("fact");
  });

  it("7 天内有明确日期 → news；超过 7 天/没有日期 → fact", () => {
    const fresh = distillHit(hit({ publishedAtMs: NOW - 2 * 86_400_000 }), "q", NOW);
    expect(fresh.knowledgeType).toBe("news");
    expect(fresh.content).toContain("2026-10-30");
    expect(distillHit(hit({ publishedAtMs: NOW - 30 * 86_400_000 }), "q", NOW).knowledgeType).toBe("fact");
    expect(distillHit(hit({ publishedAtMs: null }), "q", NOW).knowledgeType).toBe("fact");
  });

  it("摘要截断到 300 字（code point），空摘要退 snippet，空标题退 url", () => {
    const d = distillHit(hit({ summary: "长".repeat(400), title: "", snippet: "" }), "q", NOW);
    expect(Array.from(d.content.split("）：")[1] ?? "")).toHaveLength(301); // 300 + 省略号
    expect(d.content).toContain("https://example.com/a");
  });
});

describe("ingestHits：映射与幂等", () => {
  function fakePort(existing: Set<string> = new Set()): {
    writes: { id: string; source: string; credibility: number; type: string }[];
    port: {
      has: (id: string) => boolean;
      put: (rec: { id: string; source: string; source_credibility?: number; knowledge_type: string }) => void;
      idFor: (tag: string) => string;
    };
  } {
    const writes: { id: string; source: string; credibility: number; type: string }[] = [];
    return {
      writes,
      port: {
        has: (id: string) => existing.has(id),
        put: (rec) => writes.push({ id: rec.id, source: rec.source, credibility: rec.source_credibility ?? -1, type: rec.knowledge_type }),
        idFor: (tag: string) => `kn_${tag.length}_${tag.slice(-8)}`,
      },
    };
  }

  it("映射：source 裸 web、credibility 0.55、knowledge_type、ingested_at", () => {
    const { port, writes } = fakePort();
    const out = ingestHits(port, [hit()], NOW);
    expect(out).toEqual({ written: 1, skipped: 0, rejected: 0 });
    expect(writes[0]).toMatchObject({ source: "web", credibility: WEB_SOURCE_CREDIBILITY, type: "fact" });
    expect(writes[0]?.id).toContain("kn_");
  });

  it("同 id 已存在 → skipped（不重复写）", () => {
    const first = ingestHits(fakePort().port, [hit()], NOW);
    const tag = "web:https://example.com/a";
    const id = `kn_${tag.length}_${tag.slice(-8)}`; // 与 fakePort.idFor 的规则一致
    expect(first.written).toBe(1);
    const out = ingestHits(fakePort(new Set([id])).port, [hit()], NOW);
    expect(out).toEqual({ written: 0, skipped: 1, rejected: 0 });
  });

  it("单条写失败只计数，不拖垮后面的条目", () => {
    const seen: string[] = [];
    const port = {
      has: () => false,
      idFor: (tag: string) => `kn_${tag}`,
      put: (rec: { content: string }) => {
        if (rec.content.includes("会炸")) throw new Error("disk full");
        seen.push(rec.content);
      },
    };
    const out = ingestHits(port, [hit({ summary: "会炸" }), hit({ url: "https://example.com/b" })], NOW);
    expect(out).toEqual({ written: 1, skipped: 0, rejected: 1 });
    expect(seen).toHaveLength(1);
  });
});

describe("B1：source=web 必须进防火墙 quarantine 并记污点", () => {
  it("真实 guard 端口：web 条目落库 + quarantined + taintedIds；id 被记下", () => {
    const stored: { id: string; source: string }[] = [];
    const store = {
      has: () => false,
      idFor: (tag: string) => `kn_${tag}`,
      put: (rec: { id: string; source: string }) => {
        stored.push({ id: rec.id, source: rec.source });
      },
    };
    const port = createKnowledgeWritePort({ store, cfg, now: () => NOW, mode: "enforce" });
    const out = ingestHits(port, [hit({ publishedAtMs: NOW - 86_400_000 })], NOW);
    expect(out.written).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source).toBe(WEB_SOURCE);
    expect(port.stats().quarantined).toBe(1);
    expect(port.taintedIds()).toHaveLength(1);
    expect(port.taintedIds()[0]).toBe(stored[0]?.id);
  });
});
