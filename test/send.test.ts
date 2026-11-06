import { describe, expect, it } from "vitest";

import { inputPoint, sendNow, type SendDeps } from "../src/qq/send.js";
import type { OpsResult } from "../src/qq/ops.js";

interface Recorder {
  readonly calls: string[];
  readonly deps: SendDeps;
  readonly clipboard: { kind: string; payload: string }[];
}

function recorder(overrides: Partial<SendDeps> = {}, rectOk = true): Recorder {
  const calls: string[] = [];
  const clipboard: { kind: string; payload: string }[] = [];
  const base: SendDeps = {
    call: async (cmd): Promise<OpsResult> => {
      const op = String(cmd["op"]);
      calls.push(op);
      if (op === "visible") return { ok: true, result: { iconic: false, visible: true }, ms: 1 };
      if (op === "rect") {
        return rectOk
          ? { ok: true, result: { left: 0, top: 0, right: 1000, bottom: 1000 }, ms: 1 }
          : { ok: false, error: "QQ 已关闭", ms: 1 };
      }
      return { ok: true, result: {}, ms: 1 };
    },
    setClipboard: async (kind, payload) => {
      clipboard.push({ kind, payload });
    },
    sleep: async () => {},
    hwnd: () => 123,
  };
  return { calls, clipboard, deps: { ...base, ...overrides } };
}

describe("inputPoint（输入框相对位置）", () => {
  it("取 60% / 91% 的比例，与 qq.sh send 一致", () => {
    expect(inputPoint({ left: 0, top: 0, right: 1000, bottom: 1000 })).toEqual({ x: 600, y: 910 });
    expect(inputPoint({ left: 100, top: 200, right: 500, bottom: 700 })).toEqual({ x: 340, y: 655 });
  });
});

describe("sendNow（一条消息的完整动作序列）", () => {
  it("顺序是 rect → focus → click → paste → enter，且先设剪贴板", async () => {
    const rec = recorder();
    const r = await sendNow(rec.deps, { kind: "text", payload: "在吗" });
    expect(r.ok).toBe(true);
    expect(rec.calls).toEqual(["visible", "rect", "focus", "click", "paste", "enter"]);
    expect(rec.clipboard).toEqual([{ kind: "text", payload: "在吗" }]);
    expect(r.point).toEqual({ x: 600, y: 910 });
  });

  it("图片与文件走同一个序列，只是剪贴板类型不同", async () => {
    const rec = recorder();
    await sendNow(rec.deps, { kind: "image", payload: "C:/a.png" });
    await sendNow(rec.deps, { kind: "file", payload: "C:/b.pdf" });
    expect(rec.clipboard.map((c) => c.kind)).toEqual(["image", "file"]);
  });

  it("取不到窗口矩形就停下，不点任何东西", async () => {
    const rec = recorder({}, false);
    const r = await sendNow(rec.deps, { kind: "text", payload: "在吗" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rect 失败");
    expect(rec.calls).toEqual(["visible", "rect"]);
    expect(rec.clipboard).toHaveLength(0);
  });

  it("剪贴板失败时不继续点击", async () => {
    const rec = recorder({
      setClipboard: async () => {
        throw new Error("PowerShell 不在 PATH");
      },
    });
    const r = await sendNow(rec.deps, { kind: "text", payload: "在吗" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("剪贴板");
    expect(rec.calls).toEqual(["visible", "rect"]);
  });


  it("窗口最小化时先还原再取矩形", async () => {
    const calls: string[] = [];
    const rec = recorder({
      call: async (cmd): Promise<OpsResult> => {
        const op = String(cmd["op"]);
        calls.push(op);
        if (op === "visible") return { ok: true, result: { iconic: true }, ms: 1 };
        if (op === "focus") return { ok: true, result: {}, ms: 1 };
        if (op === "rect") return { ok: true, result: { left: 0, top: 0, right: 1000, bottom: 1000 }, ms: 1 };
        return { ok: true, result: {}, ms: 1 };
      },
    });
    const r = await sendNow(rec.deps, { kind: "text", payload: "在吗" });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["visible", "focus", "rect", "focus", "click", "paste", "enter"]);
  });

  it("窗口坐标是屏外值时拒绝发送（上一版会粘到别的窗口）", async () => {
    const rec = recorder({
      call: async (cmd): Promise<OpsResult> => {
        const op = String(cmd["op"]);
        if (op === "visible") return { ok: true, result: { iconic: false }, ms: 1 };
        if (op === "rect") return { ok: true, result: { left: -31881, top: -31969, right: -30881, bottom: -30969 }, ms: 1 };
        return { ok: true, result: {}, ms: 1 };
      },
    });
    const r = await sendNow(rec.deps, { kind: "text", payload: "在吗" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("坐标不可用");
    expect(rec.clipboard).toHaveLength(0);
  });

  it("粘贴失败时报告是哪一步", async () => {
    const rec = recorder({
      call: async (cmd): Promise<OpsResult> => {
        const op = String(cmd["op"]);
        if (op === "rect") return { ok: true, result: { left: 0, top: 0, right: 10, bottom: 10 }, ms: 1 };
        if (op === "paste") return { ok: false, error: "input blocked", ms: 1 };
        return { ok: true, result: {}, ms: 1 };
      },
    });
    const r = await sendNow(rec.deps, { kind: "text", payload: "在吗" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("粘贴");
  });
});
