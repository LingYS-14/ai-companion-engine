import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  createSpineGate,
  SPINE_FAIL_THRESHOLD,
  speakVoiceThroughSpine,
  type SpineGate,
} from "../src/autonomy/spine.js";

const NOW = 1_700_000_000_000;

const openGate = (): SpineGate => {
  const spine = createSpineGate({ now: () => NOW });
  for (let i = 0; i < SPINE_FAIL_THRESHOLD; i += 1) spine.recordSend(NOW, false);
  return spine;
};

describe("语音的熔断前门（B.2）", () => {
  it("熔断中：不调用发送器，返回明确原因", async () => {
    let called = 0;
    const out = await speakVoiceThroughSpine(openGate(), NOW, async () => {
      called += 1;
      return { ok: true, detail: "不应该走到这里" };
    });
    expect(called).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("熔断中");
  });

  it("通道正常：原样转发发送器结果（成功/失败都不改写）", async () => {
    const spine = createSpineGate({ now: () => NOW });
    await expect(
      speakVoiceThroughSpine(spine, NOW, async () => ({ ok: true, detail: "record: ok" })),
    ).resolves.toEqual({ ok: true, detail: "record: ok" });
    await expect(
      speakVoiceThroughSpine(spine, NOW, async () => ({ ok: false, detail: "tts down" })),
    ).resolves.toEqual({ ok: false, detail: "tts down" });
  });

  it("语音失败不计入熔断计数（一张坏语音不该熔断文字通道）", async () => {
    const spine = createSpineGate({ now: () => NOW });
    await speakVoiceThroughSpine(spine, NOW, async () => ({ ok: false, detail: "tts down" }));
    expect(spine.failures).toBe(0);
    expect(spine.canSend(NOW)).toBe(true);
  });

  it("装配锁：qq-runner 的语音出口走这道门", () => {
    const src = readFileSync(new URL("../src/autonomy/qq-runner.ts", import.meta.url), "utf8");
    expect(src).toContain("speakVoiceThroughSpine(spine, input.now()");
    expect(src).not.toContain("sendVoice: async ({ peer, text }: { peer: number; text: string }) => sendGated.voice(peer, text)");
  });

  it("装配锁：反应式路径在生成前查脊髓（B.2）", () => {
    const src = readFileSync(new URL("../src/qq/onebot-bridge.ts", import.meta.url), "utf8");
    expect(src).toContain('reason: "spine-down"');
    expect(src).toContain("脊髓熔断中：对外通道未恢复，本次不生成回复");
  });
});
