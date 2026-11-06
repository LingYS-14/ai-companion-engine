/**
 * 语音接线的装配测试（F296）。
 *
 * 这里测的是**环境知识**与**降级链**，不是 TTS 引擎本身：
 *   - 默认值是不是从 env/仓库根/数据目录推出来的（换机器、换解释器时靠它）；
 *   - edge-tts 抛错时会不会退到本机 SAPI（线上这条链以前只靠运气验证）；
 *   - 错误日志只留第一行（整段 python traceback 进日志没人看）；
 *   - 入口脚本不再自己拼这些路径（装配点下沉的锁）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createVoiceWiring } from "../src/assembly/voice-wiring.js";

const REPO = "C:/repo";
const DATA = "C:/data";

function lines(): { lines: string[]; log: (line: string) => void } {
  const out: string[] = [];
  return { lines: out, log: (line) => out.push(line) };
}

describe("语音接线（F296）", () => {
  it("默认路径从仓库根与数据目录推出来", () => {
    const { log } = lines();
    const w = createVoiceWiring({ repo: REPO, dataDir: DATA, log, env: {}, now: () => 1_700_000_000_000 });
    expect(w.voiceDeps.pythonExe).toBe("python");
    expect(w.voiceDeps.pylibsDir).toBe(join(REPO, ".pylibs"));
    expect(w.voiceDeps.asrScript).toBe(join(REPO, "tools", "voice", "asr.py"));
    expect(w.voiceDeps.asrModel).toBe(join(DATA, "whisper-base"));
    expect(w.voiceDeps.outDir).toBe(join(DATA, "voice"));
    expect(w.voiceDeps.tmpDir).toBe(join(REPO, ".tmp"));
    expect(w.localVoiceDeps.powershellExe).toBe("powershell");
    expect(w.localVoiceDeps.ttsScript).toBe(join(REPO, "tools", "voice", "tts.ps1"));
    expect(w.localVoiceDeps.voice).toBe("Microsoft Huihui Desktop");
    expect(w.localVoiceDeps.rate).toBe(0);
  });

  it("环境变量覆盖解释器、PowerShell 与音色", () => {
    const { log } = lines();
    const w = createVoiceWiring({
      repo: REPO,
      dataDir: DATA,
      log,
      env: { ACE_PYTHON: "C:/py/python.exe", ACE_POWERSHELL: "pwsh", ACE_SAPI_VOICE: "Huihui" },
      now: () => 1_700_000_000_000,
    });
    expect(w.voiceDeps.pythonExe).toBe("C:/py/python.exe");
    expect(w.localVoiceDeps.powershellExe).toBe("pwsh");
    expect(w.localVoiceDeps.voice).toBe("Huihui");
  });

  it("edge-tts 成功就不碰本机 SAPI，也不打降级日志", async () => {
    const { lines: logLines, log } = lines();
    let localCalls = 0;
    const w = createVoiceWiring({
      repo: REPO,
      dataDir: DATA,
      log,
      env: {},
      now: () => 1_700_000_000_000,
      synthEdge: async () => "edge.mp3",
      synthLocal: async () => {
        localCalls += 1;
        return "local.wav";
      },
    });
    await expect(w.synthVoice("嗯哼")).resolves.toBe("edge.mp3");
    expect(localCalls).toBe(0);
    expect(logLines.filter((l) => l.includes("edge-tts 不可用"))).toHaveLength(0);
  });

  it("edge-tts 抛错时退到本机 SAPI，日志只留第一行", async () => {
    const { lines: logLines, log } = lines();
    const w = createVoiceWiring({
      repo: REPO,
      dataDir: DATA,
      log,
      env: {},
      now: () => 1_700_000_000_000,
      synthEdge: async () => {
        throw new Error("edge connect timeout\nTraceback (most recent call last): ...");
      },
      synthLocal: async () => "local.wav",
    });
    await expect(w.synthVoice("嗯哼")).resolves.toBe("local.wav");
    const fallback = logLines.find((l) => l.includes("edge-tts 不可用"));
    expect(fallback).toBeDefined();
    expect(fallback).toContain("edge connect timeout");
    expect(fallback).not.toContain("Traceback");
  });

  it("入站：下载后转写，并记「转写 N 字」", async () => {
    const { lines: logLines, log } = lines();
    const w = createVoiceWiring({
      repo: REPO,
      dataDir: DATA,
      log,
      env: {},
      now: () => 1_700_000_000_000,
      fetchVoice: async () => join(DATA, "voice", "in-1"),
      transcribe: async () => "这是一条语音的内容",
    });
    await expect(w.transcribeVoice("http://x/a.amr")).resolves.toBe("这是一条语音的内容");
    expect(logLines.some((l) => l.includes("转写 9 字"))).toBe(true);
  });

  it("入口脚本不再自己拼语音路径（下沉锁）", () => {
    const main = readFileSync(join(process.cwd(), "scripts", "autonomy", "main.mjs"), "utf8");
    expect(main).toContain("createVoiceWiring");
    expect(main).not.toContain("pylibsDir");
    expect(main).not.toContain("asrScript");
    expect(main).not.toContain("synthesizeSpeech(");
  });
});
