/**
 * §8.3 隐私隔离（F156）：**这条记忆，眼前这个人有没有资格听**。
 *
 * 这条规则的意义不在今天（现在只有用户一个人跟她说话），而在于**将来**：
 * 一旦她进群、或者有别的联系人，默认的检索是"把整本日记翻给别人看"。
 * 所以这里三道口径要一起来：
 *   1. 访客只能拿到 allow_share 的记忆（shared_self）或他自己的对话记录；
 *   2. selftalk（她的内心话）对访客永远不可见，哪怕误打了 allow_share；
 *   3. 过滤发生在**打分之前**——被藏起来的记录连预筛都不进，
 *      否则它仍会影响候选数量与排序（隐藏不彻底等于没隐藏）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { makeMemory } from "../src/memory/types.js";
import { isVisibleTo, visibleTo } from "../src/memory/visibility.js";
import { GUEST_VISITOR, OWNER_VISITOR } from "../src/ports/visitor.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { buildTools } from "../src/plugin/tools.js";

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-privacy-"));
  clock = new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 8);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Record<string, unknown>) => ({
  source: "player",
  participants: [] as string[],
  ...over,
});

describe("isVisibleTo：主人 / 访客 / 自己的话", () => {
  it("主人看得到全部（她是为一个人活的）", () => {
    expect(isVisibleTo(rec({}), OWNER_VISITOR)).toBe(true);
    expect(isVisibleTo(rec({ source: "selftalk" }), OWNER_VISITOR)).toBe(true);
  });

  it("访客看不到没打 allow_share 的私有记忆", () => {
    expect(isVisibleTo(rec({}), GUEST_VISITOR)).toBe(false);
  });

  it("打了 allow_share 的记忆访客可见（shared_self）", () => {
    expect(isVisibleTo(rec({ allow_share: true }), GUEST_VISITOR)).toBe(true);
  });

  it("selftalk 对访客永远不可见——即使有人误打了 allow_share", () => {
    expect(isVisibleTo(rec({ source: "selftalk", allow_share: true }), GUEST_VISITOR)).toBe(false);
  });

  it("participants 里有这个访客时可见（回他自己的话不算泄露）", () => {
    const v = { owner: false, contactId: "u_42" };
    expect(isVisibleTo(rec({ participants: ["u_42"] }), v)).toBe(true);
    expect(isVisibleTo(rec({ participants: ["u_7"] }), v)).toBe(false);
    expect(isVisibleTo(rec({ participants: [] }), v)).toBe(false);
  });

  it("visibleTo 保持原顺序（检索顺序有意义，不许被打乱）", () => {
    const rows = [
      rec({ source: "player" }),
      rec({ source: "player", allow_share: true }),
      rec({ source: "selftalk" }),
      rec({ source: "player", allow_share: true }),
    ];
    expect(visibleTo(rows, GUEST_VISITOR)).toHaveLength(2);
    expect(visibleTo(rows, OWNER_VISITOR)).toHaveLength(4);
  });
});

describe("runtime.recall：访客模式下真的取不到私有记忆", () => {
  async function seeded() {
    const rt = await SoulRuntime.open(conf, clock);
    const now = clock.now();
    rt.memoryStore().write(
      makeMemory({ id: "m-private", content: "用户的银行卡密码是……", source: "player", created_at: now, tags: ["密码"] }),
      now,
    );
    rt.memoryStore().write(
      makeMemory({
        id: "m-shared",
        content: "用户喜欢在雨天听我讲猫的事",
        source: "player",
        created_at: now,
        tags: ["猫", "雨"],
        allow_share: true,
      }),
      now,
    );
    rt.memoryStore().write(
      makeMemory({ id: "m-selftalk", content: "我其实有点怕被忘记", source: "selftalk", created_at: now, tags: ["猫"] }),
      now,
    );
    return rt;
  }

  it("主人能召回全部三条里命中的", async () => {
    const rt = await seeded();
    const ids = rt.recall("猫 雨 密码", 10).map((r) => r.id);
    expect(ids).toContain("m-private");
    expect(ids).toContain("m-shared");
  });

  it("访客只能召回到 allow_share 的那条", async () => {
    const rt = await seeded();
    const rows = rt.recall("猫 雨 密码", 10, GUEST_VISITOR);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["m-shared"]);
  });

  it("访客看不到 selftalk（内心话）", async () => {
    const rt = await seeded();
    const ids = rt.recall("忘记 怕", 10, GUEST_VISITOR).map((r) => r.id);
    expect(ids).not.toContain("m-selftalk");
  });
});

describe("soul_recall / soul_remember：访客开关与 allow_share 入口都真的接上了", () => {
  async function tools() {
    const rt = await SoulRuntime.open(conf, clock);
    const defs = buildTools(rt, {});
    const recall = defs.find((d) => d.name === "soul_recall");
    const remember = defs.find((d) => d.name === "soul_remember");
    expect(recall).toBeDefined();
    expect(remember).toBeDefined();
    return { rt, recall: recall!, remember: remember! };
  }

  it("soul_remember 的 allow_share 会写进记忆，并且访客召回立刻能看见", async () => {
    const t = await tools();
    await t.remember.execute({ content: "用户说过喜欢雨天的味道", tags: ["雨"], allow_share: true } as never);
    const guest = (await t.recall.execute({ query: "雨", visitor: "guest" } as never)) as string;
    expect(guest).toContain("hits=1");
    expect(guest).toContain("雨天的味道");
  });

  it("缺省私有：相同查询在 guest 眼里是 0 条，在 owner 眼里是 1 条", async () => {
    const t = await tools();
    await t.remember.execute({ content: "用户今天很累", tags: ["累"] } as never);
    const guest = (await t.recall.execute({ query: "累", visitor: "guest" } as never)) as string;
    const owner = (await t.recall.execute({ query: "累" } as never)) as string;
    expect(guest).toContain("hits=0");
    expect(owner).toContain("hits=1");
  });
});
