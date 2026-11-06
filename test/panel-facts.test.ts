/**
 * 面板「意图面」测试（`src/orchestrator/intent/panel-facts.ts`，F269）。
 *
 * 三条纪律要在这里钉住：
 *  1. 读不到文件 = 明说读不到，不能显示成"没有待办"（安静不等于没事）；
 *  2. 只显示等待中的；已回执/已应答的不算待办；
 *  3. 面板数据读取绝不能抛——面板挂掉比少显示更糟。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dshInboxPath,
  dshReplyDir,
  buildDshAsk,
  buildDshReply,
  serializeDshAsk,
  serializeDshReply,
} from "../src/orchestrator/intent/dsh-bridge.js";
import { buildGuardianRequest, type GuardianRequest } from "../src/orchestrator/intent/guardian.js";
import { appendGuardianRequest, guardianInboxPath, guardianReplyDir, writeGuardianReply } from "../src/orchestrator/intent/persist.js";
import { readPanelFacts } from "../src/orchestrator/intent/panel-facts.js";
import { serializeIntentionFile } from "../src/orchestrator/intent/intent-file.js";
import type { IntentionRecord } from "../src/orchestrator/intent/types.js";

const NOW = Date.UTC(2026, 10, 1, 4, 0, 0);
const DAY = 86_400_000;

let base: string;
let dataDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "panel-facts-"));
  dataDir = join(base, "data");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const record = (over: Partial<IntentionRecord> = {}): IntentionRecord => ({
  id: "itn-reach-1",
  kind: "reach_out",
  goal: "想跟他说一句今天的事",
  why: "因为想有人陪",
  attempts: [],
  status: "pending",
  trigger: null,
  superseded_by: null,
  created_at: new Date(NOW - 60_000).toISOString(),
  deadline: null,
  blocked_by: null,
  survival: 0,
  source_ids: [],
  ...over,
});

describe("readPanelFacts", () => {
  it("空 DataDir：明说意图表还没生成，其余为空但不编待办", () => {
    const facts = readPanelFacts({ dataDir, characterId: "test", nowMs: NOW });
    expect(facts.intentions).toEqual({ open: 0, total: 0, items: [] });
    expect(facts.dsh.waiting).toBe(0);
    expect(facts.guardian.waiting).toBe(0);
    expect(facts.gaps).toEqual([]);
    expect(facts.notes.join("；")).toContain("意图表还没生成");
  });

  it("意图表：只显示开着的，带被拦原因与试过次数", () => {
    writeFileSync(
      join(dataDir, "intent-test.json"),
      serializeIntentionFile(
        [
          record({ id: "itn-open-1", kind: "continue_thread", blocked_by: "quota", status: "blocked", attempts: [{ at: new Date(NOW - DAY).toISOString(), act: "proactive_speak", outcome: "ok", agency: 0.5 }] }),
          record({ id: "itn-done-1", status: "done" }),
        ],
        NOW,
      ),
      "utf8",
    );
    const facts = readPanelFacts({ dataDir, characterId: "test", nowMs: NOW });
    expect(facts.intentions.open).toBe(1);
    expect(facts.intentions.total).toBe(2);
    expect(facts.intentions.items[0]?.id).toBe("itn-open-1");
    expect(facts.intentions.items[0]?.blockedBy).toBe("quota");
    expect(facts.intentions.items[0]?.attempts).toBe(1);
  });

  it("意图表坏了：说「读不出来」，不冒充「没有意图」", () => {
    writeFileSync(join(dataDir, "intent-test.json"), "{坏 json", "utf8");
    const facts = readPanelFacts({ dataDir, characterId: "test", nowMs: NOW });
    expect(facts.intentions.items).toEqual([]);
    expect(facts.notes.join("；")).toContain("意图表读不出来");
    expect(facts.notes.join("；")).not.toContain("意图表还没生成");
  });

  it("DSH 问询：等待中的进面板，已应答的不进", () => {
    const waiting = buildDshAsk({ intentionId: "cap-gap:knowledge/api", kind: "help", text: "想查 B 站字幕", tried: ["试过直接 fetch"], atMs: NOW - 60_000 });
    const answered = buildDshAsk({ intentionId: "cap-gap:skill", kind: "observe", text: "看看时间", tried: [], atMs: NOW - 120_000 });
    writeFileSync(dshInboxPath(dataDir, "test"), `${serializeDshAsk(waiting)}\n${serializeDshAsk(answered)}\n`, "utf8");
    mkdirSync(dshReplyDir(dataDir), { recursive: true });
    const reply = buildDshReply({ id: answered.id, by: "lead", atMs: NOW - 30_000, verdict: "answered", answer: "看过了" });
    writeFileSync(join(dshReplyDir(dataDir), `${answered.id}.json`), serializeDshReply(reply), "utf8");

    const facts = readPanelFacts({ dataDir, characterId: "test", nowMs: NOW });
    expect(facts.dsh.waiting).toBe(1);
    expect(facts.dsh.items[0]?.id).toBe(waiting.id);
    expect(facts.dsh.items[0]?.expired).toBe(false);
  });

  it("DSH 问询超时：留在面板并标 expired（等她升级，不是悄悄忽略）", () => {
    const old = buildDshAsk({ intentionId: "cap-gap:knowledge/api", kind: "help", text: "两小时前问的", tried: [], atMs: NOW - 3 * 60 * 60_000 });
    writeFileSync(dshInboxPath(dataDir, "test"), `${serializeDshAsk(old)}\n`, "utf8");
    const facts = readPanelFacts({ dataDir, characterId: "test", nowMs: NOW });
    expect(facts.dsh.waiting).toBe(1);
    expect(facts.dsh.items[0]?.expired).toBe(true);
  });

  it("监护人收件箱：没人回的进面板，回了的不进", () => {
    const help = { blockedIntentionId: "cap-gap:knowledge/api", what: "想查字幕", tried: ["试过 fetch"], need: "plugin" as const, ask: "能不能给我一个取字幕的办法" };
    const open = buildGuardianRequest(help, new Date(NOW - 60_000).toISOString(), NOW - 60_000);
    const handled = buildGuardianRequest({ ...help, blockedIntentionId: "cap-gap:skill" }, new Date(NOW - 2 * 60_000).toISOString(), NOW - 2 * 60_000);
    const inbox = guardianInboxPath(base, "test");
    mkdirSync(join(base, "data"), { recursive: true });
    appendGuardianRequest(inbox, open);
    appendGuardianRequest(inbox, handled);
    mkdirSync(guardianReplyDir(base), { recursive: true });
    writeGuardianReply(guardianReplyDir(base), { requestId: handled.requestId, at: new Date(NOW - 60_000).toISOString(), from: "owner", verdict: "help", note: "我来" });

    const facts = readPanelFacts({ dataDir, characterId: "test", nowMs: NOW });
    expect(facts.guardian.waiting).toBe(1);
    expect(facts.guardian.items[0]?.requestId).toBe(open.requestId);
    expect(facts.guardian.items[0]?.timedOut).toBe(false);
  });

  it("能力缺口：同一缺口跨两天算两次尝试，按次数多的在前", () => {
    const lines = [
      JSON.stringify({ at: NOW - DAY - 1000, kind: "explore", missingFamily: "api", desire: 0.6 }),
      JSON.stringify({ at: NOW - 1000, kind: "explore", missingFamily: "api", desire: 0.7 }),
      JSON.stringify({ at: NOW - 2000, kind: "create", missingFamily: "permission", desire: 0.4 }),
    ];
    writeFileSync(join(dataDir, "capability-gaps-test.ndjson"), `${lines.join("\n")}\n`, "utf8");
    const facts = readPanelFacts({ dataDir, characterId: "test", nowMs: NOW });
    expect(facts.gaps.length).toBe(2);
    expect(facts.gaps[0]?.key).toBe("explore/api");
    expect(facts.gaps[0]?.attempts).toBe(2);
    expect(facts.gaps[1]?.attempts).toBe(1);
  });

  it("坏时间参数当场抛（这是程序错误，不是数据问题）", () => {
    expect(() => readPanelFacts({ dataDir, characterId: "test", nowMs: Number.NaN })).toThrow(RangeError);
  });
});

/** 防止 fixture 与真实 GuardianRequest 漂移：能塞进 appendGuardianRequest 的类型即可 */
const _typecheck: GuardianRequest | null = null;
void _typecheck;
