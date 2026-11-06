/**
 * 召回性能实测（G8 的"把假设变成数字"）。
 *
 * 目的不是刷一个好看的 ms，而是回答一个具体问题：**"top-200 够不够"**。
 * 它要同时满足三件事——① 十万级记忆下单次召回仍是交互级延迟；
 * ② 预筛之后候选数恒 ≤ 200（外加执念），不随库大小增长；
 * ③ 截断没有让相关条目掉出去（用"注入一条唯一可命中项"来验证）。
 *
 * 用法：node tools/bench/recall-bench.mjs [最大条数]
 * 输出：一张表 + 直接可粘进文档的数字。
 */

import { loadConfig } from "../../dist/engine/config.js";
import { semanticScores, cacheStats, clearCache } from "../../dist/memory/semantic.js";
import { prefilter } from "../../dist/memory/prefilter.js";
import { retrieve } from "../../dist/memory/retrieve.js";
import { makeMemory } from "../../dist/memory/types.js";

const cfg = await loadConfig();
const NOW = 1_793_000_000_000;
const SIZES = (process.argv[2] === undefined ? [1_000, 5_000, 20_000, 50_000] : [Number(process.argv[2])]).filter(
  (n) => Number.isFinite(n) && n > 0,
);
const QUERIES = [
  "今天降温了，你那边冷不冷",
  "窗边 下午 风很冷",
  "你还记得上次说的那件事吗",
  "晚饭吃了面，有点咸",
  "最近工作压力很大",
];
/** 唯一项自己的查询：它只与「钥匙」这条相关，必须单独判定，不能混进主表 */
const NEEDLE_QUERY = "钥匙 花盆";

/** 合成一批"看起来像真的"的记忆：多数与查询无关，少量相关 */
function corpus(n) {
  const records = [];
  for (let i = 0; i < n; i += 1) {
    const related = i % 500 === 0;
    const content = related
      ? `第 ${i} 条：那天下午她一直在窗边等我，风很冷，她没走。`
      : `第 ${i} 条：普通的日常记录，聊了聊天气和晚饭，没有什么特别的事。`;
    records.push(
      makeMemory({
        id: `m${String(i).padStart(7, "0")}`,
        content,
        source: "player",
        created_at: NOW - i * 60_000,
        tags: related ? ["窗边", "下午"] : ["日常"],
        encode_ctx: { channel: "gui" },
      }),
    );
  }
  // 一条"唯一可命中"的记忆：用来验证预筛截断没有把它丢掉
  records.push(
    makeMemory({
      id: "needle",
      content: "唯一的那条：她把钥匙放在门口的花盆下面。",
      source: "player",
      created_at: NOW,
      tags: ["钥匙"],
      encode_ctx: { channel: "gui" },
    }),
  );
  return records;
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

console.log(`# 召回性能实测（top_k=${200}，${QUERIES.length} 条查询轮转）`);
console.log("");
console.log("| 记忆条数 | 渠道池 | 预筛候选 | 截断 | 平均 ms | p50 ms | p95 ms | 唯一项是否保住 |");
console.log("|---:|---:|---:|---:|---:|---:|---:|---|");

for (const size of SIZES) {
  const records = corpus(size);
  clearCache();
  const times = [];
  let pool = 0;
  let candidates = 0;
  let dropped = 0;
  let needleKept = true;

  for (let round = 0; round < QUERIES.length; round += 1) {
    const query = QUERIES[round % QUERIES.length];
    const t0 = process.hrtime.bigint();
    const pre = prefilter(records, query, cfg);
    const semantic = semanticScores(query, pre.candidates);
    retrieve(pre.candidates, { tags: query.split(/\s+/), semantic, state: {}, now: NOW }, cfg, 5);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    pool = pre.poolSize;
    candidates = pre.candidates.length;
    dropped = pre.dropped;
  }
  // 唯一项单独一件事：用它的专属查询，看预筛有没有把它截掉
  const needlePre = prefilter(records, NEEDLE_QUERY, cfg);
  needleKept = needlePre.candidates.some((m) => m.id === "needle");

  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  console.log(
    `| ${size.toLocaleString("en-US")} | ${pool.toLocaleString("en-US")} | ${candidates} | ${dropped.toLocaleString("en-US")} | ${avg.toFixed(1)} | ${pct(times, 50).toFixed(1)} | ${pct(times, 95).toFixed(1)} | ${needleKept ? "✅" : "❌"} |`,
  );
}

console.log("");
const stats = cacheStats();
console.log(`缓存：上限 ${stats.limit}，本档累计命中 ${stats.hits} / 未命中 ${stats.misses}（命中率 ${(100 * stats.hits / Math.max(1, stats.hits + stats.misses)).toFixed(1)}%）`);
console.log("");
console.log("说明：");
console.log("- 「渠道池」= 本渠道可见记忆数（预筛前的候选规模）；「预筛候选」= 进入 rerank 的条数，上限 200 + 执念。");
console.log("- 唯一项指 corpus 里那条 `needle`：预筛若把它按语义截掉，下一列会变成 ❌。");
console.log("- 计时包含 256 维哈希向量现算（不落盘），这是当前实现里最重的一段。");
