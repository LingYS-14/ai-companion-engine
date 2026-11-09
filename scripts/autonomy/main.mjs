#!/usr/bin/env node
/**
 * 自主进程入口（独立常驻，不依赖本会话、不依赖 DSH 宿主）。
 *
 *   启动：   node scripts/autonomy/main.mjs
 *   自检：   node scripts/autonomy/main.mjs --once       # 只跑一轮计划，看日志
 *   停：     scripts/autonomy/stop.ps1（或向进程发 SIGTERM / Ctrl+C）
 *
 * 与开发面的关系（见 docs/OPERATIONS.md）：
 * - 她是**唯一写者**：单写者锁 data/.writer-lock；开发面（我）只读她的状态文件；
 * - QQ 桥关着时 proactive 永远不放行——自主态只内省、学习、写日志，不打扰用户；
 * - 关机保护：SIGTERM/SIGINT/SIGBREAK 都会先 flush 状态、释放锁，再退出。
 *
 * 环境变量：
 *   ACE_CHARACTER_ID   默认 assistant
 *   ACE_DATA_DIR       默认 <repo>/data
 *   ACE_AUTONOMY       默认 1（=1 开跑；0 只装配不上定时器，用于自检）
 *   AI_COMPANION_LLM_API_KEY / _BASE_URL / _MODEL / _TIMEOUT_MS   模型凭据（缺 key 则降级模板）
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SoulRuntime } from "../../dist/plugin/runtime.js";
import { knobNumber, knobStrings, loadConfig } from "../../dist/engine/config.js";
import { energyCostFor } from "../../dist/engine/state.js";
import { startWriteChannel } from "../../dist/assembly/write-channel-wiring.js";
// P3-2b（task-57 B2）：睡眠编排在 src/autonomy/sleep-tick.ts（纯逻辑，无 import 大脑侧）。
import { SLEEP_NIGHT_BUDGET, consumeNightBudget, normalizeNightBudget, remainingNightBudget, runSleepTick } from "../../dist/autonomy/sleep-tick.js";
// P4-2 L0（task-84）：夜间梦/联想的纯函数层——选种/提示词/解析/校验/影子记录，零 IO。
import {
  DREAM_CONF_HINT,
  DREAM_RETENTION_NIGHTS,
  DREAM_SEED_MIN,
  buildDreamPrompt,
  buildShadowRecord,
  parseDreamText,
  selectDreamSeeds,
  trimShadowLines,
  validateDreamShadow,
} from "../../dist/maintenance/dream.js";
// W1（task-94）：网页学习工具层。默认关闭（WEB_SEARCH_ENABLED=0）时这里零网络、零行为变化。
import {
  canSearch,
  consumeSearch,
  emptyWebUsage,
  fetchPageText,
  ingestHits,
  normalizeWebUsage,
  readWebConfig,
  runWebFetch,
  runWebToolSearch,
  searchForLearning,
  searchForTool,
  touchSearchAttempt,
} from "../../dist/web/index.js";
import { dayKey } from "../../dist/autonomy/tick-plan.js";
import {
  appendRuntimeLog,
  loadEnvFile as loadEnvFileFromDisk,
  localPartsOf,
  readHolidayFile,
  readOneBotConfig,
  readWorkdayFile,
} from "../../dist/assembly/main-config.js";
import { createModelRefresher } from "../../dist/assembly/model-refresh.js";
import { installLifecycle } from "../../dist/assembly/lifecycle.js";
import { runSayMode } from "../../dist/assembly/say-mode.js";
import { lastContactMinutes, readSituationSignals } from "../../dist/assembly/situation-signals.js";
import { describeInputActivity } from "../../dist/autonomy/input-activity.js";
import { resolveAutonomyConfig, DEFAULT_AUTONOMY } from "../../dist/autonomy/config.js";
import { readQqProactiveConfig } from "../../dist/autonomy/onebot-config.js";
import { AutonomyLoop } from "../../dist/autonomy/loop.js";
import { chatComplete, formatUsageLog, loadLlmConfig } from "../../dist/autonomy/llm.js";
// P2（task-139）：网页聊天——共享对话流水 + daemon 侧一轮。
import { ChatLog } from "../../dist/autonomy/chat-log.js";
import { runChatTurn } from "../../dist/autonomy/chat-turn.js";
import { createDialoguePort, createLanguagePort } from "../../dist/dialogue/port-adapter.js";
import { recallForDialogue } from "../../dist/dialogue/recall.js";
import { OWNER_VISITOR } from "../../dist/ports/visitor.js";
import { appraiseFromText } from "../../dist/psychology/appraisal-qq.js";
import { makeOneBotSpeaker } from "../../dist/qq/onebot-speak.js";
import { createPortActions } from "../../dist/autonomy/port.js";
import { createStandalonePort, SPEAK_QUIET_FROM, SPEAK_QUIET_TO } from "../../dist/autonomy/standalone.js";
// 2026-11 社交主动性：读视频详情 → 决定动作 → 写弹幕/评论/点赞。写接口必须登录态。
import { ACCOUNT_BLOCKED_CODES, planActivity, summarizeSocialDay } from "../../dist/bili/activity.js";
import { getVideoDetail, likeVideo, postComment, postDanmaku } from "../../dist/bili/write.js";
import {
  buildInsightPrompt,
  emptyLedger,
  markInsight,
  parseInsight,
  insightReachable,
  pickInsightCluster,
  readLedger,
  samplesOf,
  writeLedger,
} from "../../dist/learning/insight.js";
import { clusterEpisodic } from "../../dist/memory/consolidate.js";
import { advanceLearnState, loadLearnState, saveLearnState } from "../../dist/autonomy/learn-state.js";
import { runDryTick } from "../../dist/autonomy/dryrun.js";
import { SelftalkJournal } from "../../dist/maintenance/selftalk-journal.js";
import { humanize } from "../../dist/maintenance/selftalk-voice.js";
// task-169：回声自检（生成侧 Dice 闸门）。判重是大脑层纯函数，入口只做装配。
import { isSelfAuthored } from "../../dist/memory/echo-sources.js";
import { echoScore, takeLatestRefs } from "../../dist/maintenance/echo-guard.js";
import { loadEchoPolicy } from "../../dist/maintenance/echo-policy.js";
import { createVoiceWiring } from "../../dist/assembly/voice-wiring.js";
import { pickShareableImage } from "../../dist/qq/attachments.js";
import { sendPrivateImage, sendPrivateRecord } from "../../dist/qq/onebot.js";
import { startQqBridge } from "../../dist/assembly/qq-wiring.js";
import { wrapActions } from "../../dist/assembly/action-wrapper.js";
import { LEARNING_PLAN, pickKeywords } from "../../dist/bili/topics.js";
import { chooseLearningKeyword } from "../../dist/learning/learn-plan.js";
import { OpenWorldBuffer, prefilterVideos } from "../../dist/learning/openworld.js";
import { coverageGap } from "../../dist/learning/curiosity.js";
import { describeLearningYield, learningYield, noveltyGap } from "../../dist/learning/learning-yield.js";
import { deepReadLimitOf, shouldFetchHotOf, shouldSearchOf } from "../../dist/learning/energy-budget.js";
import { runIntentTick } from "../../dist/orchestrator/intent/tick.js";
import { chooseIntentOutlet, journalSeed } from "../../dist/orchestrator/intent/outlet.js";
import { runNightlyMaintenance } from "../../dist/orchestrator/intent/maintenance.js";
import { replaySource } from "../../dist/orchestrator/intent/replay-source.js";
import {
  activeKindsOf,
  openIntentions,
  parseIntentionFile,
  pruneIntentions,
  serializeIntentionFile,
  trimIntentions,
  upsertIntention,
} from "../../dist/orchestrator/intent/intent-file.js";
import { activate, newIntention } from "../../dist/orchestrator/intent/bus.js";
import { applyHardGate } from "../../dist/orchestrator/intent/gate.js";
import { decideReRaise, dropExhaustedIntentions, exhaustedSpeakKinds, pickSpeakableIntention, retireSelfReferentialIntentions, reviveBlockedIntentions, whyPhrase } from "../../dist/orchestrator/intent/intent-lifecycle.js";
import {
  deriveTrigger,
  dueIntentionsSafe,
  pickDueIntention,
  resolveEffectiveOutlet,
} from "../../dist/orchestrator/intent/lookahead.js";
import { planTickMode } from "../../dist/orchestrator/intent/tick-mode.js";
import {
  chatReplyMemorySeed,
  ensureSpokenRecord,
  findRecentRepeat,
  intentContextOf,
  isFailedSpeakVerdict,
  recordHeldAttempt,
  recordSpeakFailure,
  recordSpokenAttempt,
  recordSurfacedFailure,
  sourcesForOutlet,
  spokenMemorySeed,
} from "../../dist/orchestrator/intent/close-loop.js";
import { buildSituationNote, situationLineStats } from "../../dist/orchestrator/intent/situation-note.js";
import { buildTemporalSnapshot } from "../../dist/orchestrator/intent/temporal.js";
import {
  buildSpeakSnapshot,
  compareTimeClaims,
  extractTimeClaims,
  formatSpeakLog,
  logProactiveTimeClaims,
} from "../../dist/orchestrator/intent/speak-metrics.js";
import { buildHisRhythm, describeRhythm, rhythmThresholdsFromConfig } from "../../dist/orchestrator/intent/rhythm.js";
import {
  addReconsolidationPatch,
  parseReconsolidationFile,
  patchesForMemory,
  reconsolidationFilePath,
  serializeReconsolidationFile,
} from "../../dist/orchestrator/intent/version-file.js";
import { resolveChain } from "../../dist/orchestrator/intent/version-chain.js";
import { planReconsolidation } from "../../dist/orchestrator/intent/reconsolidation.js";
import {
  capabilityGapKindOf,
  capabilityMissingOf,
  describeAffordanceGap,
  detectAffordanceGaps,
  gapKey,
  helpTextFor,
  summarizeGapProbes,
} from "../../dist/orchestrator/intent/capability-signal.js";
import { ASK_WINDOW_MS, describeAskPlan, planAskHelp } from "../../dist/orchestrator/intent/ask-help.js";
import { canAskAgain, gapAskOutcome } from "../../dist/orchestrator/intent/gap-outcome.js";
import { buildGuardianRequest } from "../../dist/orchestrator/intent/guardian.js";
import {
  buildDshAsk,
  dshFactsPath,
  dshInboxPath,
  dshReplyDir,
  parseDshInbox,
  parseDshReply,
  recordedDshIds,
  resolveDshAsk,
  serializeDshAsk,
  serializeDshFact,
} from "../../dist/orchestrator/intent/dsh-bridge.js";
import { formatUtc } from "../../dist/orchestrator/intent/episode.js";
import {
  AUTONOMY_TOOL_CATALOG,
  availabilityOf,
  availableAffordances,
  createToolPort,
  describeToolPort,
} from "../../dist/contracts/tool-catalog.js";
import {
  TOOL_PROBE_TTL_MS,
  describeToolProbe,
  inToolProbeWindow,
  latestToolProbes,
  observeTool,
  parseToolProbeLines,
  planToolProbe,
  serializeToolProbe,
} from "../../dist/orchestrator/intent/tool-probe.js";
import {
  appendGuardianRequest,
  askHistoryPath,
  guardianInboxPath,
  guardianReplyDir,
  readAskHistory,
  readGuardianReplies,
  readGuardianRequests,
  writeAskHistory,
} from "../../dist/orchestrator/intent/persist.js";
import {
  buildReconsolidationPrompt,
  describeReconsolidationPatch,
  parseReconsolidationExplanation,
  recallPairOf,
  toReconsolidationPatch,
} from "../../dist/orchestrator/intent/reconsolidation-write.js";
import { loadUsage } from "../../dist/autonomy/usage.js";
import { isRestDay, pacingFor } from "../../dist/autonomy/pricing.js";
import { fetchPopular, loadBiliSession, searchVideos } from "../../dist/bili/public.js";
import { ingestVideos, looksOffTopic, looksUnsuitable } from "../../dist/bili/ingest.js";
import { buildVideoNote, ingestVideoNote, notesConfig } from "../../dist/bili/notes.js";
import { resolveFfmpegPath } from "../../dist/bili/ffmpeg.js";
import { PendingQueue } from "../../dist/execution/queue.js";
import { drainPending } from "../../dist/execution/executor.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const characterId = process.env.ACE_CHARACTER_ID ?? "assistant";
// F326 方案 A：人格卡已删除。显示名只是 UI 标识；缺省回落 characterId（lead 裁决）。
const displayName = (process.env.ACE_DISPLAY_NAME ?? "").trim() || characterId;
const dataDir = resolve(process.env.ACE_DATA_DIR ?? join(repo, "data"));
const autonomyOn = (process.env.ACE_AUTONOMY ?? "1") !== "0";
const once = process.argv.includes("--once");
const tzOffsetMinutes = 480;
// P3-2b（task-57 B1）：awakeForHours 的回退链最后一级——既没有醒来时刻、也没有上次睡点时，
// 按「本进程启动」算她还是醒着的（宁可用粗一点的时间，也别给 null 让整段消失）。
const processStartedAt = Date.now();
// P3-2b（task-57 B2）：夜间额度账本。P3 只读不消费（日志里报 remaining），P4 才 ++。
// 跨夜由 normalizeNightBudget 自动重置；账本落盘在 Persisted.sleep.nightBudget（P4-1），
// 启动时从 runtime.sleepInfo() 读回再 normalize 写回，重启后同一夜不重记（F317 的边界已覆盖）。
let nightBudget = normalizeNightBudget(Date.now(), tzOffsetMinutes);

mkdirSync(dataDir, { recursive: true });
// B1（task-148）：logPath 必须先于 ChatLog.open 声明。open 在“坏行/超 5000 轮转”时会同步调用
// log()，而 log() 闭包读取 logPath —— 原来的顺序会在启动期直接 TDZ ReferenceError。
const logPath = join(dataDir, `autonomy-${characterId}.log`);
const toolProbesPath = join(dataDir, `tool-probes-${characterId}.ndjson`);
// P2 网页聊天：QQ 与网页共享同一条对话流水（data/chat-<id>.ndjson）。
// 两个通道都拿到这个实例；插件侧只读同一个文件（chat/history 路由）。
const chatLog = ChatLog.open({ dataDir, characterId, now: () => Date.now(), log });
/**
 * F246：重提的"别连发"间隔（分钟）。
 *
 * 这不是主动门（用户 m09313 明确不要死程序替她决定说不说）：它只拦"刚说过又立刻说同一批"
 * 这种明显不体面的情形；被拦下的话仍然留在意图表里，过了这个间隔、或她这拍真的憋不住
 * （outlet=speak）时照样会说。
 */
const RE_RAISE_QUIET_MIN = 10;
/**
 * F350 I1：同题主动开口去重窗口（24h，写死不新增 overlay 键）。
 *
 * 只拦「同一 goal/来源在 24h 内已经主动说过」的重复；I2 删掉 T2 proactive 补位后，
 * 这是防同题复读的第二道闸。窗口不因用户回复重置（spec §9 已知取舍）。
 */
const REPEAT_SPEAK_WINDOW_MS = 24 * 60 * 60 * 1000;
// P1 前瞻意图（F193 的读侧）：默认开；ACE_LOOKAHEAD=0 只关「读侧浮现」，
// 写侧仍会生成 trigger（多一个字段无人读，回滚安全）。
const lookaheadEnabled = process.env.ACE_LOOKAHEAD !== "0";
const pidPath = join(dataDir, `autonomy-${characterId}.pid`);
// Windows 上没有「优雅 SIGTERM」：stop.ps1 落一个停止标记，常驻进程每拍检查一次，先 flush 再退。
const stopPath = join(dataDir, `autonomy-${characterId}.stop`);

function log(line) {
  // F278：轮转与写盘细节搬进 src/assembly/main-config.ts（可单测），这里只注入路径与时钟。
  appendRuntimeLog({ logPath, line, nowMs: Date.now() });
}

/** F354：一次模型调用的用量与缓存命中（无 usage 不打） */
function logUsage(task, reply) {
  const line = formatUsageLog(task, reply);
  if (line !== undefined) log(line);
}

/** 从环境变量读数值；缺省/空串/NaN 都回落调用方给的默认值 */
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * task-137：写通道的 handler 抛错时带机器可读 code。
 * 写通道服务端会把 err.code 原样放进响应（`{ok:false,error,code}`），插件据此映射提示。
 */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** P4-1：compact 结果的一行摘要（7 天观察看 lines_before→lines_after；失败带 error） */
function compactText(compact) {
  if (compact.error !== null) return `failed(${compact.error})`;
  return compact.ran ? `${compact.linesBefore}→${compact.linesAfter}` : `skip(${compact.linesBefore})`;
}

/**
 * P4-1（task-74 B3）：hardDelete 候选 id 的日志摘要。
 *
 * 只打前 5 个示例（候选清单本身最多 20 条，见 runtime 的 PURGEABLE_ID_LIMIT），
 * 避免 7 天观察的日志被 id 刷屏；`purgeable=` 仍是全量计数。
 */
function purgeableIdsText(ids) {
  if (ids.length === 0) return "-";
  return ids.length > 5 ? `${ids.slice(0, 5).join(",")}…(+${ids.length - 5})` : ids.join(",");
}

/** P4-1：一次睡点工作的观测行——fade days / compact lines / forgotten / purgeable 都是判据 */
function logSleepWork(work) {
  if (work.fade.firstAnchor) {
    log(`[fade] first-anchor=${work.fade.anchor ?? "-"}（老存档首跑：只写锚点，不补扣）`);
  } else if (work.fade.days > 0 || work.fade.faded > 0 || work.fade.error !== null) {
    log(
      `[fade] days=${work.fade.days.toFixed(2)} faded=${work.fade.faded} forgotten=${work.fade.forgotten}${work.fade.error === null ? "" : ` error=${work.fade.error}`}`,
    );
  }
  if (work.consolidated || work.archived > 0 || work.compact.ran || work.purgeable > 0 || work.error !== null) {
    log(
      `[sleep-work] consolidated=${work.consolidated ? 1 : 0} clusters=${work.clusters} written=${work.written} archived=${work.archived} fade_days=${work.fade.days.toFixed(2)} faded=${work.fade.faded} forgotten=${work.fade.forgotten} compact=${compactText(work.compact)} purgeable=${work.purgeable} ids=${purgeableIdsText(work.purgeableIds)}${work.error === null ? "" : ` error=${work.error}`}`,
    );
  }
}

/**
 * 凭据文件：data/autonomy.env（KEY=VALUE 每行一条，# 注释）。
 * 只在本进程里注入，不打印值、不进日志、不进记忆；文件不进版本库（.gitignore 已覆盖 data/）。
 * 这样「最安全且不影响效率」：不写进任何 prompt，也不依赖 shell 历史。
 */
function loadEnvFile(path) {
  loadEnvFileFromDisk(path);
}

function readHolidays() {
  return readHolidayFile(join(dataDir, "holidays.txt"));
}

/** 调休上班日：与节假日表配对，周末被调成工作日的那几天不算休息日 */
function readWorkdays() {
  return readWorkdayFile(join(dataDir, "workdays.txt"));
}

/** 从插件配置里读 OneBot 连接参数；读不到就返回 null（她只写日记，不对外说） */
function readOneBot() {
  return readOneBotConfig(join(repo, "cordis.patch.yml"));
}

/**
 * 读 `qq.proactive`：F271 之后主动开口只发生在常驻进程里，这一段是唯一消费者。
 * 读不到就回落 AutonomyConfig 的默认值（不关功能，也不猜一个更激进的值）。
 */
function readQqProactive() {
  try {
    return readQqProactiveConfig(readFileSync(join(repo, "cordis.patch.yml"), "utf8"));
  } catch (err) {
    log(`[autonomy] qq.proactive 读取失败，回落默认节奏：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function localParts(now) {
  return localPartsOf(now, tzOffsetMinutes);
}

async function main() {
  if (existsSync(stopPath)) rmSync(stopPath, { force: true });
  log(`[autonomy] 启动 character=${characterId} dataDir=${dataDir} once=${String(once)}`);
  // 取帧要调 ffmpeg：计划任务的进程环境不一定有交互 shell 的 PATH，
  // 所以启动时就把可执行文件定下来并打一行日志（F138：frames=0 静默了十几轮）。
  const ffmpegPath = resolveFfmpegPath({ env: process.env, exists: existsSync });
  log(`[autonomy] ffmpeg=${ffmpegPath}`);
  // 手动说一句：验证「对外表达」通道，也给用户一个直接测试她的入口
  //   node scripts/autonomy/main.mjs --say "在吗，我想你了"
  const sayAt = process.argv.indexOf("--say");
  if (sayAt >= 0) {
    const text = process.argv[sayAt + 1] ?? "";
    // F281：流程搬进 src/assembly/say-mode.ts（可单测），这里只注入依赖与退出码。
    process.exitCode = await runSayMode(text, {
      log,
      loadConn: readOneBot,
      humanize,
      speak: (conn, line) => makeOneBotSpeaker({ conn, fetchImpl: fetch })(line),
    });
    return;
  }

  const cfg = await loadConfig();
  // F326 方案 A：人格卡已删除（不读、不校验、不注入）。conf 里只剩机制参数 +
  // 显示名（UI 标识，缺省回落 characterId，见文件顶部 displayName）。
  const conf = {
    characterId,
    displayName,
    dataDir,
    trace: false,
    // 批次 2a：daemon 是主写者。别的进程写过时仍要落盘（否则心跳停摆），但记一次警告。
    stateWriter: "primary",
    stateLog: log,
  };
  log(`[autonomy] displayName=${displayName}`);
  const runtime = await SoulRuntime.open(conf);
  log("[autonomy] runtime 已打开");
  // P4-1（task-69 Lead 决定 6）：夜间账本持久化——load 时按当前夜 normalize（跨夜自动
  // 重置 used），再写回 Persisted.sleep；重启后同一夜不重记。账本与白天 quota 无关。
  {
    const persistedBudget = runtime.sleepInfo().nightBudget;
    nightBudget = normalizeNightBudget(Date.now(), tzOffsetMinutes, persistedBudget ?? undefined);
    runtime.setNightBudget(nightBudget);
    log(`[sleep-budget] load night=${nightBudget.nightKey} used=${nightBudget.used}/${SLEEP_NIGHT_BUDGET}`);
  }
  // P4-1（F317）：启动补巩固——daemon 在睡点期间重启会漏一次 deterministic 巩固。
  // 只补 consolidate/archive/fade/compact，**不补** dream/habit/SelfModel（按 nightKey 记账）。
  try {
    const backfill = runtime.backfillSleepWork();
    if (backfill.ran) {
      log(
        `[sleep-backfill] missed=${backfill.missed} consolidated=${backfill.consolidated ? 1 : 0} clusters=${backfill.clusters} written=${backfill.written} archived=${backfill.archived} fade_days=${backfill.fade.days.toFixed(2)} forgotten=${backfill.fade.forgotten} compact=${compactText(backfill.compact)} purgeable=${backfill.purgeable} ids=${purgeableIdsText(backfill.purgeableIds)}${backfill.error === null ? "" : ` error=${backfill.error}`}`,
      );
      if (backfill.fade.firstAnchor) {
        log(`[fade] first-anchor=${backfill.fade.anchor ?? "-"}（补巩固首跑：只写锚点，不补扣）`);
      } else if (backfill.fade.days > 0 || backfill.fade.faded > 0 || backfill.fade.error !== null) {
        log(
          `[fade] days=${backfill.fade.days.toFixed(2)} faded=${backfill.fade.faded} forgotten=${backfill.fade.forgotten}${backfill.fade.error === null ? "" : ` error=${backfill.fade.error}`}`,
        );
      }
    } else {
      log(`[sleep-backfill] missed=0 reason=${backfill.reason}${backfill.error === null ? "" : ` error=${backfill.error}`}`);
    }
  } catch (err) {
    log(`[sleep-backfill] degraded error=${err instanceof Error ? err.message : String(err)}`);
  }
  // 批次 2b（单写者 A）：插件进程只读，写操作经本机回环写通道投到这里。
  // F286：handler 映射 + 通道文件 + 日志搬进 src/assembly/write-channel-wiring.ts（可单测）。
  // task-137：chat / web_search 通道地基。
  // task-138：web_search 接真业务——但 handler 需要后面的 webUsage/凭证初始化，
  // 所以这里留晚绑定：启动窗口内来的请求明确报"启动中"，不假装没接。
  let webToolHandler = null;
  // F1：soul_web_fetch 也需要后面才初始化的 webUsage/凭证——同样晚绑定。
  let webFetchHandler = null;
  // task-139：chat 业务需要 llm / 共享历史 / 召回，都在启动后段才就绪——同样晚绑定。
  let chatHandler = null;
  const writeChannel = await startWriteChannel({
    dataDir,
    characterId,
    runtime,
    log,
    chat: (payload) => {
      if (chatHandler === null) {
        throw codedError("CHANNEL_UNSUPPORTED", "chat 尚未就绪（daemon 启动中）");
      }
      return chatHandler(payload);
    },
    webSearch: (payload) => {
      if (webToolHandler === null) {
        throw codedError("CHANNEL_UNSUPPORTED", "web_search 尚未就绪（daemon 启动中）");
      }
      return webToolHandler(payload);
    },
    webFetch: (payload) => {
      if (webFetchHandler === null) {
        throw codedError("CHANNEL_UNSUPPORTED", "web_fetch 尚未就绪（daemon 启动中）");
      }
      return webFetchHandler(payload);
    },
  });
  // F326 方案 A：人格卡加载期体检整段删除（卡已不存在，六层人格不再从卡读）。

  loadEnvFile(join(dataDir, "autonomy.env"));

  // 社交节奏：data/autonomy.env 可覆盖（分钟/次数），默认值唯一来源是 AutonomyConfig。
  // 用 env 而不是 cordis.patch.yml 顶层新键，是因为插件没有声明 autonomy 段，新增键没人校验。
  const socialEveryMin = envNumber("ACE_SOCIAL_INTERVAL_MIN", DEFAULT_AUTONOMY.socialIntervalMs / 60_000);
  const socialDailyMax = envNumber("ACE_SOCIAL_DAILY_MAX", DEFAULT_AUTONOMY.socialDailyMax);
  const socialCommentDailyMax = envNumber("ACE_SOCIAL_COMMENT_DAILY_MAX", DEFAULT_AUTONOMY.socialCommentDailyMax);

  // 主动开口节奏：唯一来源是 qq.proactive（常驻进程是 F271 之后唯一消费者）。
  // enabled=false 时循环不再规划 proactive；minGap/maxPerDay 直接进 bridge 的机械门。
  const qqProactive = readQqProactive();
  const proactiveEveryMin =
    qqProactive?.checkEveryMin !== undefined && qqProactive.checkEveryMin > 0
      ? qqProactive.checkEveryMin
      : DEFAULT_AUTONOMY.proactiveIntervalMs / 60_000;
  const proactiveMinGapMin = qqProactive?.minGapMin ?? DEFAULT_AUTONOMY.proactiveMinGapMs / 60_000;
  const proactiveMaxPerDay = qqProactive?.maxPerDay ?? DEFAULT_AUTONOMY.proactiveMaxPerDay;
  const proactiveOptions = {
    enabled: qqProactive?.enabled ?? true,
    minGapMs: Math.max(0, proactiveMinGapMin) * 60_000,
    maxPerDay: Math.max(0, proactiveMaxPerDay),
    quietFrom: SPEAK_QUIET_FROM,
    quietTo: SPEAK_QUIET_TO,
  };
  log(
    `[autonomy] 主动节奏 check=${String(proactiveEveryMin)}min gap=${String(proactiveMinGapMin)}min max=${String(proactiveMaxPerDay)}/day enabled=${String(proactiveOptions.enabled)}；` +
      `社交 check=${String(socialEveryMin)}min max=${String(socialDailyMax)}/day 评论=${String(socialCommentDailyMax)}/day`,
  );

  const journal = SelftalkJournal.open(join(dataDir, `selftalk-${characterId}.json`));
  // task-169 C：生成侧回声自检（QQ 主动开口用；网页回复/replay 旧路径按 E3 不接）。
  // 参照文本 = 她最近说过的话（chat log 的「她」那侧）+ 自述来源记忆 + 最近 24h 日记。
  // 任何一步失败都按「未命中」放行——宁可偶尔重复，也不要因为自检坏了就不说话。
  const echoPolicy = loadEchoPolicy({ read: (name) => knobNumber(cfg, name) });
  const echoCheckForQq = (text) => {
    try {
      const nowMs = Date.now();
      const windowFloorMs = nowMs - echoPolicy.windowMs;
      const herRefs = [];
      for (const entry of chatLog.recent(120)) {
        if (entry.who === "her") herRefs.push({ text: entry.text, atMs: entry.atMs });
      }
      const memoryRefs = runtime
        .memoryStore()
        .active()
        .filter((record) => isSelfAuthored(record.source))
        .map((record) => ({ text: record.content, atMs: record.created_at }));
      const journalRefs = journal
        .entriesSince(nowMs - echoPolicy.windowMs)
        // task-172：参照只看「此刻及以前」的日记；时钟回拨写进来的未来条目不算回声依据。
        .filter((entry) => entry.at <= nowMs)
        .map((entry) => ({ text: entry.text, atMs: entry.at }));
      // task-170 B1：按时间排序后再取最新 lookback 条（拼接顺序不是时间顺序）。
      const refs = takeLatestRefs(
        [
          ...herRefs.filter((entry) => entry.atMs >= windowFloorMs && entry.atMs <= nowMs),
          ...memoryRefs.filter((entry) => entry.atMs >= windowFloorMs && entry.atMs <= nowMs),
          ...journalRefs,
        ],
        echoPolicy.lookback,
      );
      const score = echoScore(text, refs);
      return { hit: score >= echoPolicy.threshold, score };
    } catch (err) {
      log(`[echo] 自检失败（按未命中原样外发）：${err instanceof Error ? err.message : String(err)}`);
      return { hit: false, score: 0 };
    }
  };
  // key：环境变量优先，否则读 DPAPI 文件（%LOCALAPPDATA%）。日志只写"来源"，不写值。
  const resolved = await loadLlmConfig(process.env);
  const llm = resolved === null ? null : resolved.config;
  log(
    resolved === null
      ? "[autonomy] 没有模型凭据：内部言语用降级模板"
      : `[autonomy] 模型 ${llm.model} @ ${llm.baseUrl}（key=${resolved.keySource}）`,
  );

  // P2 网页聊天：daemon 侧一轮。与 QQ 共享 ChatLog 与召回口径；
  // 不调 recordUsageOnce（网页聊天不计入模型预算，设计 §3 语义 2）。
  // task-157：称呼从插件配置读（qq.onebot.peerName，缺省「用户」），不硬编码。
  // 这里先读一次 conn（后面起 QQ 桥也用同一份，避免读两遍配置）。
  const conn = readOneBot();
  chatHandler = (payload) =>
    runChatTurn(
      {
        runtime,
        llm,
        dialogue: createDialoguePort(runtime.persona()),
        // R4：spine 不 import 大脑实现，判定/语言/落记忆都从装配层注入。
        appraise: appraiseFromText,
        language: createLanguagePort(),
        replySeed: (reply) => chatReplyMemorySeed({ reply }),
        recall: (text) => recallForDialogue(runtime, text, OWNER_VISITOR, "web"),
        history: chatLog,
        peerName: conn?.peerName ?? "用户",
        // S3b（M5）：网页回信时间一致性日志。判定在装配层做（spine 不 import 大脑实现）。
        recordTimeClaims: (reply) => {
          try {
            const extracted = extractTimeClaims(reply);
            if (extracted.claims.length === 0) return;
            const nowMs = Date.now();
            let lastPeerAtMs = null;
            for (const entry of chatLog.recent(200)) {
              if (entry.who !== "peer" || !Number.isFinite(entry.atMs) || entry.atMs > nowMs) continue;
              lastPeerAtMs = Math.max(lastPeerAtMs ?? 0, entry.atMs);
            }
            const snap = buildSpeakSnapshot({
              nowMs,
              tzOffsetMinutes,
              awakeForHours: null,
              sinceLastUserMsgMin:
                lastPeerAtMs === null ? null : Math.max(0, (nowMs - lastPeerAtMs) / 60_000),
              sinceLastOwnMsgMin: null,
              lastSleepAtMs: null,
              presenceActive: null,
            });
            const compared = compareTimeClaims(extracted.claims, snap);
            log(
              formatSpeakLog("web", snap, {
                claims: compared.claims + extracted.unverified,
                verifiable: compared.verifiable,
                mismatch: compared.mismatch,
                unverified: compared.unverified + extracted.unverified,
              }),
            );
          } catch {
            log("[time-claim] failed");
          }
        },
        now: () => Date.now(),
        log,
      },
      payload,
    );

  const holidays = readHolidays();
  const workdays = readWorkdays();
  // P2a 时间观：节律统计与 pacing 用同一份日历（调休优先），避免两套「今天算不算休息日」。
  // 集合只建一次：这两张表在进程生命周期里不会变（改了表要重启，与其他 data/ 配置同规矩）。
  const rhythmCalendar = { restDays: new Set(holidays), workDays: new Set(workdays) };
  // 对外表达：连接参数复用插件配置（不另抄一份），读不到就不开口
  const speaker = conn === null ? null : makeOneBotSpeaker({ conn, fetchImpl: fetch });
  log(
    conn === null
      ? "[autonomy] 没读到 OneBot 连接配置：自言自语只说给自己听"
      : `[autonomy] 对外表达已接线 peer=${String(conn.peer)} dryRun=${String(conn.dryRun)}`,
  );
  // QQ 桥移交：owner=autonomy 时由这里起监听（收 WS + HTTP 发），插件不再建桥。
  // 没有模型凭据就不起——宁可不接待，也不回一句没有大脑的话。
  // 语音二件套（出站 TTS / 入站 ASR）都跑在宿主外的小工具里：
  //   - 出站：先 edge-tts（音色好，要联网），失败退本机 SAPI（离线，一定有声音）；两条都挂才降级文字；
  //   - 入站：OneBot 给的语音先下载到本地，再走 faster-whisper 转写；
  //   - python 解释器默认走 PATH，换解释器只改 ACE_PYTHON（与插件侧同一口径）。
  // 失败一律降级成文字：一条消息因为语音坏了而不回，比回一条文字糟得多（src/qq/voice.ts 的取舍注释）。
  // 语音二件套（出站 edge-tts→SAPI 兜底 / 入站 whisper 转写）的装配已下沉到
  // src/assembly/voice-wiring.ts（F296）：入口只拿"能说话的两个函数"，环境知识不进这层。
  const { synthVoice, transcribeVoice } = createVoiceWiring({ repo, dataDir, log, now: () => Date.now() });

  const qqSendDeps = conn === null ? null : { baseUrl: conn.baseUrl, token: conn.token };
  const qqHandle = startQqBridge({
    dataDir,
    characterId,
    repo,
    conn,
    once,
    runtime,
    llm,
    // P2：网页 ↔ QQ 共享历史（同一个 ChatLog；不给这段就是旧行为）。
    historyStore: chatLog,
    // task-169 C：主动开口的回声自检（不传 = 旧行为，不做闸门）。
    echoCheck: echoCheckForQq,
    tzOffsetMinutes,
    now: () => Date.now(),
    log,
    // 出站的洞留在入口：H11 要求出站只有一处收口，扫描面内的新文件不许直连发送。
    sendImage: (peer, imagePath) => {
      const base64 = readFileSync(imagePath).toString("base64");
      return sendPrivateImage(qqSendDeps, { peer, base64, mime: "image/jpeg" });
    },
    // 她真的能递图了：只有她说「给你看图」时才会被问一次，素材只从她自己的取帧目录里挑
    // （24h 内、4KB 以上）。没有图就照常只发文字——不假装有图（F102 的教训）。
    shareImage: () => {
      const picked = pickShareableImage({ root: join(dataDir, "frames"), nowMs: Date.now() });
      if (picked === null) return null;
      log(`[autonomy] 递图素材 frames/${picked.bvid}/${picked.path.split(/[\/]/).pop() ?? ""}`);
      return picked.path;
    },
    // 入站语音：下载 → whisper 转写（失败由桥降级成「对方发来一条语音，没转写出来」）
    transcribeVoice: (path) => transcribeVoice(path),
    // 出站语音：合成 → 发 record 段（合成/发送都在入口，H11 要求出站只有一个收口）
    sendVoice: async (peer, text) => {
      const file = await synthVoice(text);
      const sent = await sendPrivateRecord(qqSendDeps, { peer, file });
      log(`[voice] 语音已发 ${sent.detail}（${file.split(/[\/]/).pop() ?? ""}）`);
      return { ok: sent.ok, detail: `record: ${sent.detail}` };
    },
  });


  // 意图拍的上下文（A4/A5 起由 tick 写、出口动作读）。必须在这里声明：
  // learnImpl 定义得比 tick 早，A8② 要用它判断"这一拍是不是 explore"，
  // 放在后面会撞 `let` 的暂时性死区。
  let lastIntentContext;
  // F352：同一拍的 TemporalSnapshot（P1 事实层）。intentTickImpl 里建好、proactiveImpl 只读——
  // 两个函数是同一个 main() 里的不同闭包，直接互相引用会 ReferenceError（2026-11-04 线上实锤）。
  // 每拍 intentTickImpl 开头清空，算完再赋；proactive 在同一拍（intentTick 先跑）里读。
  let beatTemporal;

  // 学习轮转跨重启存活：今天进程重启过多次，进程内 rotation 从 0 开始，
  // 结果一直在搜最前面几个关键词、命中全是已入库视频（ingested=0）。
  const queuePath = join(dataDir, "execution", "autonomy-queue.json");
const learnStatePath = join(dataDir, `autonomy-learn-${characterId}.json`);
  let learnState = loadLearnState(learnStatePath);
  log(`[autonomy] 学习轮转从第 ${String(learnState.rotation)} 个关键词继续（已连续空转 ${String(learnState.idleRounds ?? 0)} 轮）`);
  // 队列里只有 at-least-once 的动作（目前是入库）：失败过的入库会在后续拍里重试，
  // 直到成功或到上限。放 tick 里跑，是为了不额外占定时器。
  const drainQueue = async () => {
    let pending;
    try {
      pending = PendingQueue.open(queuePath, Date.now()).queue;
    } catch (err) {
      log(`[queue] 队列打不开，跳过：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const outcome = await drainPending({
      queue: pending,
      now: () => Date.now(),
      log,
      run: async (item) => {
        if (item.toolId !== "bili.ingest") {
          return { ok: false, retryable: false, detail: `不认识的 toolId=${item.toolId}` };
        }
        const videos = Array.isArray(item.input) ? item.input : [];
        const r = ingestVideos(runtime.knowledgeWritePort(), videos, Date.now());
        return { ok: true, detail: `ingested=${String(r.ingested)}` };
      },
    });
    if (outcome.attempted > 0) {
      log(`[queue] attempted=${String(outcome.attempted)} ok=${String(outcome.succeeded)} retry=${String(outcome.retried)} dropped=${String(outcome.dropped)}`);
    }
  };

  /**
   * 热榜快照：关键词学习是「她想学什么」，热门榜是「外面在发生什么」；两条并列，
   * 都不当场写库（热榜先进睡眠缓冲）。hot 档只剩这一条路，所以单独提出来。
   */
  const captureHotSnapshot = async (deps, nowMs) => {
    try {
      // ps=50：热门榜一次最多 50 条。抓得多才能"淘汰 >90%"还留够 4 条
      // （规格 §10.1 第 2 段要求廉价预筛淘汰 >90%，20 条里留 4 条只有 80%）。
      const hot = await fetchPopular(deps, { pageSize: 50 });
      const funnelVideos = hot.map((v) => ({
        bvid: v.bvid,
        title: v.title,
        play: v.view,
        like: v.like,
        pubdateMs: v.pubdateMs,
        durationSec: v.durationSec,
        owner: v.owner,
        tags: v.tags,
        description: v.description,
      }));
      const pre = prefilterVideos(funnelVideos, { nowMs, keep: 4 });
      const buffer = new OpenWorldBuffer({ path: funnelBufferPath });
      buffer.load();
      const buffered = buffer.append(
        pre.kept.map((k) => ({ video: k.video, score: k.score, at: nowMs })),
        nowMs,
      );
      log(
        `[autonomy] funnel 热门=${String(hot.length)} 候选=${String(pre.examined)} 保留=${String(pre.kept.length)} 淘汰率=${String(Math.round(pre.dropRate * 100))}% 入缓冲=${String(buffered)}（共 ${String(buffer.size)} 条待睡）`,
      );
      return true;
    } catch (err) {
      // 热榜拉不到不影响关键词学习：这两条路是并列的，不是主从
      log(`[autonomy] funnel 热门拉取失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  // W1（spec v2.3 §5.3）：第二参只在 explore-only 入口出现；普通拍不传 = 旧行为。
  const learnImpl = async (tier = "full", input) => {
    // P3-3（hot）：只拉热榜就结束——不选词、不搜索、不深读、不推进轮转，也不扣 learn 费。
    // 判定在脊髓（standalone），这里只按档位接线（R4）。
    if (!shouldSearchOf(tier)) {
      const hotNowMs = Date.now();
      const hotSession = loadBiliSession(dataDir, characterId);
      const hotDeps = { fetchFn: fetch, now: () => hotNowMs, log, ...(hotSession === null ? {} : { session: hotSession }) };
      const ok = await captureHotSnapshot(hotDeps, hotNowMs);
      log(`[learn] tier=hot search=0 hot=${ok ? 1 : 0} enrich=0 deep=none`);
      return { topic: "hot", keyword: "热榜", deepReads: 0 };
    }
    // A8②：她这一拍若被 explore 推着，优先去"不认识的地方"：用固定轮转而不是好奇心
    // 偏好（好奇心偏好在最熟的词上打转，正审计说的"越学越窄"）；
    // 同时把页码往后翻一页，避免同一批视频反复被搜到。
    // W1（B5-2）：explore 的判定改由**入参**决定——只有 explore-only 入口传 exploreNow；
    // 不再从 lastIntentContext 读，避免普通学习拍被上一拍意图串味。
    const exploreNow = input?.exploreNow === true;
    // 「今天学什么」先问状态（§10.2 好奇心），状态没偏好才退回固定轮转。
    // 选完不在这里搜：搜索/入库仍是下面的 bili 工具面，这里只决定"搜什么"。
    const choice = exploreNow
      ? null
      : chooseLearningKeyword(
        {
          plan: LEARNING_PLAN,
          state: runtime.state,
          curiosityGap: coverageGap(runtime.knowledgeStore().all()),
          rotation: learnState.rotation,
        },
        runtime.config,
      );
    const picked = choice ?? pickKeywords(LEARNING_PLAN, learnState.rotation);
    log(
      `[autonomy] learn 关键词=${picked.keyword}（${picked.topic}）来源=${exploreNow ? "探索意图" : choice === null ? "固定轮转" : "好奇心"}` +
        (choice === null ? "" : ` 理由=${choice.reason}`),
    );
    // 同一关键词会随轮转反复出现：每转完一整圈往后翻一页；连续空转也直接加深，
    // 否则要等 10 个关键词轮完（约 7.5 小时）才会看到新内容。
    const keywordCount = LEARNING_PLAN.reduce((n, group) => n + group.keywords.length, 0);
    const idle = learnState.idleRounds ?? 0;
    const page = 1 + Math.floor(learnState.rotation / keywordCount) + Math.floor(idle / 3) + (exploreNow ? 1 : 0);
    const nowMs = Date.now();
    const session = loadBiliSession(dataDir, characterId);
    // log 必须接上：buildVideoNote 的所有降级（字幕取不到 / 挑不出帧 / 裁不出画面）
    // 都只通过 deps.log 说话，不接就是「静默失败」——F138 就是这么藏了十几轮。
    const deps = { fetchFn: fetch, now: () => nowMs, log, ...(session === null ? {} : { session }) };
    let videos = [];
    let fetched = 0;
    let failure = null;
    try {
      videos = await searchVideos(deps, { keyword: picked.keyword, pageSize: 5, page });
      fetched = videos.length;
    } catch (err) {
      // 搜索失败也要推进轮转，否则一个关键词挂掉会让她永远卡在同一条搜索上
      failure = err instanceof Error ? err.message : String(err);
      log(`[autonomy] learn 搜索失败 keyword=${picked.keyword} error=${failure}`);
    }
    let result = { ingested: 0, skipped: 0, blocked: 0, offTopic: 0 };
    // 深读：先给「值得看」的前 N 条补字幕与画面，再让 ingestVideos 处理剩下的。
    // 顺序不能反：ingestVideos 会把 bvid 写进知识库，之后富知识就因幂等被跳过了。
    let enriched = 0;
    if (videos.length > 0) {
      // cfg 是 EngineConfig，不是 KnobReader：直接传会让 knobs.read 抛 TypeError、
      // 被 notesConfig 的 try/catch 静默吃掉 → 深读旋钮永远等于默认值（F147 修）。
      const noteCfg = notesConfig({ read: (name) => knobNumber(cfg, name) }, {
        ffmpegPath,
        frameRoot: join(dataDir, "frames"),
        spriteDir: join(dataDir, "frames", ".sprites"),
      });
      const store = runtime.knowledgeWritePort();
      for (const video of videos) {
        if (enriched >= deepReadLimitOf(tier, noteCfg.enrichPerRound)) break;
        if (looksUnsuitable(video) || looksOffTopic(video).offTopic) continue;
        try {
          const note = await buildVideoNote(deps, video, noteCfg);
          if (ingestVideoNote(store, video, note, nowMs)) {
            enriched += 1;
            log(`[autonomy] note ${video.bvid} quotes=${String(note.quotes.length)} subtitleChars=${String(note.subtitleChars)} frames=${String(note.frames.length)}`);
          }
        } catch (err) {
          log(`[autonomy] note ${video.bvid} 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (videos.length > 0) {
      try {
        result = ingestVideos(runtime.knowledgeWritePort(), videos, nowMs);
      } catch (err) {
        // 入库失败不丢素材：进队列，后面几拍重试（at-least-once）
        const detail = err instanceof Error ? err.message : String(err);
        log(`[autonomy] learn 入库失败，转入队列：${detail}`);
        try {
          PendingQueue.open(queuePath, nowMs).queue.enqueue({
            id: `ingest-${String(nowMs)}-${String(picked.keyword)}`,
            toolId: "bili.ingest",
            input: videos,
            subject: `autonomy:${String(nowMs)}`,
            now: nowMs,
          });
        } catch (queueErr) {
          log(`[queue] 入队失败：${queueErr instanceof Error ? queueErr.message : String(queueErr)}`);
        }
      }
    }
    // §10.1 前两段：再抓一份热门快照，廉价预筛后放进睡眠缓冲——**不当场写库**。
    // 关键词搜索是「她想学什么」，热门榜是「外面在发生什么」；两条都进知识库，
    // 但热榜那条要先睡一觉（第 5 段），睡醒才决定什么值得记住。
    let hotOk = false;
    if (shouldFetchHotOf(tier)) hotOk = await captureHotSnapshot(deps, nowMs);

    learnState = advanceLearnState(learnState, picked.keyword, result.ingested, nowMs);
    try {
      saveLearnState(learnStatePath, learnState, nowMs);
    } catch (err) {
      log(`[autonomy] 学习状态写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (failure === null) {
      log(`[autonomy] learn topic=${picked.topic} keyword=${picked.keyword} page=${String(page)} fetched=${String(fetched)} ingested=${String(result.ingested)} enriched=${String(enriched)} skipped=${String(result.skipped)} blocked=${String(result.blocked)} offTopic=${String(result.offTopic)} idle=${String(learnState.idleRounds ?? 0)}`);
    }
    log(`[learn] tier=${tier} search=1 hot=${hotOk ? 1 : 0} enrich=${String(deepReadLimitOf(tier, 1))} deep=${String(enriched)}`);
    // W1（spec v2.3 §5.3）：biliEmpty 只在「B 站搜索真正执行且结果为空」时为 true。
    // 搜索失败不是空结果（那是"没找到"之外的失败），hot/skip 档根本不会走到这里。
    return {
      topic: picked.topic,
      keyword: picked.keyword,
      deepReads: enriched,
      biliEmpty: failure === null && fetched === 0,
    };
  };

  // ── 社交主动性（2026-11）───────────────────────────────────────────────
  // 主动性不再只用来“找他说话”：每拍刷一条 B 站视频，按预算决定留弹幕/评论/赞。
  // 预算与动作选择在 src/bili/activity.ts（纯函数、可穷举单测）；这里只做 IO 与账本。
  const socialLedgerPath = join(dataDir, `social-${characterId}.ndjson`);

  /** 账本：一行一次尝试（含 watch），用来算当天额度、冷却与“这条视频互动过没有” */
  function readSocialLedger(nowMs) {
    const today = dayKey(nowMs, tzOffsetMinutes);
    const entries = [];
    try {
      if (!existsSync(socialLedgerPath)) return { entries, today };
      for (const line of readFileSync(socialLedgerPath, "utf8").split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
          const entry = JSON.parse(line);
          if (entry !== null && typeof entry === "object" && typeof entry.at === "number") entries.push(entry);
        } catch {
          // 坏行跳过：账本不该让进程起不来
        }
      }
    } catch (err) {
      log(`[social] 账本读取失败（按空账本处理）：${err instanceof Error ? err.message : String(err)}`);
    }
    return { entries, today };
  }

  function appendSocialLedger(entry) {
    try {
      appendFileSync(socialLedgerPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      log(`[social] 账本写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 让模型写一句弹幕/评论；按码点截断，避免把 emoji 切成半个 */
  async function composeSocialText(action, detail, model) {
    const limit = action === "danmaku" ? 20 : 60;
    const kind = action === "danmaku" ? "弹幕" : "评论";
    const messages = [
      {
        role: "system",
        content:
          `你是「${displayName}」，在 B 站刷到一条视频，想以普通观众身份留一句${kind}。` +
          `口语、短、像真人；不解释身份，不@人，不引战，不刷屏。只输出这一句话，不超过${String(limit)}字。`,
      },
      {
        role: "user",
        content: `标题：${detail.title}\n简介：${(detail.description === "" ? "（无）" : detail.description).slice(0, 200)}`,
      },
    ];
    const reply = await chatComplete(model, messages, { task: "social", maxTokens: 120 });
    logUsage("social", reply);
    const line = reply.text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
    if (line === "") throw new Error("模型返回空句子");
    return Array.from(line).slice(0, limit).join("");
  }

  const socialImpl = async () => {
    const nowMs = Date.now();
    const { entries, today } = readSocialLedger(nowMs);
    const todayEntries = entries.filter((entry) => dayKey(entry.at, tzOffsetMinutes) === today);
    // 预算口径在 activity.ts（纯函数、可单测）：只有成功才算“做过了”，
    // 账号级失败（未转正/等级不足）记成 blocked，当天不再尝试那个动作。
    const summary = summarizeSocialDay(todayEntries);
    const lastAt = entries.reduce((max, entry) => (entry.at > max ? entry.at : max), 0);
    const session = loadBiliSession(dataDir, characterId);
    const deps = { fetchFn: fetch, now: () => nowMs, log, ...(session === null ? {} : { session }) };

    // 配置为 0 = 关掉社交：连热门都不拉（与 planActivity 的判定一致，省一次网络）
    if (socialDailyMax <= 0) {
      return { action: "skip", ok: false, reason: "社交已关闭（每日上限 0）" };
    }

    let videos;
    try {
      videos = await fetchPopular(deps, { pageSize: 20 });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`[social] 热榜拉取失败：${reason}`);
      return { action: "skip", ok: false, reason: "热榜拉取失败" };
    }
    // 今天已经在这条视频下留过痕迹就换一条：同一条反复刷容易被当成机器人。
    const candidates = videos.filter(
      (video) =>
        !looksUnsuitable(video) &&
        !looksOffTopic(video).offTopic &&
        !todayEntries.some((entry) => entry.bvid === video.bvid),
    );
    if (candidates.length === 0) {
      log("[social] 今天的热门都互动过了，等下一轮热榜刷新");
      return { action: "skip", ok: false, reason: "今天的热门都互动过了" };
    }

    let detail = null;
    let video = null;
    for (const candidate of candidates.slice(0, 3)) {
      const fetched = await getVideoDetail(deps, candidate.bvid);
      if (fetched !== null) {
        detail = fetched;
        video = candidate;
        break;
      }
    }
    if (detail === null || video === null) {
      log("[social] 候选视频详情都取不到，跳过这一拍");
      return { action: "skip", ok: false, reason: "详情取不到" };
    }

    // liked 跨天有效：点过就不重复点；actedToday 用今天账本判定。
    const liked = entries.some((entry) => entry.bvid === detail.bvid && entry.action === "like" && entry.ok === true);
    const plan = planActivity({
      now: nowMs,
      lastActionAt: lastAt > 0 ? lastAt : null,
      todayActions: summary.actions,
      todayDanmaku: summary.danmaku,
      todayComments: summary.comments,
      video: {
        bvid: detail.bvid,
        durationSec: detail.durationSec > 0 ? detail.durationSec : video.durationSec,
        liked,
        actedToday: todayEntries.some((entry) => entry.bvid === detail.bvid),
      },
      energy: runtime.state.energy,
      asleep: runtime.sleepInfo().asleep === true,
      hasSession: session !== null,
      config: {
        intervalMs: socialEveryMin * 60_000,
        dailyMax: socialDailyMax,
        // 给“评论”和“点赞”各留一个位置：默认 4 次/天 = 2 弹幕 + 1 评论 + 1 赞。
        // 账号被挡住的类型当天置 0：换视频重试也发不出去，只会白花模型调用。
        danmakuDailyMax: summary.blocked.has("danmaku")
          ? 0
          : Math.max(0, socialDailyMax - socialCommentDailyMax - 1),
        commentDailyMax: summary.blocked.has("comment") ? 0 : socialCommentDailyMax,
        likeEnabled: true,
      },
    });

    if (plan.action === "skip") {
      log(`[social] skip reason=${plan.reason}`);
      return { action: "skip", ok: false, reason: plan.reason };
    }

    let action = plan.action;
    let generated = false;
    let text = "";
    if (action === "danmaku" || action === "comment") {
      const model = portDeps.llm;
      if (model === null || model === undefined) {
        // 没有模型凭据也能点赞：不因为写不出话就整拍放弃。
        action = liked ? "watch" : "like";
        log(`[social] 没有模型凭据：${plan.action} 降级为 ${action}`);
      } else {
        // 生成即计费：即使写接口失败，这一拍也花过模型额度，standalone 要记账。
        generated = true;
        try {
          text = await composeSocialText(action, detail, model);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log(`[social] 文案生成失败，降级：${reason}`);
          action = liked ? "watch" : "like";
        }
      }
    }

    let result;
    try {
      if (action === "danmaku") {
        result = await postDanmaku(deps, {
          bvid: detail.bvid,
          cid: detail.cid,
          text,
          progressMs: plan.progressMs ?? 0,
        });
      } else if (action === "comment") {
        result = await postComment(deps, { aid: detail.aid, text });
      } else if (action === "like") {
        result = await likeVideo(deps, { aid: detail.aid });
      } else {
        result = { ok: true, code: 0, message: "只看不写" };
      }
    } catch (err) {
      // 写客户端本身不抛；这里兜底，保证一拍失败不会打断整个循环。
      result = { ok: false, code: -1, message: err instanceof Error ? err.message : String(err) };
    }

    const entry = {
      at: nowMs,
      bvid: detail.bvid,
      action,
      ok: result.ok,
      code: result.ok ? 0 : result.code,
      reason: result.message.slice(0, 200),
      ...(generated ? { generated: true } : {}),
    };
    appendSocialLedger(entry);
    log(
      `[social] action=${action} bvid=${detail.bvid} ok=${String(result.ok)} code=${String(result.code)}` +
        `${generated ? " generated=1" : ""} reason=${result.message.slice(0, 80)}`,
    );
    // 账号级失败只提示一次：写进账本后，当天该动作的额度会一直是 0，不会再重试。
    if (!result.ok && ACCOUNT_BLOCKED_CODES.has(result.code)) {
      log(`[social] 账号限制（code=${String(result.code)}）：今天不再尝试 ${action}，需要账号转正/提升等级后才能发`);
    }
    return { action, ok: result.ok, reason: result.message, generated, bvid: detail.bvid };
  };

  // 洞见账本：同一个标签 7 天内只写一次（见 dist/autonomy/insight.js 的冷却理由）
  const insightLedgerPath = join(dataDir, `insight-${characterId}.json`);

  /**
   * 睡眠巩固之后的洞见生成（v5.2 §7.3 的 extract_insight）。
   *
   * 为什么是她自己的进程来做：规格说这是全系统唯一的 LLM 入口，学习层零 LLM、插件不调模型。
   * 所以只有"她独立存在时"才有资格把一段经历收成一句信念。
   * 模型输出要过 parseInsight：几句话的松弛就让整条链路退化成往知识库里倒废话。
   */
  const insightImpl = async () => {
    const nowMs = Date.now();
    const ledger = readLedger(insightLedgerPath);
    const clusters = clusterEpisodic(runtime.memoryStore().active(), { cfg });
    // F326：人格卡已删除，阈值用引擎默认（§9.3 默认 3）；先判一次可达性，不可达就别烧模型调用。
    const insightThreshold = 3;
    const reach = insightReachable(insightThreshold, clusters.map((c) => c.evidenceCount));
    if (!reach.reachable) {
      log(
        `[autonomy] insight 跳过：阈值 ${String(insightThreshold)} > 簇证据中位数 ${String(reach.median)} × 3（A/B 层不会更新，先不花模型调用）`,
      );
      return { tag: "", stored: false, reason: "洞见阈值不可达" };
    }
    const cluster = pickInsightCluster(clusters, ledger, nowMs, { minEvidence: insightThreshold });
    if (cluster === null) return { tag: "", stored: false, reason: "没有够证据、且冷却已过的新簇" };
    // 用 portDeps.llm（refreshModel 会就地更新它），而不是外层快照，否则换 key 后永远走旧配置
    const model = portDeps.llm;
    if (model === null || model === undefined) {
      return { tag: "", stored: false, reason: "没有模型凭据" };
    }
    const messages = buildInsightPrompt({
      persona: displayName,
      tag: cluster.tag,
      samples: samplesOf(cluster),
    });
    const reply = await chatComplete(model, messages, { task: "insight" });
    logUsage("insight", reply);
    const text = parseInsight(reply.text);
    if (text === null) {
      log(`[autonomy] insight 废稿丢弃 tag=${cluster.tag} chars=${String(reply.text.trim().length)}`);
      return { tag: cluster.tag, stored: false, reason: "模型输出不合格，丢弃" };
    }
    const r = runtime.submitInsight({ tag: cluster.tag, content: text });
    // 无论 stored 与否都记一次：不合格的簇反复重试只会浪费模型调用
    try {
      writeLedger(insightLedgerPath, markInsight(ledger, cluster.tag, nowMs));
    } catch (err) {
      log(`[autonomy] insight 账本写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
    log(`[autonomy] insight tag=${cluster.tag} stored=${String(r.stored)} text=${text}`);
    return { tag: cluster.tag, stored: r.stored, reason: r.stored ? "" : r.reason };
  };

  // §5.4 再巩固：版本链落在 data/ 里，跟着记忆走。每条补丁只改 interpretation，
  // 不改情绪数值、不删旧版——"只有版本链、没有删历史"。
  const reconsolidationPath = reconsolidationFilePath(dataDir, characterId);

  /**
   * 把「同一件事、现在看法翻了面」的旧记忆重新解释一版（用户 2026-10-31 裁决 A）。
   *
   * 为什么只解释一条：这是模型调用，顺手做一条和把旧账一次改完是两回事；
   * 每条都留着旧版本，改错了还能在链上看见原来的样子。
   */
  const reconsolidateImpl = async () => {
    const nowMs = Date.now();
    // 1) 读现链：坏文件宁可不写，也不要想当然从空链开始（那会把旧版本"忘掉"）
    let existing = null;
    try {
      const raw = readFileSync(reconsolidationPath, "utf8");
      const parsed = parseReconsolidationFile(raw);
      if (parsed.file === null) {
        log(`[autonomy] 再巩固跳过：版本链文件无法解析（${parsed.errors.slice(0, 2).join("；")}）`);
        return { patched: 0, reason: "版本链文件损坏" };
      }
      existing = parsed.file;
    } catch (err) {
      const code = err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
      if (code !== "ENOENT") {
        log(`[autonomy] 再巩固跳过：读版本链失败（${err instanceof Error ? err.message : String(err)}）`);
        return { patched: 0, reason: "读版本链失败" };
      }
    }
    // 2) 找候选：同一件事、情绪翻面且差得够多；已经解释过的记忆不再重复
    const memories = runtime.memoryStore().all();
    const candidate = planReconsolidation(memories).candidates.find(
      (c) => existing === null || patchesForMemory(existing, c.olderMemoryId).length === 0,
    );
    if (candidate === undefined) return { patched: 0, reason: "没有可解释的候选" };
    // 3) 找这两条原话（候选只带 id；记忆被清掉就当没候选，不猜内容）
    const older = memories.find((m) => m.id === candidate.olderMemoryId);
    const newer = memories.find((m) => m.id === candidate.newerMemoryId);
    if (older === undefined || newer === undefined) return { patched: 0, reason: "候选记忆已不在库里" };
    // 4) 调模型（一次）：拿"现在的理解"；模型输出不合格就丢弃，不写历史
    const model = portDeps.llm;
    if (model === null || model === undefined) return { patched: 0, reason: "没有模型凭据" };
    const messages = buildReconsolidationPrompt({
      personaName: displayName,
      topicDomain: candidate.topicDomain,
      pair: recallPairOf(older, newer),
    });
    const reply = await chatComplete(model, messages, { task: "reconsolidation" });
    logUsage("reconsolidation", reply);
    const explanation = parseReconsolidationExplanation(reply.text);
    if (explanation === null) {
      log(`[autonomy] 再巩固废稿丢弃 memory=${candidate.olderMemoryId} chars=${String(reply.text.trim().length)}`);
      return { patched: 0, reason: "模型输出不合格，丢弃" };
    }
    // 5) 组补丁 + 追加（链末由 version-file 层补 supersededBy；超上限拒绝而不是裁剪）
    const chain = resolveChain(candidate.olderMemoryId, existing?.patches ?? []);
    const patch = toReconsolidationPatch({ candidate, current: chain.current, explanation });
    const added = addReconsolidationPatch(existing, patch, nowMs);
    if (!added.added || added.errors.length > 0) {
      log(`[autonomy] 再巩固补丁被拒：${added.errors.join("；")}`);
      return { patched: 0, reason: "补丁被拒" };
    }
    // 6) 原子落盘
    const tmp = `${reconsolidationPath}.tmp-${String(process.pid)}`;
    try {
      writeFileSync(tmp, serializeReconsolidationFile(added.file.patches, nowMs), "utf8");
      renameSync(tmp, reconsolidationPath);
    } catch (err) {
      log(`[autonomy] 再巩固写盘失败：${err instanceof Error ? err.message : String(err)}`);
      return { patched: 0, reason: "写盘失败" };
    }
    log(`[autonomy] 再巩固：${describeReconsolidationPatch(patch)}`);
    return { patched: 1, reason: "", memoryId: candidate.olderMemoryId };
  };

  // §10.1 第 5 段：睡眠缓冲。学习时只"看见"，睡一觉才决定什么值得写进知识库。
  // 文件落在 data/ 里（跟着状态走），进程重启不丢；容量与 TTL 在 dist/learning/openworld.js 里定。
  const funnelBufferPath = join(dataDir, `openworld-${characterId}.json`);

  /** 把缓冲里昨晚看见的候选真的写进知识库；返回 drained/ingested 供日志与测试用 */
  const drainFunnel = () => {
    const nowMs = Date.now();
    const buffer = new OpenWorldBuffer({ path: funnelBufferPath });
    buffer.load();
    const items = buffer.drain(nowMs, 10);
    if (items.length === 0) return { drained: 0, ingested: 0 };
    // 热榜只说明"很多人在看"，不说明"可信"：来源门控把可信度压到 0.55（比搜索结果 0.7 更低），
    // 客观新鲜度给 0.95（确实是刚火的）。这两个数会进 L2 记录的 source_credibility/freshness。
    const videos = items.map((it) => ({
      bvid: it.video.bvid,
      title: it.video.title,
      description: it.video.description ?? "",
      owner: it.video.owner ?? "",
      view: it.video.play ?? 0,
      like: it.video.like ?? 0,
      pubdateMs: it.video.pubdateMs ?? nowMs,
      durationSec: it.video.durationSec ?? 0,
      tags: it.video.tags ?? [],
    }));
    let ingested = 0;
    try {
      const r = ingestVideos(runtime.knowledgeWritePort(), videos, nowMs, {
        source: "bili",
        sourceCredibility: 0.55,
        objectiveFreshness: 0.95,
      });
      ingested = r.ingested;
    } catch (err) {
      log(`[autonomy] funnel 写库失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return { drained: items.length, ingested };
  };

  // ── P1 意图节拍（默认关闭：ACE_INTENT_SHADOW=1 才注入）──────────────────────────
  // 每拍跑一次纯计算，把"她想做什么 / 被什么拦下"写进观测文件；
  // 计算本身不发消息、不调模型。2026-10-31 用户批准后真出口已接：
  // 下一拍主动开口会拿到 gate（四否决）与自述（note），回消息路径不经过它。
  // D3（审计 §4）：开关语义与名字对不上——"SHADOW" 其实是**真引擎**（会主动开口、会写意图表）。
  // 新名 `ACE_INTENT_ENGINE` 为准，旧名 `ACE_INTENT_SHADOW` 只做一版兼容（start.ps1 会同步写旧名）。
  const intentEngineEnv = process.env.ACE_INTENT_ENGINE;
  const intentShadowOn = (intentEngineEnv ?? process.env.ACE_INTENT_SHADOW) === "1";
  if (intentEngineEnv === undefined && process.env.ACE_INTENT_SHADOW === "1") {
    log("[intent] 开关：正在用旧名 ACE_INTENT_SHADOW，请改成 ACE_INTENT_ENGINE（这一版仍兼容）");
  }
  // P1 真出口（2026-10-31 用户批准）：每拍把「她想说什么 + 硬闸结论」留给下一次主动开口。
  // 只在常驻进程内传递（tick 与 proactive 都在这里），不落盘；第一拍之前退回旧行为。
  const intentAccPath = join(dataDir, `intent-acc-${characterId}.json`);
  const intentLivePath = join(dataDir, `intent-live-shadow-${characterId}.ndjson`);
  // P1 意图表（F193）：跨重启的"我正想做什么"。读不回来就当空表并记一笔；
  // 解析失败不会给半份表（intent-file.ts 是 fail-closed），空表比错表安全。
  const intentFilePath = join(dataDir, `intent-${characterId}.json`);
  // P4 能力缺口的第一段：想做但没工具的事记在这里，是求助链（ask_help → 监护人）的输入。
  const capabilityGapsPath = join(dataDir, `capability-gaps-${characterId}.ndjson`);

  function readIntentionsFile() {
    try {
      const raw = readFileSync(intentFilePath, "utf8");
      const parsed = parseIntentionFile(raw);
      if (parsed.file === null) {
        log(`[intent] 意图表读不回来（当空表）：${parsed.errors.join("；")}`);
        return [];
      }
      return [...parsed.file.records];
    } catch {
      // 还没有文件：第一次跑的正常情况
      return [];
    }
  }

  function writeIntentionsFile(records) {
    try {
      // F312：所有写盘点统一过裁剪——此前只有 upsertIntention 会裁剪，其余几处直接落盘，
      // 40 条上限形同虚设（按 maxPerDay=10 算，7 天可积到 70 条）。
      const body = serializeIntentionFile(trimIntentions(records), Date.now());
      const tmp = `${intentFilePath}.tmp-${String(process.pid)}`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, intentFilePath);
    } catch (err) {
      log(`[intent] 意图表落盘失败（本轮照样过）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function readIntentAcc() {
    try {
      const raw = JSON.parse(readFileSync(intentAccPath, "utf8"));
      const acc = raw === null || raw === undefined ? undefined : raw.accumulator;
      const prev = raw === null || raw === undefined ? undefined : raw.previousDrive;
      const idleAt = raw === null || raw === undefined ? undefined : raw.lastIdleAtMs;
      const savedAt = raw === null || raw === undefined ? undefined : raw.savedAtMs;
      return {
        ...(acc === null || acc === undefined || typeof acc !== "object" ? {} : { accumulator: acc }),
        ...(prev === null || prev === undefined || typeof prev !== "object" ? {} : { previousDrive: prev }),
        ...(typeof idleAt === "number" && Number.isFinite(idleAt) ? { lastIdleAtMs: idleAt } : {}),
        ...(typeof savedAt === "number" && Number.isFinite(savedAt) ? { savedAtMs: savedAt } : {}),
      };
    } catch {
      // 第一次跑没有文件，是常事
      return {};
    }
  }

  function writeIntentAcc(accumulator, previousDrive, lastIdleAtMs) {
    try {
      const body = JSON.stringify({
        version: 1,
        savedAtMs: Date.now(),
        accumulator,
        previousDrive,
        lastIdleAtMs: typeof lastIdleAtMs === "number" && Number.isFinite(lastIdleAtMs) ? lastIdleAtMs : null,
      });
      const tmp = `${intentAccPath}.tmp-${String(process.pid)}`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, intentAccPath);
    } catch (err) {
      log(`[intent] 累积器落盘失败（本轮照样过）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 单写者冲突：写者锁被**别的 pid** 持有。她自己持有锁是正常的，不算冲突。
  // 审计 §4 指出它不是"缺信号"，只是原来没接；这里接上，免得两个进程同时写状态时她在幻觉里做决定。
  function singleWriterConflictNow() {
    try {
      const raw = JSON.parse(readFileSync(join(dataDir, ".writer-lock"), "utf8"));
      const ownerPid = typeof raw?.pid === "number" ? raw.pid : null;
      return ownerPid !== null && ownerPid !== process.pid;
    } catch {
      return false; // 没有锁/读不出来：按"不冲突"处理，宁可她正常说话，也不靠坏文件让她闭嘴
    }
  }

  // 读小文件：不存在就当空，不抛——tick 里不该因为"还没有这个文件"失败。
  function readTextOrEmpty(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  // F291：外部事实收集搬进 src/assembly/situation-signals.ts；这里只给数据目录与时钟。
  const situationDeps = (nowMs) => ({ dataDir, characterId, repo, nowMs, tzOffsetMinutes });

  // P3-3 修复（task-72）：explore 越阈也要走脊髓层——由 port.learn() 统一判 tier、
  // 睡眠硬跳、频率审核与扣费；装配点不判档（R4）。port 在下面才创建，所以晚绑定。
  let runLearnThroughPort = null;

  const intentTickImpl = !intentShadowOn
    ? undefined
    : () => {        try {
          // 批次1B/T2（B1）：跨拍防护——这一拍没算出上下文（比如睡着早退）时，
          // 上一拍的 lastIntentContext 不能继续被 proactive 读到（否则会重复带 goal）。
          lastIntentContext = undefined;
          // F352：时间快照同理——这一拍没算出（早退/抛错）时，proactive 不能读上一拍的。
          beatTemporal = undefined;
          // P3-2b（task-57 B2）：睡眠相位与 [sleep] 日志统一由 stateTick 的装配层包装推进
          // （那里每拍先 sleepState()+sleepLogLine()）。这里只按相位跳过意图拍——睡眠是暂停，
          // 不是关机：stateTick/advance/巩固/tickHooks 仍然跑。
          if (runtime.sleepInfo().asleep) return;
          const nowMs = Date.now();
          const st = runtime.state;
          const gates = runtime.proactiveGates();
          // F238：休息日额度 ×1.5（pricing.ts:P47）。这里原先没传 restDay，于是周六仍按
          // 峰时 6/h 算 → 明明还有 3 格却被判 quota，她的意向拍数就被自己"算死"了。
          // 与 health.mjs（F235）同一口径：按北京时间算本地日，再问 isRestDay。
          const pacing = pacingFor({ now: nowMs, tzOffsetMinutes, restDay: isRestDay(localParts(nowMs).localDay) });
          let usage = [];
          try {
            usage = loadUsage(join(dataDir, "autonomy-usage.json"), nowMs);
          } catch {
            // 账本读不到就当没用过：宁可多给一格，也不要因为读数失败把她哑掉
          }
          const usedLastHour = usage.filter((t) => nowMs - t < 3_600_000).length;
          const rph = Math.max(0, pacing.maxCallsPerHour - usedLastHour);
          const acc = readIntentAcc();
          // A2：λ 按时间折算。晚到的拍（进程卡顿/重启）不该少算衰减，正常拍也不该多算；
          // 夹在 [1 分钟, 2 小时]，避免时钟跳变把一整天的"憋"一次性灌进来。
          const dtMs =
            acc.savedAtMs === undefined
              ? undefined
              : Math.min(7_200_000, Math.max(60_000, nowMs - acc.savedAtMs));
          // A5/F246：处境信号只读一次（时间/来往/主动次数/在不在电脑前），
          // 后面构造处境与"重提"的连发保护共用同一份，避免同一拍读两次 qq 状态文件后不一致。
          const situationSignals = readSituationSignals(situationDeps(nowMs));
          // P2a 时间观：把记忆里「他什么时候出现」的观察交给纯函数统计（只看 inbound 且来源可信）。
          // 门槛（30 条 / 7 个本地日期 / 工作日与休息日各 3 天）没同时满足 → null，处境行如实写
          // 「我还不了解他的作息」；这里不猜、不用稀疏样本假装摸清（DESIGN §2.3，Q11）。
          let hisRhythm = null;
          try {
            const rhythmSamples = runtime.memoryStore().all().map((record) => {
              const direction = record.encode_ctx?.direction;
              return {
                occurredAtMs: record.created_at,
                direction: direction === "inbound" || direction === "outbound" ? direction : "unknown",
                source: record.source,
              };
            });
            hisRhythm = buildHisRhythm(rhythmSamples, {
              nowMs,
              tzOffsetMinutes,
              thresholds: rhythmThresholdsFromConfig(cfg),
              calendar: rhythmCalendar,
            });
            if (hisRhythm !== null) log(`[intent] ${describeRhythm(hisRhythm)}`);
          } catch (err) {
            hisRhythm = null;
            log(`[intent] 节律统计失败（这一拍按「还不了解」处理）：${err instanceof Error ? err.message : String(err)}`);
          }
          // P1 时间观：同一份事实装成时间快照（纯数据、零推断），处境行由它渲染。
          // 读不到时这一拍就不给她看"此刻"，不猜、不填默认值。
          let temporal;
          try {
            const sleepInfo = runtime.sleepInfo();
            // P3-2b（task-57 B1）：awakeForHours 从「上次醒来」算起（没有才回退上次睡点）；
            // lastSleep.hours 用 Persisted.sleep 的入睡→醒来时长——缺任一时刻就不编（null）。
            const lastSleepHours =
              sleepInfo.wokeAtMs !== null && sleepInfo.lastSleepMs !== null
                ? Math.max(0, (sleepInfo.wokeAtMs - sleepInfo.lastSleepMs) / 3_600_000)
                : null;
            temporal = buildTemporalSnapshot({
              nowMs,
              tzOffsetMinutes,
              sinceLastUserMsgMin: situationSignals.sinceLastPeerMsgMin,
              sinceLastOwnMsgMin: situationSignals.minutesSinceLastProactive,
              unansweredOwnMsgs: situationSignals.proactiveSinceLastPeerEvent,
              awakeSinceMs: sleepInfo.wokeAtMs ?? sleepInfo.lastSleepMs ?? processStartedAt,
              lastSleepAt: sleepInfo.lastSleepMs,
              lastSleepHours,
              nextSleepInHours: sleepInfo.nextInHours,
              presence: situationSignals.presence,
              hisRhythm,
            });
          } catch (err) {
            temporal = undefined;
            log(`[intent] 时间快照生成失败（这一拍不给她看此刻）：${err instanceof Error ? err.message : String(err)}`);
          }
          // F352：交给同一拍的 proactive 闭包读（beatTemporal 在 main() 作用域里声明）。
          beatTemporal = temporal;
          // 意图表：上一拍留下的"我想做什么"。它的存在会让缺口方向更稳定，
          // 也让同一类意图不会每拍都像第一次浮现。
          let intentRecords = readIntentionsFile();
          // 2026-11-09：她自己的话不是"没聊完的事"——旧版 replay 由自述记忆生成的
          // continue_thread 会把同一句话无限续杯（单话题根因）。replay 端已不再产出这类线头，
          // 这里顺手把已经落盘的旧自述意图退休，避免它继续占着 open 名额。
          const retiredSelf = retireSelfReferentialIntentions(intentRecords);
          if (retiredSelf.retired.length > 0) {
            writeIntentionsFile(retiredSelf.records);
            log(`[intent] 退休自述意图：${retiredSelf.retired.join(",")}`);
            intentRecords = retiredSelf.records;
          }
          // F312：同类重复刹车——窗口内已经说够次数的类别，这一拍不再浮现/开口。
          // 只读意图表、不改累积器，也不动她已有的记录（纯函数判据，见 intent-lifecycle）。
          const suppressedKinds = exhaustedSpeakKinds(intentRecords, nowMs);
          const openNow = openIntentions(intentRecords);
          // §4.5 #4 空转防抖：窗口没到 / 开着意图够多 → 这一拍只消化，不记新意图。
          const idleMode = planTickMode({
            lastIdleAtMs: acc.lastIdleAtMs ?? null,
            nowMs,
            openIntentions: openNow.length,
            seed: `${characterId}-${dayKey(nowMs)}`,
          });
          // P2 记忆回放候选源：把"没闭合的心事 / 余响 / 旧事"变成 continue_thread 的线头。
          // 只读记忆、纯计算、不调模型；失败就当这次没想起什么，不影响 tick。
          let replay;
          try {
            replay = replaySource(runtime.memoryStore().all(), nowMs, idleMode.recordNewIntentions);
          } catch (err) {
            log(`[intent] 回放失败（本轮当没想起什么）：${err instanceof Error ? err.message : String(err)}`);
            replay = undefined;
          }
          const replayThreads = replay === undefined ? [] : replay.threads;
          // A8：好奇缺口不再只看 knowledge freshness。
          // 老口径 1−平均 freshness 会被她自己的学习"喂饱"（学完 freshness 回 0.9 → 缺口
          // 反而变小 = 越学越不想探索的负反馈）。现在以"最近几轮有没有真的学到新东西"为主、
          // freshness 为次；两边都没样本时保持中性值，不编。
          const freshnessGap = coverageGap(runtime.knowledgeStore().all());
          const yieldInfo = learningYield(learnState.recentIngested ?? []);
          const noveltySignal = noveltyGap({ yieldGap: yieldInfo.gap, freshnessGap: freshnessGap ?? null });
          // B5/F256/F266：可执行能力清单只有一个来源（`AUTONOMY_TOOL_CATALOG`）。
          // 可用性也不再在这里手写 if 链：catalog 每条声明 availability（always / qq-bridge /
          // desktop-script），这里只提供事实，由 contracts 的 `availabilityOf` 统一换算
          // （F266 之前是 main.mjs 自己按前缀判断，等于把规则抄了第二份）。
          // 桌面工具只在开发面（DSH/工具目录）存在，常驻进程里没有 → 如实标不可用，
          // 这样"操作桌面"会作为真缺口浮出来，而不是永远假装能做。
          // B3：可用性 = "声明的能力" + "最近一次只读探测的结果"（12 小时内有效）。
          // 探测不是拍脑袋：它由真实条件（qqHandle / 工具目录是否存在）算出来，
          // 写进 tool-probes-<id>.ndjson，下一拍拿它覆盖声明值。
          const availabilityFacts = {
            qqBridge: qqHandle !== null,
            desktopScript: existsSync(join(repo, "tools", "desktop", "desktop.ps1")),
          };
          const declaredTools = Object.fromEntries(
            AUTONOMY_TOOL_CATALOG.map((entry) => [entry.tool, availabilityOf(entry, availabilityFacts)]),
          );
          const probeSeen = latestToolProbes(
            parseToolProbeLines(readTextOrEmpty(toolProbesPath)).observations,
            nowMs,
          );
          const availability = Object.fromEntries(
            Object.entries(declaredTools).map(([tool, declared]) => [tool, probeSeen.get(tool)?.available ?? declared]),
          );
          // B3：夜里（本地 3–4 点）且距上次探测超过 12 小时，就做一次只读探测。
          // 只探 risk 0 的工具；有副作用的（发消息/写文件）永远不自动探。
          try {
            const lastProbeAt = probeSeen.size === 0 ? null : Math.max(...[...probeSeen.values()].map((o) => Date.parse(o.at)));
            if (inToolProbeWindow(localParts(nowMs).localHour) && (lastProbeAt === null || nowMs - lastProbeAt > TOOL_PROBE_TTL_MS)) {
              const targets = AUTONOMY_TOOL_CATALOG.map((entry) => ({
                tool: entry.tool,
                risk: entry.risk,
                declared: declaredTools[entry.tool] === true,
              }));
              const probePlan = planToolProbe(targets);
              const observations = probePlan.due.map((t) =>
                observeTool(t, availability[t.tool] === true, nowMs, availability[t.tool] === true ? undefined : "unknown"),
              );
              if (observations.length > 0) {
                appendFileSync(toolProbesPath, observations.map((o) => `${serializeToolProbe(o)}
`).join(""), "utf8");
                log(`[intent] ${describeToolProbe(observations)}`);
              }
            }
          } catch (err) {
            log(`[intent] 工具探测失败（本轮跳过）：${err instanceof Error ? err.message : String(err)}`);
          }
          const toolPort = createToolPort(availability);
          const affordances = availableAffordances(toolPort);
          const result = runIntentTick({
            situation: {
              at: new Date(nowMs).toISOString(),
              localHour: localParts(nowMs).localHour,
              channel: qqHandle === null ? "local" : "qq",
              participants: qqHandle === null ? [] : ["用户"],
              affordances,
              sinceLastContactMin: lastContactMinutes({ dataDir, characterId, nowMs }),
              budget: { rph, peak: pacing.phase === "peak" },
              singleWriterConflict: singleWriterConflictNow(),
            },
            state: st,
            stage: runtime.stage(),
            // P1 观测口径（F213）：
            //   · 价值偏离 = 认知失调（dissonance）。规格要的是「行为与 B 层价值排序的偏离」，
            //     但本机没有「行为—价值」标注，dissonance 是同一件事在状态侧的代理（|shame−joy| 累积）。
            //     这是近似，不是等价；写在台账里，等真正有了行为—价值投影再替换。
            //   · 失败率仍缺可信来源（执行队列多数时候是空的），保持 0，不编。
            recentFailureRate: 0,
            // 批次2：主动了没被回应 → connection 缺口衰减。只喂「上次真实来往之后的主动条数」，
            // 不改 contact 口径（lastProactiveAt 仍然不算「真实来往」）。
            unansweredOwnCount: situationSignals.proactiveSinceLastContact,
            openIntentCount: openNow.length,
            maxOpenIntents: 3,
            valueDeviation: Math.min(1, Math.max(0, st.dissonance)),
            ...(noveltySignal === undefined ? {} : { coverageGap: noveltySignal }),
            trust: st.trust,
            trustFloor: gates.trustFloor,
            ...(acc.accumulator === undefined ? {} : { accumulator: acc.accumulator }),
            ...(acc.previousDrive === undefined ? {} : { previousDrive: acc.previousDrive }),
            ...(dtMs === undefined ? {} : { dtMs }),
            activeKinds: activeKindsOf(intentRecords),
            ...(suppressedKinds.length === 0 ? {} : { suppressedKinds }),
            ...(replayThreads.length === 0 ? {} : { threads: replayThreads }),
          });
          const nextIdleAt = idleMode.due ? nowMs : (acc.lastIdleAtMs ?? null);
          writeIntentAcc(result.accumulator, result.drive, nextIdleAt);
          // P1 意图表落盘：这一拍浮现的类别写进表（同类已有 open 记录就跳过），
          // 被硬闸拦下的记 blocked_by——"想说话但被拦"本身是可审计的事实。
          // A3：试满 5 次的意图真的放弃（不再只靠 7 天保留过期），再把这一拍真的浮现的类别落表。
          const exhausted = dropExhaustedIntentions(intentRecords);
          let nextRecords = exhausted.dropped.length === 0 ? intentRecords : [...exhausted.records];
          if (exhausted.dropped.length > 0) {
            log(`[intent] 放弃：${exhausted.dropped.join("、")}（试满 5 次）`);
          }
          // F239：quota 是"这一小时没额度"，不是"她不该说"。闸一放开，把当时被额度拦下的
          // 意图放回 pending 重新排队——否则它们一直占着"同类已开着"，被永久关在表里。
          const revived = reviveBlockedIntentions(nextRecords, { gateAllowed: result.gate.allowed });
          if (revived.revived.length > 0) {
            nextRecords = [...revived.records];
            log(`[intent] 重新竞争：${revived.revived.join("、")}（额度已回）`);
          }
          // A3：这一拍真的浮现了就落表。空转节流（`idleMode`）只该决定"回放要不要生成新候选"，
          // 不该让已经越阈的意图因为"还没到窗口"而消失——那正是审计说的"写了却接不上"。
          for (const kind of result.emitted) {
            const openSameKind = nextRecords.filter(
              (record) =>
                record.kind === kind &&
                (record.status === "pending" || record.status === "active" || record.status === "blocked"),
            );
            if (openSameKind.length > 0) continue;
            const candidate = result.candidates.find((item) => item.kind === kind);
            if (candidate === undefined) continue;
            let record = newIntention({
              id: `itn-${kind}-${String(nowMs)}`,
              at: new Date(nowMs).toISOString(),
              kind,
              goal: candidate.goal,
              why: whyPhrase(candidate.because),
              trigger: deriveTrigger(kind, nowMs),
              sourceIds: candidate.because.map((cause) => cause.memoryId).filter((id) => typeof id === "string"),
            });
            record = applyHardGate(record, result.gate);
            nextRecords = upsertIntention(nextRecords, record);
          }
          const pruned = pruneIntentions(nextRecords, nowMs);
          if (result.emitted.length > 0 || pruned.dropped.length > 0 || nextRecords !== intentRecords) {
            writeIntentionsFile(pruned.records);
          }
          const openAfter = openIntentions(pruned.records).length;
          const top = result.top;
          // 出口分流：能说 → speak；被挡 → journal（想说话不丢）；没想法 → idle
          const outlet = chooseIntentOutlet(result);
          // P1 前瞻意图（design v3）：先取本拍到点、且 trigger 可解析的记录。
          // 本拍已有更急的 speak 冲动、或硬闸不放行时，交由 pickDueIntention 留到下一拍；
          // 每拍最多浮现 1 条，出口覆盖在 ensureSpokenRecord 之前。
          let dueHit = null;
          let dueSkipped = [];
          if (lookaheadEnabled) {
            const safe = dueIntentionsSafe(pruned.records, { nowMs });
            dueSkipped = safe.skipped;
            if (dueSkipped.length > 0) {
              log(`[intent] lookahead 跳过坏 trigger：${dueSkipped.map((s) => s.id).join("、")}`);
            }
            dueHit = pickDueIntention(safe.due, {
              gateAllowed: result.gate.allowed,
              currentOutletIsSpeak: outlet.target === "speak",
              suppressedKinds,
              minutesSinceLastProactive: situationSignals.minutesSinceLastProactive,
              reRaiseQuietMin: RE_RAISE_QUIET_MIN,
            });
          }
          const lookaheadSurfacedId = dueHit === null ? undefined : dueHit.id;
          const seed = journalSeed(outlet);
          // F240：这一拍没有"憋不住"，但表里还有上次被额度拦住、没说完的话 → 重新提上来。
          // 只在硬闸真的放行时提；否则仍走 journal/idle（不绕过任何门）。
          const speakableCandidate = dueHit !== null || outlet.target === "speak" || !result.gate.allowed
            ? null
            : pickSpeakableIntention(pruned.records);
          // F246：这不是"主动门"，只是不让她隔 5 分钟连发两句同一件事——
          // 刚说过、他还没回的时候先把话留在表里，下一拍/十分钟后仍会被提起。
          const recentlySpokeMin = situationSignals.minutesSinceLastProactive;
          // F312 接线修复：被同类重复刹车压着的类别，连"重提"也不走——否则旧 pending 记录会从后门漏出去。
          // 两个正向条件放在纯函数里（decideReRaise），装配层只传参与打日志；四连 && 的短路写法曾被 supervisor 打回。
          const reRaise = decideReRaise({
            candidate: speakableCandidate,
            suppressedKinds,
            minutesSinceLastProactive: recentlySpokeMin,
            reRaiseQuietMin: RE_RAISE_QUIET_MIN,
          });
          const speakable = reRaise.speakable;
          if (speakableCandidate !== null && speakable === null) {
            log(
              `[intent] 重提：先放着（${speakableCandidate.id}）——${
                reRaise.blocked === "suppressed"
                  ? "这一类已经说够了"
                  : `${String(recentlySpokeMin)} 分钟前刚开口过，等一会儿`
              }`,
            );
          }
          // P1 lookahead：出口覆盖抽成纯函数（due > speakable > 原 outlet），装配层只接结果；
          // speakable 分支的 note 文案也在 lookahead.resolveEffectiveOutlet 里，由行为锁覆盖。
          let effectiveOutlet = resolveEffectiveOutlet({ due: dueHit, speakable, outlet }).effective;
          if (speakable !== null) {
            log(`[intent] 重提：${speakable.id}（${speakable.kind}）——上次被拦下，额度回来了`);
          }
          // F349 I3：按实际出口取这次开口的来源（due > speakable > 本拍候选的 because），
          // 只给真要新建记录的 ensureSpokenRecord 用；来源与出口不一致会把因果写糊。
          // 提前到这里算：I1 的重复判定也要用同一份来源，两处必须看到同一个出口。
          const outletSources = sourcesForOutlet({ dueHit, speakable, top });
          // F350 I1：同题 24h 去重。必须在 due 激活之前判定；首版只覆盖 `dueHit === null`
          // 的基础/speakable 路径（不覆盖 due 的取舍见 spec §3.2）。
          const repeatHit =
            dueHit === null && effectiveOutlet.target === "speak"
              ? findRecentRepeat({
                  records: pruned.records,
                  goal: effectiveOutlet.line ?? top?.goal ?? null,
                  kind: effectiveOutlet.kind,
                  sourceIds: outletSources,
                  nowMs,
                  windowMs: REPEAT_SPEAK_WINDOW_MS,
                })
              : null;
          if (repeatHit !== null) {
            const minutesAgo = String(Math.round((nowMs - Date.parse(repeatHit.created_at)) / 60_000));
            log(`[intent] 重复抑制：${repeatHit.id}（${minutesAgo} 分钟前同一目标）→ 本拍不开口`);
            effectiveOutlet = {
              ...effectiveOutlet,
              target: "journal",
              note: `重复：${repeatHit.id} 在窗口内说过同一目标`,
            };
          }
          // 批次1B（P0-C）：这一拍真要开口，但表里没有对应的 open 记录时，补建/重开一条
          // pending——否则 lastIntentContext 拿不到 intentionId，闭环（recordSpokenAttempt）
          // 整段跳过（审计实测 84 条实发只有 2 条对得上账）。判断逻辑在纯函数里，这里只接线。
          let speakRecords = pruned.records;
          let ensuredSpoken = null;
          // P1 lookahead：到点的旧意图先激活并落盘，再走 ensureSpokenRecord——
          // 先落盘保证崩溃也不会下一拍重复浮现同一条。
          if (dueHit !== null && lookaheadSurfacedId !== undefined) {
            speakRecords = upsertIntention(speakRecords, activate(dueHit));
            writeIntentionsFile(speakRecords);
            log(`[intent] lookahead due=${dueHit.id} kind=${dueHit.kind} → surfaced`);
          }
          if (effectiveOutlet.target === "speak") {
            const ensured = ensureSpokenRecord({
              records: speakRecords,
              kind: effectiveOutlet.kind,
              nowMs,
              ...(effectiveOutlet.line === null ? {} : { goal: effectiveOutlet.line }),
              ...(effectiveOutlet.whyLine === null ? {} : { why: effectiveOutlet.whyLine }),
              ...(outletSources.length === 0 ? {} : { sourceIds: outletSources }),
            });
            ensuredSpoken = ensured.record;
            if (ensured.created || ensured.reopened) {
              speakRecords = ensured.records;
              writeIntentionsFile(speakRecords);
              log(`[intent] 记账：${ensured.note}`);
            }
          }
          // 这一拍"最想做的事"对应表里的哪条记录：主动开口成功后要用它记账（F195）。
          let topRecord =
            speakable ??
            (top === null
              ? undefined
              : speakRecords.find(
                  (record) =>
                    record.kind === top.kind &&
                    (record.status === "pending" || record.status === "active" || record.status === "blocked"),
                )) ??
            ensuredSpoken ??
            undefined;
          if (dueHit !== null) topRecord = dueHit;
          // A5 情境自觉：这一拍她"看见"的事实。只作素材，不参与是否开口的判定。
          // P1：由 TemporalSnapshot 渲染，纯事实、不含推断与建议。
          let situation;
          if (temporal !== undefined) {
            try {
              const situationNote = buildSituationNote(temporal);
              situation = situationNote.lines;
              // S3a：只落计数（不落行文本）——供 M1「处境事实率」按日聚合。
              try {
                const stats = situationLineStats(situationNote);
                log(`[situation] lines=${stats.lines} inferred=${stats.inferred}`);
              } catch {
                log("[situation] stats-failed");
              }
            } catch (err) {
              log(`[intent] 处境生成失败（这一拍不给她看处境）：${err instanceof Error ? err.message : String(err)}`);
              situation = undefined;
            }
          }
          // A4：上下文带上类别与去向。只有 speak 出口才把 gate/note 交给桥——
          // 否则"该记日记"的意图会以"想开口"的身份进 compose，语义又糊了。
          // 批次1B/T2：形状与 goalAtTime/goalId 的汇聚搬进纯函数 intentContextOf，
          // speakable / dueHit / ensuredSpoken 三类出口都从 topRecord 取同一个目标。
          lastIntentContext = intentContextOf({
            outlet: effectiveOutlet,
            emitted: result.emitted,
            gate: { allowed: result.gate.allowed, verdict: result.gate.verdict, note: result.gate.note },
            topRecord,
            situation,
            lookaheadSurfacedId,
          });
          log(`[intent] tick top=${top === null ? "none" : `${top.kind}:${top.score.toFixed(3)}`} gate=${result.gate.verdict} outlet=${effectiveOutlet.target} wouldSpeak=${String(result.wouldSpeak)} emitted=${result.emitted.join(",") || "none"} open=${String(openAfter)} idle=${idleMode.mode} tools=${describeToolPort(toolPort)}${suppressedKinds.length === 0 ? "" : ` suppressed=${suppressedKinds.join(",")}`}${replayThreads.length === 0 ? "" : ` replay=${String(replayThreads.length)}`}`);
          // F247：把"在场"单独记一行——它是她决定要不要开口的素材，事后要能对账
          // （"他那会儿明明在电脑前 / 他真的不在"，两种情况的沉默意义不同）。
          log(
            `[intent] 在场：${
              situationSignals.presence === null
                ? "不知道（不猜）"
                : situationSignals.presence.active
                  ? "他在电脑前"
                  : "他离开了"
            }（${describeInputActivity(situationSignals.inputActivity)}）`,
          );
          log(
            `[intent] 学习产出：${describeLearningYield(yieldInfo)}（novelty=${noveltySignal === undefined ? "中性" : noveltySignal.toFixed(3)}）`,
          );
          // A8②：越阈的 explore 是"我想去看看"，不该等 45 分钟定时器；20 分钟内不重复触发。
          // P3-3 修复（task-72）：走脊髓层 port.learn()，由 standalone 统一 sleep/能量分档/频率/扣费。
          const LEARN_ON_EXPLORE_GAP_MS = 20 * 60_000;
          if (result.emitted.includes("explore") && nowMs - (learnState.lastLearnAt ?? 0) > LEARN_ON_EXPLORE_GAP_MS) {
            log("[intent] explore 越阈：提前学一轮（不等 45 分钟定时器）");
            void runLearnThroughPort?.().catch((err) => {
              log(`[intent] 探索学习失败：${err instanceof Error ? err.message : String(err)}`);
            });
          }
          try {
            appendFileSync(
              intentLivePath,
              `${JSON.stringify({
                at: nowMs,
                localHour: localParts(nowMs).localHour,
                drive: result.drive,
                hardBlocks: result.frame.hardBlocks,
                candidates: result.candidates.map((c) => ({ kind: c.kind, score: c.score, seeds: c.planSeeds })),
                emitted: result.emitted,
                gate: result.gate.verdict,
                wouldSpeak: result.wouldSpeak,
                outlet: { target: effectiveOutlet.target, kind: effectiveOutlet.kind, note: effectiveOutlet.note, seed },
                // F247：标出这一拍是"装配层把表里被拦下的话重新提出来"（否则观测里
                // wouldSpeak=false 却真的发了消息，事后对不上账）。
                reRaised: speakable === null ? null : { id: speakable.id, kind: speakable.kind },
                narrative: result.narrative,
                replay:
                  replay === undefined
                    ? null
                    : {
                        selected: replay.items.map((item) => item.memoryId),
                        threads: replay.threads.map((thread) => thread.id),
                        note: replay.note,
                      },
              })}
`,
              "utf8",
            );
          } catch (err) {
            log(`[intent] 观测行写入失败（不影响继续）：${err instanceof Error ? err.message : String(err)}`);
          }

          // P4 能力缺口：想做、缺口越阈值、但手边没有对应的能力族 → 记一条（纯计算、零模型调用）。
          // 不在这里求助：求助要等同一缺口被真实检测到 ≥2 次才够格（ask-help 的门槛），
          // 否则重启一次就喊一次妈。这里只负责"留下证据"。
          try {
            const gaps = detectAffordanceGaps({ drive: result.drive, affordances });
            if (gaps.length > 0) {
              log(`[intent] 能力缺口：${gaps.map(describeAffordanceGap).join("；")}`);
              appendFileSync(
                capabilityGapsPath,
                `${gaps.map((gap) => JSON.stringify({ at: nowMs, kind: gap.kind, missingFamily: gap.missingFamily, desire: gap.desire })).join("\n")}\n`,
                "utf8",
              );
            }
          } catch (err) {
            log(`[intent] 能力缺口检测失败（不影响 tick）：${err instanceof Error ? err.message : String(err)}`);
          }

          // P4 求助发射端：同一缺口"昨天想做、今天还想做"（≥2 天才算两次尝试）才够格写进监护人收件箱。
          // 只写文件 + 记历史；发不发 QQ、谁来回，是 guardian CLI（人这一侧）的事，这里不越界。
          try {
            const sightings = [];
            let rawGaps = "";
            try {
              rawGaps = readFileSync(capabilityGapsPath, "utf8");
            } catch {
              rawGaps = ""; // 还没有缺口文件 = 还没有缺口，正常
            }
            for (const line of rawGaps.split("\n")) {
              if (line.trim() === "") continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed !== null && typeof parsed === "object") sightings.push(parsed);
              } catch {
                // 坏行跳过：观测日志不值得打断 tick
              }
            }
            const pending = summarizeGapProbes(sightings, nowMs).find((probe) => probe.attempts >= 2);
            if (pending !== undefined) {
              const rootDir = resolve(dataDir, "..");
              const historyPath = askHistoryPath(rootDir, characterId);
              const history = readAskHistory(historyPath);
              const intentionId = `cap-gap:${gapKey(pending)}`;
              // 回执这一侧：上次问的结果（还在等 / 答应了 / 拒绝了 / 超时了）决定现在能不能再问。
              const inboxPath = guardianInboxPath(rootDir, characterId);
              const replyDir = guardianReplyDir(rootDir);
              const outcome = gapAskOutcome({
                intentionId,
                history: history.entries,
                requests: readGuardianRequests(inboxPath).requests,
                replies: readGuardianReplies(replyDir).replies,
                nowMs,
              });
              const verdict = canAskAgain(outcome, nowMs);
              if (!verdict.allowed) {
                log(`[intent] 求助：这次不问｜${verdict.reason}`);
              } else {
                const text = helpTextFor(pending, pending.attempts);
                const plan = planAskHelp({
                  gap: { missing: capabilityMissingOf(pending), kind: capabilityGapKindOf(pending) },
                  intentionId,
                  what: text.what,
                  ask: text.ask,
                  tried: [...text.tried],
                  attempts: pending.attempts,
                  // stalled=true 时下面两个估计值不参与判定（shouldAskHelp 的第二条通道），
                  // 写在这里只是为了留形；数值来源标"估计"，不冒充测量。
                  selfEfficacyEff: 0.5,
                  empowermentGain: Math.max(0.1, Math.min(1, pending.desire)),
                  stalled: true,
                  history: history.entries.filter((entry) => entry.askedAtMs >= nowMs - ASK_WINDOW_MS),
                  nowMs,
                  ownerLastActiveMs: nowMs - lastContactMinutes({ dataDir, characterId, nowMs }) * 60_000,
                });
                if (plan.shouldAsk && plan.guardian !== null && plan.historyAdd !== null) {
                  // P1：先问 DSH（她的工具/求助对象），2 小时没回音再升级到监护人通道。
                  // 不直接写 guardian，是为了让"找工具帮忙"成为默认路径，人只是兜底。
                  const dshAsk = buildDshAsk({
                    intentionId,
                    atMs: nowMs,
                    kind: "help",
                    text: `${text.what}。${text.ask}`,
                    tried: [...text.tried],
                  });
                  appendFileSync(dshInboxPath(dataDir, characterId), `${serializeDshAsk(dshAsk)}\n`, "utf8");
                  writeAskHistory(historyPath, [...history.entries, plan.historyAdd]);
                  log(
                    `[intent] ${describeAskPlan(plan)}；已投递 ${dshAsk.id}（DSH 收件箱；2 小时无回音升级监护人）`,
                  );
                } else {
                  log(`[intent] ${describeAskPlan(plan)}`);
                }
              }
            }
          } catch (err) {
            log(`[intent] 求助发射端失败（不影响 tick）：${err instanceof Error ? err.message : String(err)}`);
          }
          // P1 方向二回程：读 DSH 回执 → 落成事实（她下一拍能记住）；2 小时没回音 → 升级到 guardian。
          // 事实按 id 去重、升级按 intentionId 去重：同一件事不会被记两次、也不会被升级两次。
          try {
            const inboxText = readTextOrEmpty(dshInboxPath(dataDir, characterId));
            if (inboxText.trim() !== "") {
              const inbox = parseDshInbox(inboxText);
              const factsPath = dshFactsPath(dataDir, characterId);
              const recorded = recordedDshIds(readTextOrEmpty(factsPath));
              const replyDir = dshReplyDir(dataDir);
              const repliesById = new Map();
              if (existsSync(replyDir)) {
                for (const name of readdirSync(replyDir)) {
                  if (!name.endsWith(".json")) continue;
                  try {
                    const parsed = parseDshReply(JSON.parse(readFileSync(join(replyDir, name), "utf8")));
                    if (parsed !== null) repliesById.set(parsed.id, parsed);
                  } catch {
                    // 坏回执跳过：她能等，但不能因为坏文件停掉整拍
                  }
                }
              }
              // 这里没有 rootDir（那是 main() 里的变量，tick 作用域看不到）——运行时根一律由 dataDir 反推（F253）。
              const guardianInbox = guardianInboxPath(resolve(dataDir, ".."), characterId);
              const escalated = new Set(readGuardianRequests(guardianInbox).requests.map((r) => r.intentionId));
              for (const ask of inbox.asks) {
                if (recorded.has(ask.id)) continue;
                const resolution = resolveDshAsk(ask, repliesById.get(ask.id) ?? null, nowMs);
                if (resolution.fact === null) continue;
                appendFileSync(factsPath, `${serializeDshFact(resolution, nowMs)}\n`, "utf8");
                recorded.add(ask.id);
                log(`[intent] DSH 回执：${resolution.fact}`);
                if (resolution.status === "expired" && !escalated.has(ask.intentionId)) {
                  const escalation = buildGuardianRequest(
                    {
                      blockedIntentionId: ask.intentionId,
                      what: ask.text,
                      tried: [...ask.tried],
                      need: "unknown",
                      ask: "这条问过 DSH，两小时没有回音，想请你看看能不能帮上",
                    },
                    formatUtc(Math.floor(nowMs / 1000) * 1000),
                    nowMs,
                  );
                  appendGuardianRequest(guardianInbox, escalation);
                  escalated.add(ask.intentionId);
                  log(`[intent] DSH 超时升级监护人：${escalation.requestId}`);
                }
              }
            }
          } catch (err) {
            log(`[intent] DSH 回程失败（不影响 tick）：${err instanceof Error ? err.message : String(err)}`);
          }
          // P4 落盘接线：能力转正 / 求助窗口裁剪 / 监护人事实（幂等，失败不打断 tick）。
          // 每拍跑一次很便宜（只读几个小文件），只有真的写了东西才打日志。
          try {
            const maintenance = runNightlyMaintenance({ root: resolve(dataDir, ".."), characterId, nowMs });
            const interesting =
              maintenance.promoted.length > 0 ||
              maintenance.ask.dropped > 0 ||
              maintenance.guardian.facts.length > 0;
            if (interesting) log(`[intent] 夜间维护：${maintenance.notes.join("；")}`);
          } catch (err) {
            log(`[intent] 夜间维护失败（不影响循环）：${err instanceof Error ? err.message : String(err)}`);
          }
        } catch (err) {
          log(`[intent] tick 失败（不影响循环）：${err instanceof Error ? err.message : String(err)}`);
        }
      };

  // P3-2b（task-57 B2）：装配层的「睡眠感知 runtime」——stateTick 的 advance 由这里分流。
  // 醒着（awake/drowsy/waking）走 runtime.advance；A 通道在 awake 与 drowsy 扣
  // （drowsy 是「清醒但困」，必须继续耗能才会越来越困；task-117 ①），waking 不扣。
  // 睡着走 sleep-tick 编排：只恢复、不推进意图/学习；跨睡点的夜间巩固在 sleepAdvance 里。
  // 相位判定与 [sleep] 日志都在这一层（sleepState），runtime 自己不再判 asleep。
  const sleepRuntime = {
    get state() {
      return runtime.state;
    },
    memoryStore: () => runtime.memoryStore(),
    consolidate: (opts) => runtime.consolidate(opts),
    advance: (hours) => {
      const sl = runtime.sleepState();
      log(runtime.sleepLogLine());
      if (!sl.asleep) {
        // waking 按醒着处理但不扣 A（task-57 B4）；drowsy 必须继续耗能——
        // 否则一犯困就回血、睡压永远到不了入睡线，自锁在 drowsy（task-117 ①，审计 §1.3 缺陷 A）。
        return runtime.advance(hours, { wakeDrain: sl.phase === "awake" || sl.phase === "drowsy" });
      }
      const nowMs = Date.now();
      // 跨夜自动换账本；P3 不消费额度，只把 remaining 写进日志（P4 才 consume）。
      nightBudget = normalizeNightBudget(nowMs, tzOffsetMinutes, nightBudget);
      let left = hours;
      while (left > 0) {
        // sleep-tick 要求 dtHours ∈ (0,1]：进程卡顿/重启后的长间隔按小时切片补恢复。
        const chunk = Math.min(1, left);
        // P4-1：sleepAdvance 现在返回夜间工作结果（fade/archive/compact/候选），
        // 由装配层打 [fade]/[sleep-work] 观测行——runtime 自己不打日志字符串。
        let work = null;
        const r = runSleepTick(
          { nowMs, dtHours: chunk, sleep: { phase: sl.phase, asleep: true }, budget: nightBudget },
          {
            recoverEnergy: (dt) => {
              // F340（task-179）：把本段睡眠的 episode（=asleepSince）传给 runtime，
              // 让她在真实入睡后的首拍做一次夜间功课——不再依赖 03:00 跨点。
              work = runtime.sleepAdvance(dt, { episodeMs: sl.asleepSince ?? undefined });
            },
            log,
          },
        );
        nightBudget = { nightKey: r.nightKey, used: r.budgetUsed };
        // P4-1：账本落 Persisted.sleep（同值早退，不会每拍多写一次状态文件）
        runtime.setNightBudget(nightBudget);
        if (work !== null) logSleepWork(work);
        // F340（task-179）：onset 只在「本段首拍真的触发功课」时打（crossing 不重复打）。
        if (work !== null && work.trigger === "onset") {
          log(
            `[sleep-work-onset] episode=${sl.asleepSince ?? "-"} ran=1${work.error === null ? "" : ` error=${work.error}`}`,
          );
        }
        // P4-2 L0（task-84）：夜间巩固完成的那一拍才是梦的触发点——跨界重放，而不是睡前。
        // 每个 nightKey 只调度一次；fire-and-forget，不阻塞本拍恢复。
        if (work !== null && work.consolidated) scheduleDreamShadow(r.nightKey);
        log(`[sleep-budget] remaining=${r.budgetLeft}/${SLEEP_NIGHT_BUDGET} night=${r.nightKey}`);
        left -= chunk;
      }
      // 睡眠里不推进 S 层状态：返回零推进的 AdvanceSummary（形状同 engine advance 的返回）。
      return {
        steps: 0,
        pressure: runtime.state.pressure,
        energy: runtime.state.energy,
        mask: runtime.state.maskIntegrity,
        sleep: null,
        faded: 0,
        forgotten: 0,
        taintCleared: 0,
      };
    },
  };

  const portDeps = {
    runtime: sleepRuntime,
    cfg,
    journal,
    // P3-2b：睡眠闸与 B 通道扣能都由装配层注入——脊髓层（autonomy）按 R2 不 import 大脑侧实现。
    sleepState: () => runtime.sleepInfo(),
    // P3-3：能量只读给脊髓层分档；装配点不判档（R4），只把当前值递进去。
    energy: () => runtime.state.energy,
    spendEnergy: (kind) => runtime.spendEnergy(energyCostFor(cfg, kind)),
    now: () => Date.now(),
    localHour: () => localParts(Date.now()).localHour,
    tzOffsetMinutes,
    holidays,
    workdays,
    llm,
    reviewFile: join(dataDir, "autonomy-review.json"),
    personaName: displayName,
    usageFile: join(dataDir, "autonomy-usage.json"),
    learnImpl,
    insightImpl,
    reconsolidateImpl,
    drainFunnel,
    ...(speaker === null ? {} : { speakImpl: speaker }),
    ...(qqHandle === null
      ? {}
      : {
          proactiveImpl: async () => {
            // 主动开口：判定/生成/发送都在 bridge 内（与插件里同一套代码），这里只做形状转换。
            // P1 真出口：把上一拍意向引擎的硬闸结论与自述递进去（没有就传 undefined = 旧行为）。
            // A4（F240 补全）：只有这一拍真的"该开口"才走 bridge。
            //   以前 outlet 不是 speak 时传 undefined 走旧路径，结果是旧机制替她决定说话——
            //   日志里能看到 `intent=outlet:journal` 却仍然发出去的消息。这正是审计说的
            //   "出口不认意图"：不是她决定说，是旧程序还在按定时器开口。
            //   现在 engine 开着而 outlet≠speak 时直接跳过（她的"没说"也要留痕）。
            if (intentTickImpl !== undefined && lastIntentContext?.outlet !== "speak") {
              log(
                `[autonomy] proactive 跳过：这一拍出口=${lastIntentContext === undefined ? "none" : String(lastIntentContext.outlet)}（A4：只有 speak 才主动开口）`,
              );
              return { opened: false, reason: "outlet", generated: false };
            }
            const intentCtx = lastIntentContext;
            const r = await qqHandle.bridge.proactive(proactiveOptions, intentCtx);
            // A5：她判断"此刻不宜打扰"→ 不发送，但这次判断同样记回意图表（held）。
            if (r.verdict === "held" && intentCtx?.intentionId !== undefined) {
              try {
                const records = readIntentionsFile();
                const held = recordHeldAttempt({
                  records,
                  intentionId: intentCtx.intentionId,
                  nowMs: Date.now(),
                });
                if (held.held !== null) {
                  writeIntentionsFile(held.records);
                  log(`[intent] held：${held.note}`);
                }
              } catch (err) {
                log(`[intent] held 记账失败（不影响下一拍）：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // F195 闭环：真的开口成功 → 把这次成功记回意图表（pending/blocked → done）。
            // 失败只记日志：记账不该影响这次开口已经发出去的事实。
            if (r.acted && r.reply !== undefined && intentCtx?.intentionId !== undefined) {
              try {
                const records = readIntentionsFile();
                const closed = recordSpokenAttempt({
                  records,
                  intentionId: intentCtx.intentionId,
                  nowMs: Date.now(),
                });
                if (closed.closed !== null) {
                  writeIntentionsFile(closed.records);
                  log(`[intent] 闭环：${closed.note}`);
                }
              } catch (err) {
                log(`[intent] 闭环记账失败（不影响已发出的消息）：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // P1 lookahead（design v3 B1-a）：到点浮现的旧意图最终没发出去（非 held、也没成功）。
            // 必须重新读表→记账→写回；只改内存的话，下一拍读文件仍是 pending/active，会被重复提起。
            // D11-2：只对「真失败」verdict 记账（allowlist，不是所有 acted=false）；
            // 外层条件字面量保持不变（intent-lookahead-wiring-lock 锁它），把 allowlist 放进块内。
            else if (intentCtx?.lookaheadSurfacedId !== undefined && r.verdict !== "held") {
              try {
                if (isFailedSpeakVerdict(r.verdict)) {
                  const records = readIntentionsFile();
                  const failed = recordSurfacedFailure({
                    records,
                    intentionId: intentCtx.lookaheadSurfacedId,
                    nowMs: Date.now(),
                  });
                  if (failed.failed !== null) {
                    writeIntentionsFile(failed.records);
                    log(`[intent] lookahead 失败：${failed.note}（不自动重提）`);
                  }
                }
              } catch (err) {
                log(`[intent] lookahead 失败记账失败（不影响下一拍）：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // D11-2：普通开口（非 lookahead 记录）真失败 → 也补 held + 下次到点 trigger，
            // 而不是永远丢掉这条意图。与上一路互斥（lookaheadSurfacedId 有值时走上面）。
            else if (isFailedSpeakVerdict(r.verdict) && intentCtx?.intentionId !== undefined) {
              try {
                const nowMs = Date.now();
                const records = readIntentionsFile();
                const failed = recordSpeakFailure({
                  records,
                  intentionId: intentCtx.intentionId,
                  nowMs,
                });
                if (failed.failed !== null) {
                  writeIntentionsFile(failed.records);
                  const trigger = failed.failed.trigger;
                  const retryHours =
                    trigger !== null && trigger.type === "time"
                      ? Math.max(1, Math.round((Date.parse(trigger.spec) - nowMs) / 3_600_000))
                      : null;
                  log(`[intent] 开口失败：${failed.note}（${retryHours === null ? "无到点时间" : `+${String(retryHours)} 小时后再试`}）`);
                }
              } catch (err) {
                log(`[intent] 开口失败记账失败（不影响下一拍）：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // 批次1B（P0-F）：她真的说出口了 → 把她自己的话写进记忆（只写成功、只写一次）。
            // 以前主动消息只进桥的 history（进程内环形缓冲），不进 memory 持久层，于是
            // 下一拍 recall 永远想不起"我上次说过什么"，只能编（审计里的「霜/雪/七点的光」）。
            // 来源/标签/鲜活度的取舍见 close-loop.spokenMemorySeed 的注释；失败只记日志。
            if (r.acted && r.reply !== undefined) {
              try {
                const seed = spokenMemorySeed({
                  reply: r.reply,
                  kind: intentCtx?.kind ?? null,
                  // 批次1B/T2：把这一拍的目标一起写进 encode_ctx（intentContextOf 已汇聚三类出口）
                  ...(intentCtx?.goalAtTime === undefined ? {} : { goalAtTime: intentCtx.goalAtTime }),
                  ...(intentCtx?.goalId === undefined ? {} : { goalId: intentCtx.goalId }),
                });
                const stored = runtime.remember(seed);
                log(`[intent] 记忆：主动开口${stored.stored ? `已写 ${stored.id}` : `未写（${stored.reason}）`}`);
              } catch (err) {
                log(`[intent] 主动开口写记忆失败（不影响已发出的消息）：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // S3b（M5）：主动开口成功后的时间一致性日志。只认「现在 N 点」「N 小时没见」这类
            // 明确表述；快照取本拍已建好的 beatTemporal（没有就不记，不补造）。只落计数，不落原文。
            // F352：逻辑在 speak-metrics.logProactiveTimeClaims（可单测），这里只负责传本拍快照。
            if (r.acted && r.reply !== undefined) {
              logProactiveTimeClaims({
                reply: r.reply,
                temporal: beatTemporal,
                tzOffsetMinutes,
                log,
              });
            }
            log(
              `[autonomy] proactive opened=${String(r.acted)} reason=${r.verdict}` +
                ` intent=${lastIntentContext === undefined ? "none" : `outlet:${String(lastIntentContext.outlet)}`}` +
                // F252：带上意图 kind，让"这条消息是哪一类心事让她开口的"能在日志里回溯（验收 §7.2）。
                ` kind=${lastIntentContext?.kind ?? "none"}` +
                `${r.reply === undefined ? "" : ` reply=${r.reply.slice(0, 40)}`}`,
            );
            // generated：真的生成了台词（花过钱）。判定没过（gap/熔断）时为 false，不记账。
            // held 也是一次真实的模型调用（她看过处境、决定先不说），按"花过钱"记账。
            return {
              opened: r.acted,
              reason: r.detail === "" ? r.verdict : r.detail,
              generated: r.reply !== undefined || r.verdict === "held",
            };
          },
        }),
    socialImpl,
    log,
    ...(intentTickImpl === undefined ? {} : { intentTickImpl }),
    // P1 真出口（自言自语）：同一拍的由头给 selftalk 用；没有就退回旧提示词。
    // 放在这里而不是 tick 里，是因为 selftalk 也在同一进程的同一拍里跑。
    ...(intentTickImpl === undefined
      ? {}
      : { intentNoteImpl: () => (lastIntentContext === undefined ? undefined : lastIntentContext.note) }),
  };
  // P4-2 L0（task-84）：夜间梦/联想的 shadow——只跑模型、写影子文件，不落库。
  // 触发：sleepAdvance() 报告 consolidated=true（跨睡点 + 夜间巩固完成的那一拍）；
  // 每个 nightKey 只跑一次，不重试、不阻塞睡眠（fire-and-forget）。
  const dreamShadowPath = join(dataDir, `dream-shadow-${characterId}.ndjson`);
  /** 影子文件一行/夜；超过 2×保留夜数才重写一次，保留最近 DREAM_RETENTION_NIGHTS 行 */
  function appendDreamShadowLine(line) {
    try {
      appendFileSync(dreamShadowPath, `${line}\n`, "utf8");
      const lines = readFileSync(dreamShadowPath, "utf8")
        .split("\n")
        .filter((entry) => entry.trim() !== "");
      if (lines.length > DREAM_RETENTION_NIGHTS * 2) {
        const tmp = `${dreamShadowPath}.tmp`;
        writeFileSync(tmp, `${trimShadowLines(lines, DREAM_RETENTION_NIGHTS).join("\n")}\n`, "utf8");
        renameSync(tmp, dreamShadowPath);
        log(`[dream-shadow] 保留最近 ${DREAM_RETENTION_NIGHTS} 夜：${lines.length} → ${DREAM_RETENTION_NIGHTS}`);
      }
    } catch (err) {
      // 影子文件写失败只影响今晚的观测，不能影响睡眠/巩固；不重试。
      log(`[dream-shadow] 写盘失败（不重试）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let dreamNightKey = null;
  let dreamInFlight = false;

  function scheduleDreamShadow(nightKey) {
    if (process.env.ACE_DREAM_SHADOW === "0") return;
    if (typeof nightKey !== "string" || nightKey.trim() === "") return;
    if (dreamInFlight || dreamNightKey === nightKey) return;
    // 先占坑再异步：同一夜只会调一次模型（失败也不重试，等明天）。
    dreamNightKey = nightKey;
    dreamInFlight = true;
    void dreamShadow(nightKey, Date.now())
      .catch((err) => log(`[dream-shadow] 失败（不重试）：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        dreamInFlight = false;
      });
  }

  async function dreamShadow(nightKey, nowMs) {
    const model = portDeps.llm;
    if (model === null || model === undefined) {
      log("[dream-shadow] 跳过：没有模型凭据");
      return;
    }
    const records = runtime.memoryStore().active().map((record) => ({
      id: record.id,
      content: record.content,
      source: record.source,
      created_at: record.created_at,
      vividness: record.vividness,
      access_count: record.access_count,
      forgotten: record.forgotten,
      suppressed_by_stronger: record.suppressed_by_stronger,
      encode_ctx: record.encode_ctx,
    }));
    let realSources;
    try {
      realSources = knobStrings(cfg, "RELATION_SOURCES");
    } catch {
      realSources = ["player", "qq_contact_verified"];
    }
    const picked = selectDreamSeeds({ nowMs, records, limit: 4, realSources });
    if (picked.seeds.length < DREAM_SEED_MIN) {
      log(
        `[dream-shadow] night=${nightKey} 跳过：可用种子 ${picked.seeds.length} < ${DREAM_SEED_MIN}（reason=${picked.reason}）`,
      );
      return;
    }
    // 预算先记账再调模型（brief §1.2）：额度不够就跳过，不降级模板。
    let nextBudget;
    try {
      nextBudget = consumeNightBudget(nightBudget, 1);
    } catch (err) {
      log(
        `[dream-shadow] night=${nightKey} 跳过：夜间预算不足（${err instanceof Error ? err.message : String(err)}）`,
      );
      return;
    }
    nightBudget = nextBudget;
    runtime.setNightBudget(nightBudget);

    const startedAt = Date.now();
    let reply = null;
    let errorText = null;
    try {
      reply = await chatComplete(
        model,
        buildDreamPrompt({ personaName: displayName, seeds: picked.seeds, nightKey }),
        { task: "dream" },
      );
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err);
    }
    if (reply !== null) logUsage("dream", reply);
    const durationMs = Date.now() - startedAt;
    const text = reply === null ? null : parseDreamText(reply.text);
    const seedIds = picked.seeds.map((seed) => seed.id);
    const validation = validateDreamShadow({
      records,
      seedIds,
      text: text ?? "",
      confidenceHint: DREAM_CONF_HINT,
      error: errorText,
    });
    const record = buildShadowRecord({
      nightKey,
      ranAtMs: nowMs,
      model: reply === null ? "unknown" : reply.model,
      seedIds,
      text,
      validation,
      lowData: picked.lowData,
      tokens: {
        prompt: reply?.usage?.promptTokens ?? 0,
        completion: reply?.usage?.completionTokens ?? 0,
      },
      durationMs,
      budget: { used: nextBudget.used, left: remainingNightBudget(nextBudget) },
      error: errorText,
    });
    appendDreamShadowLine(JSON.stringify(record));
    log(
      `[dream-shadow] night=${nightKey} seeds=${seedIds.length} ok=${String(validation.ok)}` +
        ` chars=${text === null ? 0 : Array.from(text).length}` +
        ` tokens=${record.tokens.prompt}+${record.tokens.completion} ms=${durationMs}` +
        `${errorText === null ? "" : ` error=${errorText}`}`,
    );
  }

  // ---- W1：网页学习（spec v2.3；默认 WEB_SEARCH_ENABLED=0 → 零网络、零行为变化） ----
  // 分工：脊髓层只算 webPlan（该不该查）；这里负责开关/额度/HTTP/落库；src/web 只做纯逻辑与校验。
  // 装配层是 data/web-usage-<characterId>.json 的唯一写者（W2/W3 也不许别处写）。
  const webUsagePath = join(dataDir, `web-usage-${characterId}.json`);
  const webConfigReader = { read: (name) => knobNumber(cfg, name) };
  const readWebUsageFile = () => {
    try {
      if (!existsSync(webUsagePath)) return emptyWebUsage(Date.now(), tzOffsetMinutes);
      return normalizeWebUsage(JSON.parse(readFileSync(webUsagePath, "utf8")), Date.now(), tzOffsetMinutes);
    } catch (err) {
      log(`[web] usage 读取失败，按空额度处理：${err instanceof Error ? err.message : String(err)}`);
      return emptyWebUsage(Date.now(), tzOffsetMinutes);
    }
  };
  let webUsage = readWebUsageFile();
  const writeWebUsage = () => {
    try {
      const tmp = `${webUsagePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(webUsage), "utf8");
      renameSync(tmp, webUsagePath);
    } catch (err) {
      // 额度账本写失败只影响下一拍的重试节奏，不影响这次搜索本身；不重试。
      log(`[web] usage 写入失败（不重试）：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  function webLogQuery(text) {
    const chars = Array.from(String(text).replace(/\s+/g, " ").trim());
    return chars.length <= 40 ? chars.join("") : `${chars.slice(0, 40).join("")}…`;
  }
  async function executeWebPlan(out) {
    const plan = out?.webPlan;
    // 常态：allowSearch=false / 非 full 档 / 不在学习拍 → 直接返回（零网络零日志）
    if (plan === undefined || plan.allowSearch !== true) return;
    let webCfg;
    try {
      webCfg = readWebConfig(webConfigReader, log);
    } catch (err) {
      log(`[web] skip：配置非法（${err instanceof Error ? err.message : String(err)}）`);
      return;
    }
    if (!webCfg.enabled) return;
    // Search API 与模型共用同一份凭据（DeepSeek 官方 API）；没 key 就没法查，也不值得降级。
    const model = portDeps.llm;
    if (model === null || model === undefined) {
      log("[web] skip：没有模型凭据（Search 与模型共用 key）");
      return;
    }
    const nowMs = Date.now();
    webUsage = normalizeWebUsage(webUsage, nowMs, tzOffsetMinutes);
    const gate = canSearch(nowMs, webUsage, webCfg);
    if (!gate.allowed) {
      log(`[web] budget exhausted reason=${gate.reason}`);
      return;
    }
    // 先记「尝试」再发请求：失败也算用掉一次最小间隔，避免失败风暴（日计数只加成功）。
    webUsage = touchSearchAttempt(webUsage, nowMs);
    writeWebUsage();
    const deps = {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      fetchImpl: (input, init) => fetch(input, init),
      timeoutMs: webCfg.timeoutMs,
      now: () => Date.now(),
      log,
    };
    let result;
    try {
      result = await searchForLearning(plan, deps);
    } catch (err) {
      // search.ts 自己吞网络错误并记 [web] fail；走到这里说明是没料到的异常，同样不重试。
      log(`[web] fail kind=internal query=${webLogQuery(plan.keyword)} error=${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!result.ok) return; // search.ts 已记 [web] fail
    if (result.hits.length > 0) {
      // 日计数只加"成功且结果非空"；空结果不算一次额度（否则会把 20 次耗在无结果上）。
      webUsage = consumeSearch(webUsage, Date.now());
      writeWebUsage();
    }
    const picked = result.hits.filter((hit) => hit.authority >= 1 && hit.rerankScore >= 1).slice(0, 2);
    if (picked.length === 0) {
      log(`[web] skip low-quality query=${webLogQuery(plan.keyword)} hits=${String(result.hits.length)}`);
      return;
    }
    const ingest = ingestHits(runtime.knowledgeWritePort(), picked, nowMs, {
      credibility: webCfg.sourceCredibility,
    });
    // 污点落库（source="web" 必进防火墙 quarantine）；这里只报数，不读回来。
    log(
      `[web] ok query=${webLogQuery(plan.keyword)} hits=${String(result.hits.length)} picked=${String(picked.length)}` +
        ` written=${String(ingest.written)} skipped=${String(ingest.skipped)} rejected=${String(ingest.rejected)}`,
    );
  }

  // task-138：soul_web_search（只读工具，daemon 代理）。插件没有 key、不写 usage、不联网；
  // 真正的闸与 fresh/clamp 在 src/web/tool-run.ts（纯函数，可 mock），这里只做装配：
  // 读 6 个 WEB_* 键 → 共用 webUsage 账本 → 调 searchForTool → 落盘 → 返回结构化结果。
  function webToolFailure(code, message) {
    return {
      ok: false,
      code,
      hits: [],
      failure: null,
      message,
      retryAfterMs: null,
      stats: { searchCount: webUsage.searchCount, dailyCap: 0 },
      fresh: false,
    };
  }
  async function executeWebToolSearch(rawPayload) {
    const payload = rawPayload !== null && typeof rawPayload === "object" ? rawPayload : {};
    const query = typeof payload.query === "string" ? payload.query : "";
    const maxResults = typeof payload.maxResults === "number" ? payload.maxResults : undefined;
    const fresh = payload.fresh === true;
    let webCfg;
    try {
      webCfg = readWebConfig(webConfigReader, log);
    } catch (err) {
      return webToolFailure("WEB_INTERNAL", `配置非法（${err instanceof Error ? err.message : String(err)}）`);
    }
    const model = portDeps.llm;
    const hasKey = model !== null && model !== undefined;
    const nowMs = Date.now();
    webUsage = normalizeWebUsage(webUsage, nowMs, tzOffsetMinutes);
    const deps = hasKey
      ? {
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          fetchImpl: (input, init) => fetch(input, init),
          timeoutMs: webCfg.timeoutMs,
          now: () => Date.now(),
          log,
        }
      : null;
    let outcome;
    try {
      outcome = await runWebToolSearch({
        query,
        ...(maxResults === undefined ? {} : { maxResults }),
        fresh,
        nowMs,
        cfg: webCfg,
        usage: webUsage,
        hasKey,
        search: async (q, count) => {
          if (deps === null) throw new Error("没有模型凭据（Search 与模型共用 key）");
          return searchForTool(q, deps, count);
        },
      });
    } catch (err) {
      return webToolFailure("WEB_INTERNAL", err instanceof Error ? err.message : String(err));
    }
    webUsage = outcome.usage;
    writeWebUsage();
    const result = outcome.result;
    if (result.ok) {
      log(
        `[web-tool] ok query=${webLogQuery(query)} hits=${String(result.hits.length)} fresh=${String(result.fresh)}` +
          ` used=${String(result.stats.searchCount)}/${String(result.stats.dailyCap)}`,
      );
    } else {
      log(`[web-tool] fail code=${String(result.code)} query=${webLogQuery(query)} message=${String(result.message ?? "")}`);
    }
    return result;
  }
  webToolHandler = executeWebToolSearch;

  // F1：soul_web_fetch（只读抓取，daemon 代理）。闸/参数/记账在 src/web/fetch-run.ts；
  // 插件没有 key、不联网、不写账本。这里只做装配：共享 webUsage 账本 + fetchPageText。
  function webFetchFailure(code, message, retryAfterMs = null) {
    return {
      ok: false,
      code,
      url: null,
      finalUrl: null,
      title: null,
      text: null,
      truncated: false,
      bytes: 0,
      fetchedAtMs: null,
      failure: null,
      message,
      retryAfterMs,
      stats: { fetchCount: webUsage.fetchCount, dailyCap: 0 },
    };
  }
  async function executeWebToolFetch(rawPayload) {
    const payload = rawPayload !== null && typeof rawPayload === "object" ? rawPayload : {};
    const url = typeof payload.url === "string" ? payload.url : "";
    const maxChars = typeof payload.maxChars === "number" ? payload.maxChars : undefined;
    let webCfg;
    try {
      webCfg = readWebConfig(webConfigReader, log);
    } catch (err) {
      return webFetchFailure("WEB_INTERNAL", `配置非法（${err instanceof Error ? err.message : String(err)}）`);
    }
    const model = portDeps.llm;
    const hasKey = model !== null && model !== undefined;
    const nowMs = Date.now();
    webUsage = normalizeWebUsage(webUsage, nowMs, tzOffsetMinutes);
    const deps = hasKey
      ? {
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          fetchImpl: (input, init) => fetch(input, init),
          timeoutMs: webCfg.timeoutMs,
          now: () => Date.now(),
          log,
        }
      : null;
    let outcome;
    try {
      outcome = await runWebFetch({
        url,
        ...(maxChars === undefined ? {} : { maxChars }),
        nowMs,
        cfg: webCfg,
        usage: webUsage,
        hasKey,
        fetch: async (target, opts) => {
          if (deps === null) throw new Error("没有模型凭据（抓取与模型共用 key）");
          return fetchPageText(target, deps, {
            maxChars: opts.maxChars,
            deadlineAtMs: opts.deadlineAtMs,
          });
        },
      });
    } catch (err) {
      return webFetchFailure("WEB_INTERNAL", err instanceof Error ? err.message : String(err));
    }
    webUsage = outcome.usage;
    writeWebUsage();
    const result = outcome.result;
    if (result.ok) {
      log(
        `[web-fetch] ok url=${webLogQuery(result.url ?? url)} chars=${String(Array.from(result.text ?? "").length)}` +
          ` truncated=${String(result.truncated)} bytes=${String(result.bytes)}` +
          ` used=${String(result.stats.fetchCount)}/${String(result.stats.dailyCap)}`,
      );
    } else {
      log(`[web-fetch] fail code=${String(result.code)} url=${webLogQuery(url)} message=${String(result.message ?? "")}`);
    }
    return result;
  }
  webFetchHandler = executeWebToolFetch;

  const port = createStandalonePort(portDeps);
  // 延迟绑定：explore 越阈路径也走同一个脊髓入口（统一 tier/睡眠/频率/扣费）。
  // W1：explore-only 入口固定传 exploreNow=true（普通 actions.learn 不传）。
  runLearnThroughPort = async () => {
    const out = await port.learn({ exploreNow: true });
    log(`[autonomy] learn ${out.topic} / ${out.keyword}`);
    await executeWebPlan(out);
  };

  // F282：策略搬进 src/assembly/model-refresh.ts（节流 + 装上/清掉），这里只注入存取器。
  const refreshModel = createModelRefresher({
    log,
    now: () => Date.now(),
    loadConfig: (env) => loadLlmConfig(env),
    getLlm: () => portDeps.llm ?? null,
    setLlm: (llm) => {
      portDeps.llm = llm;
    },
  });

  // F301：动作包装（先刷新凭据、再跑固定副作用、最后才是动作）收进装配层；
  // 每拍固定副作用（队列补偿 / 面板快照 / 3 点数据快照 / 6 点早报）见 src/assembly/tick-hooks.ts。
  const actions = wrapActions({
    // W1：网页执行的唯一普通入口（explore-only 路径在 runLearnThroughPort 里手动调）
    actions: createPortActions(port, log, { afterLearn: executeWebPlan }),
    refreshModel,
    tickHooks: { dataDir, characterId, repo, tzOffsetMinutes, log, runtime, drainQueue },
    now: () => Date.now(),
  });

  const lockPath = join(dataDir, ".writer-lock");
  const beatPath = join(dataDir, `autonomy-${characterId}.beat`);
  if (once) {
    const now = Date.now();
    const result = await runDryTick({ now, localHour: localParts(now).localHour, lockPath, tzOffsetMinutes });
    log(`[autonomy] dry-run actions=${result.ran.join("+")} reason=${result.plan.reason}`);
    return;
  }

  // 主动性节奏全部来自配置：qq.proactive（消息侧）+ autonomy.env 的 ACE_SOCIAL_*（B 站侧）。
  // 默认值在 AutonomyConfig 里只有一份；这里只把“分钟”换算成毫秒。
  const config = resolveAutonomyConfig({
    enabled: autonomyOn,
    proactiveEnabled: proactiveOptions.enabled,
    proactiveIntervalMs: proactiveEveryMin * 60_000,
    proactiveMinGapMs: proactiveOptions.minGapMs,
    proactiveMaxPerDay: proactiveOptions.maxPerDay,
    socialIntervalMs: socialEveryMin * 60_000,
    socialDailyMax,
    socialCommentDailyMax,
  });
  const loop = new AutonomyLoop({
    config,
    actions,
    releaseOnTick: qqHandle === null,
    lockPath,
    beatPath,
    pid: process.pid,
    now: () => Date.now(),
    localHour: () => localParts(Date.now()).localHour,
    tzOffsetMinutes,
  });

  // F293：pid 文件 + 信号/顺序/flush/退出 收进装配层；入口只注入这一进程的依赖。
  const lifecycle = installLifecycle({
    pidPath,
    characterId,
    pid: process.pid,
    now: () => Date.now(),
    log,
    stopLoop: () => loop.stop(),
    ...(qqHandle === null ? {} : { stopQq: () => qqHandle.stop() }),
    closeChannel: () => writeChannel.close(),
    flush: () => runtime.flush(),
    cleanup: () => {
      clearInterval(keepAlive);
      clearInterval(stopWatch);
    },
  });
  const shutdown = lifecycle.shutdown;

  log(`[autonomy] 循环启动 enabled=${String(config.enabled)} tick=${String(config.stateIntervalMs)}ms`);
  loop.start();
  // 醒来先跑一拍：心跳文件立刻有内容，开发面的只读闸才不会在她"睡着"的那五分钟里失灵
  void loop.runOnce().catch((err) => log(`[autonomy] 首拍异常：${err instanceof Error ? err.message : String(err)}`));
  // AutonomyLoop 的定时器是 unref 的（它本来嵌在 DSH 里用），常驻进程必须自己攥住事件循环，
  // 否则 runtime 打开完、日志写完，进程就静悄悄退出了。
  const keepAlive = setInterval(() => {}, 60_000);
  const stopWatch = setInterval(() => {
    if (!existsSync(stopPath)) return;
    clearInterval(stopWatch);
    clearInterval(keepAlive);
    shutdown("stop-file");
  }, 3000);
  stopWatch.unref?.();
  // 常驻：不主动退出；退出只由信号触发
}

main().catch((err) => {
  log(`[autonomy] 致命错误：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
