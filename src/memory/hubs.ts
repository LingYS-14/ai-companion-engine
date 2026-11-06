/**
 * §4.4 hub 摘要的轻量持久化：`consolidation_hubs: Dict[mem_id, float]`。
 *
 * 规格把写入者钉死在 MemoryStore、读取者只给 Orchestrator：
 *   · `MemoryStore.consolidation_hubs.update(...)` 是唯一写入口（这里用 `HubStore.update`）；
 *   · `sleep_consolidation` 只读，用于"跨夜优先级延续"；
 *   · TTL = HUB_SUMMARY_TTL（7 天）——过期 hub 不再参与优先级，但记录不会立刻被删。
 *
 * 存 JSON 而不是 NDJSON：hub 是"当前值"不是"事件流"，读的时候只关心最新权重。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { knobNumber, type EngineConfig } from "../engine/config.js";

interface HubFile {
  readonly version: 1;
  readonly hubs: Record<string, { weight: number; updated_at: number }>;
}

export class HubStore {
  private readonly file: string;
  private hubs: Record<string, { weight: number; updated_at: number }>;

  private constructor(file: string, hubs: HubFile["hubs"]) {
    this.file = file;
    this.hubs = hubs;
  }

  static open(file: string): HubStore {
    if (!existsSync(file)) return new HubStore(file, {});
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HubFile>;
      const hubs = parsed.hubs !== null && typeof parsed.hubs === "object" ? parsed.hubs : {};
      return new HubStore(file, hubs);
    } catch {
      // 坏档不致命：hub 只影响优先级排序，丢了就是"这一夜按默认优先级来"
      return new HubStore(file, {});
    }
  }

  /** 唯一写入口：返回写入后的权重 */
  update(id: string, weight: number, nowMs: number): number {
    const w = Number.isFinite(weight) ? Math.max(0, weight) : 0;
    this.hubs[id] = { weight: w, updated_at: nowMs };
    this.persist();
    return w;
  }

  /** 读：过期（now − updated_at > HUB_SUMMARY_TTL）返回 0，并在下次写时自然淘汰 */
  get(id: string, nowMs: number, cfg: EngineConfig): number {
    const hit = this.hubs[id];
    if (hit === undefined) return 0;
    const ttlMs = knobNumber(cfg, "HUB_SUMMARY_TTL") * 1000;
    if (nowMs - hit.updated_at > ttlMs) return 0;
    return hit.weight;
  }

  /** 只读视图：Orchestrator 在 sleep_consolidation 里用它按优先级排队 */
  entries(nowMs: number, cfg: EngineConfig): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const [id, hit] of Object.entries(this.hubs)) {
      const w = this.get(id, nowMs, cfg);
      if (w > 0) out.set(id, w);
    }
    return out;
  }

  get size(): number {
    return Object.keys(this.hubs).length;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, hubs: this.hubs } satisfies HubFile), "utf8");
    renameSync(tmp, this.file);
  }
}
