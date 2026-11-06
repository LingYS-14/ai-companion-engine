/**
 * MemoryStore —— 记忆的读写门面。**写路径必须过 Firewall**（INV-1 的静态可达性）。
 *
 * 为什么把 firewall 作为构造参数而不是可选回调：
 *   规格里 INV-1 是"Firewall 必须在 MemoryStore 写路径上"，如果它可省，第一次赶工就会省掉，
 *   而这类缺口没有任何运行时征兆 —— 必须在类型层就做不出来（构造不出来 = 写不进去）。
 */

import { knobStrings, type EngineConfig } from "../engine/config.js";
import type { MemoryRecord } from "./types.js";
import { withLoci } from "./loci.js";
import { baseActivationAfterRetrieval, hoursBetween, migratedBaseActivation } from "./thermal.js";
import { Wal, type WalStats } from "./wal.js";

export interface FirewallVerdict {
  /** false = 不落盘（但仍会留下拒绝原因，供审计） */
  readonly keep: boolean;
  readonly reason: string;
  /** keep 时可选：把这条记忆标成"编码时处于污点环境" */
  readonly markTainted?: boolean;
}

export type Firewall = (rec: MemoryRecord, cfg: EngineConfig) => FirewallVerdict;

export interface WriteResult {
  readonly stored: boolean;
  readonly reason: string;
}

/**
 * 同一句话在 24 小时内重复抵达（重连补发、多客户端同步、同一次测试反复注入）不新建记忆，
 * 只把已有那条当「又想起一次」抬激活——否则同一条消息会变成 5 条几乎一样的记忆。
 * 2026-10-30 实测：23 条记忆里有 9 条是同句重复（「在吗？我回来了。」×5、「昨晚学到什么」×4），
 * 直接后果是内部言语没有材料可说，只能反复念「刚才那件小事」。
 */
const DUPLICATE_WINDOW_MS = 24 * 3_600_000;

/** 比较用的归一化：忽略空白/标点/大小写，只比“说了什么” */
function comparable(content: string): string {
  return content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface RejectLogEntry {
  readonly id: string;
  readonly reason: string;
  readonly at: number;
}

export class MemoryStore {
  private readonly rejects: RejectLogEntry[] = [];

  private constructor(
    private readonly wal: Wal,
    private readonly firewall: Firewall,
    private readonly cfg: EngineConfig,
  ) {
    if (typeof firewall !== "function") throw new TypeError("MemoryStore 必须传 firewall（INV-1）");
  }

  static open(path: string, firewall: Firewall, cfg: EngineConfig, compactAt?: number): MemoryStore {
    const wal = new Wal(path, compactAt).open();
    return new MemoryStore(wal, firewall, cfg);
  }

  /** 唯一写入入口：先过防火墙，再落 WAL */
  write(rec: MemoryRecord, now: number): WriteResult {
    const verdict = this.firewall(rec, this.cfg);
    if (!verdict.keep) {
      this.rejects.push({ id: rec.id, reason: verdict.reason, at: now });
      return { stored: false, reason: verdict.reason };
    }
    const marked: MemoryRecord = verdict.markTainted
      ? { ...rec, retrieved_under_taint: true }
      : rec;
    // 去重必须在防火墙之后（被拒的消息不该「合并」进已有记忆），在分配宫殿格子之前
    const key = comparable(marked.content);
    if (key !== "") {
      const dup = this.wal.snapshot().find(
        (m) =>
          m.source === marked.source &&
          !m.forgotten &&
          !m.suppressed_by_stronger &&
          now - m.created_at >= 0 &&
          now - m.created_at <= DUPLICATE_WINDOW_MS &&
          comparable(m.content) === key,
      );
      if (dup !== undefined) {
        this.touch(dup.id, now);
        return { stored: false, reason: "duplicate" };
      }
    }
    // §4.3：写入时一次性分配记忆宫殿格子；已有格子不重写（A36 幂等）
    const stored = withLoci(marked, this.wal.snapshot(), this.cfg);
    this.wal.put(stored);
    return { stored: true, reason: verdict.reason };
  }

  get(id: string): MemoryRecord | undefined {
    return this.wal.get(id);
  }

  /** §6.9 active()：忘掉的与被压制的都不参与检索 */
  active(): MemoryRecord[] {
    return this.wal.snapshot().filter((m) => !m.forgotten && !m.suppressed_by_stronger);
  }

  all(): MemoryRecord[] {
    return this.wal.snapshot();
  }

  /**
   * 检索命中后回写访问计数 + 激活强度（唯一允许就地改字段的地方，且必须立即落盘）。
   *
   * v5.4-P1 §4.2 把 `on_retrieve` 写成「检索内联写字段」，但检索在本仓库是纯函数；
   * 写必须收敛到这里（D9，A27 单写入者）。
   */
  touch(id: string, now: number): MemoryRecord | undefined {
    const rec = this.wal.get(id);
    if (!rec) return undefined;
    const hours = hoursBetween(rec.last_accessed, now);
    const next: MemoryRecord = {
      ...rec,
      access_count: rec.access_count + 1,
      last_accessed: now,
      base_activation: baseActivationAfterRetrieval(
        Number.isFinite(rec.base_activation) ? rec.base_activation : 0,
        hours,
        this.cfg,
      ),
    };
    this.wal.put(next);
    return next;
  }

  /**
   * 旧记忆迁移（D2）：v5.3.1 的落盘记录没有 base_activation，直接读会是 NaN。
   * 用「访问次数 + 年龄」反推一个不会让旧记忆一开始就冷掉的初始值，并立即落盘。
   */
  migrateActivation(now: number): number {
    let migrated = 0;
    for (const rec of this.wal.snapshot()) {
      if (Number.isFinite(rec.base_activation)) continue;
      this.wal.put({ ...rec, base_activation: migratedBaseActivation(rec, now, this.cfg) });
      migrated += 1;
    }
    return migrated;
  }

  /**
   * 元数据维护（鲜明度衰减、unresolved 衰减、遗忘标记）：**不重跑内容防火墙**。
   *
   * 为什么允许绕开 firewall：INV-1 管的是"内容进入记忆库"这条写路径（新内容可能来自不可信来源）。
   * 这里改的是同一条已有记录的数值字段，content 不变，重跑防火墙只会因为 `source: "web"` 把
   * 一条早就被接受的记忆判成拒绝，从而让"遗忘"变成"删除"。语义不同的两件事不共用一道闸。
   */
  mutate(id: string, patch: Partial<Pick<MemoryRecord, "vividness" | "unresolved_score" | "forgotten" | "suppressed_by_stronger" | "suppression_strength" | "last_accessed" | "access_count" | "base_activation" | "encode_state">>): MemoryRecord | undefined {
    const rec = this.wal.get(id);
    if (!rec) return undefined;
    const next: MemoryRecord = { ...rec, ...patch };
    this.wal.put(next);
    return next;
  }

  /**
   * §8.2 的 `retrieved_under_taint` 单向标记（F154）：记忆"在污染状态下被检索过"。
   *
   * 为什么不复用 `mutate`：那个白名单里都是**可反复调整的数值字段**（鲜明度、unresolved…），
   * 而这一位是**污点留痕**——写上去就永不清除（规格：只读、永不清）。把它混进 mutate 会让
   * "谁能改它"和"谁能改鲜明度"变成同一道闸，以后想收紧留痕语义就无处可收。
   */
  markRetrievedUnderTaint(id: string): MemoryRecord | undefined {
    const rec = this.wal.get(id);
    if (!rec) return undefined;
    if (rec.retrieved_under_taint === true) return rec;
    const next: MemoryRecord = { ...rec, retrieved_under_taint: true };
    this.wal.put(next);
    return next;
  }

  /** §6.5 的压制标记（G6-⑤ 自拟规则）：与遗忘一样是元数据，不重跑内容防火墙 */
  suppress(id: string, suppressed: boolean, strength: number): MemoryRecord | undefined {
    return this.mutate(id, { suppressed_by_stronger: suppressed, suppression_strength: Math.max(0, Math.min(1, strength)) });
  }

  /**
   * 从热档移出（冷归档用）：写 tombstone，热档不再有它。
   * 与 forget 的区别是"搬走"而不是"标脏"——记录本体已经在冷档里了（F29）。
   */
  remove(id: string): boolean {
    if (this.wal.get(id) === undefined) return false;
    this.wal.remove(id);
    return true;
  }

  /**
   * 重新接纳一条**曾经在库里**的记录（冷档 restore 用）：不重跑内容防火墙。
   *
   * 理由与 mutate 相同：内容没变、来源也没变，它在当初进入记忆库时已经过闸；
   * 若因为 `source: "web"` 在此刻被判拒绝，冷档 restore 就变成了"永远救不回来"。
   * 这仍然是写路径，所以只有本类的方法能调用 wal（INV-1 的写收敛不变）。
   */
  readmit(rec: MemoryRecord): MemoryRecord {
    this.wal.put(rec);
    return rec;
  }

  /** 遗忘是软删除：保留 id 与时间，供"为什么忘了"回溯 */
  forget(id: string): boolean {
    const rec = this.wal.get(id);
    if (!rec) return false;
    this.wal.put({ ...rec, forgotten: true });
    return true;
  }

  rejections(): readonly RejectLogEntry[] {
    return this.rejects;
  }

  stats(): Readonly<WalStats> & { size: number } {
    return { ...this.wal.stats(), size: this.wal.size() };
  }

  compact(): void {
    this.wal.compact();
  }

  /** 来源是否不可信（§6.6 UNTRUSTED_SOURCES） */
  isUntrustedSource(source: string): boolean {
    const untrusted = knobStrings(this.cfg, "UNTRUSTED_SOURCES");
    return untrusted.includes(source);
  }
}
