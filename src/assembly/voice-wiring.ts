/**
 * 语音进出接线的装配（F296，批次 3「入口下沉」第八刀）。
 *
 * 为什么放在装配层而不是入口脚本里：
 *   - 这一坨（python 解释器、whisper 模型目录、tts.ps1 路径、临时目录、降级链）
 *     是**环境知识**，不是业务逻辑；入口脚本只该说"给我一个能说话的她"。
 *   - 入口脚本在 `spec/config/layers.json` 的扫描面之外（`scripts/` 只作为额外根收边），
 *     混在那里的逻辑没有单测；搬上来之后可以用假实现把"edge-tts 挂了要退到 SAPI"
 *     这条链真正测一遍——它以前只在线上靠运气验证过。
 *   - 语音失败必须降级成文字（src/qq/voice.ts 的取舍），所以这里的失败路径比成功路径更重要。
 *
 * 边界：本模块只装配，不读时钟（`now` 由调用方给）、不落业务状态、不决定要不要发声。
 */

import { join } from "node:path";
import {
  fetchVoiceFile,
  synthesizeSpeech,
  synthesizeSpeechLocal,
  transcribeAudio,
  type LocalVoiceDeps,
  type VoiceToolDeps,
} from "../qq/voice.js";

export interface VoiceWiringInput {
  /** 仓库根（脚本与模型都相对它） */
  readonly repo: string;
  /** 数据目录（合成音频、下载的语音都放这里） */
  readonly dataDir: string;
  readonly log: (line: string) => void;
  /** 环境变量（测试注入用；不给就读 process.env） */
  readonly env?: NodeJS.ProcessEnv;
  /** 时钟：装配层不自己取时间（writers lint 只允许 src/engine/clock.ts 取），由入口给 */
  readonly now: () => number;
  /** 出站合成（测试注入用；默认 edge-tts） */
  readonly synthEdge?: (deps: VoiceToolDeps, text: string) => Promise<string>;
  /** 出站兜底合成（测试注入用；默认本机 SAPI） */
  readonly synthLocal?: (deps: LocalVoiceDeps, text: string) => Promise<string>;
  /** 入站下载（测试注入用） */
  readonly fetchVoice?: (
    deps: Pick<VoiceToolDeps, "outDir" | "now" | "log">,
    source: string,
  ) => Promise<string>;
  /** 入站转写（测试注入用） */
  readonly transcribe?: (deps: VoiceToolDeps, audioPath: string) => Promise<string>;
}

export interface VoiceWiring {
  readonly voiceDeps: VoiceToolDeps;
  readonly localVoiceDeps: LocalVoiceDeps;
  /** 出站：先 edge-tts，失败退本机 SAPI；两条都挂由调用方降级文字 */
  readonly synthVoice: (text: string) => Promise<string>;
  /** 入站：下载 → whisper 转写（失败由桥降级成"收到一条语音，没转写出来"） */
  readonly transcribeVoice: (source: string) => Promise<string>;
}

/** 只留第一行错误信息：日志里铺一整个 python traceback 没人看得下去。 */
function firstLine(err: unknown): string {
  if (err instanceof Error) return err.message.split(String.fromCharCode(10))[0] ?? err.message;
  return String(err);
}

export function createVoiceWiring(input: VoiceWiringInput): VoiceWiring {
  const env = input.env ?? process.env;
  const now = input.now;
  const synthEdge = input.synthEdge ?? synthesizeSpeech;
  const synthLocal = input.synthLocal ?? synthesizeSpeechLocal;
  const fetchVoice =
    input.fetchVoice ??
    ((deps, source) => fetchVoiceFile(deps, source));
  const transcribe = input.transcribe ?? transcribeAudio;

  const voiceDeps: VoiceToolDeps = {
    pythonExe: env["ACE_PYTHON"] ?? "python",
    pylibsDir: join(input.repo, ".pylibs"),
    asrScript: join(input.repo, "tools", "voice", "asr.py"),
    asrModel: join(input.dataDir, "whisper-base"),
    outDir: join(input.dataDir, "voice"),
    tmpDir: join(input.repo, ".tmp"),
    now,
    log: input.log,
  };

  const localVoiceDeps: LocalVoiceDeps = {
    powershellExe: env["ACE_POWERSHELL"] ?? "powershell",
    ttsScript: join(input.repo, "tools", "voice", "tts.ps1"),
    outDir: join(input.dataDir, "voice"),
    tmpDir: join(input.repo, ".tmp"),
    now,
    voice: env["ACE_SAPI_VOICE"] ?? "Microsoft Huihui Desktop",
    rate: 0,
    log: input.log,
  };

  async function synthVoice(text: string): Promise<string> {
    try {
      return await synthEdge(voiceDeps, text);
    } catch (err) {
      input.log(`[voice] edge-tts 不可用（${firstLine(err)}），改用本机 SAPI`);
    }
    return synthLocal(localVoiceDeps, text);
  }

  async function transcribeVoice(source: string): Promise<string> {
    const file = await fetchVoice(voiceDeps, source);
    const text = await transcribe(voiceDeps, file);
    input.log(`[voice] 转写 ${String(text.length)} 字：${text.slice(0, 40)}`);
    return text;
  }

  return { voiceDeps, localVoiceDeps, synthVoice, transcribeVoice };
}
