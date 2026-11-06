/**
 * 语音进出：出站用 edge-tts 合成，入站用 faster-whisper 转写。
 *
 * 设计取舍：
 *   - 不把模型/依赖装进宿主进程：TTS/ASR 都是「外部小工具」，用受控子进程调用，
 *     换引擎只换脚本，宿主代码不用重编；进程挂掉也只是这一句话没有声音。
 *   - 合成/转写都可能慢（秒级），所以调用方必须给超时并在失败时降级成文字——
 *     一条消息因为语音失败而不回，比回一条文字糟得多。
 *   - 本模块不读时钟也不写状态：文件名序号由调用方给的 `now` 和自增计数拼，
 *     符合 writers lint（时钟只能在 clock.ts 里读）。
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface VoiceToolDeps {
  /** python 解释器（含 edge_tts / faster_whisper 依赖的那一个） */
  readonly pythonExe: string;
  /** 依赖目录（PYTHONPATH），通常是仓库下 `.pylibs` */
  readonly pylibsDir: string;
  /** tools/voice/asr.py 的绝对路径 */
  readonly asrScript: string;
  /** whisper 模型目录（本地，不联网下载） */
  readonly asrModel: string;
  /** 合成音频落盘目录 */
  readonly outDir: string;
  /** edge-tts 音色，默认晓伊（偏轻、适合她） */
  readonly ttsVoice?: string;
  /** 子进程临时目录（宿主进程的 %TEMP% 常被沙箱拒绝，必须显式给一个可写目录） */
  readonly tmpDir?: string;
  /** 单次子进程超时（毫秒），默认 60s */
  readonly timeoutMs?: number;
  readonly now: () => number;
  readonly log?: (line: string) => void;
}

let SEQ = 0;

function childEnv(deps: VoiceToolDeps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: deps.pylibsDir,
    PYTHONIOENCODING: "utf-8",
  };
  if (deps.tmpDir !== undefined) {
    env.ACE_TMP = deps.tmpDir;
    env.TMP = deps.tmpDir;
    env.TEMP = deps.tmpDir;
    env.TMPDIR = deps.tmpDir;
  }
  return env;
}

function timeoutOf(deps: VoiceToolDeps): number {
  return deps.timeoutMs ?? 60_000;
}

/** 合成一句语音，返回本地 mp3 路径。空文本直接抛错（发出去也只是空气泡）。 */
export async function synthesizeSpeech(deps: VoiceToolDeps, text: string): Promise<string> {
  const clean = text.trim();
  if (clean === "") throw new Error("语音文本为空");
  mkdirSync(deps.outDir, { recursive: true });
  SEQ += 1;
  const file = join(deps.outDir, `tts-${deps.now().toString(36)}-${String(SEQ)}.mp3`);
  const voice = deps.ttsVoice ?? "zh-CN-XiaoyiNeural";
  const { stderr } = await run(
    deps.pythonExe,
    ["-m", "edge_tts", "--voice", voice, "--text", clean, "--write-media", file],
    { env: childEnv(deps), timeout: timeoutOf(deps), windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  const noise = stderr.trim();
  if (noise !== "") deps.log?.(`[voice] tts stderr: ${noise.slice(0, 200)}`);
  return file;
}

/** 转写一段音频（wav/mp3/amr…），返回识别文本；失败抛错，由调用方降级。 */
export async function transcribeAudio(deps: VoiceToolDeps, audioPath: string): Promise<string> {
  const { stdout } = await run(
    deps.pythonExe,
    [deps.asrScript, audioPath, deps.asrModel],
    { env: childEnv(deps), timeout: timeoutOf(deps), windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  if (line === "") throw new Error("ASR 没有输出");
  const parsed = JSON.parse(line) as { text?: unknown };
  if (typeof parsed.text !== "string") throw new Error("ASR 输出缺 text");
  return parsed.text.trim();
}

/** 把 OneBot 给的语音下载到本地（http/https 才需要；本地路径直接返回）。 */
export async function fetchVoiceFile(
  deps: Pick<VoiceToolDeps, "outDir" | "now" | "log">,
  source: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  // OneBot 端给的本地语音常是 file:///C:/... 形式，python/ffmpeg 只认裸路径
  if (/^file:\/\//i.test(source)) return fileURLToPath(source);
  if (!/^https?:\/\//i.test(source)) return source;
  mkdirSync(deps.outDir, { recursive: true });
  SEQ += 1;
  const dest = join(deps.outDir, `in-${deps.now().toString(36)}-${String(SEQ)}`);
  const res = await fetchFn(source, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`下载语音失败：HTTP ${String(res.status)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("下载到的语音是空的");
  writeFileSync(dest, bytes);
  deps.log?.(`[voice] 下载 ${String(bytes.length)}B -> ${dest}`);
  return dest;
}

/**
 * 本机 SAPI 合成（离线兜底）。
 *
 * 为什么需要：edge-tts 要连 `speech.platform.bing.com`，网络不通时一句声音都发不出来。
 * 本机 Windows 自带 SAPI 是离线的，音色差一些，但"一定有声音"比"声音好听"重要。
 * 调用方（装配点）先试 `synthesizeSpeech`，失败再落到这里；两条都失败才降级成文字。
 */
export interface LocalVoiceDeps {
  /** PowerShell 可执行名/路径（默认 `powershell`） */
  readonly powershellExe: string;
  /** tools/voice/tts.ps1 的绝对路径 */
  readonly ttsScript: string;
  /** 合成音频落盘目录（wav） */
  readonly outDir: string;
  readonly now: () => number;
  /** SAPI 音色名；缺省或不存在时脚本会退回第一个中文音色 */
  readonly voice?: string;
  /** 语速 -10..10，默认 0 */
  readonly rate?: number;
  /** 子进程临时目录（沙箱里 %TEMP% 常不可写，显式给一个） */
  readonly tmpDir?: string;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

/** 拼 PowerShell 参数（纯函数，便于测顺序与文件名）。 */
export function localTtsArgs(deps: LocalVoiceDeps, text: string, outFile: string): string[] {
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    deps.ttsScript,
    "-Text",
    text,
    "-Out",
    outFile,
    "-Voice",
    deps.voice ?? "",
    "-Rate",
    String(deps.rate ?? 0),
  ];
}

/** 用本机 SAPI 合成一句语音，返回 wav 路径；空文本直接抛错。 */
export async function synthesizeSpeechLocal(deps: LocalVoiceDeps, text: string): Promise<string> {
  const clean = text.trim();
  if (clean === "") throw new Error("语音文本为空");
  mkdirSync(deps.outDir, { recursive: true });
  SEQ += 1;
  const file = join(deps.outDir, `sapi-${deps.now().toString(36)}-${String(SEQ)}.wav`);
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };
  if (deps.tmpDir !== undefined) {
    env.ACE_TMP = deps.tmpDir;
    env.TMP = deps.tmpDir;
    env.TEMP = deps.tmpDir;
    env.TMPDIR = deps.tmpDir;
  }
  const { stderr } = await run(deps.powershellExe, localTtsArgs(deps, clean, file), {
    env,
    timeout: deps.timeoutMs ?? 60_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const noise = stderr.trim();
  if (noise !== "") deps.log?.(`[voice] sapi stderr: ${noise.slice(0, 200)}`);
  return file;
}
