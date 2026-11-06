/**
 * QQ 桥的规则测试。
 *
 * 不碰真 QQ、不跑 bash：bridge 的外部世界全在 QQDeps 里，这里用假 deps。
 * 覆盖的是**会让人踩坑的判断**：回声/去重/静默/限速/发送失败要不要推进游标。
 */

import { describe, expect, it } from "vitest";

import { QQBridge, type QQDeps } from "../src/qq/bridge.js";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";
import { decideReply, isEcho } from "../src/qq/filter.js";
import { imageNote, parseInbound, unreadImageNote } from "../src/qq/inbound.js";
import { cleanReply, qqSystemPrompt, qqUserPrompt } from "../src/dialogue/prompt.js";
// 桥的「嘴」现在由装配点注入端口；测试直接用真适配器（测试不受分层门禁约束）
import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { DEFAULT_QQ_OPTIONS, emptyQQState, type InboxMessage, type QQOptions, type QQStateRecord } from "../src/qq/types.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";
import type { Persona } from "../src/dialogue/persona.js";

/** 测试里直接拿真端口：appraisal 需要语言特征提取 */
const appraise = (text: string) => appraiseFromText(text, createLanguagePort());

const NOW = 1_700_000_000_000;
const opts = (over: Partial<QQOptions> = {}): QQOptions => ({ ...DEFAULT_QQ_OPTIONS, ignoreOlderThanMs: 60_000, ...over });

function msg(id: string, text: string, over: Partial<InboxMessage> = {}): InboxMessage {
  return { id, epochNs: (NOW - 5_000) * 1e6, at: "12:00:00", sender: "用户", text, ...over };
}

type RT = SoulRuntime;

function fakeRuntime(calls: { text: string; source?: string }[] = []): RT {
  const fake = {
    turn(req: { text: string }, o: { source?: string }) {
      calls.push({ text: req.text, source: o.source });
      return {
        mode: "NORMAL",
        stage: "stranger",
        bondProgress: 0,
        state: {},
        style: { modeStyle: "平常", stageStyle: "客气", expressionStyle: "稳", suppressInstruction: "不必压", signals: {} },
        expression: { tone: "稳", move: "聊", avoid: "别急", quadrant: "secure", stage: "stranger", source: "table" },
        eventStyle: null,
        memory: { wrote: 1, rejected: 0 },
        bandit: { actionTag: "care", ucb: 0, source: "fallback", candidates: [], scored: false },
        // 只有 bridge 用到的字段是必须的，其余给个空对象占位
      } as unknown as ReturnType<RT["turn"]>;
    },
    persona: (): Persona | null => null,
  };
  return fake as unknown as RT;
}

interface Harness {
  readonly deps: QQDeps;
  readonly sent: string[];
  readonly saved: QQStateRecord[];
  readonly inbox: InboxMessage[];
  readonly logs: string[];
}

interface GenInput {
  readonly system: string;
  readonly prompt: string;
  readonly images?: readonly { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }[];
}

function harness(over: {
  generate?: () => Promise<string>;
  generateIn?: (input: GenInput) => Promise<string>;
  readImage?: (path: string) => Promise<{ data: Uint8Array; mediaType: string; name?: string } | null>;
  sendOk?: boolean;
} = {}): Harness {
  const sent: string[] = [];
  const saved: QQStateRecord[] = [];
  const logs: string[] = [];
  const inbox: InboxMessage[] = [];
  let state: QQStateRecord = emptyQQState();
  const deps: QQDeps = {
    now: () => NOW,
    localHour: () => 12,
    appraise,
    readInbox: () => inbox,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    saveState: (s) => {
      state = s;
      saved.push(s);
    },
    generate: over.generate ?? over.generateIn ?? (async () => "嗯，我在呢♪"),
    ...(over.readImage === undefined ? {} : { readImage: over.readImage }),
    send: async (text) => {
      sent.push(text);
      return { ok: over.sendOk ?? true, detail: "sent at 700,1200" };
    },
    log: (line) => logs.push(line),
  };
  return { deps, sent, saved, inbox, logs };
}

describe("appraiseFromText", () => {
  it("指责 → 负向、eventType=争吵", () => {
    const r = appraise("你到底有没有在听我说话？每次都这样！");
    expect(r.contextTag).toBe("conflict");
    expect(r.eventType).toBe("争吵");
    expect(r.appraisal.goal_congruence).toBeLessThan(0);
    expect(r.appraisal.goal_relevance).toBeGreaterThan(0.7);
  });

  it("夸奖 → 正向、eventType=夸奖", () => {
    const r = appraise("你今天真可爱，好喜欢你");
    expect(r.contextTag).toBe("praise");
    expect(r.appraisal.goal_congruence).toBeGreaterThan(0.5);
  });

  it("普通闲聊落到 neutral，且数值都在合法域内", () => {
    const r = appraise("今天吃了面条");
    expect(r.contextTag).toBe("neutral");
    for (const v of Object.values(r.appraisal)) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("感叹号抬 novelty，问号抬 relevance", () => {
    const base = appraise("今天下雨");
    const loud = appraise("今天下雨！！！");
    const asked = appraise("今天下雨吗？");
    expect(loud.appraisal.novelty).toBeGreaterThan(base.appraisal.novelty);
    expect(asked.appraisal.goal_relevance).toBeGreaterThan(base.appraisal.goal_relevance);
  });
});

describe("decideReply", () => {
  it("空消息/自己发的/带 tag 的回声都跳过", () => {
    const o = opts();
    const state = emptyQQState();
    expect(decideReply({ msg: msg("a", "  "), opts: o, state, now: NOW, localHour: 12 }).reason).toBe("empty");
    expect(decideReply({ msg: msg("b", "在吗", { sender: "鲸鱼" }), opts: o, state, now: NOW, localHour: 12 }).reason).toBe("echo");
    expect(decideReply({ msg: msg("c", "[ase] 在吗"), opts: o, state, now: NOW, localHour: 12 }).reason).toBe("echo");
    expect(isEcho(msg("d", "x", { sender: "" }), o)).toBe(true);
  });

  it("不是 peer 的人不回", () => {
    const d = decideReply({ msg: msg("a", "在吗", { sender: "路人" }), opts: opts(), state: emptyQQState(), now: NOW, localHour: 12 });
    expect(d.reason).toBe("not-peer");
  });

  it("回过的、太旧的、静默时段、间隔不足、超速都不回", () => {
    const o = opts({ minGapMs: 8_000, maxPerHour: 2 });
    const base = emptyQQState();
    expect(
      decideReply({ msg: msg("a", "在吗"), opts: o, state: { ...base, repliedIds: ["a"] }, now: NOW, localHour: 12 }).reason,
    ).toBe("duplicate");
    expect(
      decideReply({ msg: msg("b", "在吗", { epochNs: (NOW - 10 * 60_000) * 1e6 }), opts: o, state: base, now: NOW, localHour: 12 }).reason,
    ).toBe("stale");
    expect(decideReply({ msg: msg("c", "在吗"), opts: o, state: base, now: NOW, localHour: 3 }).ok).toBe(true);
    expect(
      decideReply({ msg: msg("d", "在吗"), opts: o, state: { ...base, lastReplyAt: NOW - 1_000 }, now: NOW, localHour: 12 }).reason,
    ).toBe("gap");
    expect(
      decideReply({
        msg: msg("e", "在吗"),
        opts: o,
        state: { ...base, replyTimes: [NOW - 1_000, NOW - 2_000] },
        now: NOW,
        localHour: 12,
      }).reason,
    ).toBe("rate");
  });

  it("静默时段跨午夜也成立（22–7）", () => {
    const o = opts({ quietFrom: 22, quietTo: 7 });
    expect(decideReply({ msg: msg("a", "在吗"), opts: o, state: emptyQQState(), now: NOW, localHour: 23 }).ok).toBe(true);
    expect(decideReply({ msg: msg("b", "在吗"), opts: o, state: emptyQQState(), now: NOW, localHour: 3 }).ok).toBe(true);
    expect(decideReply({ msg: msg("c", "在吗"), opts: o, state: emptyQQState(), now: NOW, localHour: 12 }).ok).toBe(true);
  });
});

describe("prompt 与清理", () => {
  const persona: Persona = { name: "AI助手", description: "一个普通青年，喜欢花与闪光的东西。" };

  it("F326：人格卡不再进系统提示，身份协议在；怎么说四层与硬规则不变", () => {
    // 传卡只为证明「传了也不渲染」：F326 方案 A 起身份由身份协议 + 记忆承接。
    const s = qqSystemPrompt({
      persona,
      mode: "NORMAL",
      modeStyle: "平常",
      stageStyle: "客气但亲近",
      expressionStyle: "稳",
      suppressInstruction: "不必压",
      eventPermission: null,
      eventAvoid: null,
    });
    expect(s).not.toContain("AI助手");
    expect(s).toContain("不要自称 AI");
    expect(s).toContain("关系阶段：客气但亲近");
    expect(s).toContain("不要用 emoji");
  });

  it("用户提示带历史与这一条", () => {
    const p = qqUserPrompt({
      peerName: "用户",
      text: "在吗",
      history: [
        { who: "peer", text: "早上好" },
        { who: "her", text: "早呀♪" },
      ],
    });
    expect(p).toContain("用户：在吗");
    expect(p).toContain("你：早呀♪");
  });

  it("cleanReply 去前缀/去 emoji/剥外壳/截断", () => {
    expect(cleanReply("AI助手：嗯，我在呢♪")).toBe("嗯，我在呢♪");
    expect(cleanReply("「在的哦♪」")).toBe("在的哦♪");
    // 把对方 QQ 号当称呼（2026-10-30 实测：「10000001，我刚学到…」）
    expect(cleanReply("10000001，我刚学到冷泡茶得用凉白开泡四小时。")).toBe("我刚学到冷泡茶得用凉白开泡四小时。");
    expect(cleanReply("在的，10000001。", 160, 10000001)).toBe("在的，。");
    expect(cleanReply("开心😄吧")).toBe("开心吧");
    expect(cleanReply("一".repeat(500)).length).toBeLessThanOrEqual(160);
    expect(cleanReply("```\n好呀♪\n```")).toBe("好呀♪");
    // 通道/代理挂上去的方括号标签不该出现在对方屏幕上（用户 2026-10-28 反馈）
    expect(cleanReply("[ase] [lead] 在呢♪")).toBe("在呢♪");
    expect(cleanReply("[ase]在呢♪")).toBe("在呢♪");
    // 「我刚在心里念了一句：…」这类旁白框架不该发到对方屏幕上（用户 2026-10-29 反馈）
    expect(cleanReply("我刚在心里念了一句：晚上的风有点凉。")).toBe("晚上的风有点凉。");
    expect(cleanReply("说到[ase]这个词时不剥")).toBe("说到[ase]这个词时不剥");
  });
});

describe("QQBridge 回合", () => {
  it("没有新消息 → idle", async () => {
    const h = harness();
    const b = new QQBridge(fakeRuntime(), opts(), h.deps);
    expect((await b.poll()).reason).toBe("idle");
  });

  it("试运行：生成台词但不发送，游标推进", async () => {
    const h = harness();
    const b = new QQBridge(fakeRuntime(), opts({ dryRun: true }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await b.poll();
    expect(r.reason).toBe("dry-run");
    expect(r.reply).toBe("嗯，我在呢♪");
    expect(h.sent).toEqual([]);
    expect(h.saved.at(-1)?.cursorEpochNs).toBe(msg("m1", "").epochNs);
    // 第二轮不该再回同一条
    expect((await b.poll()).reason).toBe("idle");
  });

  it("正式发送：发一次、记时间、记 id", async () => {
    const h = harness();
    const b = new QQBridge(fakeRuntime(), opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await b.poll();
    expect(r.reason).toBe("replied");
    expect(h.sent).toEqual(["嗯，我在呢♪"]);
    const saved = h.saved.at(-1);
    expect(saved?.repliedIds).toEqual(["m1"]);
    expect(saved?.lastReplyAt).toBe(NOW);
    expect(saved?.replyTimes.length).toBe(1);
  });

  it("发送失败不推进游标（下一轮还能重试）", async () => {
    const h = harness({ sendOk: false });
    const b = new QQBridge(fakeRuntime(), opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await b.poll();
    expect(r.reason).toBe("send-failed");
    expect(h.saved).toEqual([]);
    const again = await b.poll();
    expect(again.reason).toBe("send-failed");
  });

  it("连发多条只回最后一条，且不可回的批次会推进游标", async () => {
    const calls: { text: string; source?: string }[] = [];
    const h = harness();
    const b = new QQBridge(fakeRuntime(calls), opts({ dryRun: true }), h.deps);
    h.inbox.push(msg("m1", "第一条"), msg("m2", "第二条"), msg("m3", "最后一条"));
    await b.poll();
    expect(calls.map((c) => c.text)).toEqual(["最后一条"]);
    expect(calls[0]?.source).toBe("qq_contact_verified");

    const h2 = harness();
    const b2 = new QQBridge(fakeRuntime(), opts(), h2.deps);
    h2.inbox.push(msg("x1", "在吗", { sender: "路人" }));
    const skipped = await b2.poll();
    expect(skipped.reason).toBe("skipped");
    expect(h2.saved.at(-1)?.cursorEpochNs).toBeGreaterThan(0);
  });

  it("模型抛错 → llm-failed，且不推进游标", async () => {
    const h = harness({ generate: async () => Promise.reject(new Error("boom")) });
    const b = new QQBridge(fakeRuntime(), opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await b.poll();
    expect(r.reason).toBe("llm-failed");
    expect(h.sent).toEqual([]);
  });
});

describe("入站图片", () => {
  it("抽出路径并从正文里去掉 `<file://…>`", () => {
    const raw = "看这个 [图片 a1b2.png] <file:///C:/Users/user/Documents/Tencent Files/10000002/nt_qq/nt_data/Pic/2026-10/a1b2.png> 刚拍的";
    const r = parseInbound(raw);
    expect(r.text).toBe("看这个 刚拍的");
    expect(r.images).toHaveLength(1);
    expect(r.images[0]?.name).toBe("a1b2.png");
    expect(r.images[0]?.path).toBe("C:/Users/user/Documents/Tencent Files/10000002/nt_qq/nt_data/Pic/2026-10/a1b2.png");
  });

  it("多张图一次抽完，图片顺序保持", () => {
    const raw = "[图片 1.png] <file:///C:/a/1.png> [图片 2.png] <file:///C:/a/2.png>";
    const r = parseInbound(raw);
    expect(r.images.map((x) => x.name)).toEqual(["1.png", "2.png"]);
    expect(r.text).toBe("");
  });

  it("没有图片时原样返回（只压掉多余空格）", () => {
    const r = parseInbound("今天   好累");
    expect(r.images).toHaveLength(0);
    expect(r.text).toBe("今天 好累");
  });

  it("只有图没有字时给模型一句人话", () => {
    expect(imageNote(1)).toContain("一张图片");
    expect(imageNote(2)).toContain("2 张图片");
    expect(imageNote(0)).toBe("");
  });

  it("图片真的读进 generate，且提示词里没有本地路径", async () => {
    let seen: GenInput | undefined;
    const h = harness({
      generateIn: async (input) => {
        seen = input;
        return "收到啦♪";
      },
      readImage: async (path) =>
        path.endsWith("a1b2.png") ? { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png", name: "a1b2.png" } : null,
    });
    h.inbox.push(msg("m1", "看这个 [图片 a1b2.png] <file:///C:/a/a1b2.png> 刚拍的"));
    const bridge = new QQBridge(fakeRuntime(), opts({ dryRun: false }), h.deps, emptyQQState());
    const r = await bridge.poll();
    expect(r.reason).toBe("replied");
    expect(seen?.images).toHaveLength(1);
    expect(seen?.images?.[0]?.mediaType).toBe("image/png");
    expect(seen?.prompt ?? "").not.toContain("file://");
    expect(seen?.prompt ?? "").toContain("刚拍的");
  });

  it("只有图片时，进模型的是「对方发来一张图片」", async () => {
    let seen: GenInput | undefined;
    const h = harness({
      generateIn: async (input) => {
        seen = input;
        return "这张图好看♪";
      },
      readImage: async () => null, // 读不到也要降级，而不是报错
    });
    h.inbox.push(msg("m2", "[图片 x.png] <file:///C:/a/x.png>"));
    const bridge = new QQBridge(fakeRuntime(), opts(), h.deps, emptyQQState());
    await bridge.poll();
    expect(seen?.prompt ?? "").toContain("对方发来一张图片");
    expect(seen?.images ?? []).toHaveLength(0);
  });
});

describe("unreadImageNote（图片读不到时不许猜）", () => {
  it("没有图片标记时为空", () => {
    expect(unreadImageNote(0, 0)).toBe("");
  });
  it("一张都没读到：明确要求不要描述、不要猜、不要声称看到", () => {
    const note = unreadImageNote(1, 0);
    expect(note).toContain("没能读取");
    expect(note).toContain("不要描述");
    expect(note).toContain("不要声称你看到了");
  });
  it("部分读到：只说没读到的那几张", () => {
    const note = unreadImageNote(3, 1);
    expect(note).toContain("其中 2 张没能读取");
    expect(note).not.toContain("不要声称");
  });
  it("全部读到：不加任何提示", () => {
    expect(unreadImageNote(2, 2)).toBe("");
  });
});
