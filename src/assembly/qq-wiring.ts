/**
 * QQ 接待接线的装配（F300，批次 3「入口下沉」第九刀）。
 *
 * 为什么搬上来：这段代码在入口里占 ~110 行，混着三类东西——
 *   1. 环境知识（OneBot 连接参数、spine 快照路径、静默窗默认值）；
 *   2. 宿主能力代理（发图读文件转 base64、从取帧目录挑图、语音合成/转写）；
 *   3. 一句"桥归谁"的开关判断。
 * 入口脚本该说的只有"把 QQ 接待交给她，或别交"。搬到这里之后：
 *   - 开关判断（owner/once/没凭据）第一次有单测；
 *   - 发图/递图/语音这些洞（读文件、联网）集中在装配层，脊髓里的 qq-runner 保持"只会调注入的洞"。
 *
 * 边界：不取时钟（`now` 由调用方给）、不启动 ws 以外的进程、失败一律降级（桥没起来=插件侧可能接，
 * 也可能谁都不接，所以这里只记录"为什么不交"，不抛错）。
 */

import { join } from "node:path";

import {
  startAutonomyQq,
  type AutonomyQqHandle,
  type AutonomyQqInput,
} from "../autonomy/qq-runner.js";
import type { OneBotConn } from "../autonomy/onebot-config.js";

import { localPartsOf } from "./main-config.js";
import type { VoiceWiring } from "./voice-wiring.js";

/** 静默窗与主动间隔的常驻进程默认值（与 `src/contracts/quiet-hours.ts` 同一事实，测试锁住）。 */
export const QQ_QUIET_FROM = 23;
export const QQ_QUIET_TO = 7;
export const QQ_MIN_GAP_MS = 60_000;
export const QQ_MAX_PER_HOUR = 6;

export interface QqBridgeInput {
  readonly dataDir: string;
  readonly characterId: string;
  readonly repo: string;
  /** 读不到的 OneBot 配置就是 null（不是抛错）——没有连接就只是不接待 */
  readonly conn: OneBotConn | null;
  /** `--say` 一次性模式：只发一条就退，不常驻接待 */
  readonly once: boolean;
  readonly runtime: AutonomyQqInput["runtime"];
  readonly llm: AutonomyQqInput["llm"];
  /** 可选（P2）：与网页聊天共享的对话历史；装配入口把同一个 ChatLog 交给两边。 */
  readonly historyStore?: AutonomyQqInput["historyStore"];
  /**
   * 可选（task-169 C）：生成侧回声自检。装配入口用 chatLog/journal/memory 拼出参照文本，
   * 这里只透传给桥——装配层不自己判重（判重是大脑层的 echo-guard）。
   */
  readonly echoCheck?: AutonomyQqInput["echoCheck"];
  /**
   * 出站的三个"洞"由入口注入：发图、递图素材、发语音。
   *
   * 为什么不在这里直接调发送函数：`tools/audit/check_execution.mjs` 的 H11 规定出站只有一个收口，
   * 扫描面内的新文件直连发送会被判违规；入口脚本（scripts/）不在扫描面内，是既定的收口位置。
   * 所以装配层只决定"交给谁、用什么参数"，不自己张嘴。
   */
  readonly sendImage: (peer: number, imagePath: string) => Promise<{ ok: boolean; detail: string }>;
  readonly shareImage: () => string | null;
  readonly sendVoice: (peer: number, text: string) => Promise<{ ok: boolean; detail: string }>;
  /** 入站语音转写（语音接线给的函数；失败由桥降级成"没听清"） */
  readonly transcribeVoice: (path: string) => Promise<string>;
  /** 本地时区偏移（分钟）；本地小时的口径与入口/health 一致 */
  readonly tzOffsetMinutes: number;
  /** 时钟（必填：装配层不自己取时间，writers lint 只允许 engine/clock 取） */
  readonly now: () => number;
  /** 桥工厂（测试注入；默认就是 `startAutonomyQq`） */
  readonly startBridge?: (input: AutonomyQqInput) => AutonomyQqHandle | null;
  readonly log: (line: string) => void;
}

/**
 * 把 QQ 接待交给常驻进程（或明确不交）。
 *
 * 返回 null 的三种情况都写日志说明原因：
 *   - 没有 OneBot 配置（入口已先行记录，这里不重复）；
 *   - `--say` 一次性模式；
 *   - 桥归宿主（owner=host），不由本进程接待。
 */
export function startQqBridge(input: QqBridgeInput): AutonomyQqHandle | null {
  if (input.conn === null || input.once) return null;
  if (input.conn.owner !== "autonomy") {
    input.log(`[autonomy] QQ 桥 owner=${String(input.conn.owner)}（不由本进程接待）`);
    return null;
  }

  const now = input.now;
  const startBridge = input.startBridge ?? startAutonomyQq;
  const conn = input.conn;

  const handle = startBridge({
    runtime: input.runtime,
    llm: input.llm,
    dataDir: input.dataDir,
    characterId: input.characterId,
    repoRoot: input.repo,
    onebot: conn,
    quietFrom: QQ_QUIET_FROM,
    quietTo: QQ_QUIET_TO,
    minGapMs: QQ_MIN_GAP_MS,
    maxPerHour: QQ_MAX_PER_HOUR,
    // B.6：熔断状态落盘，health 才看得见（不给路径就只在内存里，等价于"出事了没人知道"）。
    spinePath: join(input.dataDir, `spine-${input.characterId}.json`),
    now,
    localHour: () => localPartsOf(now(), input.tzOffsetMinutes).localHour,
    // S3b（M5）：回信时间一致性日志的本地时区基准（与 localHour 同一口径）。
    tzOffsetMinutes: input.tzOffsetMinutes,
    // 出站/递图/转写的实现由入口注入（H11：直连发送只在扫描面外的入口收口）。
    sendImageImpl: input.sendImage,
    shareImage: input.shareImage,
    transcribeVoiceImpl: async (ref) => input.transcribeVoice(ref.path),
    sendVoiceImpl: input.sendVoice,
    // P2：共享历史（网页 ↔ QQ）。不给 = 旧行为，桥内自己记。
    ...(input.historyStore === undefined ? {} : { historyStore: input.historyStore }),
    // task-169 C：回声自检。不给 = 旧行为（不做闸门）。
    ...(input.echoCheck === undefined ? {} : { echoCheck: input.echoCheck }),
    log: input.log,
  });

  input.log(
    handle === null
      ? "[autonomy] 桥移交=autonomy 但没有凭据：QQ 接待未启动"
      : "[autonomy] QQ 桥已移交给常驻进程（插件只观察）",
  );
  return handle;
}
