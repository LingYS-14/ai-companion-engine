import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(__dirname, "..");

function dryReport(): string {
  return execFileSync(process.execPath, [join(repo, "tools", "report", "morning-report.mjs"), "--dry"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("早报生成器", () => {
  it("能生成七段结构，且事实段不是待补", () => {
    const out = dryReport();
    for (const section of ["## 一、一句话", "## 二、她今晚做了什么", "## 三、进程与通道", "## 四、成效", "## 五、问题与修复", "## 六、对终极目标的下一步建议", "## 七、取证命令"]) {
      expect(out).toContain(section);
    }
    // 成效段的事实行必须来自取证，不能整段都是（待补）
    expect(out).toMatch(/- 学习：/);
    expect(out).toMatch(/- 内部言语：/);
  });

  it("意向引擎段把她这一拍在想什么带进早报（或明说还没有样本）", () => {
    const out = dryReport();
    expect(out).toContain("### 意向引擎（她这一拍在想什么）");
    expect(out).toMatch(/- 样本：\d+ 拍|意向引擎还没有真实样本/);
    // 指标行必须来自看板；不许写"她很主动"这类自评
    expect(out).not.toContain("她很主动");
  });

  it("意图活动段把一昼夜的事实带进早报（或明说跑不起来）", () => {
    const out = dryReport();
    expect(out).toContain("### 她的意图活动（一昼夜）");
    expect(out).toMatch(/\[tick\]|活动汇总跑不起来/);
    // 只搬事实，不替她表态
    expect(out).not.toContain("她很主动");
  });

  it("问题段按 F 编号列，不是空的待补", () => {
    const out = dryReport();
    const five = out.split("## 五、问题与修复")[1]?.split("## 六、")[0] ?? "";
    expect(five).not.toContain("（待补）按");
    expect(/F\d+/.test(five) || five.includes("昨夜没有新增 F 编号")).toBe(true);
  });
});

describe("早报判断段持久化", () => {
  it("重跑时把标记之间的判断段搬回来，不被事实刷新擦掉", () => {
    const dir = mkdtempSync(join(tmpdir(), "ase-morning-"));
    try {
      const target = join(dir, "report.md");
      const run = (): void => {
        execFileSync(process.execPath, [join(repo, "tools", "report", "morning-report.mjs"), `--target=${target}`], {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      };
      run();
      // 人写判断：把标记之间换成一句可识别的话
      const first = readFileSync(target, "utf8");
      const withJudgment = first.replace(
        /<!-- judgment:start -->[\s\S]*?<!-- judgment:end -->/u,
        "<!-- judgment:start -->\n- 四段的判断：她学会了用细节而不是形容词。\n<!-- judgment:end -->",
      );
      writeFileSync(target, withJudgment, "utf8");
      run();
      const second = readFileSync(target, "utf8");
      expect(second).toContain("她学会了用细节而不是形容词");
      // 事实段仍应被刷新（不是把整份文件原样搬回来）
      expect(second).toMatch(/- 学习：/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
