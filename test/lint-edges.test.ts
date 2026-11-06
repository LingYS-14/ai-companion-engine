import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 分层边界门禁（tools/lint/edges.mjs）的测试。
 *
 * 这个脚本是 .mjs 且顶层会 main()，所以不能直接 `import` 它的默认行为；
 * 两条路都测：
 *   ① 子进程：execFileSync 跑 `node tools/lint/edges.mjs --json`（基线态 / 临时夹具 / 棘轮）
 *   ② 纯函数：脚本导出了 judge(edges, cfg)，直接在进程内验证四条规则
 *
 * 临时夹具不碰真实 src：`--root <dir>` 只认该目录下的 spec/config/layers.json 与 src。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "tools", "lint", "edges.mjs");
const BASELINE = join(ROOT, "spec", "config", "edge-baseline.json");
const TEXT_BASELINE = join(ROOT, "spec", "config", "layers-text-baseline.json");

interface Violation {
  rule: string;
  file: string;
  line: number;
  target: string;
  fromLayer: string;
  toLayer: string;
}
interface JudgeOutput {
  ok: boolean;
  files: number;
  /** 批次 3 · D4：扫描面拆成 src 与额外根（scripts），便于看清"主装配点在不在扫" */
  srcFiles?: number;
  extraFiles?: number;
  /** 归不了层的文件（审计 A.1：原来它们被静默丢弃，现在要点名） */
  unmappedFiles?: string[];
  /** R4 文本规则（D8）：装配点里的工具定义 / HTTP / HTML，按棘轮基线冻结 */
  textDebt?: { kept: Violation[]; suppressed: Violation[] };
  edges: number;
  violations: Violation[];
  suppressed: Violation[];
}
interface Edge {
  file: string;
  line: number;
  target: string;
  fromLayer: string;
  toLayer: string;
  toPublic?: boolean;
}
interface LayersCfg {
  srcRoot: string;
  layers: Record<string, string[]>;
  assembly: string[];
  brainPublicPrefixes: string[];
  rules: Record<string, Record<string, unknown>>;
  /** 批次 3 · D4：额外扫描根（scripts 等），归为 scripts 层、不参与 R1–R3 */
  extraRoots?: string[];
  /** 批次 3 · D8：装配点文本规则（禁工具定义 / HTTP / HTML） */
  textRules?: Array<{ id: string; title?: string; patterns: Array<{ label: string; regex: string }> }>;
}

/** 跑 CLI；非 0 退出码不抛，统一返回 {status, stdout, stderr} */
function runCli(args: string[], cwd: string = ROOT): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/** 夹具用的层配置（目录名简化：brain / spine / tools 各一个目录） */
const FIXTURE_CFG: LayersCfg = {
  srcRoot: "src",
  layers: {
    brain: ["brain"],
    spine: ["spine"],
    tools: ["tools"],
  },
  assembly: ["src/assembly.ts"],
  brainPublicPrefixes: ["src/ports/"],
  rules: {
    R1: { kind: "forbidden-target-layer", from: "brain", to: ["spine", "tools"] },
    R2: { kind: "forbidden-target-layer", from: "spine", to: ["tools"] },
    R3: {
      kind: "forbidden-target-layer",
      from: "tools",
      to: ["brain"],
      allowTargetPrefixes: ["brainPublicPrefixes"],
    },
    R4: { kind: "forbidden-multi-layer", layers: ["brain", "spine"] },
  },
};

/** 在临时目录里造一个最小项目：spec/config/layers.json + 给定源码文件 */
function makeProject(files: Record<string, string>, cfg: LayersCfg = FIXTURE_CFG): string {
  const dir = mkdtempSync(join(tmpdir(), "edges-lint-"));
  mkdirSync(join(dir, "spec", "config"), { recursive: true });
  writeFileSync(join(dir, "spec", "config", "layers.json"), JSON.stringify(cfg, null, 2), "utf8");
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
  // 装配点存在性校验（F228）：夹具若在 layers.json 里列了 assembly 却没给文件，补一个空的，
  // 避免"幽灵装配点"校验把与它无关的门禁用例也拖红。
  for (const rel of cfg.assembly) {
    if (files[rel] !== undefined) continue;
    const abs = join(dir, rel);
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "export {};\n", "utf8");
  }
  return dir;
}

/** 造一个最小项目夹具：brain→tools 违规 1 条，assembly 同时 import 三层合法 */
function makeFixture(): string {
  return makeProject({
    // 违规：大脑 import 工具层（R1）
    "src/brain/a.ts": `import { t } from "../tools/t.js";

export const a = t;
`,
    "src/tools/t.ts": `export const t = 1;
`,
    "src/spine/s.ts": `export const s = 2;
`,
    // 装配点：同时 import 三层是合法的
    "src/assembly.ts": `import { a } from "./brain/a.js";
import { s } from "./spine/s.js";
import { t } from "./tools/t.js";

export const ready = a + s + t;
`,
  });
}

describe("edges lint（子进程 · 真实项目）", () => {
  it("基线态：当前 src 没有未抑制违规，退出码 0，且基线条目数对得上", () => {
    const r = runCli(["--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as JudgeOutput;
    expect(out.ok).toBe(true);
    expect(out.violations).toEqual([]);
    expect(out.files).toBeGreaterThanOrEqual(100);
    expect(out.edges).toBeGreaterThan(0);

    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { count: number; entries: Violation[] };
    // 基线只许减：现状命中数不能超过基线条目数（修好后基线会变"陈旧"，等 --update-baseline 收紧）
    expect(baseline.entries.length).toBe(baseline.count);
    expect(out.suppressed.length).toBeLessThanOrEqual(baseline.entries.length);
  });

  it("装配点名单没有幽灵：assembly 里每个路径都真实存在", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "spec", "config", "layers.json"), "utf8")) as {
      assembly: string[];
    };
    const missing = cfg.assembly.filter((rel) => !existsSync(join(ROOT, rel)));
    expect(missing).toEqual([]);
    expect(cfg.assembly.length).toBeGreaterThanOrEqual(5);
  });

  it("真实仓库：额外扫描根生效，主装配点 scripts/autonomy/main.mjs 进了扫描面（批次 3 · D4）", () => {
    const r = runCli(["--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as JudgeOutput;
    // 额外根（scripts）里的文件确实被扫了：否则常驻进程入口的 import 边会全部消失
    expect(out.srcFiles).toBeGreaterThanOrEqual(100);
    expect(out.extraFiles).toBeGreaterThanOrEqual(1);
    expect(out.files).toBe((out.srcFiles ?? 0) + (out.extraFiles ?? 0));
    expect(out.unmappedFiles).toEqual([]);
    const cfg = JSON.parse(readFileSync(join(ROOT, "spec", "config", "layers.json"), "utf8")) as {
      extraRoots?: string[];
      assembly: string[];
    };
    expect(cfg.extraRoots).toContain("scripts");
    expect(cfg.assembly).toContain("scripts/autonomy/main.mjs");
  });

  it("未归层文件会被点名并判失败，而不是静默丢弃（审计 A.1 / 批次 3 收紧）", () => {
    const cfg: LayersCfg = { ...FIXTURE_CFG, extraRoots: ["scripts"] } as LayersCfg & { extraRoots: string[] };
    const dir = makeProject(
      {
        "src/brain/a.ts": `export const a = 1;
`,
        "src/loose/orphan.ts": `import { a } from "../brain/a.js";

export const orphan = a;
`,
      },
      cfg,
    );
    try {
      const r = runCli(["--root", dir]);
      // 批次 3 收紧：归不了层 = 它的边不在任何规则覆盖内，必须失败而不是告警。
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("✗ 未归层文件 1 个");
      expect(r.stdout).toContain("src/loose/orphan.ts");
      expect(r.stdout).toContain("分层门禁失败");
      const json = JSON.parse(runCli(["--root", dir, "--json"]).stdout) as JudgeOutput;
      expect(json.unmappedFiles).toContain("src/loose/orphan.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

  it("真实仓库：R4 文本规则已生效，存量业务痕迹冻结在棘轮基线（等于基线、新增即红）", () => {
    const r = runCli(["--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as JudgeOutput;
    expect(out.textDebt).toBeDefined();
    // 新写的工具定义 / HTTP / 大脑判定调用会在下面的用例里被抓住；这里只保证现状 = 基线。
    expect(out.textDebt?.kept).toEqual([]);
    const baseline = JSON.parse(readFileSync(TEXT_BASELINE, "utf8")) as { count: number; entries: Violation[] };
    expect(baseline.entries.length).toBe(baseline.count);
    expect(baseline.entries.length).toBeGreaterThan(0); // P1-H 冻结的存量（R4-business）
    const suppressed = out.textDebt?.suppressed ?? [];
    // 棘轮：现状命中数必须正好等于基线条目数（多 = 新债被漏放；少 = 基线该收紧）
    expect(suppressed.length).toBe(baseline.entries.length);
    for (const debt of suppressed) {
      expect(baseline.entries).toContainEqual(
        expect.objectContaining({ rule: debt.rule, file: debt.file, target: debt.target }),
      );
    }
    const cfg = JSON.parse(readFileSync(join(ROOT, "spec", "config", "layers.json"), "utf8")) as {
      textRules?: Array<{ id: string; patterns: unknown[] }>;
    };
    expect(Array.isArray(cfg.textRules)).toBe(true);
    const ids = (cfg.textRules ?? []).map((rule) => rule.id);
    expect(ids).toContain("R4-text");
    // P1-H：装配点不许长新的业务判断（大脑判定函数调用）
    expect(ids).toContain("R4-business");
  });

  it("R4 文本规则：装配点里新写的 HTTP/工具定义会让门禁红（D8）", () => {
    const cfg: LayersCfg = {
      ...FIXTURE_CFG,
      textRules: [
        {
          id: "R4-text",
          patterns: [
            { label: "http-response", regex: String.raw`\bres\.end\s*\(` },
            { label: "tool-definition", regex: String.raw`\bname:\s*"soul_[a-z_]+` },
          ],
        },
      ],
    };
    const dir = makeProject(
      {
        "src/assembly.ts": `export function route(res: { end: (v: string) => void }) {
  res.end("ok");
}
export const tool = { name: "soul_demo" };
`,
        "src/tools/t.ts": `export const t = 1;
`,
      },
      cfg,
    );
    try {
      const r = runCli(["--root", dir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("R4 文本规则未通过");
      expect(r.stdout).toContain("src/assembly.ts:2");
      expect(r.stdout).toContain("http-response");
      expect(r.stdout).toContain("tool-definition");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R4 文本规则：非装配点文件不受限（工具层自己写 HTTP/工具定义不算装配点越界）", () => {
    const cfg: LayersCfg = {
      ...FIXTURE_CFG,
      textRules: [{ id: "R4-text", patterns: [{ label: "http-response", regex: String.raw`\bres\.end\s*\(` }] }],
    };
    const dir = makeProject(
      {
        "src/tools/t.ts": `export function route(res: { end: (v: string) => void }) {
  res.end("ok");
}
`,
        "src/assembly.ts": `export const ready = 1;
`,
      },
      cfg,
    );
    try {
      const out = JSON.parse(runCli(["--root", dir, "--json"]).stdout) as JudgeOutput;
      expect(out.textDebt?.kept).toEqual([]);
      expect(out.textDebt?.suppressed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R4-business：装配点名册里的文件出现大脑判定函数调用会被抓（P1-H）", () => {
    const cfg: LayersCfg = {
      ...FIXTURE_CFG,
      textRules: [
        { id: "R4-business", patterns: [{ label: "outlet-decision", regex: String.raw`\bchooseIntentOutlet\s*\(` }] },
      ],
    };
    const dir = makeProject(
      {
        // 装配点：把"该走哪个出口"的判定函数直接摆在接线代码里
        "src/assembly.ts": `export function wire(decision: unknown) {
  return chooseIntentOutlet(decision);
}
`,
        "src/brain/a.ts": `export const a = 1;
`,
      },
      cfg,
    );
    try {
      const r = runCli(["--root", dir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("R4 文本规则未通过");
      expect(r.stdout).toContain("src/assembly.ts:2");
      expect(r.stdout).toContain("outlet-decision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R4-business：非装配点文件出现同样的判定调用不抓（只扫装配点名册，不扫目录）", () => {
    const cfg: LayersCfg = {
      ...FIXTURE_CFG,
      textRules: [
        { id: "R4-business", patterns: [{ label: "outlet-decision", regex: String.raw`\bchooseIntentOutlet\s*\(` }] },
      ],
    };
    const dir = makeProject(
      {
        // 大脑/工具层自己调用判定函数是本职，不该被装配点规则误伤
        "src/tools/t.ts": `export function wire(decision: unknown) {
  return chooseIntentOutlet(decision);
}
`,
        "src/assembly.ts": `export const ready = 1;
`,
      },
      cfg,
    );
    try {
      const out = JSON.parse(runCli(["--root", dir, "--json"]).stdout) as JudgeOutput;
      expect(out.textDebt?.kept).toEqual([]);
      expect(out.textDebt?.suppressed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R4 文本债务是棘轮：基线里的旧债放行，新增的债拒绝（--update-text-baseline 退出码 2）", () => {
    const cfg: LayersCfg = {
      ...FIXTURE_CFG,
      textRules: [{ id: "R4-text", patterns: [{ label: "http-response", regex: String.raw`\bres\.end\s*\(` }] }],
    };
    const dir = makeProject(
      {
        "src/assembly.ts": `export function route(res: { end: (v: string) => void }) {
  res.end("old debt");
}
`,
      },
      cfg,
    );
    const baselinePath = join(dir, "spec", "config", "layers-text-baseline.json");
    writeFileSync(
      baselinePath,
      JSON.stringify({
        count: 1,
        entries: [{ rule: "R4-text", file: "src/assembly.ts", line: 2, target: "http-response" }],
      }),
      "utf8",
    );
    try {
      // 旧债在基线里：通过
      const ok = runCli(["--root", dir]);
      expect(ok.status).toBe(0);
      // 新增一条债：门禁红
      writeFileSync(
        join(dir, "src", "assembly.ts"),
        `export function route(res: { end: (v: string) => void }) {
  res.end("old debt");
}
export const extra = (res: { end: (v: string) => void }) => res.end("new debt");
`,
        "utf8",
      );
      const bad = runCli(["--root", dir]);
      expect(bad.status).toBe(1);
      // 想靠重写基线放行新增项：拒绝
      const upd = runCli(["--root", dir, "--update-text-baseline"]);
      expect(upd.status).toBe(2);
      expect(upd.stderr).toContain("只许减不许增");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

describe("edges lint（子进程 · 临时夹具）", () => {
  it("额外扫描根 + dist→src 映射：scripts 入口 import 构建产物时，边不会被吞掉（批次 3 · D4）", () => {
    const cfg = { ...FIXTURE_CFG, extraRoots: ["scripts"], assembly: ["scripts/main.mjs"] } as LayersCfg & {
      extraRoots: string[];
    };
    const dir = makeProject(
      {
        "src/brain/a.ts": `export const a = 1;
`,
        "scripts/main.mjs": `import { a } from "../dist/brain/a.js";

console.log(a);
`,
      },
      cfg,
    );
    try {
      const r = runCli(["--root", dir, "--json"]);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as JudgeOutput;
      expect(out.ok).toBe(true);
      expect(out.extraFiles).toBe(1);
      // 195：dist/brain/a.js → src/brain/a.ts 被解析成内部分层边（assembly→brain，合法但可见）
      expect(out.edges).toBe(1);
      expect(out.violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("额外根里的非装配文件归为 scripts：有边但不参与 R1–R3 判定", () => {
    const cfg = { ...FIXTURE_CFG, extraRoots: ["scripts"] } as LayersCfg & { extraRoots: string[] };
    const dir = makeProject(
      {
        "src/brain/a.ts": `export const a = 1;
`,
        "src/tools/t.ts": `export const t = 1;
`,
        // 运维脚本 import 大脑内部（脚本不受三层规则约束，但边必须可见）
        "scripts/ops.mjs": `import { a } from "../dist/brain/a.js";

console.log(a);
`,
      },
      cfg,
    );
    try {
      const out = JSON.parse(runCli(["--root", dir, "--json"]).stdout) as JudgeOutput;
      expect(out.edges).toBe(1);
      expect(out.violations).toEqual([]);
      expect(out.unmappedFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("抓到 brain→tools 的 R1 违规，装配点同时 import 三层不报", () => {
    const dir = makeFixture();
    try {
      const r = runCli(["--root", dir, "--json"]);
      expect(r.status).toBe(1);
      const out = JSON.parse(r.stdout) as JudgeOutput;
      expect(out.ok).toBe(false);
      expect(out.violations).toHaveLength(1);
      expect(out.violations[0]).toMatchObject({
        rule: "R1",
        file: "src/brain/a.ts",
        line: 1,
        target: "src/tools/t.ts",
        fromLayer: "brain",
        toLayer: "tools",
      });
      expect(out.suppressed).toEqual([]);
      expect(out.files).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("装配点写了不存在的文件：整道门禁失败，不数幽灵特权", () => {
    // 夹具故意不创建 src/assembly.ts（FIXTURE_CFG 里列了它）
    const dir = makeProject({
      "src/brain/a.ts": `export const a = 1;
`,
    });
    // makeProject 会替夹具补空的装配点文件；这里删掉它，专门验"幽灵装配点"。
    rmSync(join(dir, "src", "assembly.ts"), { force: true });
    try {
      const r = runCli(["--root", dir]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("装配点不存在");
      expect(r.stderr).toContain("src/assembly.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("export ... from 与动态 import() 也算跨层边（工具层 → 大脑）", () => {
    const dir = makeProject({
      "src/brain/state.ts": `export const state = 1;
`,
      "src/tools/re-export.ts": `export * from "../brain/state.js";
`,
      "src/tools/lazy.ts": `export async function load() {
  const m = await import("../brain/state.js");
  return m.state;
}
`,
    });
    try {
      const r = runCli(["--root", dir, "--json"]);
      expect(r.status).toBe(1);
      const out = JSON.parse(r.stdout) as JudgeOutput;
      expect(out.violations).toHaveLength(2);
      expect(out.violations[0]).toMatchObject({
        rule: "R3",
        file: "src/tools/lazy.ts",
        line: 2,
        target: "src/brain/state.ts",
      });
      expect(out.violations[1]).toMatchObject({
        rule: "R3",
        file: "src/tools/re-export.ts",
        line: 1,
        target: "src/brain/state.ts",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("src/ports/ 公共接口：工具层/脊髓层 import 放行，不算 R3/R4 违规", () => {
    const dir = makeProject({
      "src/ports/brain-port.ts": `export interface BrainPort {
  value: number;
}
`,
      "src/tools/bridge.ts": `import type { BrainPort } from "../ports/brain-port.js";

export const read = (p: BrainPort) => p.value;
`,
      "src/spine/runner.ts": `import type { BrainPort } from "../ports/brain-port.js";

export const run = (p: BrainPort) => p.value;
`,
    });
    try {
      const r = runCli(["--root", dir, "--json"]);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as JudgeOutput;
      expect(out.ok).toBe(true);
      expect(out.violations).toEqual([]);
      expect(out.suppressed).toEqual([]);
      expect(out.edges).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("棘轮：出现新增违规时 --update-baseline 退出码 2，且不写基线", () => {
    const dir = makeFixture();
    const baselinePath = join(dir, "spec", "config", "edge-baseline.json");
    try {
      writeFileSync(baselinePath, JSON.stringify({ count: 0, entries: [] }, null, 2), "utf8");
      const before = readFileSync(baselinePath, "utf8");
      const r = runCli(["--root", dir, "--update-baseline"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("基线只许减");
      expect(readFileSync(baselinePath, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("棘轮：没有新增项时 --update-baseline 允许收紧（只减不增）", () => {
    const dir = makeFixture();
    const baselinePath = join(dir, "spec", "config", "edge-baseline.json");
    try {
      // 基线里多冻结了一条已经修好的旧账（src/ghost/z.ts 不存在了）
      writeFileSync(
        baselinePath,
        JSON.stringify(
          {
            count: 2,
            entries: [
              { rule: "R1", file: "src/brain/a.ts", line: 1, target: "src/tools/t.ts" },
              { rule: "R2", file: "src/ghost/z.ts", line: 9, target: "src/tools/t.ts" },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
      const r = runCli(["--root", dir, "--update-baseline"]);
      expect(r.status).toBe(0);
      const after = JSON.parse(readFileSync(baselinePath, "utf8")) as { count: number; entries: Violation[] };
      expect(after.count).toBe(1);
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0]).toMatchObject({ rule: "R1", file: "src/brain/a.ts", target: "src/tools/t.ts" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("层配置非法时整道门禁失败（退出码 1），不会静默放行", () => {
    const dir = mkdtempSync(join(tmpdir(), "edges-lint-bad-"));
    try {
      mkdirSync(join(dir, "spec", "config"), { recursive: true });
      writeFileSync(join(dir, "spec", "config", "layers.json"), '{ "layers": { "brain": [] } }', "utf8");
      const r = runCli(["--root", dir, "--json"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("layers.brain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("judge(edges, cfg) 纯函数", () => {
  const CFG: LayersCfg = {
    srcRoot: "src",
    layers: { brain: ["engine"], spine: ["autonomy"], tools: ["qq"] },
    assembly: ["src/plugin/index.ts"],
    brainPublicPrefixes: ["src/ports/"],
    rules: {
      R1: { kind: "forbidden-target-layer", from: "brain", to: ["spine", "tools"] },
      R2: { kind: "forbidden-target-layer", from: "spine", to: ["tools"] },
      R3: {
        kind: "forbidden-target-layer",
        from: "tools",
        to: ["brain"],
        allowTargetPrefixes: ["brainPublicPrefixes"],
      },
      R4: { kind: "forbidden-multi-layer", layers: ["brain", "spine"] },
    },
  };

  async function loadJudge(): Promise<(edges: Edge[], cfg: unknown) => Violation[]> {
    const mod = (await import(pathToFileURL(SCRIPT).href)) as {
      judge: (edges: Edge[], cfg: unknown) => Violation[];
    };
    return mod.judge;
  }

  it("R1：大脑 import 工具层 → 违规；同层/白名单不报", async () => {
    const judge = await loadJudge();
    const edges: Edge[] = [
      { file: "src/engine/a.ts", line: 3, target: "src/qq/tool.ts", fromLayer: "brain", toLayer: "tools" },
      { file: "src/engine/a.ts", line: 4, target: "src/engine/b.ts", fromLayer: "brain", toLayer: "brain" },
    ];
    const out = judge(edges, CFG);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: "R1", line: 3, target: "src/qq/tool.ts", toLayer: "tools" });
  });

  it("R2：脊髓 import 工具层 → 违规", async () => {
    const judge = await loadJudge();
    const out = judge(
      [{ file: "src/autonomy/a.ts", line: 7, target: "src/qq/b.ts", fromLayer: "spine", toLayer: "tools" }],
      CFG,
    );
    expect(out.map((v) => v.rule)).toEqual(["R2"]);
    expect(out[0]).toMatchObject({ file: "src/autonomy/a.ts", line: 7 });
  });

  it("R3：工具 import 大脑内部实现违规，但 src/ports/ 公共接口放行", async () => {
    const judge = await loadJudge();
    const out = judge(
      [
        { file: "src/qq/bridge.ts", line: 10, target: "src/engine/state.ts", fromLayer: "tools", toLayer: "brain" },
        { file: "src/qq/bridge.ts", line: 11, target: "src/ports/brain.ts", fromLayer: "tools", toLayer: "brain", toPublic: true },
      ],
      CFG,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: "R3", line: 10, target: "src/engine/state.ts" });
  });

  it("R4：非装配点同时 import 大脑+脊髓 → 违规；装配点豁免", async () => {
    const judge = await loadJudge();
    const spineFile: Edge[] = [
      { file: "src/autonomy/s.ts", line: 5, target: "src/engine/config.ts", fromLayer: "spine", toLayer: "brain" },
      { file: "src/autonomy/s.ts", line: 6, target: "src/autonomy/lock.ts", fromLayer: "spine", toLayer: "spine" },
    ];
    const out = judge(spineFile, CFG);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: "R4", line: 5, target: "src/engine/config.ts" });

    const assemblyEdges: Edge[] = [
      { file: "src/plugin/index.ts", line: 5, target: "src/engine/config.ts", fromLayer: "assembly", toLayer: "brain" },
      { file: "src/plugin/index.ts", line: 6, target: "src/autonomy/lock.ts", fromLayer: "assembly", toLayer: "spine" },
    ];
    expect(judge(assemblyEdges, CFG)).toEqual([]);
  });

  it("R4：只 import 一层（只有大脑边、没有脊髓边）不算违规", async () => {
    const judge = await loadJudge();
    const out = judge(
      [
        { file: "src/autonomy/s.ts", line: 5, target: "src/engine/config.ts", fromLayer: "spine", toLayer: "brain" },
      ],
      CFG,
    );
    expect(out).toEqual([]);
  });
});
