/**
 * B 站公开读取 + 知识摄取的规则测试。
 *
 * 全程假 fetch、不碰真网络、不读真实凭据：
 *   - `src/bili/public.ts` 的行为（URL、请求头、容错、错误码）；
 *   - `src/bili/ingest.ts` 的确定性（计数格式、截断、11 个字段、幂等）。
 *
 * 为什么要断言"没有 Cookie"：公开接口不该带登录态；这条一旦破，
 * dry-run 的测试就会把真实 SESSDATA 打进日志里（B 站历史上出过这种事故）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BiliError,
  fetchNav,
  fetchPopular,
  fetchVideoInfo,
  fetchVideoTags,
  loadBiliSession,
  loadBiliSessionFromFile,
  searchVideos,
  type BiliDeps,
  type BiliSession,
  type BiliVideo,
} from "../src/bili/public.js";
import { LEARNING_PLAN, pickKeywords } from "../src/bili/topics.js";
import {
  DEFAULT_BILI_INGEST,
  distillVideo,
  explainOffTopic,
  explainUnsuitable,
  formatBiliCount,
  ingestVideos,
  looksOffTopic,
  looksUnsuitable,
  truncateDescription,
} from "../src/bili/ingest.js";
import { knowledgeIdFor } from "../src/memory/consolidate.js";
import { KnowledgeStore } from "../src/memory/knowledge.js";

const NOW = 1_760_000_000_000;
/** 默认素材对应的 tag 与知识 id（id 走 knowledgeIdFor，与 L2 其余条目同一套规则） */
const BILI_TAG = "bili:BV1xx411c7mD";
const BILI_KNOWLEDGE_ID = knowledgeIdFor(BILI_TAG);

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** 假 fetch：记录每次调用（URL + init），响应由各用例给 */
function fakeDeps(respond: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const deps: BiliDeps = { fetchFn, now: () => NOW, log: (line) => { logs.push(line); } };
  return { calls, logs, deps };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 一条素材齐备的视频；用例按需覆盖单个字段 */
function video(over: Partial<BiliVideo> = {}): BiliVideo {
  return {
    bvid: "BV1xx411c7mD",
    aid: 111,
    title: "标题",
    description: "描述",
    owner: "UP主",
    view: 12_000,
    like: 3_400,
    pubdateMs: 1_700_000_000_000,
    durationSec: 300,
    tags: ["a", "b", "c"],
    ...over,
  };
}

describe("fetchPopular", () => {
  it("解析 data.list，并带上 UA/Referer、ps/pn，且不带 Cookie", async () => {
    const f = fakeDeps(() =>
      jsonResponse({
        code: 0,
        message: "0",
        data: {
          list: [
            {
              aid: 111,
              bvid: "BV1xx411c7mD",
              title: "标题",
              desc: "描述",
              owner: { name: "UP主" },
              stat: { view: 12_000, like: 3_400 },
              pubdate: 1_700_000_000,
              duration: 300,
            },
            {
              aid: 222,
              bvid: "BV2xx411c7mE",
              title: "第二个",
              desc: "描述2",
              owner: { name: "UP2" },
              stat: { view: 999, like: 12 },
              pubdate: 1_700_000_100,
              duration: 61,
            },
          ],
        },
      }),
    );
    const videos = await fetchPopular(f.deps, { pageSize: 5 });
    expect(videos).toHaveLength(2);
    expect(videos[0]).toEqual({
      bvid: "BV1xx411c7mD",
      aid: 111,
      title: "标题",
      description: "描述",
      owner: "UP主",
      view: 12_000,
      like: 3_400,
      pubdateMs: 1_700_000_000_000,
      durationSec: 300,
      tags: [],
    });
    expect(videos[1]?.owner).toBe("UP2");
    expect(videos[1]?.pubdateMs).toBe(1_700_000_100_000);

    expect(f.calls[0]?.url).toBe("https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1");
    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Mozilla/5.0 ai-companion-engine");
    expect(headers["Referer"]).toBe("https://www.bilibili.com/");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    expect(f.logs.some((line) => line.includes("/x/web-interface/popular"))).toBe(true);

    // 不传 pageSize 时缺省 10（而不是 5 或 20）
    await fetchPopular(f.deps);
    expect(f.calls[1]?.url).toBe("https://api.bilibili.com/x/web-interface/popular?ps=10&pn=1");
  });

  it("字段缺失要容错：没有 bvid 的条目丢弃，其余给默认值而不是抛错", async () => {
    const f = fakeDeps(() =>
      jsonResponse({ code: 0, data: { list: [{ bvid: "BV3xx411c7mF" }, { title: "没有 bvid" }] } }),
    );
    const videos = await fetchPopular(f.deps);
    expect(videos).toHaveLength(1);
    const v = videos[0];
    expect(v).toMatchObject({
      bvid: "BV3xx411c7mF",
      title: "（无标题）",
      description: "",
      owner: "（未知 UP）",
      view: 0,
      like: 0,
      pubdateMs: 0,
      durationSec: 0,
      tags: [],
    });
    expect(v?.aid).toBeUndefined();
  });

  it("data 里没有 list 时按空列表处理", async () => {
    const f = fakeDeps(() => jsonResponse({ code: 0, data: null }));
    expect(await fetchPopular(f.deps)).toEqual([]);
  });
});

describe("错误路径", () => {
  it("code !== 0 抛 BiliError，带业务码与 message", async () => {
    const f = fakeDeps(() => jsonResponse({ code: -400, message: "请求错误", data: null }));
    let caught: unknown;
    try {
      await fetchPopular(f.deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BiliError);
    expect((caught as BiliError).code).toBe(-400);
    expect((caught as BiliError).message).toContain("请求错误");
  });

  it("HTTP 非 200（风控 412）抛 BiliError，code 是状态码", async () => {
    const f = fakeDeps(() => new Response("rate limited", { status: 412 }));
    await expect(fetchPopular(f.deps)).rejects.toBeInstanceOf(BiliError);
    try {
      await fetchPopular(f.deps);
    } catch (err) {
      expect((err as BiliError).code).toBe(412);
    }
  });

  it("fetch 本身失败（断网/超时）抛 BiliError，code 用负数哨兵，不带请求头", async () => {
    const f = fakeDeps(() => {
      throw new Error("ECONNRESET");
    });
    let caught: unknown;
    try {
      await fetchPopular(f.deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BiliError);
    expect((caught as BiliError).code).toBe(-1);
    const message = (caught as BiliError).message;
    expect(message).toContain("ECONNRESET");
    expect(message.toLowerCase()).not.toContain("cookie");
    expect(message.toLowerCase()).not.toContain("sessdata");
  });

  it("200 但返回 HTML（被风控）抛 BiliError，不静默当成空列表", async () => {
    const f = fakeDeps(() => new Response("<html>被风控了</html>", { status: 200 }));
    await expect(fetchPopular(f.deps)).rejects.toBeInstanceOf(BiliError);
  });
});

describe("fetchVideoInfo / fetchVideoTags", () => {
  it("view 解析 data，缺 bvid 时返回 null", async () => {
    const payloads = [
      jsonResponse({
        code: 0,
        data: {
          aid: 111,
          bvid: "BV1xx411c7mD",
          title: "标题",
          desc: "描述",
          owner: { name: "UP主" },
          stat: { view: 12_000, like: 3_400 },
          pubdate: 1_700_000_000,
          duration: 300,
        },
      }),
      jsonResponse({ code: 0, data: {} }),
    ];
    const f = fakeDeps(() => payloads.shift() ?? jsonResponse({ code: 0, data: null }));

    expect(await fetchVideoInfo(f.deps, "BV1xx411c7mD")).toMatchObject({
      bvid: "BV1xx411c7mD",
      title: "标题",
      owner: "UP主",
      view: 12_000,
    });
    expect(f.calls[0]?.url).toBe("https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD");
    expect(await fetchVideoInfo(f.deps, "BV1xx411c7mD")).toBeNull();

    // 空 bvid 不发请求
    expect(await fetchVideoInfo(f.deps, "   ")).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  it("tags 只取 tag_name，请求带 bvid", async () => {
    const f = fakeDeps(() =>
      jsonResponse({ code: 0, data: [{ tag_name: "动画" }, { tag_name: "音乐" }, { tag_id: 7 }] }),
    );
    expect(await fetchVideoTags(f.deps, "BV1xx411c7mD")).toEqual(["动画", "音乐"]);
    expect(f.calls[0]?.url).toBe("https://api.bilibili.com/x/tag/archive/tags?bvid=BV1xx411c7mD");
  });

  it("tags 接口失败（HTTP / 业务码 / 断网）一律返回 []，不连累视频本体", async () => {
    const status = fakeDeps(() => new Response("oops", { status: 503 }));
    expect(await fetchVideoTags(status.deps, "BV1xx411c7mD")).toEqual([]);

    const business = fakeDeps(() => jsonResponse({ code: -412, message: "请求被拦截" }));
    expect(await fetchVideoTags(business.deps, "BV1xx411c7mD")).toEqual([]);

    const offline = fakeDeps(() => {
      throw new Error("ENOTFOUND");
    });
    expect(await fetchVideoTags(offline.deps, "BV1xx411c7mD")).toEqual([]);
  });
});

describe("distillVideo", () => {
  it("content 格式固定：标题、UP、播放/点赞、描述、标签", () => {
    expect(distillVideo(video())).toEqual({
      tag: "bili:BV1xx411c7mD",
      content: "在 B 站看到《标题》（UP主，播放 1.2 万，点赞 3.4 千）：描述 标签：a/b/c",
      knowledgeType: "trend",
    });
  });

  it("空描述写「（无简介）」，无标签时不留尾随空格", () => {
    const d = distillVideo(video({ description: "", tags: [] }));
    expect(d.content).toBe("在 B 站看到《标题》（UP主，播放 1.2 万，点赞 3.4 千）：（无简介）");
    expect(d.content).not.toMatch(/\s+$/);
  });

  it("长描述按 code point 截到 120 字再补省略号，且空白先折叠", () => {
    const long = distillVideo(video({ description: "啊".repeat(121) })).content;
    expect(long).toContain(`${"啊".repeat(120)}…`);
    expect(long).not.toContain("啊".repeat(121));

    expect(truncateDescription("啊".repeat(120))).toBe("啊".repeat(120));
    expect(truncateDescription("a\n\nb    c")).toBe("a b c");
    expect(truncateDescription("  ")).toBe("");

    // emoji 是代理对：按 UTF-16 长度截会把最后一个劈成半个，按 code point 不会
    const emoji = "🌙".repeat(121);
    const cut = truncateDescription(emoji);
    expect(Array.from(cut)).toHaveLength(121);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toContain("\uFFFD");
  });
});

describe("formatBiliCount", () => {
  it("不足千原样；千/万截断一位小数；异常值 0", () => {
    expect(formatBiliCount(0)).toBe("0");
    expect(formatBiliCount(7)).toBe("7");
    expect(formatBiliCount(999)).toBe("999");
    expect(formatBiliCount(1000)).toBe("1 千");
    expect(formatBiliCount(3400)).toBe("3.4 千");
    expect(formatBiliCount(9999)).toBe("9.9 千");
    expect(formatBiliCount(10_000)).toBe("1 万");
    expect(formatBiliCount(12_000)).toBe("1.2 万");
    // 截断而非四舍五入：19999 是 1.9999 万，不能报成 2 万
    expect(formatBiliCount(19_999)).toBe("1.9 万");
    expect(formatBiliCount(1_234_567)).toBe("123.4 万");
    expect(formatBiliCount(Number.NaN)).toBe("0");
    expect(formatBiliCount(-5)).toBe("0");
  });
});

describe("ingestVideos", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-bili-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const openStore = (): KnowledgeStore => new KnowledgeStore(join(dir, "knowledge.ndjson")).open();

  it("写入 11 个字段，类型是 trend、来源是 bili", () => {
    const store = openStore();
    const result = ingestVideos(store, [video()], NOW);
    expect(result).toEqual({ ingested: 1, skipped: 0, blocked: 0, offTopic: 0 });

    const rec = store.get(BILI_KNOWLEDGE_ID);
    expect(rec).toBeDefined();
    expect(rec?.id).toMatch(/^kn_[0-9a-f]{8}$/);
    expect(rec).toMatchObject({
      id: BILI_KNOWLEDGE_ID,
      knowledge_type: "trend",
      source: "bili",
      source_credibility: 0.7,
      objective_freshness: 0.9,
      social_freshness: 0.5,
      freshness: 0.9,
      access_count: 0,
      ingested_at: NOW,
      worldview_translated: false,
    });
    expect(rec?.content).toBe(distillVideo(video()).content);
    // 默认参数与任务给的常量一致（cfg 可覆盖，但默认不许漂）
    expect(DEFAULT_BILI_INGEST).toEqual({
      source: "bili",
      sourceCredibility: 0.7,
      objectiveFreshness: 0.9,
      socialFreshness: 0.5,
      freshness: 0.9,
      worldviewTranslated: false,
    });
  });

  it("重复 ingest 跳过（跨重启也是）：只留一行 NDJSON", () => {
    const path = join(dir, "knowledge.ndjson");
    const first = ingestVideos(new KnowledgeStore(path).open(), [video()], NOW);
    expect(first).toEqual({ ingested: 1, skipped: 0, blocked: 0, offTopic: 0 });

    // 重开 = 插件重启：判重不能只靠内存
    const second = ingestVideos(new KnowledgeStore(path).open(), [video()], NOW + 1000);
    expect(second).toEqual({ ingested: 0, skipped: 1, blocked: 0, offTopic: 0 });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("同一批里同一个 bvid 出现两次只写一次", () => {
    const store = openStore();
    const result = ingestVideos(store, [video(), video()], NOW);
    expect(result).toEqual({ ingested: 1, skipped: 1, blocked: 0, offTopic: 0 });
    expect(store.size()).toBe(1);
  });

  it("空列表返回 0/0/0，不写文件内容", () => {
    const store = openStore();
    expect(ingestVideos(store, [], NOW)).toEqual({ ingested: 0, skipped: 0, blocked: 0, offTopic: 0 });
    expect(store.size()).toBe(0);
  });

  it("cfg 能覆盖可信度/新鲜度（以后从 engine.json 的 knob 读的入口）", () => {
    const store = openStore();
    ingestVideos(store, [video()], NOW, { sourceCredibility: 0.5, freshness: 0.6 });
    const rec = store.get(BILI_KNOWLEDGE_ID);
    expect(rec?.source_credibility).toBe(0.5);
    expect(rec?.freshness).toBe(0.6);
    expect(rec?.source).toBe("bili");
  });

  /**
   * 事故回归（2026-10-29）：rotation=5 裸搜「二次元」抓到 5 条擦边/标题党，
   * 当时 fetched=5 ingested=5 全部落盘。闸门必须在**写之前**拦，且计入 skipped/blocked。
   */
  it("跳过命中质量闸门的视频：不落盘，计入 skipped 与 blocked", () => {
    const store = openStore();
    const clean = video({ bvid: "BV1good000001", title: "【崩坏3】动画短片「因你而在的故事」" });
    const dirty = video({ bvid: "BV1bad0000001", title: "原味胖次脱下来给男友……" });
    const result = ingestVideos(store, [clean, dirty], NOW);

    expect(result).toEqual({ ingested: 1, skipped: 1, blocked: 1, offTopic: 0 });
    expect(store.size()).toBe(1);
    expect(store.has(knowledgeIdFor("bili:BV1bad0000001"))).toBe(false);
    expect(store.has(knowledgeIdFor("bili:BV1good000001"))).toBe(true);
  });

  it("被闸门挡下的视频不占用幂等语义：同一条再 ingest 仍是 blocked 而不是「已存在」", () => {
    const store = openStore();
    const dirty = video({ bvid: "BV1bad0000002", title: "我的妈呀！碧蓝航线你有点太顶了！" });
    ingestVideos(store, [dirty], NOW);
    expect(ingestVideos(store, [dirty], NOW).blocked).toBe(1);
    expect(store.size()).toBe(0);
  });

  /**
   * 离题闸门（2026-10-29 实测）：裸搜「二次元」时儿童早教内容因关键词字面匹配混进来
   * （「宝宝巴士安全教育」「食物戰爭 早教 益智 育儿」）。它们不是擦边，不能算进 blocked，
   * 但同样不能落盘——单独计入 offTopic，且 ingested 不增加。
   */
  it("离题（儿童早教）条目不落盘：计入 skipped 与 offTopic，ingested 不增加", () => {
    const store = openStore();
    const clean = video({ bvid: "BV1good000003", title: "【原神】3.2 版本前瞻" });
    const off = video({ bvid: "BV1kid0000001", title: "宝宝巴士安全教育儿歌合集" });
    const result = ingestVideos(store, [clean, off], NOW);

    expect(result).toEqual({ ingested: 1, skipped: 1, blocked: 0, offTopic: 1 });
    expect(store.size()).toBe(1);
    expect(store.has(knowledgeIdFor("bili:BV1kid0000001"))).toBe(false);
    expect(store.has(knowledgeIdFor("bili:BV1good000003"))).toBe(true);
  });

  it("两道闸门分开计数：擦边记 blocked、离题记 offTopic，互不串味", () => {
    const store = openStore();
    const clean = video({ bvid: "BV1good000004", title: "历届奥斯卡最佳动画短片盘点" });
    const dirty = video({ bvid: "BV1bad0000003", title: "原味胖次测评" });
    const off = video({ bvid: "BV1kid0000002", title: "食物戰爭 早教 益智 育儿" });
    const result = ingestVideos(store, [clean, dirty, off], NOW);

    expect(result).toEqual({ ingested: 1, skipped: 2, blocked: 1, offTopic: 1 });
    expect(store.size()).toBe(1);
  });
});

describe("looksUnsuitable（内容质量闸门）", () => {
  /**
   * 正例 = 两次真实测试实际抓到的 8 条：
   *   - 第一次（rotation=5）5 条：前 4 条命中的是标题里的强信号词；第 5 条「负 重 前 行」
   *     标题里没有任何擦边词，命中走「拆字」规则（短标题被空格逐字拆开 = 规避搜索/推荐的写法）；
   *   - 第二次（rotation=10，泛词「二次元」）3 条：前两条走「组合」/强信号词，第三条靠
   *     「圣水」——这三条在事故里**漏过并落库**，所以每条的 term 也一并断言，
   *     防止以后换成别的规则「碰巧」命中。
   */
  const positives: readonly {
    readonly title: string;
    readonly tags?: readonly string[];
    readonly rule: "strong" | "combo" | "short-title" | "spaced-title";
    readonly term?: string;
  }[] = [
    { title: "原味胖次脱下来给男友……", rule: "strong" },
    { title: "玩这么大！？8年老二游这波联动真是太懂玩家了", rule: "strong" },
    { title: "让人眼馋的没边没际了…（9）", rule: "strong" },
    { title: "我的妈呀！碧蓝航线你有点太顶了！", rule: "strong" },
    { title: "负 重 前 行", rule: "spaced-title" },
    // 第二次真实测试漏进知识库的 3 条原文（知识库 id：kn_ad8602a4 / kn_08f876fb / kn_839c3c4d）
    { title: "“猫娘的基础装备即将被绑匪解开~”", rule: "combo", term: "猫娘+绑匪" },
    { title: "“当学姐馋你身子时”", rule: "strong", term: "馋你" },
    { title: "【你这是憋了多少圣水啊-也太逆天了吧？！！", rule: "strong", term: "圣水" },
  ];

  /** 反例：正常的二次元/游戏内容，一个都不许误杀（含任务里点名的 5 条正例） */
  const negatives: readonly { readonly title: string; readonly description?: string; readonly tags?: readonly string[] }[] = [
    { title: "【崩坏3】动画短片「因你而在的故事」", tags: ["崩坏3", "动画"] },
    { title: "原神 3.2 版本前瞻", tags: ["原神", "前瞻"] },
    { title: "手书：往世乐土的一天", tags: ["手书", "往世乐土"] },
    { title: "【4K】飞驒高山《冰菓》圣地巡礼", tags: ["圣地巡礼", "冰菓"] },
    { title: "黑神话：悟空剧情解析", tags: ["黑神话", "剧情解析"] },
    // 长标题里的「腿」是健身科普，不该被短标题规则误杀
    { title: "健身科普：如何正确练腿不伤膝盖（附 8 个动作）", tags: ["健身", "科普"] },
    // 简介里有「福利」但标题不短、且没有强信号词
    { title: "《明日方舟》三周年活动全流程攻略与干员评测", description: "活动福利与卡池分析", tags: ["明日方舟", "攻略"] },
  ];

  it("两次事故的 8 条全部命中（且命中依据对得上）", () => {
    for (const { title, tags, rule, term } of positives) {
      const v = video({ title, ...(tags === undefined ? {} : { tags }) });
      expect(looksUnsuitable(v), title).toBe(true);
      expect(explainUnsuitable(v)?.rule, title).toBe(rule);
      if (term !== undefined) expect(explainUnsuitable(v)?.term, title).toBe(term);
    }
  });

  it("正常二次元/游戏内容不命中（不误杀）", () => {
    for (const { title, description, tags } of negatives) {
      const v = video({
        title,
        ...(description === undefined ? {} : { description }),
        ...(tags === undefined ? {} : { tags }),
      });
      expect(looksUnsuitable(v), title).toBe(false);
      expect(explainUnsuitable(v), title).toBeNull();
    }
  });

  it("标签露馅也拦：标题干净、标签里出现强信号词", () => {
    expect(looksUnsuitable(video({ title: "今天给大家整了个大活", tags: ["男娘", "cosplay"] }))).toBe(true);
  });

  it("拆字：短标题被空格逐字拆开 → 命中；长标题/含数字章节不拆字误判", () => {
    expect(explainUnsuitable(video({ title: "负 重 前 行" }))).toEqual({ term: "负重前行", rule: "spaced-title" });
    // 「第 1 章」这类排版不是拆字：段内是数字/多字符，或者标题本身很长
    expect(looksUnsuitable(video({ title: "【4K修复】某动画 第 12 话 观影记录与细节解析" }))).toBe(false);
    expect(looksUnsuitable(video({ title: "第 1 章 的 故 事 全 集 讲 解 与 回 顾" }))).toBe(false);
  });

  it("标题插空格也拦得住（回避审核的常见写法）", () => {
    expect(looksUnsuitable(video({ title: "原 味 胖 次 测评" }))).toBe(true);
  });

  it("弱信号词只在短标题生效：短标题命中、长标题放过", () => {
    expect(looksUnsuitable(video({ title: "这腿真长" }))).toBe(true);
    expect(looksUnsuitable(video({ title: "【科普】如何正确练腿不伤膝盖的 8 个动作详解" }))).toBe(false);
  });

  it("第二次事故的 3 条：命中依据是组合/强信号，不是碰巧", () => {
    // 「猫娘」「解开」单看都是正常词 → 不拦；同一标题里组合起来才是话术
    expect(explainUnsuitable(video({ title: "猫娘基础装备即将被解开" }))).toEqual({ term: "猫娘+解开", rule: "combo" });
    expect(looksUnsuitable(video({ title: "猫娘手书合集：往世乐土的猫耳少女" }))).toBe(false);
    // 强信号词扫标题/简介/标签三个面
    expect(explainUnsuitable(video({ title: "当学姐馋你身子时" }))).toEqual({ term: "馋你", rule: "strong" });
    expect(explainUnsuitable(video({ description: "这期全是圣水梗" }))).toEqual({ term: "圣水", rule: "strong" });
    // 「逆天」故意不进词表：游戏区的「逆天操作」是正当说法（误杀成本高于漏抓）
    expect(looksUnsuitable(video({ title: "这波操作太逆天了，解说都看傻了" }))).toBe(false);
  });

  it("组合只扫标题：简介里凑齐「猫娘+解开」不算（可能是正常剧情讨论）", () => {
    expect(looksUnsuitable(video({ title: "往世乐土剧情解析", description: "猫娘被解开封印的那一段" }))).toBe(false);
  });

  it("引号+波浪号短标题：三个条件同时成立才拦，长标题/无波浪号放过", () => {
    expect(explainUnsuitable(video({ title: "“这个夏天有点甜~”" }))).toEqual({ term: "这个夏天有点甜~", rule: "quoted-title" });
    expect(looksUnsuitable(video({ title: "「今天也要早睡~」" }))).toBe(true);
    // 引号在标题中间（没包住整条）→ 不算
    expect(looksUnsuitable(video({ title: "动画短片「因你而在的故事~」" }))).toBe(false);
    // 整条有引号但没有波浪号 → 不算
    expect(looksUnsuitable(video({ title: "“今天的番剧推荐”" }))).toBe(false);
    // 整条有引号+波浪号但太长 → 放过
    expect(looksUnsuitable(video({ title: "“【4K】某动画 第 12 话 观影记录与细节解析与幕后花絮~”" }))).toBe(false);
  });

  it("空标题/空标签不抛", () => {
    expect(looksUnsuitable(video({ title: "", description: "", tags: [] }))).toBe(false);
  });
});

describe("looksOffTopic（离题闸门：儿童早教/低龄内容）", () => {
  /**
   * 正例 = 真实测试里漏进知识库的儿童早教/低龄内容：
   *   - 「宝宝巴士安全教育」「食物戰爭 早教 益智 育儿」因关键词字面匹配被抓进来；
   *   - 「Kids Cartoon」是英文标题，中文词表一个都命中不了，所以单独一条规则。
   * 每条的 rule/term 一并断言：防止以后换成别的规则「碰巧」命中。
   */
  const offTopicCases: readonly {
    readonly title: string;
    readonly rule: "term" | "title-combo" | "kids-cartoon";
    readonly term: string;
  }[] = [
    { title: "宝宝巴士安全教育", rule: "term", term: "宝宝巴士" },
    { title: "食物戰爭 早教 益智 育儿", rule: "term", term: "早教" },
    { title: "Kids Cartoon", rule: "kids-cartoon", term: "kids cartoon" },
    // 「动画」「短片」单独出现是正常词；和低龄主体词同框才判离题
    { title: "幼儿动画短片：小兔子的一天", rule: "title-combo", term: "动画+幼儿" },
  ];

  /** 反例：正常动画/游戏内容，一个都不许误判（含任务里点名的 3 条） */
  const normalCases: readonly string[] = [
    "皮克斯《洞穴》治愈动画短片",
    "历届奥斯卡最佳动画短片",
    "国创热度TOP10盘点",
    "【崩坏3】动画短片「因你而在的故事」",
    "手书：往世乐土的一天",
  ];

  it("儿童早教/低龄内容判离题（rule 与 term 对得上）", () => {
    for (const { title, rule, term } of offTopicCases) {
      const v = video({ title });
      expect(looksOffTopic(v).offTopic, title).toBe(true);
      expect(explainOffTopic(v)?.rule, title).toBe(rule);
      expect(explainOffTopic(v)?.term, title).toBe(term);
    }
  });

  it("正常动画内容不误判（奥斯卡/皮克斯/国创/动画短片都放过）", () => {
    for (const title of normalCases) {
      expect(looksOffTopic(video({ title })).offTopic, title).toBe(false);
      expect(explainOffTopic(video({ title })), title).toBeNull();
    }
  });

  it("命中时 reason 以 off-topic: 开头；没命中时不带 reason 字段", () => {
    expect(looksOffTopic(video({ title: "宝宝巴士安全教育" }))).toEqual({
      offTopic: true,
      reason: "off-topic:宝宝巴士",
    });
    // 旧调用方按布尔用时不受影响：没命中就只有 offTopic=false
    expect(looksOffTopic(video({ title: "历届奥斯卡最佳动画短片" }))).toEqual({ offTopic: false });
  });

  it("只看标题：空标题/标签里有动画词都不误报", () => {
    expect(looksOffTopic(video({ title: "", description: "", tags: [] }))).toEqual({ offTopic: false });
    // 组合规则要求标题里同框；标签里的「动画」「短片」不参与判定（搜索接口的标签还可能为空）
    expect(looksOffTopic(video({ title: "手书：往世乐土的一天", tags: ["动画", "短片"] })).offTopic).toBe(false);
  });

  it("与质量闸门互不影响：擦边内容不会被当成离题（计数才不串味）", () => {
    expect(looksUnsuitable(video({ title: "原味胖次测评" }))).toBe(true);
    expect(looksOffTopic(video({ title: "原味胖次测评" })).offTopic).toBe(false);
  });
});

describe("登录态注入（BiliSession）", () => {
  // 故意带 `%2C`：B 站 cookie 值本身就是编码过的，原样透传，绝不解码
  const SESSDATA = "s%2Csecret";
  const BILI_JCT = "jct123";

  function headersOf(call: FetchCall | undefined): Record<string, string> {
    return (call?.init.headers ?? {}) as Record<string, string>;
  }

  it("有 session 时 popular 请求头带 SESSDATA 与 bili_jct，值原样不解码", async () => {
    const { calls, deps } = fakeDeps(() => jsonResponse({ code: 0, data: { list: [] } }));
    await fetchPopular({ ...deps, session: { sessdata: SESSDATA, biliJct: BILI_JCT } });
    expect(headersOf(calls[0])["Cookie"]).toBe(`SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}`);
  });

  it("只有 sessdata 时不拼 bili_jct", async () => {
    const { calls, deps } = fakeDeps(() => jsonResponse({ code: 0, data: { list: [] } }));
    await fetchPopular({ ...deps, session: { sessdata: SESSDATA } });
    expect(headersOf(calls[0])["Cookie"]).toBe(`SESSDATA=${SESSDATA}`);
  });

  it("session 为 null 时请求头没有 Cookie 键（不是空 Cookie）", async () => {
    const { calls, deps } = fakeDeps(() => jsonResponse({ code: 0, data: { list: [] } }));
    await fetchPopular({ ...deps, session: null });
    expect(headersOf(calls[0])).not.toHaveProperty("Cookie");
  });

  it("不传 session 时请求头与匿名路径逐字段一致（UA/Referer/Accept）", async () => {
    const { calls, deps } = fakeDeps(() => jsonResponse({ code: 0, data: { list: [] } }));
    await fetchPopular(deps);
    expect(headersOf(calls[0])).toEqual({
      "User-Agent": "Mozilla/5.0 ai-companion-engine",
      Referer: "https://www.bilibili.com/",
      Accept: "application/json",
    });
  });

  it("带 session 时日志只有 path 与时间戳，不含凭据", async () => {
    const { logs, deps } = fakeDeps(() => jsonResponse({ code: 0, data: { list: [] } }));
    await fetchPopular({ ...deps, session: { sessdata: SESSDATA, biliJct: BILI_JCT } });
    expect(logs).toHaveLength(1);
    const line = logs[0] ?? "";
    expect(line).toContain("/x/web-interface/popular");
    expect(line).toContain(`@${NOW}`);
    expect(line).not.toContain(SESSDATA);
    expect(line).not.toContain("SESSDATA");
    expect(line).not.toContain(BILI_JCT);
  });

  it("带 session 时 HTTP 失败的错误消息不含凭据", async () => {
    const { deps } = fakeDeps(() => new Response("blocked", { status: 412 }));
    const err = await fetchPopular({ ...deps, session: { sessdata: SESSDATA, biliJct: BILI_JCT } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BiliError);
    const message = (err as BiliError).message;
    expect(message).toContain("HTTP 412");
    expect(message).not.toContain(SESSDATA);
    expect(message).not.toContain("SESSDATA");
    expect(message).not.toContain(BILI_JCT);
  });

  it("带 session 时传输失败的错误消息不含凭据", async () => {
    const { deps } = fakeDeps(() => {
      throw new TypeError("fetch failed");
    });
    const err = await fetchVideoInfo({ ...deps, session: { sessdata: SESSDATA } }, "BV1xx411c7mD")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BiliError);
    const message = (err as BiliError).message;
    expect(message).toContain("fetch failed");
    expect(message).not.toContain(SESSDATA);
    expect(message).not.toContain("SESSDATA");
  });
});

describe("loadBiliSessionFromFile", () => {
  let dir: string;
  const FILE = "bili-assistant.json";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-bili-session-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    return path;
  }

  it("读到 sessdata 与 biliJct，`%2C` 原样保留不解码", () => {
    const path = write(
      FILE,
      JSON.stringify({ sessdata: "s%2Csecret", biliJct: "jct123", dedeUserId: "1", savedAt: 1 }),
    );
    expect(loadBiliSessionFromFile(path)).toEqual({ sessdata: "s%2Csecret", biliJct: "jct123" });
  });

  it("缺文件返回 null", () => {
    expect(loadBiliSessionFromFile(join(dir, "nope.json"))).toBeNull();
  });

  it("坏 JSON 返回 null", () => {
    expect(loadBiliSessionFromFile(write(FILE, '{"sessdata": "s%2Csecret"'))).toBeNull();
  });

  it("缺 sessdata 字段返回 null", () => {
    expect(loadBiliSessionFromFile(write(FILE, JSON.stringify({ biliJct: "jct123" })))).toBeNull();
  });

  it("sessdata 不是字符串/是空白返回 null", () => {
    expect(loadBiliSessionFromFile(write("a.json", JSON.stringify({ sessdata: 123 })))).toBeNull();
    expect(loadBiliSessionFromFile(write("b.json", JSON.stringify({ sessdata: "   " })))).toBeNull();
  });

  it("缺 biliJct 时只返回 sessdata（该键不出现）", () => {
    const path = write(FILE, JSON.stringify({ sessdata: "s%2Csecret" }));
    expect(loadBiliSessionFromFile(path)).toEqual({ sessdata: "s%2Csecret" });
  });

  it("biliJct 为空串时也不带该键", () => {
    const path = write(FILE, JSON.stringify({ sessdata: "s%2Csecret", biliJct: "" }));
    expect(loadBiliSessionFromFile(path)).toEqual({ sessdata: "s%2Csecret" });
  });

  it("坏文件静默返回 null：不 console.log/error/warn（尤其不打印内容）", () => {
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");
    const logSpy = vi.spyOn(console, "log");
    expect(loadBiliSessionFromFile(write(FILE, '{"sessdata": "s%2Csecret"'))).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("loadBiliSession", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-bili-session-"));
    writeFileSync(join(dir, "bili-assistant.json"), JSON.stringify({ sessdata: "s%2Csecret" }), "utf8");
    writeFileSync(join(dir, "bili-other.json"), JSON.stringify({ sessdata: "s%2Cother" }), "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("按 dataDir/bili-<characterId>.json 拼路径", () => {
    expect(loadBiliSession(dir, "assistant")).toEqual({ sessdata: "s%2Csecret" });
    expect(loadBiliSession(dir, "other")).toEqual({ sessdata: "s%2Cother" });
  });

  it("characterId 为空/文件不存在都返回 null", () => {
    expect(loadBiliSession(dir, "")).toBeNull();
    expect(loadBiliSession(dir, "missing")).toBeNull();
  });
});

describe("fetchNav", () => {
  function headersOf(call: FetchCall | undefined): Record<string, string> {
    return (call?.init.headers ?? {}) as Record<string, string>;
  }

  it("带 session 自检：请求 /x/web-interface/nav，带 Cookie，解析三个字段", async () => {
    const { calls, deps } = fakeDeps(() =>
      jsonResponse({ code: 0, data: { isLogin: true, uname: "bili_90083128322", mid: 3747576174087043 } }),
    );
    const nav = await fetchNav({ ...deps, session: { sessdata: "s%2Csecret", biliJct: "jct123" } });
    expect(calls[0]?.url).toBe("https://api.bilibili.com/x/web-interface/nav");
    expect(headersOf(calls[0])["Cookie"]).toBe("SESSDATA=s%2Csecret; bili_jct=jct123");
    expect(nav).toEqual({ isLogin: true, uname: "bili_90083128322", mid: 3747576174087043 });
  });

  it("匿名自检不带 Cookie", async () => {
    const { calls, deps } = fakeDeps(() => jsonResponse({ code: 0, data: { isLogin: false, uname: "", mid: 0 } }));
    const nav = await fetchNav(deps);
    expect(headersOf(calls[0])).not.toHaveProperty("Cookie");
    expect(nav).toEqual({ isLogin: false, uname: "", mid: 0 });
  });

  it("code=-101（账号未登录）归一成 isLogin:false，而不是 null", async () => {
    const { deps } = fakeDeps(() => jsonResponse({ code: -101, message: "账号未登录" }));
    const nav = await fetchNav({ ...deps, session: { sessdata: "s%2Csecret" } });
    expect(nav).toEqual({ isLogin: false, uname: "", mid: 0 });
  });

  it("网络错返回 null（问不到 ≠ 未登录）", async () => {
    const { deps } = fakeDeps(() => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchNav({ ...deps, session: { sessdata: "s%2Csecret" } })).toBeNull();
  });

  it("HTTP 412 返回 null", async () => {
    const { deps } = fakeDeps(() => new Response("<html>blocked</html>", { status: 412 }));
    expect(await fetchNav(deps)).toBeNull();
  });

  it("data 缺字段时给出 isLogin:false / 空 uname / 0 mid", async () => {
    const { deps } = fakeDeps(() => jsonResponse({ code: 0, data: {} }));
    expect(await fetchNav(deps)).toEqual({ isLogin: false, uname: "", mid: 0 });
  });
});

describe("searchVideos", () => {
  function headersOf(call: FetchCall | undefined): Record<string, string> {
    return (call?.init.headers ?? {}) as Record<string, string>;
  }

  /** 搜索接口的一条原始记录：扁平结构（author/play/like），与热门榜的嵌套结构不同 */
  function searchItem(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      aid: 111,
      bvid: "BV1xx411c7mD",
      title: "崩坏3 <em class=\"keyword\">AI助手</em> 解析",
      description: "描述",
      author: "UP主",
      play: 12_000,
      like: 3_400,
      pubdate: 1_700_000_000,
      duration: "05:00",
      tag: "a,b,c",
      ...over,
    };
  }

  const ok = (items: unknown[]) => jsonResponse({ code: 0, message: "0", data: { result: items } });

  it("按关键词搜主接口：URL/参数/UA/Referer，扁平字段映射成 BiliVideo，且不带 Cookie", async () => {
    const f = fakeDeps(() => ok([searchItem()]));
    const videos = await searchVideos(f.deps, { keyword: "崩坏3" });

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(
      "https://api.bilibili.com/x/web-interface/wbi/search/type"
        + "?search_type=video&keyword=%E5%B4%A9%E5%9D%8F3&page=1&page_size=10",
    );
    const headers = headersOf(f.calls[0]);
    expect(headers["User-Agent"]).toBe("Mozilla/5.0 ai-companion-engine");
    expect(headers["Referer"]).toBe("https://www.bilibili.com/");
    expect(headers).not.toHaveProperty("Cookie");

    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      bvid: "BV1xx411c7mD",
      aid: 111,
      description: "描述",
      owner: "UP主",
      view: 12_000,
      like: 3_400,
      pubdateMs: 1_700_000_000_000,
      durationSec: 300,
      tags: ["a", "b", "c"],
    });
  });

  it("剥掉标题里的 <em class=\"keyword\"> 高亮，MM:SS / 数字字符串也归一", async () => {
    const f = fakeDeps(() =>
      ok([
        searchItem({
          title: "<em class=\"keyword\">二次元</em>手书合集",
          author: "某UP",
          play: "1000",
          like: "234",
          pubdate: "1700000000",
          duration: "1:02:03",
          tag: " x , ,y ",
        }),
      ]),
    );
    const [v] = await searchVideos(f.deps, { keyword: "手书" });

    expect(v?.title).toBe("二次元手书合集");
    expect(v?.owner).toBe("某UP");
    expect(v?.view).toBe(1000);
    expect(v?.like).toBe(234);
    expect(v?.pubdateMs).toBe(1_700_000_000_000);
    expect(v?.durationSec).toBe(3723);
    expect(v?.tags).toEqual(["x", "y"]);
  });

  it("主接口失败（412）时退回不签名的 /x/web-interface/search/type，查询参数不变", async () => {
    const f = fakeDeps((call) =>
      call.url.includes("/wbi/search/type")
        ? new Response("<html>blocked</html>", { status: 412 })
        : ok([searchItem()]),
    );
    const videos = await searchVideos(f.deps, { keyword: "往世乐土", pageSize: 3 });

    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.bilibili.com/x/web-interface/wbi/search/type"
        + "?search_type=video&keyword=%E5%BE%80%E4%B8%96%E4%B9%90%E5%9C%9F&page=1&page_size=3",
      "https://api.bilibili.com/x/web-interface/search/type"
        + "?search_type=video&keyword=%E5%BE%80%E4%B8%96%E4%B9%90%E5%9C%9F&page=1&page_size=3",
    ]);
    expect(videos).toHaveLength(1);
    // 回退原因只记 code：日志里不出现响应体，也不出现凭据
    expect(f.logs.some((line) => line.includes("回退") && line.includes("code=412"))).toBe(true);
  });

  it("网络错同样会回退（code=-1）", async () => {
    const f = fakeDeps((call) => {
      if (call.url.includes("/wbi/search/type")) throw new TypeError("fetch failed");
      return ok([searchItem()]);
    });
    const videos = await searchVideos(f.deps, { keyword: "动画" });

    expect(f.calls).toHaveLength(2);
    expect(videos).toHaveLength(1);
    expect(f.logs.some((line) => line.includes("回退") && line.includes("code=-1"))).toBe(true);
  });

  it("两条接口都失败才抛 BiliError；消息里不含 Cookie/SESSDATA/bili_jct", async () => {
    const f = fakeDeps((call) =>
      call.url.includes("/wbi/")
        ? jsonResponse({ code: -412, message: "请求被拦截" })
        : jsonResponse({ code: -352, message: "风控校验失败" }),
    );
    const session: BiliSession = { sessdata: "s%2Csecret", biliJct: "jct123" };
    const err = await searchVideos({ ...f.deps, session }, { keyword: "AI助手" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BiliError);
    expect((err as BiliError).code).toBe(-352);
    expect(f.calls).toHaveLength(2);
    // 就算带了登录态，错误消息也只能有 path / 状态码 / 接口 message
    const message = (err as Error).message;
    expect(message).toContain("请求被拦截");
    expect(message).toContain("/x/web-interface/wbi/search/type");
    expect(message).not.toContain("s%2Csecret");
    expect(message).not.toContain("SESSDATA");
    expect(message).not.toContain("jct123");
  });

  it("空关键词不发请求，直接返回空列表", async () => {
    const f = fakeDeps(() => ok([searchItem()]));
    expect(await searchVideos(f.deps, { keyword: "   " })).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("缺 bvid 的条目丢弃，缺字段给默认值；data.result 不是数组按空列表", async () => {
    const f = fakeDeps(() =>
      ok([
        { title: "没有 bvid" },
        "garbage",
        searchItem({
          bvid: "BVonly",
          aid: undefined,
          title: undefined,
          description: undefined,
          author: undefined,
          play: undefined,
          like: undefined,
          pubdate: undefined,
          duration: undefined,
          tag: undefined,
        }),
      ]),
    );
    const videos = await searchVideos(f.deps, { keyword: "新番" });

    expect(videos).toEqual([
      {
        bvid: "BVonly",
        title: "（无标题）",
        description: "",
        owner: "（未知 UP）",
        view: 0,
        like: 0,
        pubdateMs: 0,
        durationSec: 0,
        tags: [],
      },
    ]);

    const g = fakeDeps(() => jsonResponse({ code: 0, data: {} }));
    expect(await searchVideos(g.deps, { keyword: "动画" })).toEqual([]);
  });

  it("pageSize 缺省 10、夹在 1..50，小数截断", async () => {
    const f = fakeDeps(() => ok([]));
    const cases: readonly (readonly [number | undefined, number])[] = [
      [undefined, 10],
      [0, 1],
      [3.9, 3],
      [99, 50],
    ];
    for (const [pageSize, expected] of cases) {
      await searchVideos(f.deps, pageSize === undefined ? { keyword: "k" } : { keyword: "k", pageSize });
      expect(f.calls.at(-1)?.url.endsWith(`&page_size=${expected}`)).toBe(true);
    }
  });

  it("注入 session 时带 Cookie（复用 requestJson 这个唯一凭据入口）", async () => {
    const f = fakeDeps(() => ok([searchItem()]));
    await searchVideos(
      { ...f.deps, session: { sessdata: "s%2Csecret", biliJct: "jct123" } },
      { keyword: "崩坏3" },
    );
    expect(headersOf(f.calls[0])["Cookie"]).toBe("SESSDATA=s%2Csecret; bili_jct=jct123");
  });
});

describe("LEARNING_PLAN / pickKeywords", () => {
  const FLAT: readonly { topic: string; keyword: string }[] = [
    { topic: "崩坏三", keyword: "崩坏3" },
    { topic: "崩坏三", keyword: "崩坏三" },
    { topic: "崩坏三", keyword: "AI助手" },
    { topic: "崩坏三", keyword: "逐火十三英桀" },
    { topic: "崩坏三", keyword: "往世乐土" },
    { topic: "二次元", keyword: "动画短片" },
    { topic: "二次元", keyword: "手书" },
    { topic: "二次元", keyword: "剧情解析" },
    { topic: "二次元", keyword: "圣地巡礼" },
    { topic: "二次元", keyword: "国创" },
  ];

  it("学习计划固定两条：先崩坏三、再二次元，关键词按序", () => {
    expect(LEARNING_PLAN.map((t) => t.topic)).toEqual(["崩坏三", "二次元"]);
    expect(LEARNING_PLAN[0]?.keywords).toEqual(["崩坏3", "崩坏三", "AI助手", "逐火十三英桀", "往世乐土"]);
    expect(LEARNING_PLAN[1]?.keywords).toEqual(["动画短片", "手书", "剧情解析", "圣地巡礼", "国创"]);
  });

  /**
   * 事故回归（2026-10-29 第二次）：第一次只把泛词「二次元」挪到组尾，rotation=10 又轮到它、
   * 又漏进 3 条擦边，所以这次**直接删掉**——扁平关键词表从 11 个缩到 10 个。
   */
  it("泛词「二次元」已从计划里删除：整条计划不再有任何裸泛词", () => {
    const all = LEARNING_PLAN.flatMap((t) => t.keywords);
    expect(all).not.toContain("二次元");
    expect(LEARNING_PLAN[1]?.keywords).not.toContain("二次元");
    // 剩下 5 个都是有内容属性的词：删泛词不能把组删空，也不能退化成只剩泛词
    expect(LEARNING_PLAN[1]?.keywords.length).toBe(5);
  });

  it("rotation 走扁平关键词表：0 从崩坏三开始，5 进二次元（有内容属性的词）", () => {
    for (let rotation = 0; rotation < FLAT.length; rotation += 1) {
      expect(pickKeywords(LEARNING_PLAN, rotation)).toEqual(FLAT[rotation]);
    }
    expect(pickKeywords(LEARNING_PLAN, 0)).toEqual({ topic: "崩坏三", keyword: "崩坏3" });
    expect(pickKeywords(LEARNING_PLAN, 4)).toEqual({ topic: "崩坏三", keyword: "往世乐土" });
    expect(pickKeywords(LEARNING_PLAN, 5)).toEqual({ topic: "二次元", keyword: "动画短片" });
    expect(pickKeywords(LEARNING_PLAN, 9)).toEqual({ topic: "二次元", keyword: "国创" });
  });

  it("越界回绕一圈：扁平表 10 个词，rotation=10 回到崩坏三，负数从尾部回绕", () => {
    expect(pickKeywords(LEARNING_PLAN, 10)).toEqual({ topic: "崩坏三", keyword: "崩坏3" });
    expect(pickKeywords(LEARNING_PLAN, 11)).toEqual({ topic: "崩坏三", keyword: "崩坏三" });
    expect(pickKeywords(LEARNING_PLAN, -1)).toEqual({ topic: "二次元", keyword: "国创" });
    expect(pickKeywords(LEARNING_PLAN, -9)).toEqual({ topic: "崩坏三", keyword: "崩坏三" });
  });

  it("非有限数按 0，小数按整数截断", () => {
    expect(pickKeywords(LEARNING_PLAN, Number.NaN)).toEqual({ topic: "崩坏三", keyword: "崩坏3" });
    expect(pickKeywords(LEARNING_PLAN, Number.POSITIVE_INFINITY)).toEqual({
      topic: "崩坏三",
      keyword: "崩坏3",
    });
    expect(pickKeywords(LEARNING_PLAN, 4.9)).toEqual({ topic: "崩坏三", keyword: "往世乐土" });
  });

  it("空计划 / 全是空关键词抛 RangeError（不拿空关键词去搜）", () => {
    expect(() => pickKeywords([], 0)).toThrow(RangeError);
    expect(() => pickKeywords([{ topic: "空", keywords: ["", "  "] }], 0)).toThrow(RangeError);
  });

  it("自定义计划照走轮转：以后加方向只改常量，不动实现", () => {
    const plan = [
      { topic: "A", keywords: ["a1", "a2"] },
      { topic: "B", keywords: ["b1"] },
    ];
    expect(pickKeywords(plan, 0)).toEqual({ topic: "A", keyword: "a1" });
    expect(pickKeywords(plan, 2)).toEqual({ topic: "B", keyword: "b1" });
    expect(pickKeywords(plan, 3)).toEqual({ topic: "A", keyword: "a1" });
  });
});

describe("弱信号词的平衡值：短标题 1 个即拦，长标题要 2 个不同词", () => {
  const v = (title: string) => ({
    bvid: "BV1balance", title, description: "", owner: "u", view: 1, like: 1,
    pubdateMs: 0, durationSec: 60, tags: [] as string[],
  });

  it("长标题里只出现一个弱词 —— 放行（创作区常见正当用法）", () => {
    expect(looksUnsuitable(v("她的身材与性格都被写进了这段独白｜角色解析"))).toBe(false);
    expect(looksUnsuitable(v("腿伤之后他怎么站起来：康复训练全记录"))).toBe(false);
  });

  it("长标题里出现两个不同弱词 —— 拦住，并说明是 soft-multi", () => {
    const hit = explainUnsuitable(v("身材 腿 内衣 全套展示，这次真的拍全了"));
    expect(hit?.rule).toBe("soft-multi");
    expect(hit?.term).toBe("腿+身材+内衣");
  });

  it("短标题里一个弱词仍然拦（短句里的弱词几乎无正当用法）", () => {
    expect(explainUnsuitable(v("这腿绝了"))?.rule).toBe("short-title");
  });
});
