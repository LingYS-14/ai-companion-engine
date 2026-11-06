/**
 * A4 收紧的**配置锁**（F240）。
 *
 * 为什么锁：A4 的语义是"只有 speak 类别才允许主动开口"，但第一版只把 `intentCtx`
 * 在 speak 时交给 bridge，其它出口传 `undefined` —— bridge 拿到 undefined 就退回
 * 旧主动路径（旧机械门 + quota 自己决定），于是出现"她说的话不是意向引擎决定的"。
 * 这类缺口不会被类型检查抓到（都是可选参数），只能在装配层锁字符串。
 *
 * 同时锁"重提"：闸放行后，表里还没说出口的 speak 类意图必须能被重新选中，
 * 否则一句被额度拦下的话会烂在表里直到 7 天过期。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { newIntention } from "../src/orchestrator/intent/bus.js";
import { resolveEffectiveOutlet } from "../src/orchestrator/intent/lookahead.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");

describe("F240：outlet≠speak 时不许旧主动路径替她开口", () => {
  it("proactiveImpl 有严格 A4 守卫（engine 开且出口不是 speak 就跳过）", () => {
    expect(main).toContain('outlet !== "speak"');
    expect(main).toContain("A4：只有 speak 才主动开口");
    expect(main).toContain("reason: \"outlet\"");
  });

  it("旧路径不再能在 journal/idle 出口上偷偷开口（不再把 intentCtx 置 undefined）", () => {
    // 旧写法：const intentCtx = lastIntentContext?.outlet === "speak" ? lastIntentContext : undefined;
    expect(main).not.toMatch(/outlet === "speak"\s*\?\s*lastIntentContext\s*:\s*undefined/);
  });
});

describe("F252：发送日志必须带意图 kind", () => {
  it("发送日志行里有 kind=（让每条消息能回溯到类别）", () => {
    expect(main).toContain('kind=${lastIntentContext?.kind ?? "none"}');
  });
});

describe("F240：被拦下的话要能被重新提起", () => {
  it("装配层调用 pickSpeakableIntention", () => {
    expect(main).toContain("pickSpeakableIntention");
  });

  it("重提时用 effectiveOutlet 覆盖出口，并打日志（文案由 lookahead.resolveEffectiveOutlet 给）", () => {
    expect(main).toContain("effectiveOutlet");
    expect(main).toContain("上次被拦下，额度回来了");
    // F240 的 note 文案已搬进纯函数（design v3 B3）：行为锁在纯函数上，
    // 不再靠 main.mjs 注释里的字面量冒充覆盖（task-196 复核指出的假绿）。
    const speakable = newIntention({
      id: "itn-reach_out-1",
      at: "2026-10-31T02:00:00.000Z",
      kind: "reach_out",
      goal: "想找用户说句话",
      why: "因为想有人陪",
    });
    const resolved = resolveEffectiveOutlet({
      due: null,
      speakable,
      outlet: { target: "journal", kind: null, line: null, whyLine: null, note: "" },
    });
    expect(resolved.effective.target).toBe("speak");
    expect(resolved.effective.note).toBe("接着上次被额度拦住的那句话");
  });

  it("tick 日志与观测行也用 effectiveOutlet（否则日志会骗人）", () => {
    // 至少出现两次：一次日志、一次 shadow 记录
    const hits = main.match(/effectiveOutlet/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });
});

describe("A5/F240：处境必须以 { lines } 形状交给桥（线上首跑抓到过数组形状）", () => {
  it("lastIntentContext 的 situation 是对象，不是数组", () => {
    // P2a/T2：形状转换搬进 close-loop.intentContextOf（main 只把 situation 传进去）
    const closeLoop = readFileSync(
      join(ROOT, "src", "orchestrator", "intent", "close-loop.ts"),
      "utf8",
    );
    expect(closeLoop).toContain("situation: { lines: input.situation }");
    expect(main).toContain("situation,");
    expect(main).not.toMatch(/\{\s*situation\s*\}/);
  });
});

describe("F246：重提的连发保护（不是主动门）", () => {
  it("装配层有 10 分钟间隔常量与'先放着'日志", () => {
    expect(main).toContain("RE_RAISE_QUIET_MIN = 10");
    expect(main).toContain("重提：先放着");
    expect(main).toContain("分钟前刚开口过");
  });

  it("处境信号只读一次，并先装成时间快照再渲染 (P1)", () => {
    expect(main).toContain("const situationSignals = readSituationSignals(situationDeps(nowMs))");
    expect(main).toContain("buildTemporalSnapshot({");
    expect(main).toContain("buildSituationNote(temporal)");
    // 不得在构造处境时又读一遍（两拍之间状态会变）
    expect(main).not.toContain("...readSituationSignals(");
  });

  it("just-spoke 行由 situation-note 产出，装配层不自己拼", () => {
    expect(main).toContain("buildSituationNote");
    expect(main).not.toContain("刚主动说过一句");
  });

  it("时间快照的「他上一次说话」用 peer-only 字段，不用含她回复的来往时间（监督 blocking 的回归锁）", () => {
    // lastContactMs = max(onebotLastEventAt, lastReplyAt)，而 lastReplyAt 是她回复时写的；
    // 把它当 sinceLastUserMsgMin 会在她刚回过一句之后说出「他刚刚说话」的假事实。
    expect(main).toContain("sinceLastUserMsgMin: situationSignals.sinceLastPeerMsgMin");
    expect(main).toContain("unansweredOwnMsgs: situationSignals.proactiveSinceLastPeerEvent");
    expect(main).not.toContain("sinceLastUserMsgMin: situationSignals.sinceLastContactMin");
    expect(main).not.toContain("unansweredOwnMsgs: situationSignals.proactiveSinceLastContact");
  });
});

describe("F312：同类重复刹车与 40 条上限的接线锁", () => {
  it("装配层算出说够次数的类别，并交给 tick 过滤", () => {
    expect(main).toContain("const suppressedKinds = exhaustedSpeakKinds(intentRecords, nowMs)");
    expect(main).toContain("...(suppressedKinds.length === 0 ? {} : { suppressedKinds })");
  });

  it("所有意图表写盘都先裁剪（绕过 upsertIntention 的那几处也守住 40 条）", () => {
    expect(main).toContain("serializeIntentionFile(trimIntentions(records), Date.now())");
  });

  it("被压的类别连「重提」也不走——装配层必须走 decideReRaise 纯函数（不能四连 && 短路）", () => {
    expect(main).toContain("const reRaise = decideReRaise({");
    expect(main).toContain("reRaiseQuietMin: RE_RAISE_QUIET_MIN");
    expect(main).toContain("const speakable = reRaise.speakable;");
    // 反锁：曾经把两个否定条件并进四连 &&，短路后反而放行被压类别（supervisor 打回的那处）
    expect(main).not.toContain("!suppressedKinds.includes(speakableCandidate.kind)");
    expect(main).toContain("reRaise.blocked === \"suppressed\"");
  });
});
