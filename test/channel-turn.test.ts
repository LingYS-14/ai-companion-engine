/**
 * F272：插件侧的「回合投递」。
 *
 * 这是单写者的最后一截：桥要 turn，但插件不能自己写——只能投给自主进程的
 * 写通道。这里测三件事：投递的形状、成功后才刷新只读视图、失败绝不回退。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { makeChannelTurn, type ChannelTurnCallInput } from "../src/plugin/channel-turn.js";
import type { TurnRequest, TurnText } from "../src/ports/index.js";

const req: TurnRequest = { text: "在吗", appraisal: {}, language: {} } as unknown as TurnRequest;

function fakeTurnText(): TurnText {
  return { mode: "NORMAL", style: { modeStyle: "平常" } } as unknown as TurnText;
}

function okCall(log: ChannelTurnCallInput[], result: unknown = fakeTurnText()) {
  return async (input: ChannelTurnCallInput) => {
    log.push(input);
    return { ok: true, result };
  };
}

describe("makeChannelTurn", () => {
  it("投递 turn 到写通道：op/payload 形状固定，返回结果并刷新视图", async () => {
    const calls: ChannelTurnCallInput[] = [];
    let reloads = 0;
    const turn = makeChannelTurn({
      dataDir: "C:/data",
      characterId: "assistant",
      call: okCall(calls),
      reload: () => {
        reloads += 1;
      },
    });
    const result = await turn(req, { source: "qq_contact_verified" });
    expect(result.mode).toBe("NORMAL");
    expect(reloads).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.dataDir).toBe("C:/data");
    expect(calls[0]?.characterId).toBe("assistant");
    expect(calls[0]?.op).toBe("turn");
    expect(calls[0]?.payload).toEqual({ args: req, opts: { source: "qq_contact_verified" } });
  });

  it("没给选项时不塞空 opts（服务端会按缺省处理）", async () => {
    const calls: ChannelTurnCallInput[] = [];
    const turn = makeChannelTurn({ dataDir: "d", characterId: "c", call: okCall(calls), reload: () => {} });
    await turn(req);
    expect(calls[0]?.payload).toEqual({ args: req });
  });

  it("通道拒绝时抛错且不刷新（不假装成功）", async () => {
    let reloads = 0;
    const turn = makeChannelTurn({
      dataDir: "d",
      characterId: "c",
      call: async () => ({ ok: false, error: "写通道没开" }),
      reload: () => {
        reloads += 1;
      },
    });
    await expect(turn(req)).rejects.toThrow(/写通道没开/);
    expect(reloads).toBe(0);
  });

  it("投递本身抛错时原样冒出（由桥记 engine-failed）", async () => {
    const turn = makeChannelTurn({
      dataDir: "d",
      characterId: "c",
      call: async () => {
        throw new Error("ECONNREFUSED");
      },
      reload: () => {},
    });
    await expect(turn(req)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("F272 装配点锁定", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const plugin = readFileSync(join(repo, "src", "plugin", "index.ts"), "utf8");
  const bridge = readFileSync(join(repo, "src", "qq", "bridge.ts"), "utf8");
  const onebot = readFileSync(join(repo, "src", "qq", "onebot-bridge.ts"), "utf8");

  it("两个桥都从装配点拿 turn（不是自己 turn）", () => {
    expect(plugin).toContain("import { makeChannelTurn } from \"./channel-turn.js\";");
    // 窗口桥与 OneBot 桥的 deps 各一处
    expect(plugin.split("turn: makeChannelTurn({").length - 1).toBe(2);
    expect(plugin).toContain("reload: () => {");
    expect(plugin).toContain("runtime.reloadState();");
  });

  it("桥侧保留回退：没有 deps.turn 时仍调本进程 turn", () => {
    for (const source of [bridge, onebot]) {
      expect(source).toContain("this.deps.turn === undefined");
      expect(source).toContain(": await this.deps.turn(turnRequest, turnOptions)");
    }
  });

  it("插件不再直接把 runtime 递给桥当唯一 turn 来源", () => {
    // 旧写法是 new QQBridge(runtime, ...) 后桥里直接 this.rt.turn；
    // 现在装配点一定注入了 turn（上面已锁），这里再锁没有「只给 runtime」的注释暗示
    expect(plugin).not.toContain("// 桥直接调 runtime.turn");
  });
});
