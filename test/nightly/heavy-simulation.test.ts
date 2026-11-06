/**
 * 夜间慢速套件（M12-05 CI 分层）——**不进 `npm run gate`**。
 *
 * 分层理由：v5.2 §12.2 P-C 要求「快速 <10s + 夜间慢速」两层。这个仓库的常规套件已经是
 * 4–5s 量级，所以「慢」不能靠人为 sleep，只能靠**真的跑长时间仿真**：
 *   · 60 天无人搭理（240 次 6h 推进）——褪色、能量、状态边界
 *   · 1000 个真实回合——每回合都要过 appraisal/tick/检索/记忆写入，验证不会积累出 NaN
 *   · 800 条 60 天前的知识重算新鲜度——验证大库重算是一次过、且可重复
 *
 * 这些用例在 gate 的 `test:fast` 里被 `--exclude test/nightly/**` 排除，
 * 由 `npm run test:nightly` 单独跑。配置锁在 `test/ci-layering.test.ts` 里。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeClock } from "../../src/engine/clock.js";
import { loadConfig, DEFAULT_CONFIG_URL } from "../../src/engine/config.js";
import { SoulRuntime, type SoulConfig } from "../../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const DAY = 86_400_000;

let dir: string | null = null;
let rt: SoulRuntime | null = null;

/** `SoulRuntime.open` 是 async（会先读盘、再建索引），必须 await。 */
async function open(): Promise<{ rt: SoulRuntime; dir: string; clock: FakeClock }> {
  dir = mkdtempSync(join(tmpdir(), "soul-nightly-"));
  const clock = new FakeClock(Date.UTC(2026, 9, 1, 9, 0, 0), 12);
  const conf: SoulConfig = { characterId: "nightly", dataDir: dir, trace: false };
  rt = await SoulRuntime.open(conf, clock);
  return { rt, dir, clock };
}

afterEach(() => {
  try {
    rt?.flush();
  } catch {
    /* flush 失败不该让测试失败（断言已经做完了） */
  }
  rt = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function assertFiniteSState(snap: Record<string, unknown>) {
  const state = snap["state"] as Record<string, number>;
  for (const key of ["valence", "arousal", "pressure", "energy", "dissonance", "entropy", "affection", "trust", "jealousy", "maskIntegrity", "suppressionLoad", "rumination"]) {
    const value = state[key];
    expect(typeof value, `state.${key} 应该是数字`).toBe("number");
    expect(Number.isFinite(value), `state.${key} 不该是 NaN/Infinity（实际 ${String(value)}）`).toBe(true);
    expect(value, `state.${key} 出界（${String(value)}）`).toBeGreaterThanOrEqual(0);
    expect(value, `state.${key} 出界（${String(value)}）`).toBeLessThanOrEqual(1);
  }
}

describe("夜间慢速：长时间仿真", () => {
  it("60 天无人搭理：状态留在界内、褪色真的发生、不是死循环", async () => {
    const opened = await open();
    const stored = opened.rt.remember({ content: "用户说过今晚会回来，她在门口等过一会儿", source: "player", tags: ["聊天"] });
    expect(stored.stored).toBe(true);

    const before = opened.rt.snapshot() as Record<string, unknown>;
    const beforeVividness = (opened.rt.memoryStore().all().find((m) => m.id === stored.id)?.vividness ?? 1) as number;
    expect(beforeVividness).toBeGreaterThan(0);

    // 240 次 6 小时推进 = 60 天。跨过睡点会触发巩固与冷归档，所以这条记忆
    // 最终可能：①还在热档但鲜明度掉下来；②被遗忘标记；③被搬去冷档（从热档移除）。
    // 三者都是规格内行为，测试断的是"褪色真的在发生"和"没有数值污染"。
    let fadedTotal = 0;
    let forgottenTotal = 0;
    let archivedTotal = 0;
    for (let i = 0; i < 240; i += 1) {
      const res = opened.rt.advance(6);
      fadedTotal += res.faded;
      forgottenTotal += res.forgotten;
      archivedTotal += res.sleep?.archived ?? 0;
    }
    expect(fadedTotal, "60 天里至少有一次褪色").toBeGreaterThan(0);

    const after = opened.rt.snapshot() as Record<string, unknown>;
    assertFiniteSState(after);
    const record = opened.rt.memoryStore().all().find((m) => m.id === stored.id);
    if (record !== undefined) {
      expect(record.vividness, "60 天后仍在热档的这条记忆，鲜明度应该掉下来").toBeLessThan(beforeVividness);
      expect(record.vividness).toBeGreaterThanOrEqual(0);
    } else {
      // 不在热档 = 被遗忘/被冷归档，两者都必须有账可查，不能"凭空消失"
      expect(forgottenTotal + archivedTotal, "记忆离开热档必须有遗忘或归档记录").toBeGreaterThan(0);
    }
    // 次数是有限的：60 天推进不会把 turns 变成 NaN
    expect(Number.isFinite(Number(after["turns"]))).toBe(true);
    expect(Number(after["turns"])).toBe(Number(before["turns"]));
  });

  it("1000 个真实回合：状态无 NaN、记忆写入是线性的", async () => {
    const opened = await open();
    const firstTurns = Number((opened.rt.snapshot() as Record<string, unknown>)["turns"]);

    // `turn()` 的 appraisal 是必填项（规格里它是"这一句怎么被理解"的五成分），
    // 所以慢速仿真也必须按真实形状喂，否则测的不是线上那条路径。
    const POSITIVE = { goal_congruence: 0.8, goal_relevance: 0.7, coping_potential: 0.8, novelty: 0.3, legitimacy: 0.9 };
    const NEUTRAL = { goal_congruence: 0.1, goal_relevance: 0.5, coping_potential: 0.6, novelty: 0.4, legitimacy: 0.7 };
    const NEGATIVE = { goal_congruence: -0.6, goal_relevance: 0.8, coping_potential: 0.4, novelty: 0.2, legitimacy: 0.3 };
    for (let i = 0; i < 1000; i += 1) {
      opened.rt.turn({
        text: i % 3 === 0 ? "今天有点累，但还是想跟你说话" : i % 3 === 1 ? "刚看完一个视频，讲的是深海里的鱼" : "你在吗？",
        appraisal: i % 3 === 0 ? POSITIVE : i % 3 === 1 ? NEUTRAL : NEGATIVE,
        source: "player",
        eventType: "conversation",
      });
    }

    const snap = opened.rt.snapshot() as Record<string, unknown>;
    assertFiniteSState(snap);
    expect(Number(snap["turns"]) - firstTurns).toBe(1000);
    const memories = opened.rt.memoryStore().active();
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.length).toBeLessThanOrEqual(1000);
    // 每条记忆的数值同样必须有限（这是 1000 轮之后最常见的污染点）
    for (const m of memories.slice(0, 50)) {
      expect(Number.isFinite(m.vividness)).toBe(true);
      expect(Number.isFinite(m.base_activation)).toBe(true);
    }
  });

  it("800 条 60 天前的知识：一次重算全部到位，且再跑一次是幂等的", async () => {
    const opened = await open();
    const store = opened.rt.knowledgeStore();
    const ingestedAt = opened.clock.now() - 60 * DAY;
    for (let i = 0; i < 800; i += 1) {
      store.put({
        id: `kn_nightly_${i}`,
        content: `第 ${i} 条旧知识：深海鱼在高压下靠渗透压调节`,
        knowledge_type: "trend",
        source: "bili",
        freshness: 0.9,
        ingested_at: ingestedAt,
        social_freshness: 0.5,
      } as never);
    }
    expect(store.size()).toBe(800);

    const changed = opened.rt.refreshKnowledgeFreshness();
    expect(changed, "60 天前的记录应该全部被重算").toBe(800);
    const afterFirst = store.all().map((k) => k.freshness);
    expect(Math.max(...afterFirst), "重算之后不该还有 0.9 的旧值").toBeLessThan(0.9);
    expect(Math.min(...afterFirst)).toBeGreaterThanOrEqual(0);

    const again = opened.rt.refreshKnowledgeFreshness();
    expect(again, "同样的时间点再算一次不该再改任何记录（epsilon 以内）").toBe(0);
    expect(store.all().map((k) => k.freshness)).toEqual(afterFirst);
  });
});
