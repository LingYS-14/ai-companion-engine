/**
 * F303：导入路径锁——插件编译后必须能真的被加载。
 *
 * 起因（真实事故）：F295 把 `panel.ts` 搬进 `src/assembly/` 时，`src/plugin/index.ts`
 * 里写成了 `import … from "../../src/assembly/panel-payload.js"`。
 * TypeScript 能解析它（相对路径落回正确的 .ts），所以 tsc 干净、gate 绿；但编译产物
 * `dist/plugin/index.js` 会原样保留这个字面量，从 `dist/plugin/` 出发就指向
 * `src/assembly/panel-payload.js`（不存在）→ **插件在 DSH 里加载失败**，
 * 面板路由、工具、apply-report 全部消失。
 *
 * 这个测试锁两件事：
 * 1. 源码里不许出现"绕回 src/"的导入（`../../src/...` 这类冗余跳转）；
 * 2. 编译产物里每一条相对导入都必须指向真实存在的文件（dist 存在时）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

function walk(dir: string, filter: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

interface ImportRef {
  readonly file: string;
  readonly spec: string;
}

function importsOf(file: string): ImportRef[] {
  const text = readFileSync(file, "utf8");
  const refs: ImportRef[] = [];
  for (const match of text.matchAll(/(?:from|import)\s+"(\.[^"]*)"/g)) {
    const spec = match[1];
    if (spec !== undefined) refs.push({ file, spec });
  }
  return refs;
}

function resolveTs(base: string): string | null {
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

describe("源码导入路径（F303）", () => {
  it("不许用 ../../src/… 这类绕回 src 的路径（tsc 会放过、编译产物会断）", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
      for (const ref of importsOf(file)) {
        if (/\/src\//.test(ref.spec) || ref.spec.startsWith("../../src")) {
          offenders.push(`${relative(ROOT, ref.file)} -> ${ref.spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("每一条相对导入都能解析到 src 内真实文件（且不逃出 src）", () => {
    const missing: string[] = [];
    for (const file of walk(SRC, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
      for (const ref of importsOf(file)) {
        const target = resolve(dirname(ref.file), ref.spec);
        const rel = relative(SRC, target);
        if (rel.startsWith("..")) {
          missing.push(`${relative(ROOT, ref.file)} -> ${ref.spec}（逃出 src）`);
          continue;
        }
        if (resolveTs(target) === null) missing.push(`${relative(ROOT, ref.file)} -> ${ref.spec}（文件不存在）`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!existsSync(DIST))("编译产物导入路径（F303）", () => {
  it("dist 里每条相对导入都指向真实文件（插件加载失败的根因）", () => {
    const missing: string[] = [];
    for (const file of walk(DIST, (name) => name.endsWith(".js"))) {
      for (const ref of importsOf(file)) {
        const target = resolve(dirname(ref.file), ref.spec);
        if (!existsSync(target)) missing.push(`${relative(ROOT, ref.file)} -> ${ref.spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("package.json 的插件入口指向 dist（别把 src 当产物）", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      main?: string;
      exports?: Record<string, unknown>;
    };
    expect(pkg.main ?? "").toContain("dist/");
    expect(JSON.stringify(pkg.exports ?? {})).toContain("dist/");
  });
});
