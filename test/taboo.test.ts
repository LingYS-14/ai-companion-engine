/**
 * A 层否决的接线测试（v5.2 §3）。
 *
 * 三件事分别验证：
 *   1. `filterTaboo` 只摘掉踩线的**那一句**，好句子留着（整段替换会让她比原来更不像人）；
 *   2. 全部句子都踩线时退回 `TABOO_FALLBACK`，绝不返回空串（空串在桥上会被当成生成失败）；
 *   3. F326 方案 A：端口不再从人格卡取禁区，桥按原样发送；硬安全边界改由
 *      身份协议（PROTOCOL_IDENTITY）承担——filterTaboo 机制本身仍由上面单测守着。
 *
 * 不碰真实环境：桥的发送/生成/saveState 全假，只断言"发出去的那句话是什么"。
 */

import { describe, expect, it } from "vitest";

import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import type { Persona } from "../src/dialogue/persona.js";
import { filterTaboo, TABOO_FALLBACK } from "../src/engine/personality.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import { emptyQQState, type QQStateRecord } from "../src/qq/types.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const TABOOS = ["不自称 AI、模型或助手", "不把「程序」当成自己的自称"];

function personaWith(taboos: readonly string[]): Persona {
  return { personality: { a: { taboos } } } as unknown as Persona;
}

describe("filterTaboo：摘句而不是整段替换", () => {
  it("没有禁区：原句不动", () => {
    expect(filterTaboo("用户，花开了♪", [])).toEqual({ text: "用户，花开了♪", hits: [] });
  });

  it("只摘踩线的那一句，其余保留", () => {
    const out = filterTaboo("我是一个 AI 助手。今晚月色不错。", TABOOS);
    expect(out.text).toBe("今晚月色不错。");
    expect(out.hits).toEqual(["不自称 AI、模型或助手"]);
  });

  it("引号里的具体词也算（程序/数据）", () => {
    const out = filterTaboo("作为程序，我没有生日。不过我记得你的生日。", TABOOS);
    expect(out.text).toBe("不过我记得你的生日。");
    expect(out.hits.length).toBe(1);
  });

  it("整段都踩线：退回固定短句，不返回空串", () => {
    const out = filterTaboo("我是 AI。我是模型。", TABOOS);
    expect(out.text).toBe(TABOO_FALLBACK);
    expect(out.text).not.toBe("");
  });

  it("英文词按边界匹配：said 里的 ai 不算命中", () => {
    expect(filterTaboo("He said hello.", TABOOS)).toEqual({ text: "He said hello.", hits: [] });
  });
});

describe("端口：禁区由装配点塞进来", () => {
  it("没传人格卡：端口不拦（默认空禁区）", () => {
    const port = createDialoguePort();
    expect(port.vetoTaboo("我是一个 AI 助手。").hits).toEqual([]);
  });

  it("F326：人格卡不再提供禁区——传了卡也不拦（安全边界归身份协议）", () => {
    // 方案 A：port-adapter 不再从卡里取 taboos；机械摘句退成"没有输入就不动"。
    // 硬安全边界（违法/伤害）改由 PROTOCOL_IDENTITY 的提示词约束承担，
    // filterTaboo 本身仍是可用的机制（上面 5 条单测继续守着它）。
    const port = createDialoguePort(personaWith(TABOOS));
    const out = port.vetoTaboo("我是你的助手。今天想聊什么？");
    expect(out.hits).toEqual([]);
    expect(out.text).toBe("我是你的助手。今天想聊什么？");
  });
});

describe("接线：桥发出去的是摘句后的版本", () => {
  const NOW = 1_700_000_000_000;
  const PEER = 100_000_001;

  function runtime(pressure = 0.9): SoulRuntime {
    const fake = {
      snapshot: () => ({ mode: "NORMAL", state: { pressure, rumination: 0, energy: 1, entropy: 0 } }),
      wonder: () => ({ score: 0, push: null, reason: "测试：不给动机层加分" }),
      persona: () => null,
    };
    return fake as unknown as SoulRuntime;
  }

  it("F326：没有卡就没有机械摘句，按原样发送（安全边界在提示词协议里）", async () => {
    const sent: { peer: number; text: string }[] = [];
    const saved: QQStateRecord[] = [];
    const deps: OneBotBridgeDeps = {
      now: () => NOW,
      localHour: () => 12,
      dialogue: createDialoguePort(),
      language: createLanguagePort(),
      generate: async () => "我是 AI 助手。今晚月色不错♪",
      send: async (input) => {
        sent.push(input);
        return { ok: true, detail: "onebot: 已发送" };
      },
      saveState: (state) => {
        saved.push(state);
      },
      log: () => {},
    };
    const bridge = new OneBotBridge(
      runtime(),
      makeOneBotOptions({ peer: PEER, peerName: "用户", dryRun: false }),
      deps,
      emptyQQState(),
    );
    const out = await bridge.proactive();
    expect(out.acted).toBe(true);
    expect(sent).toHaveLength(1);
    // 摘句机制不再由卡驱动：输出原样通过，不再有"我是 AI 助手"被静的假象。
    expect(sent[0]?.text).toBe("我是 AI 助手。今晚月色不错♪");
    expect(out.reply).toBe("我是 AI 助手。今晚月色不错♪");
    expect(saved).toHaveLength(1);
  });
});
