/**
 * 知识写入闸的接线锁（F257）。
 *
 * 为什么锁：闸本身有单测，但**接不上就等于没有**——审计 P0-5 说的正是
 * "记忆有闸、知识裸写"：`this.knowledge.put(...)` 与
 * `ingestVideos(runtime.knowledgeStore(), ...)` 都很自然，写起来一点不报错。
 * 类型也拦不住：`KnowledgeWritePort` 是结构类型，裸 `KnowledgeStore` 恰好满足。
 * 所以用源码锁把"必须走端口"钉住。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const runtime = readFileSync(join(ROOT, "src", "plugin", "runtime.ts"), "utf8");
const plugin = readFileSync(join(ROOT, "src", "plugin", "index.ts"), "utf8");
const main = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");

describe("F257：知识写入必须走带闸的端口", () => {
  it("runtime 在 open() 里建端口，默认 enforce，观察模式走环境变量", () => {
    expect(runtime).toContain("createKnowledgeWritePort({");
    expect(runtime).toContain('parseKnowledgeGuardMode(process.env[KNOWLEDGE_GUARD_ENV]) ?? "enforce"');
    expect(runtime).toContain("knowledgeWritePort(): GuardedKnowledgePort");
    expect(runtime).toContain("knowledgeGuardStats(): KnowledgeGuardStats");
  });

  it("runtime 内部三处知识写入都过端口（不再裸 put）", () => {
    expect(runtime).not.toContain("this.knowledge.put(");
    expect(runtime).toContain("this.knowledgePort.put(");
  });

  it("装配点把端口递给摄取函数（不再递裸 store）", () => {
    for (const source of [plugin, main]) {
      expect(source).not.toContain("ingestVideos(runtime.knowledgeStore()");
      expect(source).not.toContain("ingestVideoNote(runtime.knowledgeStore()");
    }
    expect(plugin).toContain("ingestVideos(runtime.knowledgeWritePort()");
    expect(plugin).toContain("ingestVideoNote(runtime.knowledgeWritePort()");
    expect(main).toContain("ingestVideos(runtime.knowledgeWritePort()");
  });

  it("知识文件的污点侧车与 guard 日志都落在 data 目录（可审计）", () => {
    expect(runtime).toContain("knowledge-taint-${conf.characterId}.ndjson");
    expect(runtime).toContain("knowledge-guard-${conf.characterId}.ndjson");
  });
});
