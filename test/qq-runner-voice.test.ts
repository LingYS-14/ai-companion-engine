/** 语音出站走执行层的语义：同一句话 24h 内不重复合成；没接发送器要说清楚。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeGatedSender } from "../src/autonomy/qq-runner.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-qqvoice-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = (sendVoice?: (peer: number, text: string) => Promise<{ ok: boolean; detail: string }>) => {
  const calls: { peer: number; text: string }[] = [];
  const lines: string[] = [];
  const g = makeGatedSender({
    now: () => 1_000,
    dataDir: tempDir(),
    send: async () => ({ ok: true, detail: "text" }),
    ...(sendVoice === undefined ? {} : { sendVoice }),
    log: (line) => lines.push(line),
  });
  return { g, calls, lines };
};

describe("语音出站", () => {
  it("没接发送器时明确失败，而不是假装发了", async () => {
    const { g } = base();
    const r = await g.voice(10000001, "在呢");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("没接语音发送器");
  });

  it("接了发送器就真调一次，并带上执行层前缀", async () => {
    const seen: string[] = [];
    const { g } = base(async (_peer, text) => {
      seen.push(text);
      return { ok: true, detail: "record: onebot: 语音已发送" };
    });
    const r = await g.voice(10000001, "在呢");
    expect(r.ok).toBe(true);
    expect(r.detail.startsWith("onebot-voice:")).toBe(true);
    expect(seen).toEqual(["在呢"]);
  });

  it("同一句话 24 小时内第二次是去重命中（不重复合成/发送）", async () => {
    const seen: string[] = [];
    const { g } = base(async (_peer, text) => {
      seen.push(text);
      return { ok: true, detail: "sent" };
    });
    await g.voice(10000001, "在呢");
    const again = await g.voice(10000001, "在呢");
    expect(again.ok).toBe(true);
    expect(again.detail).toContain("已经发过语音");
    expect(seen).toHaveLength(1);
  });

  it("换一句话就是新的一次表达（不被去重误伤）", async () => {
    const seen: string[] = [];
    const { g } = base(async (_peer, text) => {
      seen.push(text);
      return { ok: true, detail: "sent" };
    });
    await g.voice(10000001, "在呢");
    await g.voice(10000001, "在呢，刚才在看书");
    expect(seen).toHaveLength(2);
  });
});
