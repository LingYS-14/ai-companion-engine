/**
 * 知识写入闸（F257）：把 `vetWrite` 挂到所有 L2 知识写入上。
 *
 * 为什么要有这个文件：审计 P0-5 实测发现——L1 记忆写入有防火墙（`SoulRuntime.open` 里给
 * `MemoryStore` 建了闸闭包），但 L2 知识是裸的：`this.knowledge.put(...)` 与
 * `ingestVideos(runtime.knowledgeStore(), ...)` 直接落库，`src/memory/knowledge.ts` 里
 * `vetWrite|firewall` 命中 0。于是 web/parasocial 来源的条目可以原样进入知识库，
 * 之后又被检索、被拿去讲——"来源不可信"这条规则在知识这一侧等于不存在。
 *
 * 这一层的职责很窄：
 *   · `rejected`：内容/来源/时间不可用 → 不落库，记进 guard 日志；
 *   · `quarantined`：来源不可信 → **保留**（知识本身可能有用）但把 id 记进污点侧车文件，
 *     供检索/洞见一侧以后过滤（消费端在批次 4 接，见 docs/ARCHITECTURE.md）；
 *   · `clean`：照常落库。
 *
 * 为什么不给 `KnowledgeRecord` 加 `taint` 字段：`spec/schema/knowledge.schema.json` 是
 * `additionalProperties: false` 的冻结 schema，加字段等于破 schema；而污点只需要"id 集合"，
 * 落一个侧车文件（只追加、按 id 去重）比改 schema 便宜，也不会让知识文件本身变成两种语义。
 *
 * 观察模式（`ACE_KNOWLEDGE_WRITE_GUARD=observe`）：只记 `would-reject` / `would-quarantine`，
 * 行为与没有闸时完全一样——用来先看一天"真打开会拦掉什么"，再切 `enforce`。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { EngineConfig } from "../engine/config.js";
import { vetWrite } from "../firewall/guard.js";
import type { KnowledgeWritePort } from "../ports/index.js";
import type { KnowledgeRecord } from "./knowledge.js";

/** guard 日志/污点侧车的行版本；升版说明形状变了，读侧要能拒旧行 */
export const KNOWLEDGE_GUARD_VERSION = 1;

/** 环境变量名：装配点用它选择 observe / enforce */
export const KNOWLEDGE_GUARD_ENV = "ACE_KNOWLEDGE_WRITE_GUARD";

export type KnowledgeGuardMode = "observe" | "enforce";

export const KNOWLEDGE_GUARD_MODES: readonly KnowledgeGuardMode[] = ["observe", "enforce"];

/** 解析开关；不认识的写法返回 null（调用方回落到默认 enforce，而不是悄悄观察） */
export function parseKnowledgeGuardMode(raw: string | undefined): KnowledgeGuardMode | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return null;
  return (KNOWLEDGE_GUARD_MODES as readonly string[]).includes(value) ? (value as KnowledgeGuardMode) : null;
}

/** 写入闸的计数（只在本进程内），给 health/日志用 */
export interface KnowledgeGuardStats {
  /** 收到几次 put（含被拦下的） */
  readonly put: number;
  readonly clean: number;
  /** 判定 rejected 的次数 */
  readonly rejected: number;
  /** 判定 quarantined 的次数 */
  readonly quarantined: number;
  /** 真正没落库的条数（enforce 下的 rejected） */
  readonly dropped: number;
  /** 真正打了污点的条数（enforce 下的 quarantined，按新 id 计） */
  readonly tainted: number;
}

/** guard 日志的一行：只记"非 clean"的判定，避免每写一条知识就多一行噪音 */
interface GuardJournalLine {
  readonly version: number;
  readonly at: number;
  readonly id: string;
  readonly source: string;
  readonly verdict: string;
  readonly reason: string;
  readonly mode: KnowledgeGuardMode;
  readonly action: "dropped" | "tainted" | "would-reject" | "would-quarantine";
}

/** 污点侧车的一行：只存 id → 来自哪、为什么脏 */
interface KnowledgeTaintLine {
  readonly version: number;
  readonly id: string;
  readonly source: string;
  readonly reason: string;
  readonly at: number;
}

/** 端口实现 = 对外接口 + 观测口（stats / taintedIds），不把实现细节塞进 ports */
export interface GuardedKnowledgePort extends KnowledgeWritePort {
  readonly mode: KnowledgeGuardMode;
  stats(): KnowledgeGuardStats;
  /** 已被打污点的知识 id（升序；含本次进程新记的） */
  taintedIds(): readonly string[];
}

export interface KnowledgeWritePortOptions {
  /** 真正的存储；端口只做闸与记账 */
  readonly store: Pick<KnowledgeWritePort, "has" | "idFor" | "put">;
  readonly cfg: EngineConfig;
  /** 观察时间来源；`rec.ingested_at` 合法时优先用它（那是"事件发生时间"） */
  readonly now: () => number;
  readonly mode: KnowledgeGuardMode;
  /** 污点侧车路径；不传 = 只在内存里记账（测试用） */
  readonly taintPath?: string;
  /** guard 日志路径；不传 = 只在内存里计数（测试用） */
  readonly journalPath?: string;
}

function appendLine(path: string | undefined, line: unknown): boolean {
  if (path === undefined) return true;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch {
    // 记账失败不能让"写知识"失败：知识比日志重要；调用方能从 stats 看出异常
    return false;
  }
}

/**
 * 造一个带闸的知识写入端口。
 *
 * 幂等口径沿用 `KnowledgeStore`：同 id 重复写会追加一行、读侧按 id 覆盖；
 * 闸不做额外的去重（`has` 由调用方判断，端口只声明它）。
 */
export function createKnowledgeWritePort(options: KnowledgeWritePortOptions): GuardedKnowledgePort {
  const { store, cfg, now, mode } = options;

  const tainted = new Set<string>();
  const counters = { put: 0, clean: 0, rejected: 0, quarantined: 0, dropped: 0, tainted: 0 };

  const journal = (line: GuardJournalLine): void => {
    appendLine(options.journalPath, line);
  };

  return {
    mode,
    has(id: string): boolean {
      return store.has(id);
    },
    idFor(tag: string): string {
      return store.idFor(tag);
    },
    put(rec: KnowledgeRecord): void {
      counters.put += 1;
      const observedAt =
        typeof rec.ingested_at === "number" && Number.isFinite(rec.ingested_at) ? rec.ingested_at : now();
      const candidate =
        typeof rec.source_credibility === "number"
          ? { content: rec.content, claimedConfidence: rec.source_credibility }
          : { content: rec.content };
      const verdict = vetWrite(candidate, { source: rec.source, channel: "knowledge", observedAt }, cfg);

      if (verdict.verdict === "clean") {
        counters.clean += 1;
        store.put(rec);
        return;
      }

      if (verdict.verdict === "rejected") {
        counters.rejected += 1;
        if (mode === "observe") {
          // 观察模式：行为不变，只把"真打开会拦掉什么"记下来
          journal({
            version: KNOWLEDGE_GUARD_VERSION,
            at: observedAt,
            id: rec.id,
            source: rec.source,
            verdict: verdict.verdict,
            reason: verdict.reason,
            mode,
            action: "would-reject",
          });
          counters.clean += 1;
          store.put(rec);
          return;
        }
        counters.dropped += 1;
        journal({
          version: KNOWLEDGE_GUARD_VERSION,
          at: observedAt,
          id: rec.id,
          source: rec.source,
          verdict: verdict.verdict,
          reason: verdict.reason,
          mode,
          action: "dropped",
        });
        return;
      }

      // quarantined：来源不可信，但内容本身可能仍有用——保留，按 id 打污点
      counters.quarantined += 1;
      if (mode === "observe") {
        journal({
          version: KNOWLEDGE_GUARD_VERSION,
          at: observedAt,
          id: rec.id,
          source: rec.source,
          verdict: verdict.verdict,
          reason: verdict.reason,
          mode,
          action: "would-quarantine",
        });
        counters.clean += 1;
        store.put(rec);
        return;
      }

      store.put(rec);
      if (!tainted.has(rec.id)) {
        tainted.add(rec.id);
        counters.tainted += 1;
        const line: KnowledgeTaintLine = {
          version: KNOWLEDGE_GUARD_VERSION,
          id: rec.id,
          source: rec.source,
          reason: verdict.reason,
          at: observedAt,
        };
        appendLine(options.taintPath, line);
        journal({
          version: KNOWLEDGE_GUARD_VERSION,
          at: observedAt,
          id: rec.id,
          source: rec.source,
          verdict: verdict.verdict,
          reason: verdict.reason,
          mode,
          action: "tainted",
        });
      }
    },
    stats(): KnowledgeGuardStats {
      return { ...counters };
    },
    taintedIds(): readonly string[] {
      return [...tainted].sort();
    },
  };
}
