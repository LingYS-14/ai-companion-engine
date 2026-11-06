/** 语音工具的边界：离线可测的部分（文件落盘、ASR 输出解析、失败路径）。 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchVoiceFile, localTtsArgs, synthesizeSpeech, synthesizeSpeechLocal, transcribeAudio, type VoiceToolDeps } from "../src/qq/voice.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-voice-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const deps = (outDir: string): VoiceToolDeps => ({ pythonExe: "python", pylibsDir: "x", asrScript: "y", asrModel: "z", outDir, now: () => 1 });

describe("fetchVoiceFile", () => {
  it("本地路径原样返回，不发起网络请求", async () => {
    const out = await fetchVoiceFile(deps(tmp()), "C:/already/local.amr", () => {
      throw new Error("不该发请求");
    });
    expect(out).toBe("C:/already/local.amr");
  });

  it("file:// 转成裸路径（ffmpeg 不认 URL）", async () => {
    const out = await fetchVoiceFile(deps(tmp()), "file:///X:/tmp/x%20y.amr", () => {
      throw new Error("不该发请求");
    });
    expect(out.startsWith("/") || /^[A-Za-z]:/.test(out)).toBe(true);
    expect(out).toContain("x y.amr");
  });

  it("http 下载后落盘，字节完整", async () => {
    const outDir = tmp();
    const body = Buffer.from("RIFFfake");
    const got = await fetchVoiceFile(deps(outDir), "https://example.test/v.amr", async () =>
      new Response(body, { status: 200 }),
    );
    expect(readFileSync(got)).toEqual(body);
    expect(got.startsWith(outDir)).toBe(true);
  });

  it("非 2xx 抛错（调用方降级成「没听清」）", async () => {
    await expect(
      fetchVoiceFile(deps(tmp()), "https://example.test/v.amr", async () => new Response("no", { status: 500 })),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("transcribeAudio", () => {
  it("取 stdout 最后一行的 JSON text", async () => {
    const dir = tmp();
    const script = join(dir, "asr.mjs");
    // 用字符拼接避免在测试源码里嵌转义（heredoc + TS 两层转义很容易写错）
    const NL = String.fromCharCode(10);
    const body = ["const NL = String.fromCharCode(10);", 'process.stdout.write("debug" + NL);', 'process.stdout.write(JSON.stringify({ text: " 你好 " }) + NL);'].join(NL);
    writeFileSync(script, body + NL);
    const text = await transcribeAudio({ ...deps(dir), pythonExe: process.execPath, asrScript: script }, "a.wav");
    expect(text).toBe("你好");
  });

  it("解释器不存在时 reject（不吞错）", async () => {
    await expect(
      transcribeAudio({ ...deps(tmp()), pythonExe: "definitely-not-a-python-exe", asrScript: "x.py" }, "a.wav"),
    ).rejects.toThrow();
  });
});

describe("synthesizeSpeech", () => {
  it("空文本直接抛错，不启动子进程", async () => {
    await expect(synthesizeSpeech({ ...deps(tmp()), pythonExe: "definitely-not-a-python-exe" }, "   ")).rejects.toThrow(
      /语音文本为空/,
    );
  });
});

describe("本机 SAPI 兜底", () => {
  const localDeps = (outDir: string) => ({
    powershellExe: "powershell",
    ttsScript: "C:/x/tts.ps1",
    outDir,
    now: () => 7,
    voice: "Microsoft Huihui Desktop",
    rate: 0,
  });

  it("参数顺序稳定（-File 指向脚本、-Text/-Out 成对出现）", () => {
    const args = localTtsArgs(localDeps(tmp()), "在呢", "C:/x/a.wav");
    expect(args.slice(0, 5)).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/x/tts.ps1"]);
    const iText = args.indexOf("-Text");
    const iOut = args.indexOf("-Out");
    expect(args[iText + 1]).toBe("在呢");
    expect(args[iOut + 1]).toBe("C:/x/a.wav");
    expect(args[args.indexOf("-Voice") + 1]).toBe("Microsoft Huihui Desktop");
  });

  it("空文本直接抛错（发出去也只是空气泡）", async () => {
    await expect(synthesizeSpeechLocal(localDeps(tmp()), "   ")).rejects.toThrow(/为空/);
  });

  it("可执行文件不存在时抛错（由装配点降级成文字）", async () => {
    await expect(
      synthesizeSpeechLocal({ ...localDeps(tmp()), powershellExe: "definitely-not-a-real-exe-xyz" }, "在呢"),
    ).rejects.toThrow();
  });
});
