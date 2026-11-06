/**
 * 配置 diff：v5.2 §12 的收口判据「10 秒回答：这次改配置改了什么、谁负责、有没有关掉一个没人读的旋钮」。
 *
 * 为什么需要它：这套系统的"行为"很大一部分由旋钮决定（engine.json 93 个 + overlay 34 个），
 * 但它们散在两个文件里、含义靠 name 猜。一次改动到底影响了谁，只有把两份快照按名字对齐才看得出来。
 *
 * 边界：
 * - 纯函数，读写文件与 git 的事在 CLI（tools/config/diff.mjs）里做。
 * - 不判断"这个值改得对不对"——只回答"哪些键变了、它们归谁、有没有问题"。
 * - 引擎基线（engine.json）没有 owner 字段（v5.3 附录 A 的形态），所以"owner 未知"是正常状态，
 *   不是错误；overlay 的键从 v5.4-P1 起必须带 owner/readers。
 */

export type ConfigSource = "engine" | "overlay";

/** 一个旋钮的元信息，取到多少写多少（engine 的键没有 owner/readers）。 */
export interface ConfigKnobMeta {
  readonly source: ConfigSource;
  readonly kind?: string;
  readonly unit?: string;
  readonly timeBase?: string;
  readonly owner?: string;
  readonly readers?: readonly string[];
}

export interface ConfigSnapshot {
  /** engine.json 的 knobs（name → 原始条目） */
  readonly engine: Readonly<Record<string, unknown>>;
  /** v54.overlay.json 的 knobs */
  readonly overlay: Readonly<Record<string, unknown>>;
}

export type ConfigDiffStatus = "added" | "removed" | "changed";
export type ConfigDiffFlag = "unregistered" | "dead" | "shadow";

export interface ConfigDiffEntry {
  readonly name: string;
  readonly status: ConfigDiffStatus;
  readonly base: unknown;
  readonly head: unknown;
  /** 生效来源：overlay 覆盖 engine 时算 overlay */
  readonly source: ConfigSource;
  readonly owner: string | null;
  readonly readers: number;
  readonly flags: readonly ConfigDiffFlag[];
  /** 一行人类可读的摘要（CLI 直接打这个） */
  readonly line: string;
}

export interface ConfigDiffResult {
  readonly entries: readonly ConfigDiffEntry[];
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  /** 需要人看一眼的问题：未登记（没有 owner）、死旋钮（readers 为空） */
  readonly problems: readonly string[];
  readonly summary: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取一个生效值：overlay 优先（overlay 只加不覆盖，text 占位升级除外）。 */
function effective(
  engine: Readonly<Record<string, unknown>>,
  overlay: Readonly<Record<string, unknown>>,
  name: string,
): { source: ConfigSource; entry: Record<string, unknown> | null } {
  if (isRecord(overlay[name])) return { source: "overlay", entry: overlay[name] };
  if (isRecord(engine[name])) return { source: "engine", entry: engine[name] };
  return { source: "engine", entry: null };
}

/** 拿"值"：overlay 里也带 valueText，但带结构化的 value 时以 value 为准。 */
function valueOf(entry: Record<string, unknown> | null): unknown {
  if (entry === null) return undefined;
  if ("value" in entry) return entry["value"];
  if ("valueText" in entry) return entry["valueText"];
  return null;
}

function metaOf(entry: Record<string, unknown> | null, source: ConfigSource): ConfigKnobMeta {
  if (entry === null) return { source };
  const readers = Array.isArray(entry["readers"]) ? (entry["readers"] as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
  return {
    source,
    ...(typeof entry["kind"] === "string" ? { kind: entry["kind"] } : {}),
    ...(typeof entry["unit"] === "string" ? { unit: entry["unit"] } : {}),
    ...(typeof entry["timeBase"] === "string" ? { timeBase: entry["timeBase"] } : {}),
    ...(typeof entry["owner"] === "string" && entry["owner"] !== "" ? { owner: entry["owner"] } : {}),
    ...(readers === undefined ? {} : { readers }),
  };
}

/** 稳定序列化：对象的键排序，避免"同一个对象换个顺序"被当成改动。 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) || Math.abs(a - b) <= 1e-12;
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

function renderValue(v: unknown): string {
  if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`;
  if (typeof v === "number") return String(v);
  if (v === undefined) return "（无）";
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/**
 * 对齐两份快照的旋钮。
 *
 * flags 的语义：
 * - `unregistered`：改了的键在 head 里没有 owner（engine 基线本来就没有，所以只在 overlay 键缺 owner 时才算问题）
 * - `dead`：overlay 键的 readers 是空数组（改了没人读）
 * - `shadow`：同一个名字在 engine 与 overlay 里都有（只允许 text 占位升级，其余是冲突，注册表检查会另行报错）
 */
export function diffConfig(base: ConfigSnapshot, head: ConfigSnapshot): ConfigDiffResult {
  const names = new Set<string>();
  for (const n of Object.keys(base.engine)) names.add(n);
  for (const n of Object.keys(base.overlay)) names.add(n);
  for (const n of Object.keys(head.engine)) names.add(n);
  for (const n of Object.keys(head.overlay)) names.add(n);

  const entries: ConfigDiffEntry[] = [];
  const problems: string[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const name of [...names].sort()) {
    const b = effective(base.engine, base.overlay, name);
    const h = effective(head.engine, head.overlay, name);
    const bv = valueOf(b.entry);
    const hv = valueOf(h.entry);
    const wasThere = b.entry !== null;
    const isThere = h.entry !== null;
    if (!wasThere && !isThere) continue;

    let status: ConfigDiffStatus;
    if (!wasThere) status = "added";
    else if (!isThere) status = "removed";
    else if (same(bv, hv)) continue;
    else status = "changed";

    if (status === "added") added += 1;
    else if (status === "removed") removed += 1;
    else changed += 1;

    const meta = metaOf(h.entry, h.source);
    const flags: ConfigDiffFlag[] = [];
    // 只有 overlay 键有 owner/readers 约定：engine 基线不要求（v5.3 附录 A 没有这两个字段）
    if (h.source === "overlay" && (meta.owner === undefined || meta.readers === undefined || meta.readers.length === 0)) {
      flags.push(meta.owner === undefined ? "unregistered" : "dead");
    }
    // 同名同时出现在 engine 与 overlay：唯一允许的是「v5.3 的 text 占位被升级成结构化」。
    const engineInHead = head.engine[name];
    if (h.source === "overlay" && isRecord(engineInHead) && engineInHead["kind"] !== "text") flags.push("shadow");

    const arrow = status === "changed" ? `${renderValue(bv)} → ${renderValue(hv)}` : renderValue(status === "added" ? hv : bv);
    const ownerText = meta.owner ?? "（engine 基线无 owner）";
    const flagText = flags.length === 0 ? "" : ` ⚠${flags.join(",")}`;
    const line = `${status === "added" ? "+" : status === "removed" ? "-" : "~"} ${name} = ${arrow}｜owner=${ownerText}｜readers=${meta.readers?.length ?? 0}｜源=${meta.source}${flagText}`;
    entries.push({
      name,
      status,
      base: bv,
      head: hv,
      source: meta.source,
      owner: meta.owner ?? null,
      readers: meta.readers?.length ?? 0,
      flags,
      line,
    });
    if (flags.includes("unregistered")) problems.push(`${name}：改了但没有登记 owner`);
    if (flags.includes("dead")) problems.push(`${name}：readers 为空（改了没人读）`);
  }

  const summary =
    entries.length === 0
      ? "配置无变化（engine + overlay 两份对齐后没有差异）"
      : `${added} 新增 / ${removed} 删除 / ${changed} 修改${problems.length === 0 ? "" : `；${problems.length} 处需要人看一眼`}`;
  return { entries, added, removed, changed, problems, summary };
}
