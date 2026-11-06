/**
 * 写入闸门（INV-1）。
 *
 * 规格只说"所有记忆写入必须过防火墙"，没定义裁决表 —— 这里把它落成可断言的规则：
 *
 *   clean      来源可信（RELATION_SOURCES / 本地观测）      → 接受，不改标记
 *   quarantined 来源在 UNTRUSTED_SOURCES 里                 → 接受但打污点标记
 *               （记忆要留下"我当时是听谁说的"，而不是把用户观察到的事实一起删掉）
 *   rejected   来源为空/未知，或内容为空                    → 拒绝，返回原因
 *
 * 拒绝不抛错：调用方拿到 verdict 后照常继续这一轮（degrade），但不得落盘。
 */

import { knobNumber, knobStrings, type EngineConfig } from "../engine/config.js";
import { magnitudeCaps } from "../learning/learn.js";

export type ProvenanceSource = "local" | "player" | "qq_contact_verified" | "web" | "parasocial" | "unknown";

export interface Provenance {
  /** 这条记忆最初是从哪来的（不是"现在谁在说"） */
  readonly source: string;
  /** 观测到它的通道，用于 trace */
  readonly channel: string;
  /** 观测时刻（由 Clock 提供，禁止 Date.now） */
  readonly observedAt: number;
}

export interface WriteCandidate {
  readonly content: string;
  /** 调用方声明的可信度，0..1；防火墙不拿它做裁决，只记进 trace */
  readonly claimedConfidence?: number;
}

export type Verdict = "clean" | "quarantined" | "rejected";

export interface FirewallVerdict {
  readonly verdict: Verdict;
  readonly reason: string;
  /** quarantined 时为 true：落盘后 retrieved_under_taint = true，且永不清洗 */
  readonly markTainted: boolean;
  readonly source: string;
}

export function vetWrite(
  candidate: WriteCandidate,
  provenance: Provenance,
  cfg: EngineConfig,
): FirewallVerdict {
  const untrusted = knobStrings(cfg, "UNTRUSTED_SOURCES");
  const source = (provenance.source ?? "").trim();
  if (source.length === 0) {
    return { verdict: "rejected", reason: "来源为空，无法追溯", markTainted: false, source };
  }
  if (candidate.content.trim().length === 0) {
    return { verdict: "rejected", reason: "内容为空", markTainted: false, source };
  }
  if (!Number.isFinite(provenance.observedAt)) {
    return { verdict: "rejected", reason: "observedAt 非有限值（必须来自 Clock）", markTainted: false, source };
  }
  if (untrusted.includes(source)) {
    return { verdict: "quarantined", reason: `不可信来源 ${source}：保留但打污点`, markTainted: true, source };
  }
  return { verdict: "clean", reason: "来源可信", markTainted: false, source };
}

/**
 * 检索守卫：命中污点记忆时返回标记，供 derive_insight 排除。
 * 注意"排除"不是"删除"——污点记忆仍可参与排序（A.11 决策：排除 + 打标）。
 */
export interface TaintMark {
  readonly memoryId: string;
  readonly source: string;
}

export function guardRetrieve(hits: readonly { id: string; retrieved_under_taint?: boolean; source: string }[]): readonly TaintMark[] {
  return hits.filter((h) => h.retrieved_under_taint === true).map((h) => ({ memoryId: h.id, source: h.source }));
}


/**
 * OCEAN 三重防护（v5.2 §8.4 / V52-GAP M8-10）。
 *
 * 人格漂移（F148）让她的 OCEAN 每晚能动 0.02，这是"她会变"的证据；但一个会变的性格
 * 也意味着它能被"喂"歪——所以规格要求三道闸，落在写入闸门的同一层：
 *
 *   1. **来源白名单**：只允许内部机制推动（睡眠结账、人格卡加载）。B 站标题、聊天文本、
 *      网页内容这些外部输入**没有任何路径**能写 OCEAN；这里把"没有路径"变成"有断言"。
 *   2. **单次幅度**：任一维一次变动超过 `MAGNITUDE_CAP.ocean`（0.02）就拒。
 *   3. **累计偏移**：相对人格卡的偏移超过 `DRIFT_GUARD_MAX`（0.3）之后不许再往外走，
 *      但**允许往回走**（否则她一旦撞线就永久锁死，连回归都不行）。
 *
 * 拒绝不抛错：调用方拿到 applied 才写，没写的那一维保持原值。
 */
export const OCEAN_ALLOWED_SOURCES = ["drift_settle", "persona_load"] as const;

export interface OceanDeltaInput {
  /** 这次变动是谁推动的（内部机制名，不是消息来源） */
  readonly source: string;
  /** 出生值（人格卡 OCEAN），只用于算累计偏移 */
  readonly base: Readonly<Record<string, number>>;
  /** 当前值（没有漂移记录时等于 base） */
  readonly current: Readonly<Record<string, number>>;
  /** 想加的量：逐维，正负都有 */
  readonly delta: Readonly<Record<string, number>>;
}

export interface OceanGuardVerdict {
  /** 至少有一维被放行 */
  readonly ok: boolean;
  readonly reason: string;
  /** 放行的量（调用方只加这里面的） */
  readonly applied: Readonly<Record<string, number>>;
  readonly rejected: readonly { readonly dim: string; readonly reason: string }[];
}

export function vetOceanDelta(input: OceanDeltaInput, cfg: EngineConfig): OceanGuardVerdict {
  const dims = Object.keys(input.delta).sort();
  const finite = dims.filter((dim) => Number.isFinite(input.delta[dim]));
  if (finite.length === 0) {
    return { ok: false, reason: "没有可引入的变动（delta 为空或非有限值）", applied: {}, rejected: [] };
  }
  if (!(OCEAN_ALLOWED_SOURCES as readonly string[]).includes(input.source)) {
    const reason = `来源 ${input.source} 不在 OCEAN 白名单（只允许 ${OCEAN_ALLOWED_SOURCES.join(" / ")}）`;
    return {
      ok: false,
      reason,
      applied: {},
      rejected: finite.map((dim) => ({ dim, reason })),
    };
  }

  const cap = magnitudeCaps(cfg).ocean;
  const guardMax = knobNumber(cfg, "DRIFT_GUARD_MAX");
  const applied: Record<string, number> = {};
  const rejected: { dim: string; reason: string }[] = [];

  for (const dim of finite) {
    const d = input.delta[dim] ?? 0;
    if (Math.abs(d) > cap + 1e-9) {
      rejected.push({ dim, reason: `单次变动 ${d.toFixed(3)} 超过上限 ${cap.toFixed(3)}` });
      continue;
    }
    const current = input.current[dim];
    const base = input.base[dim];
    if (!Number.isFinite(current) || !Number.isFinite(base)) {
      rejected.push({ dim, reason: `当前值或出生值不是有限数（current=${String(current)} base=${String(base)}）` });
      continue;
    }
    const nextDrift = (current ?? 0) + d - (base ?? 0);
    const currentDrift = (current ?? 0) - (base ?? 0);
    // 撞线只拦"继续往外"：允许回头（否则撞线后连修正都被拒，等于把她钉死）
    if (Math.abs(nextDrift) > guardMax + 1e-9 && Math.abs(nextDrift) > Math.abs(currentDrift) + 1e-12) {
      rejected.push({
        dim,
        reason: `累计偏移 ${nextDrift.toFixed(3)} 超过上限 ${guardMax.toFixed(3)}，且方向仍在远离出生值`,
      });
      continue;
    }
    applied[dim] = d;
  }

  const ok = Object.keys(applied).length > 0;
  const reason = ok
    ? `放行 ${Object.entries(applied).map(([d, v]) => `${d}${v >= 0 ? "+" : ""}${v.toFixed(3)}`).join(" ")}${rejected.length > 0 ? `；拒绝 ${rejected.map((r) => r.dim).join(" ")}` : ""}`
    : `全部拒绝：${rejected.map((r) => `${r.dim}（${r.reason}）`).join("；")}`;
  return { ok, reason, applied, rejected };
}
