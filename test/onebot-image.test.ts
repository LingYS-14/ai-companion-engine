/**
 * 「她说了要给你看图，就真的把图发出去」——桥的接线 + 执行层幂等。
 *
 * F102 是这组测试的来由：她在日记里写「这张图给你」，但 OneBot 通道没有发图能力，
 * 于是那句话落地成空气。现在分三层验证：
 *   1) 真在说「给你看图」+ 手上有画面 → 发送参数里带 imagePath；
 *   2) 在说「给你看图」但手上没图 → 只发文字（不假装有图）；
 *   3) 没说要看图 → 就算有素材也不附（别每句话都拖一张截图）。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { makeGatedSender } from "../src/autonomy/qq-runner.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import { emptyQQState } from "../src/qq/types.js";
import type { OneBotEvent } from "../src/qq/onebot.js";
import type { Persona } from "../src/dialogue/persona.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const NOW = 1_700_000_000_000;
const PEER = 100_000_001;
const SELF = 10_000_002;

function event(text: string): OneBotEvent {
  return {
    post_type: "message",
    message_type: "private",
    self_id: SELF,
    user_id: PEER,
    time: Math.floor((NOW - 5_000) / 1000),
    message_id: 4321,
    message: [{ type: "text", data: { text } }],
  } as OneBotEvent;
}

interface Sent {
  readonly peer: number;
  readonly text: string;
  readonly imagePath?: string;
}

function harness(reply: string, image: string | null): { deps: OneBotBridgeDeps; rt: SoulRuntime; sent: Sent[] } {
  const sent: Sent[] = [];
  const rt = {
    turn: () => ({
      mode: "NORMAL",
      stage: "stranger",
      bondProgress: 0,
      state: {},
      style: { modeStyle: "平常", stageStyle: "客气", expressionStyle: "稳", suppressInstruction: "不必压", signals: {} },
      expression: { tone: "稳", move: "聊", avoid: "别急", quadrant: "secure", stage: "stranger", source: "table" },
      eventStyle: null,
      memory: { wrote: 1, rejected: 0 },
      bandit: { actionTag: "care", ucb: 0, source: "fallback", candidates: [], scored: false },
    }),
    persona: (): Persona | null => null,
  };
  const deps: OneBotBridgeDeps = {
    now: () => NOW,
    localHour: () => 12,
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async () => reply,
    send: async ({ peer, text, imagePath }) => {
      sent.push({ peer, text, ...(imagePath === undefined ? {} : { imagePath }) });
      return { ok: true, detail: "onebot: 已发送" };
    },
    saveState: () => {},
    log: () => {},
    ...(image === null ? {} : { shareImage: () => image }),
  };
  return { deps, rt: rt as unknown as SoulRuntime, sent };
}

function bridgeOf(deps: OneBotBridgeDeps, rt: SoulRuntime): OneBotBridge {
  return new OneBotBridge(
    rt,
    makeOneBotOptions({ peer: PEER, selfId: SELF, peerName: "用户", dryRun: false }),
    deps,
    emptyQQState(),
  );
}

describe("接线：说了要给图就真的附件一起发", () => {
  it("「这张图给你」+ 手上有画面 → send 带 imagePath", async () => {
    const { deps, rt, sent } = harness("你看我今天拍的花，这张图给你，你认得吗", "X:/tmp/x/data/frames/BV1abc/f1.jpg");
    await bridgeOf(deps, rt).handle(event("在吗"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.imagePath).toBe("X:/tmp/x/data/frames/BV1abc/f1.jpg");
  });

  it("说了要看图但手上没图 → 只发文字，不假装有图", async () => {
    const { deps, rt, sent } = harness("给你看看这张，我刚才拍的", null);
    await bridgeOf(deps, rt).handle(event("在吗"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.imagePath).toBeUndefined();
  });

  it("没说要看图 → 有素材也不附", async () => {
    const { deps, rt, sent } = harness("嗯，我在呢", "X:/tmp/x/data/frames/BV1abc/f1.jpg");
    await bridgeOf(deps, rt).handle(event("在吗"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.imagePath).toBeUndefined();
  });

  it("说了要给图但手上没图 → 承诺句被摘掉，不发空话", async () => {
    const { deps, rt, sent } = harness("今天走了好多路。这张图给你，拍的花。", null);
    await bridgeOf(deps, rt).handle(event("在吗"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("今天走了好多路。");
    expect(sent[0]?.text).not.toContain("图");
  });

  it("shareImage 抛错也不影响文字发送", async () => {
    const { deps, rt, sent } = harness("这张图给你", null);
    const thrower: OneBotBridgeDeps = {
      ...deps,
      shareImage: () => {
        throw new Error("目录读不了");
      },
    };
    await bridgeOf(thrower, rt).handle(event("在吗"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.imagePath).toBeUndefined();
  });
});

describe("执行层：同一张图 24 小时内只发一次", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ase-image-"));
    mkdirSync(join(dir, "execution"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("第二次走 deduplicated（不会两张图刷屏）", async () => {
    const images: string[] = [];
    const sender = makeGatedSender({
      now: () => NOW,
      dataDir: dir,
      send: async () => ({ ok: true, detail: "text" }),
      sendImage: async (_peer, path) => {
        images.push(path);
        return { ok: true, detail: `已发 ${path}` };
      },
    });
    const first = await sender.image(PEER, "C:/img/a.jpg");
    const second = await sender.image(PEER, "C:/img/a.jpg");
    expect(first.ok).toBe(true);
    expect(images).toHaveLength(1);
    expect(second.ok).toBe(true);
    expect(second.detail).toContain("已经发过");
  });

  it("换一张新图是新的表达（不被上一张的去重挡住）", async () => {
    const images: string[] = [];
    const sender = makeGatedSender({
      now: () => NOW,
      dataDir: dir,
      send: async () => ({ ok: true, detail: "text" }),
      sendImage: async (_peer, path) => {
        images.push(path);
        return { ok: true, detail: "sent" };
      },
    });
    await sender.image(PEER, "C:/img/a.jpg");
    await sender.image(PEER, "C:/img/b.jpg");
    expect(images).toEqual(["C:/img/a.jpg", "C:/img/b.jpg"]);
  });

  it("没接图片发送器时明确失败，不静默当成功", async () => {
    const sender = makeGatedSender({
      now: () => NOW,
      dataDir: dir,
      send: async () => ({ ok: true, detail: "text" }),
    });
    const r = await sender.image(PEER, "C:/img/a.jpg");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("没接图片发送器");
  });
});
