import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "autonomy", "health.mjs");
const dirs: string[] = [];

// health.mjs 会硬探 OneBot 端口（默认 3000/3001）；CI/离线环境没有 OneBot，
// 外部依赖一项会判 ✗ 并把退出码拉成 1，导致与 OneBot 无关的断言全红。
// 这里起一个只监听不处理的本地 TCP 服务当作「OneBot 在线」，探测端口用它，
// 这样测试只依赖本进程，不再依赖机器上恰好跑着 NapCat/LLOneBot。
let probeServer: Server | null = null;
let probePort = 0;

beforeAll(async () => {
  probeServer = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => probeServer?.listen(0, "127.0.0.1", resolve));
  const address = probeServer.address();
  if (address !== null && typeof address === "object") probePort = address.port;
  expect(probePort).toBeGreaterThan(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (probeServer === null) resolve();
    else probeServer.close(() => resolve());
  });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-health-"));
  dirs.push(dir);
  return dir;
};

const run = (dataDir: string): { status: number | null; stdout: string } => {
  const res = spawnSync(process.execPath, [script], {
    cwd: repo,
    env: {
      ...process.env,
      ACE_DATA_DIR: dataDir,
      ACE_CHARACTER_ID: "assistant",
      ACE_ONEBOT_PROBE_PORT: String(probePort),
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: String(res.stdout) };
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("自主进程健康检查", () => {

  it("模型调用项给出余量百分比（独立审计 §2.2）", () => {
    const dir = tempDir();
    const now = Date.now();
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(
      join(dir, "autonomy-assistant.beat"),
      JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }),
    );
    writeFileSync(
      join(dir, "autonomy-usage.json"),
      JSON.stringify({ version: 1, calls: [now - 1000, now - 2000, now - 3000] }),
    );
    const out = run(dir);
    // 这里只验「余量」这一项的格式：最小夹具下别的检查会红，退出码不是本用例的被测对象。
    expect(out.stdout).toMatch(/模型调用\/小时：\d+ 次（.+上限 \d+\/h，余量 \d+ 次 \/ \d+%）/);
  });


  it("旧版宿主锁（没有 version）只警告、不影响退出码", () => {
    const dir = tempDir();
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ pid: 999_999, owner: "host", heartbeatAt: now, note: "QQ 桥接待中" }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated" }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 1 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), '{"id":"k1"}\n');
    writeFileSync(join(dir, "memory-assistant.ndjson"), '{"op":"put","record":{"id":"m1"}}\n');
    writeFileSync(join(dir, "autonomy-assistant.log"), "tick\n");

    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 写锁");
    expect(stdout).toContain("旧版锁残留");
    expect(stdout).not.toContain("✗ 写锁");
  });

  it("看不到进程但同 pid 心跳新鲜：只警告，不判死", () => {
    const dir = tempDir();
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: 999_999, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: 999_999, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ version: 2, pid: 999_999, owner: "autonomy", heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated" }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 1 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), JSON.stringify({ id: "k1" }) + String.fromCharCode(10));
    writeFileSync(join(dir, "memory-assistant.ndjson"), JSON.stringify({ op: "put", record: { id: "m1" } }) + String.fromCharCode(10));
    writeFileSync(join(dir, "autonomy-assistant.log"), "tick" + String.fromCharCode(10));

    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 进程");
    expect(stdout).toContain("同 pid 的心跳还新鲜");
  });

  it("空数据目录：进程不在、心跳缺失 → 退出码 1 并说明问题", () => {
    const dir = tempDir();
    const { status, stdout } = run(dir);
    expect(status).toBe(1);
    expect(stdout).toContain("✗ 进程");
    expect(stdout).toContain("✗ 心跳");
    expect(stdout).toContain("项需要处理");
  });

  it("一切正常：进程活着、心跳新鲜、桥已移交 → 退出码 0", () => {
    const dir = tempDir();
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ owner: "autonomy", pid: process.pid, heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated", tools: 23, error: null }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 2 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), '{"id":"k1"}\n');
    writeFileSync(join(dir, "memory-assistant.ndjson"), '{"op":"put","record":{"id":"m1"}}\n');
    writeFileSync(join(dir, "autonomy-assistant.log"), "2026-10-29T00:00:00.000Z [autonomy] tick\n");

    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("✓ 进程");
    expect(stdout).toContain("✓ QQ 桥");
    expect(stdout).toContain("结论：正常");
  });

  it("日志里只有上游 5xx：警告而非故障", () => {
    const dir = tempDir();
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ version: 2, owner: "autonomy", pid: process.pid, heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated", error: null }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 2 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), JSON.stringify({ id: "k1" }) + String.fromCharCode(10));
    writeFileSync(join(dir, "memory-assistant.ndjson"), JSON.stringify({ op: "put", record: { id: "m1" } }) + String.fromCharCode(10));
    writeFileSync(
      join(dir, "autonomy-assistant.log"),
      "2026-10-30T08:25:55.309Z [autonomy] proactive opened=false reason=LLM HTTP 503：" +
        JSON.stringify({ error: { message: "Service is too busy." } }) +
        String.fromCharCode(10),
    );

    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("上游临时错误");
    expect(stdout).not.toContain("✗ 日志异常");
  });
  it("宿主占着写锁（桥没移交）→ 报错", () => {
    const dir = tempDir();
    const now = Date.now();
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ version: 2, owner: "host", pid: 1, heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "listening", error: null }));

    const { status, stdout } = run(dir);
    expect(status).toBe(1);
    expect(stdout).toContain("✗ 写锁");
    expect(stdout).toContain("host");
  });
});

describe("health 的「开口」软提示（8.6b）", () => {
  const healthy = (dir: string): void => {
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ version: 2, owner: "autonomy", pid: process.pid, heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated", error: null }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 2 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), "{\"id\":\"k1\"}\n");
    writeFileSync(join(dir, "memory-assistant.ndjson"), "{\"op\":\"put\",\"record\":{\"id\":\"m1\"}}\n");
    writeFileSync(join(dir, "autonomy-assistant.log"), "2026-10-31T00:00:00.000Z [autonomy] tick\n");
  };

  const shadow = (dir: string, rows: readonly unknown[]): void => {
    writeFileSync(
      join(dir, "intent-live-shadow-assistant.ndjson"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
  };

  it("刚刚想开口过：✓ 开口，写明口径不是发送数", () => {
    const dir = tempDir();
    healthy(dir);
    const now = Date.now();
    shadow(dir, [
      { at: now - 20 * 60_000, gate: "quota", wouldSpeak: false, outlet: { target: "idle" } },
      { at: now - 5 * 60_000, gate: "speak", wouldSpeak: false, outlet: { target: "speak", kind: "reach_out" } },
    ]);
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("✓ 开口");
    expect(stdout).toContain("上次想开口在 5 分钟前");
    expect(stdout).toContain("24 小时内想开口 1 次");
    expect(stdout).toContain("不是实际发送数");
    expect(stdout).toContain("最近一拍 gate=speak");
  });

  it("只在 8 小时前想开口过：⚠ 提示但不影响退出码", () => {
    const dir = tempDir();
    healthy(dir);
    const now = Date.now();
    shadow(dir, [{ at: now - 9 * 60 * 60_000, gate: "speak", wouldSpeak: true, outlet: { target: "speak" } }]);
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 开口");
    expect(stdout).toContain("上次想开口在 540 分钟前");
  });

  it("有拍但一次都不想开口：⚠ 说清是「判定口径」而不是坏了", () => {
    const dir = tempDir();
    healthy(dir);
    const now = Date.now();
    shadow(dir, [
      { at: now - 60_000, gate: "quota", wouldSpeak: false, outlet: { target: "idle" } },
      { at: now - 120_000, gate: "quota", wouldSpeak: false, outlet: { target: "journal" } },
    ]);
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 开口");
    expect(stdout).toContain("最近 24 小时没有一次开口倾向");
    expect(stdout).toContain("安静不等于坏了");
  });

  it("连拍记录都没有：说「还没有拍记录」，并仍只是提示", () => {
    const dir = tempDir();
    healthy(dir);
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 开口");
    expect(stdout).toContain("还没有拍记录");
    expect(stdout).not.toContain("✗ 开口");
  });
});

describe("health 的「对外通道」熔断（8.6c，F267）", () => {
  const healthyDir = (dir: string): void => {
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ version: 2, owner: "autonomy", pid: process.pid, heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated", error: null }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 2 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), "{\"id\":\"k1\"}\n");
    writeFileSync(join(dir, "memory-assistant.ndjson"), "{\"op\":\"put\",\"record\":{\"id\":\"m1\"}}\n");
    writeFileSync(join(dir, "autonomy-assistant.log"), "2026-10-31T00:00:00.000Z [autonomy] tick\n");
  };

  it("没有快照：说「还没有熔断记录」，不影响退出码", () => {
    const dir = tempDir();
    healthyDir(dir);
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("对外通道");
    expect(stdout).toContain("还没有熔断记录");
  });

  it("快照是熔断中：⚠ 并写明到几点、连续失败几次（仍不判失败）", () => {
    const dir = tempDir();
    healthyDir(dir);
    const now = Date.now();
    writeFileSync(
      join(dir, "spine-assistant.json"),
      JSON.stringify({
        version: 1,
        atMs: now,
        state: "open",
        failures: 3,
        openUntilMs: now + 9 * 60_000,
        probeAtMs: null,
        threshold: 3,
        cooldownMs: 10 * 60_000,
      }),
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 对外通道");
    expect(stdout).toContain("熔断中");
    expect(stdout).toContain("连续失败 3 次");
  });

  it("快照是 open 但冷却期已过：显示半开（等下一次探针），不再报 ⚠ 熔断中（task-162）", () => {
    const dir = tempDir();
    healthyDir(dir);
    const now = Date.now();
    writeFileSync(
      join(dir, "spine-assistant.json"),
      JSON.stringify({
        version: 1,
        atMs: now - 3 * 60 * 60_000,
        state: "open",
        failures: 37,
        openUntilMs: now - 2 * 60 * 60_000,
        probeAtMs: null,
        threshold: 3,
        cooldownMs: 10 * 60_000,
      }),
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("半开");
    expect(stdout).toContain("冷却期已过");
    expect(stdout).not.toContain("⚠ 对外通道");
    expect(stdout).not.toContain("熔断中：");
  });

  it("快照是 half-open：显示半开，不报 ⚠", () => {
    const dir = tempDir();
    healthyDir(dir);
    const now = Date.now();
    writeFileSync(
      join(dir, "spine-assistant.json"),
      JSON.stringify({
        version: 1,
        atMs: now,
        state: "half-open",
        failures: 3,
        openUntilMs: now - 60_000,
        probeAtMs: null,
        threshold: 3,
        cooldownMs: 10 * 60_000,
      }),
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("半开（熔断冷却已过，等下一次发送探针");
    expect(stdout).not.toContain("⚠ 对外通道");
  });

  it("快照坏了：按「还没有熔断记录」处理，不猜是闭合", () => {
    const dir = tempDir();
    healthyDir(dir);
    writeFileSync(join(dir, "spine-assistant.json"), "{ not json");
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("还没有熔断记录");
    expect(stdout).not.toContain("闭合");
  });
});

describe("health 的「状态写入」仲裁（8.6d，F258/F272）", () => {
  const baseDir = (dir: string): void => {
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ version: 2, owner: "autonomy", pid: process.pid, heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated", error: null }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 2 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), "{\"id\":\"k1\"}\n");
    writeFileSync(join(dir, "memory-assistant.ndjson"), "{\"op\":\"put\",\"record\":{\"id\":\"m1\"}}\n");
    writeFileSync(join(dir, "autonomy-assistant.log"), "2026-10-31T00:00:00.000Z [autonomy] tick\n");
  };

  it("没有 [state] 记录：说「次要写者没在写状态」，不影响退出码", () => {
    const dir = tempDir();
    baseDir(dir);
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("状态写入");
    expect(stdout).toContain("没有拒绝覆盖");
  });

  it("出现拒绝覆盖：⚠ 且指出「插件还在试图写」", () => {
    const dir = tempDir();
    baseDir(dir);
    const at = new Date().toISOString();
    writeFileSync(
      join(dir, "autonomy-assistant.log"),
      `2026-10-31T00:00:00.000Z [autonomy] tick\n${at} [state] 次要写者拒绝覆盖（磁盘上的状态被别的进程改过）\n`,
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 状态写入");
    expect(stdout).toContain("1 次拒绝覆盖");
  });

  it("只有主写者覆盖警告：也算需要看一眼（不判失败）", () => {
    const dir = tempDir();
    baseDir(dir);
    const at = new Date().toISOString();
    writeFileSync(
      join(dir, "autonomy-assistant.log"),
      `${at} [state] overwrite-warning：磁盘上的版本被别的进程改过（current=2，本进程上次看到=1）\n`,
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 状态写入");
    expect(stdout).toContain("1 次主写者覆盖警告");
  });
});

describe("health 的「写通道」与监护人回执配对（8.6e / F290）", () => {
  const base = (dir: string): void => {
    const now = Date.now();
    mkdirSync(join(dir, "execution"), { recursive: true });
    writeFileSync(join(dir, "autonomy-assistant.pid"), JSON.stringify({ pid: process.pid, startedAt: now }));
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: now, ran: ["tick"] }));
    writeFileSync(join(dir, ".writer-lock"), JSON.stringify({ version: 2, owner: "autonomy", pid: process.pid, heartbeatAt: now }));
    writeFileSync(join(dir, "apply-report.json"), JSON.stringify({ onebot: "delegated", error: null }));
    writeFileSync(join(dir, "autonomy-usage.json"), JSON.stringify({ version: 1, calls: [] }));
    writeFileSync(join(dir, "autonomy-learn-assistant.json"), JSON.stringify({ rotation: 2 }));
    writeFileSync(join(dir, "knowledge-assistant.ndjson"), '{"id":"k1"}\n');
    writeFileSync(join(dir, "memory-assistant.ndjson"), '{"op":"put","record":{"id":"m1"}}\n');
    writeFileSync(join(dir, "autonomy-assistant.log"), "2026-10-31T00:00:00.000Z [autonomy] tick\n");
  };

  it("写通道文件缺失：⚠ 说清插件写操作会失败，不影响退出码", () => {
    const dir = tempDir();
    base(dir);
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 写通道");
    expect(stdout).toContain("没有通道文件");
  });

  it("写通道属于别的 pid：⚠ 点明可能双实例或旧文件", () => {
    const dir = tempDir();
    base(dir);
    writeFileSync(
      join(dir, "write-channel-assistant.json"),
      JSON.stringify({ version: 1, port: 12345, token: "t".repeat(24), pid: 999_999 }),
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("⚠ 写通道");
    expect(stdout).toContain("通道属于 pid 999999");
  });

  it("写通道与当前进程一致：✓ 并给出地址", () => {
    const dir = tempDir();
    base(dir);
    writeFileSync(
      join(dir, "write-channel-assistant.json"),
      JSON.stringify({ version: 1, port: 51234, token: "t".repeat(24), pid: process.pid }),
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("✓ 写通道");
    expect(stdout).toContain("127.0.0.1:51234");
  });

  it("监护人回执按内容里的 requestId 配对（F269 改了文件名，也能认出已答）", () => {
    const dir = tempDir();
    base(dir);
    const at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    writeFileSync(
      join(dir, "guardian-assistant.ndjson"),
      JSON.stringify({ requestId: "grd-itn-1-123", at, intentionId: "itn-1", what: "想问", tried: ["a"], need: "knowledge", ask: "帮我", timeoutMs: 7_200_000 }) + "\n",
    );
    mkdirSync(join(dir, "guardian-reply"), { recursive: true });
    // F269：文件名是安全 id + hash，不是 requestId 本身
    writeFileSync(
      join(dir, "guardian-reply", "grd-itn-1-123-1a2b3c4d.json"),
      JSON.stringify({ requestId: "grd-itn-1-123", by: "lead", at, verdict: "answered", answer: "在" }),
    );
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("✓ 监护人收件箱");
    expect(stdout).toContain("全部已有应答");
  });
});
