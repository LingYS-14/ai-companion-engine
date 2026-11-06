#!/usr/bin/env node
/**
 * `npm run intent:presence` —— DSH 侧写到 `data/presence-<id>.json` 的心跳（P0-B §2.6 方向一）。
 *
 * 为什么需要它：A5 起她会读这个文件判断"用户现在是不是在电脑前"。没有写入方时，
 * 她只能诚实地说"不知道"（`situation-note.ts` 里已按过期/缺失处理，不会假装他在）。
 *
 * 谁该写：DSH 侧——也就是我（Lead）。**用户发消息/我在会话里活跃时写一次 active**，
 * 会话结束或我判断他离开时写 inactive。这不是她的进程该做的事（她不能自己判断他在不在）。
 *
 * 用法：
 *   node tools/intent/presence.mjs                 # 写 active，TTL 默认 30 分钟
 *   node tools/intent/presence.mjs --ttl 45        # 自定义 TTL（分钟）
 *   node tools/intent/presence.mjs --inactive      # 写"已经离开"，TTL 2 分钟
 *   node tools/intent/presence.mjs --json          # 打印写下的内容
 *   node tools/intent/presence.mjs --data <dir> --character assistant
 *
 * 只写一个文件，不碰她的进程、不发 QQ、不调模型。
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const DEFAULT_TTL_MINUTES = 30;
const INACTIVE_TTL_MINUTES = 2;

function parseArgs(argv) {
  const out = {
    dataDir: join(REPO, "data"),
    characterId: process.env.ACE_CHARACTER_ID ?? "assistant",
    ttlMinutes: DEFAULT_TTL_MINUTES,
    active: true,
    json: false,
    nowMs: Date.now(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data") out.dataDir = resolve(String(argv[++i] ?? ""));
    else if (arg === "--character") out.characterId = String(argv[++i] ?? "");
    else if (arg === "--ttl") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--ttl 需要一个正数（分钟）");
      out.ttlMinutes = n;
    } else if (arg === "--inactive") {
      out.active = false;
      out.ttlMinutes = INACTIVE_TTL_MINUTES;
    } else if (arg === "--json") out.json = true;
    else if (arg === "--now") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error("--now 需要毫秒时间戳");
      out.nowMs = n;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "用法：node tools/intent/presence.mjs [--ttl 分钟] [--inactive] [--json] [--data 目录] [--character id]",
          "",
          "写 data/presence-<id>.json：{ atMs, active, ttlMs }。",
          "她读到 fresh 且 active=true 才认为用户在电脑前；过期/缺失一律当不知道。",
        ].join("\n"),
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

/** 纯函数：构造要写的记录（便于单测）。 */
export function buildPresence({ nowMs, ttlMinutes, active = true }) {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new RangeError("ttlMinutes 必须是正数");
  return { atMs: Math.floor(nowMs), active: active === true, ttlMs: Math.floor(ttlMinutes * 60_000) };
}

export function presencePath(dataDir, characterId) {
  return join(dataDir, `presence-${characterId}.json`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const record = buildPresence({ nowMs: opts.nowMs, ttlMinutes: opts.ttlMinutes, active: opts.active });
  const file = presencePath(opts.dataDir, opts.characterId);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, JSON.stringify(record), "utf8");
  renameSync(tmp, file);
  if (opts.json) console.log(JSON.stringify({ file, ...record }, null, 2));
  else {
    console.log(
      `presence 已写：${file} → ${record.active ? "用户在电脑前" : "用户已离开"}（TTL ${String(record.ttlMs / 60_000)} 分钟）`,
    );
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
