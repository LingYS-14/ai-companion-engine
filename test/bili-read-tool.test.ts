/**
 * `soul_bili_read` 工具：深读一条视频的**工具契约**。
 *
 * 这里不碰网络、不碰 ffmpeg：`bili.read` 是注入的假实现，只验「工具层怎么说话」。
 * 真链路（videoshot/字幕/裁帧）由学习轮次与 F138/F147 的线上证据覆盖。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { buildTools, type BiliFeedLike, type BiliReadResult } from "../src/plugin/tools.js";

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-bili-read-"));
  clock = new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sample: BiliReadResult = {
  bvid: "BV1xx411c7mD",
  title: "把复杂的东西讲简单",
  owner: "某UP",
  durationSec: 754,
  view: 123_456,
  like: 8_900,
  tags: ["知识", "科普"],
  description: "这一期聊聊表达。",
  quotes: ["好的解释是省略的艺术", "先给结论再给理由"],
  subtitleChars: 4023,
  visual: "画面：3 处取样（00:12/00:30/00:42），偏亮、以粉为主，帧间几乎没有变化",
  frameFiles: ["C:/data/frames/BV1xx411c7mD/f0.jpg"],
  ingested: false,
};

function fakeBili(read: BiliFeedLike["read"]): BiliFeedLike {
  return {
    feed: async () => ({ fetched: 0, ingested: 0, skipped: 0, blocked: 0, videos: [] }),
    me: async () => ({ session: false, nav: null }),
    learn: async () => ({ topic: "t", keyword: "k", fetched: 0, ingested: 0, skipped: 0, blocked: 0, items: [] }),
    ...(read === undefined ? {} : { read }),
  };
}

async function toolWith(bili: BiliFeedLike | null) {
  const rt = await SoulRuntime.open(conf, clock);
  const defs = buildTools(rt, bili === null ? {} : { bili });
  const tool = defs.find((d) => d.name === "soul_bili_read");
  expect(tool).toBeDefined();
  return tool!;
}

describe("soul_bili_read", () => {
  it("宿主没接 B 站通路时明确说未接", async () => {
    const tool = await toolWith(null);
    expect(String(await tool.execute({ bvid: "BV1xx411c7mD" }))).toContain("未接");
  });

  it("bvid 不合法时直接拒绝，不去取数", async () => {
    let called = 0;
    const tool = await toolWith(
      fakeBili(async () => {
        called += 1;
        return sample;
      }),
    );
    const out = String(await tool.execute({ bvid: "BV123" }));
    expect(out).toContain("bvid 不合法");
    expect(called).toBe(0);
  });

  it("正常深读：标题/时长/播放/标签/字幕引用/画面/帧文件都带出来", async () => {
    const tool = await toolWith(fakeBili(async () => sample));
    const out = String(await tool.execute({ bvid: "BV1xx411c7mD" }));
    expect(out).toContain("把复杂的东西讲简单（某UP）");
    expect(out).toContain("12:34");
    expect(out).toContain("12.3万");
    expect(out).toContain("标签：知识 / 科普");
    expect(out).toContain("字幕（全文 4023 字）");
    expect(out).toContain("1. 「好的解释是省略的艺术」");
    expect(out).toContain("画面：3 处取样");
    expect(out).toContain("f0.jpg");
    expect(out).toContain("入库：没写（remember=false，只读）");
  });

  it("remember=true / frames=false / quotes 原样递给深读实现", async () => {
    const seen: unknown[] = [];
    const tool = await toolWith(
      fakeBili(async (_bvid, opts) => {
        seen.push(opts);
        return { ...sample, ingested: opts.remember === true };
      }),
    );
    const out = String(await tool.execute({ bvid: "BV1xx411c7mD", remember: true, frames: false, quotes: 2 }));
    expect(seen[0]).toEqual({ remember: true, frames: false, quotes: 2 });
    expect(out).toContain("入库：已写一条富知识");
  });

  it("字幕没取到时说清楚原因，不让画面顶替", async () => {
    const tool = await toolWith(fakeBili(async () => ({ ...sample, quotes: [], subtitleChars: 0 })));
    const out = String(await tool.execute({ bvid: "BV1xx411c7mD" }));
    expect(out).toContain("字幕：没取到");
  });

  it("取数抛错时把原因带回，不抛给宿主", async () => {
    const tool = await toolWith(
      fakeBili(async () => {
        throw new Error("风控拦了");
      }),
    );
    const out = String(await tool.execute({ bvid: "BV1xx411c7mD" }));
    expect(out).toContain("失败：风控拦了");
  });
});
