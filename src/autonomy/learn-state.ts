/**
 * 学习轮转的持久化状态。
 *
 * 为什么需要：`scripts/autonomy/main.mjs` 里的 `rotation` 原来是进程内变量，
 * 每次重启从 0 开始——而进程今天重启过多次，于是学习一直在搜最前面几个关键词，
 * 命中的全是已入库的旧视频（ingest 按 bvid 去重），看起来就是「她没有在学习」。
 * 轮转必须跨重启存活，否则「学完一轮」这件事永远不会发生。
 *
 * 只存三个事实：轮到第几个关键词、上次学习的时间与关键词、上次入库数。
 * 不存提示词、不存视频、不存知识本身（知识在 knowledge-*.ndjson）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface LearnState {
  /** **下一次**要用的扁平关键词表下标（从 0 开始） */
  readonly rotation: number;
  /** 上次真正执行学习的时间（ms） */
  readonly lastLearnAt?: number;
  /** 上次学习用的关键词，便于日志与排查 */
  readonly lastKeyword?: string;
  /** 上次入库条数（0 也记，用来判断"是不是一直在空转"） */
  readonly lastIngested?: number;
  /** 连续空转次数（入库=0 且抓取=0 或全是重复）；达到阈值可在日志里升级提示 */
  readonly idleRounds?: number;
  /**
   * 最近若干轮各自的入库数（A8：学习产出率 → 好奇缺口）。
   *
   * 为什么要存：`lastIngested` 只有一次的结果，判断不了"这块地是不是挖空了"；
   * 用最近 12 轮的产出率才知道该不该换主题。只存数字，不存关键词历史。
   */
  readonly recentIngested?: readonly number[];
}

/** 产出率窗口：与 `src/learning/learning-yield.ts:YIELD_WINDOW` 保持一致（这里不 import，避免 spine→brain 的方向争议）。 */
const RECENT_INGESTED_CAP = 12;

export const LEARN_STATE_VERSION = 1;

const DEFAULT_STATE: LearnState = { rotation: 0 };

/** 读取学习状态；文件缺失/损坏时回到初始值，**不抛错**（学习不能因为状态坏掉就停）。 */
export function loadLearnState(file: string): LearnState {
  if (!existsSync(file)) return DEFAULT_STATE;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LearnState>;
    const rotation = typeof raw.rotation === "number" && Number.isFinite(raw.rotation)
      ? Math.max(0, Math.trunc(raw.rotation))
      : 0;
    return {
      rotation,
      ...(typeof raw.lastLearnAt === "number" ? { lastLearnAt: raw.lastLearnAt } : {}),
      ...(typeof raw.lastKeyword === "string" ? { lastKeyword: raw.lastKeyword } : {}),
      ...(typeof raw.lastIngested === "number" ? { lastIngested: raw.lastIngested } : {}),
      ...(typeof raw.idleRounds === "number" ? { idleRounds: Math.max(0, Math.trunc(raw.idleRounds)) } : {}),
      ...(Array.isArray(raw.recentIngested)
        ? {
            recentIngested: raw.recentIngested
              .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
              .slice(-RECENT_INGESTED_CAP)
              .map((n) => Math.max(0, Math.trunc(n))),
          }
        : {}),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/** 原子写：先写 .tmp-<pid> 再 rename，避免半截文件。 */
export function saveLearnState(file: string, state: LearnState, nowMs: number): void {
  const body = JSON.stringify(
    {
      version: LEARN_STATE_VERSION,
      rotation: Math.trunc(state.rotation),
      ...(state.lastLearnAt === undefined ? {} : { lastLearnAt: state.lastLearnAt }),
      ...(state.lastKeyword === undefined ? {} : { lastKeyword: state.lastKeyword }),
      ...(state.lastIngested === undefined ? {} : { lastIngested: state.lastIngested }),
      ...(state.idleRounds === undefined ? {} : { idleRounds: state.idleRounds }),
      ...(state.recentIngested === undefined ? {} : { recentIngested: state.recentIngested.slice(-RECENT_INGESTED_CAP) }),
      savedAt: nowMs,
    },
    null,
    2,
  );
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}

/**
 * 推进一轮：把下标 +1 并记录结果。
 *
 * 纯函数，方便单测：不读盘、不看时钟。
 */
export function advanceLearnState(
  state: LearnState,
  keyword: string,
  ingested: number,
  nowMs: number,
): LearnState {
  // 空转 = 这一轮什么都没入库；fetch 数只进日志，不参与判定
  const idleRounds = ingested === 0 ? (state.idleRounds ?? 0) + 1 : 0;
  const safeIngested = Number.isFinite(ingested) ? Math.max(0, Math.trunc(ingested)) : 0;
  const recentIngested = [...(state.recentIngested ?? []), safeIngested].slice(-RECENT_INGESTED_CAP);
  return {
    rotation: (Number.isFinite(state.rotation) ? Math.trunc(state.rotation) : 0) + 1,
    lastLearnAt: nowMs,
    lastKeyword: keyword,
    lastIngested: safeIngested,
    idleRounds,
    recentIngested,
  };
}
