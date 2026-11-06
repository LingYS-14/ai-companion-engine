import { describe, expect, it } from "vitest";
import { clamp01, initialSState, type SState } from "../src/engine/state.js";
import type { Stage } from "../src/engine/bonds.js";
import { runIntentTick, tickDriveInput } from "../src/orchestrator/intent/tick.js";
import {
  COMPETENCE_FAILURE_WEIGHT,
  CONNECTION_BY_STAGE,
  CONTACT_FULL_GAP_MIN,
  CONTACT_WEIGHT,
  DEFAULT_NOVELTY_GAP,
  projectDrive,
  UNANSWERED_DECAY,
  UNANSWERED_FULL_COUNT,
  type DriveInput,
} from "../src/orchestrator/intent/drive.js";

const STAGES: Stage[] = ["stranger", "familiar", "close", "beloved"];

function state(overrides: Partial<SState> = {}): SState {
  return { ...initialSState(), ...overrides };
}

function input(overrides: Partial<DriveInput> = {}): DriveInput {
  return {
    state: state(),
    stage: "stranger",
    sinceLastContactMin: 0,
    recentFailureRate: 0,
    openIntentCount: 0,
    maxOpenIntents: 5,
    coverageGap: 0.5,
    valueDeviation: 0,
    ...overrides,
  };
}

describe("B0 稳态投影（§4.2）", () => {
  it("基准投影：六维按文档来源逐项成立（可手算）", () => {
    const drive = projectDrive(
      input({ state: state({ energy: 0.4, suppressionLoad: 0.2 }), coverageGap: 0.3, valueDeviation: 0.1 }),
    );
    expect(drive.energy).toBeCloseTo(0.6, 12); // 1 − 0.4
    expect(drive.integrity).toBeCloseTo(0.2, 12); // suppression_load 原值
    expect(drive.connection).toBeCloseTo(CONNECTION_BY_STAGE.stranger, 12); // 刚联系过 = 阶段基线
    expect(drive.competence).toBeCloseTo(0, 12); // 没失败、没挂起意图
    expect(drive.novelty).toBeCloseTo(0.3, 12); // coverageGap 原值
    expect(drive.coherence).toBeCloseTo(0.1, 12); // valueDeviation 原值
  });

  it("energy 与 integrity 是逐项映射，不是二次加工", () => {
    for (const energy of [0, 0.25, 0.5, 0.75, 1]) {
      for (const suppressionLoad of [0, 0.3, 0.7, 1]) {
        const drive = projectDrive(
          input({ state: state({ energy, suppressionLoad, maskIntegrity: 0.1 }) }),
        );
        expect(drive.energy).toBeCloseTo(1 - energy, 12);
        expect(drive.integrity).toBeCloseTo(suppressionLoad, 12);
      }
    }
  });

  it("connection = 阶段基线 + 联系衰减爬升，最多到 1（不会溢出）", () => {
    for (const stage of STAGES) {
      const base = CONNECTION_BY_STAGE[stage];
      // 刚联系过
      expect(projectDrive(input({ stage })).connection).toBeCloseTo(base, 12);
      // 半程
      const half = projectDrive(input({ stage, sinceLastContactMin: CONTACT_FULL_GAP_MIN / 2 })).connection;
      expect(half).toBeCloseTo(Math.min(1, base + CONTACT_WEIGHT * 0.5), 12);
      // 爬满（beloved 的基线低，爬满后仍未到 1）
      const full = projectDrive(input({ stage, sinceLastContactMin: CONTACT_FULL_GAP_MIN })).connection;
      expect(full).toBeCloseTo(Math.min(1, base + CONTACT_WEIGHT), 12);
      // 再久也不超过 1
      const longer = projectDrive(input({ stage, sinceLastContactMin: CONTACT_FULL_GAP_MIN * 10 })).connection;
      expect(longer).toBeCloseTo(full, 12);
      expect(longer).toBeLessThanOrEqual(1);
    }
    // 越亲近基线越低：这是"常联系的人不需要主动补连接"的工程表达
    expect(CONNECTION_BY_STAGE.stranger).toBeGreaterThan(CONNECTION_BY_STAGE.familiar);
    expect(CONNECTION_BY_STAGE.familiar).toBeGreaterThan(CONNECTION_BY_STAGE.close);
    expect(CONNECTION_BY_STAGE.close).toBeGreaterThan(CONNECTION_BY_STAGE.beloved);
    expect(CONNECTION_BY_STAGE.beloved).toBeGreaterThan(0); // 再亲也不会归零
  });

  it("competence = 失败率权重 + 未完成意图负载（上限为 0 时负载项记 0，不除零）", () => {
    const drive = projectDrive(
      input({ recentFailureRate: 0.5, openIntentCount: 2, maxOpenIntents: 5 }),
    );
    expect(drive.competence).toBeCloseTo(
      COMPETENCE_FAILURE_WEIGHT * 0.5 + (1 - COMPETENCE_FAILURE_WEIGHT) * (2 / 5),
      12,
    );
    const noSlot = projectDrive(
      input({ recentFailureRate: 0.5, openIntentCount: 3, maxOpenIntents: 0 }),
    );
    expect(noSlot.competence).toBeCloseTo(COMPETENCE_FAILURE_WEIGHT * 0.5, 12);
  });

  it("novelty：有缺口用原值，没记录取中性值，越界被夹住", () => {
    expect(projectDrive(input({ coverageGap: 0 })).novelty).toBeCloseTo(0, 12);
    expect(projectDrive(input({ coverageGap: 1.4 })).novelty).toBe(1);
    expect(projectDrive(input({ coverageGap: -0.2 })).novelty).toBe(0);
    const noRecord = projectDrive(input({ coverageGap: undefined }));
    expect(noRecord.novelty).toBeCloseTo(DEFAULT_NOVELTY_GAP, 12);
  });

  it("所有输入组合下六维都在 [0,1] 且有限（12×4×4 网格）", () => {
    const energies = [0, 0.33, 0.66, 1];
    const contact = [0, 45, 90, 179, 180, 500];
    for (const stage of STAGES) {
      for (const energy of energies) {
        for (const minutes of contact) {
          for (const failure of [0, 0.5, 1]) {
            const drive = projectDrive(
              input({
                stage,
                state: state({ energy, suppressionLoad: energy }),
                sinceLastContactMin: minutes,
                recentFailureRate: failure,
                openIntentCount: 4,
                valueDeviation: 0.5,
                coverageGap: 0.5,
              }),
            );
            for (const [key, value] of Object.entries(drive)) {
              expect(Number.isFinite(value), `${stage}/${energy}/${minutes}/${failure} 的 ${key}`).toBe(true);
              expect(value).toBeGreaterThanOrEqual(0);
              expect(value).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it("纯函数：同输入同输出，且不修改输入（P0 golden replay 的前提）", () => {
    const inp = input({
      state: state({ energy: 0.2, suppressionLoad: 0.45 }),
      stage: "close",
      sinceLastContactMin: 95,
      recentFailureRate: 0.25,
      openIntentCount: 1,
    });
    const before = JSON.stringify(inp);
    const a = projectDrive(inp);
    const b = projectDrive(inp);
    expect(a).toEqual(b);
    expect(JSON.stringify(inp)).toBe(before);
  });

  it("非法输入当场抛 RangeError，不把 NaN 带进打分", () => {
    expect(() => projectDrive(input({ state: state({ energy: Number.NaN }) }))).toThrow(RangeError);
    expect(() => projectDrive(input({ state: state({ suppressionLoad: Number.NaN }) }))).toThrow(RangeError);
    expect(() => projectDrive(input({ sinceLastContactMin: -1 }))).toThrow(RangeError);
    expect(() => projectDrive(input({ recentFailureRate: Number.NaN }))).toThrow(RangeError);
    expect(() => projectDrive(input({ openIntentCount: -2 }))).toThrow(RangeError);
    expect(() => projectDrive(input({ maxOpenIntents: -1 }))).toThrow(RangeError);
    expect(() => projectDrive(input({ coverageGap: Number.NaN }))).toThrow(RangeError);
    expect(() => projectDrive(input({ valueDeviation: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
  });
});

describe("主动了没人回：connection 缺口衰减（批次2，D2 离线先验值）", () => {
  it("不传 unansweredOwnCount：六维与引入衰减前的旧 gold 逐项一致", () => {
    const base = input({
      state: state({ energy: 0.2, suppressionLoad: 0.45 }),
      stage: "close",
      sinceLastContactMin: 95,
      recentFailureRate: 0.25,
      openIntentCount: 1,
      maxOpenIntents: 5,
      coverageGap: 0.5,
      valueDeviation: 0.1,
    });
    const drive = projectDrive(base);
    // 旧 gold 的六维（可手算）：energy 1−0.2；integrity 0.45；connection 0.4+0.35×(95/180)；
    // competence 0.6×0.25+0.4×(1/5)；novelty 0.5；coherence 0.1。
    expect(drive.energy).toBeCloseTo(0.8, 12);
    expect(drive.integrity).toBeCloseTo(0.45, 12);
    expect(drive.connection).toBeCloseTo(
      clamp01(CONNECTION_BY_STAGE.close + CONTACT_WEIGHT * (95 / CONTACT_FULL_GAP_MIN)),
      12,
    );
    expect(drive.competence).toBeCloseTo(
      COMPETENCE_FAILURE_WEIGHT * 0.25 + (1 - COMPETENCE_FAILURE_WEIGHT) * (1 / 5),
      12,
    );
    expect(drive.novelty).toBeCloseTo(0.5, 12);
    expect(drive.coherence).toBeCloseTo(0.1, 12);
    // 显式传 0 与完全不传必须逐字段相等：缺省值就是旧行为，不是"另一种模式"。
    expect(projectDrive({ ...base, unansweredOwnCount: 0 })).toEqual(drive);
  });

  it("顶格想说话的 stranger：连说 1/2/3 句 → 0.85 / 0.70 / 0.55，3 句后封顶", () => {
    const at = input({ stage: "stranger", sinceLastContactMin: CONTACT_FULL_GAP_MIN * 10 });
    expect(projectDrive(at).connection).toBe(1);
    expect(projectDrive({ ...at, unansweredOwnCount: 1 }).connection).toBeCloseTo(1 - UNANSWERED_DECAY / 3, 12);
    expect(projectDrive({ ...at, unansweredOwnCount: 2 }).connection).toBeCloseTo(
      1 - (2 * UNANSWERED_DECAY) / 3,
      12,
    );
    expect(projectDrive({ ...at, unansweredOwnCount: 3 }).connection).toBeCloseTo(1 - UNANSWERED_DECAY, 12);
    // 10 句不会继续往下掉（clamp01(n/3) 封顶）：最低点仍高于 close/beloved 的阶段基线。
    const capped = projectDrive({ ...at, unansweredOwnCount: 10 }).connection;
    expect(capped).toBeCloseTo(1 - UNANSWERED_DECAY, 12);
    expect(capped).toBeGreaterThan(CONNECTION_BY_STAGE.close);
    expect(capped).toBeGreaterThan(CONNECTION_BY_STAGE.beloved);
  });

  it("所有阶段/联系距离下：connection 单调不升、夹在 [0,1]，其他五维一个都不动", () => {
    const counts = [0, 1, 2, 3, 10];
    for (const stage of STAGES) {
      for (const minutes of [0, CONTACT_FULL_GAP_MIN / 2, CONTACT_FULL_GAP_MIN, CONTACT_FULL_GAP_MIN * 10]) {
        const without = projectDrive(input({ stage, sinceLastContactMin: minutes }));
        let prev = without.connection;
        for (const n of counts.slice(1)) {
          const d = projectDrive(input({ stage, sinceLastContactMin: minutes, unansweredOwnCount: n }));
          expect(d.connection, `${stage}/${minutes}/${n}`).toBeLessThanOrEqual(prev);
          // 触底（0）之后不再"严格下降"：clamp01 把负值夹平，是设计如此。
          if (n <= UNANSWERED_FULL_COUNT && prev > 0) expect(d.connection, `${stage}/${minutes}/${n}`).toBeLessThan(prev);
          expect(d.connection).toBeGreaterThanOrEqual(0);
          expect(d.connection).toBeLessThanOrEqual(1);
          prev = d.connection;
          expect(d.energy).toBe(without.energy);
          expect(d.integrity).toBe(without.integrity);
          expect(d.competence).toBe(without.competence);
          expect(d.novelty).toBe(without.novelty);
          expect(d.coherence).toBe(without.coherence);
        }
      }
    }
  });

  it("非法 unansweredOwnCount 当场抛 RangeError（负条数/NaN 不污染打分）", () => {
    expect(() => projectDrive(input({ unansweredOwnCount: -1 }))).toThrow(RangeError);
    expect(() => projectDrive(input({ unansweredOwnCount: Number.NaN }))).toThrow(RangeError);
  });
});

describe("接线：tick 把 unansweredOwnCount 透传到 projectDrive", () => {
  const AT = "2026-10-31T03:20:00.000Z";
  function tickInput(overrides: Partial<Parameters<typeof runIntentTick>[0]> = {}) {
    return {
      situation: {
        at: AT,
        localHour: 14,
        channel: "local" as const,
        participants: [],
        affordances: [],
        sinceLastContactMin: 30,
        activeIntents: [],
        budget: { rph: 8, peak: false },
        singleWriterConflict: false,
      },
      state: state(),
      stage: "close" as Stage,
      recentFailureRate: 0,
      openIntentCount: 0,
      maxOpenIntents: 3,
      valueDeviation: 0,
      trust: 0.5,
      trustFloor: 0.1,
      ...overrides,
    };
  }

  it("不传时 DriveInput 里没有该字段（旧形状）；传了就按原值透传", () => {
    expect(tickDriveInput(tickInput()).unansweredOwnCount).toBeUndefined();
    expect(tickDriveInput(tickInput({ unansweredOwnCount: 2 })).unansweredOwnCount).toBe(2);
  });

  it("端到端：runIntentTick 的 drive.connection 随 unansweredOwnCount 下降", () => {
    const without = runIntentTick(tickInput());
    const withUnanswered = runIntentTick(tickInput({ unansweredOwnCount: 2 }));
    expect(withUnanswered.drive.connection).toBeLessThan(without.drive.connection);
    expect(without.drive.connection - withUnanswered.drive.connection).toBeCloseTo(
      (2 * UNANSWERED_DECAY) / 3,
      12,
    );
  });
});
