"""只读侦察：QQ 进程里有没有可用的 sqlite3 符号。

目的不是马上读库，而是回答一个很具体的问题：**SQLCipher 的 C 接口在这个进程里是不是「导出符号」**。
如果是，我们就可以 hook `sqlite3_prepare_v2` / `sqlite3_step` / `sqlite3_column_text`，
借 QQ 已经打开的连接跑一条只读 SELECT——不需要钥匙、不改任何文件。
如果全都不是导出符号，就得换打法（内存扫描 / 在 wrapper.node 里找函数），这一轮先看清楚。

自带安全阀：只 attach 一次、只枚举、不写内存、不做任何 patch，跑完立刻 detach。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# frida 会把 agent DLL 解到 TEMP 再注入；默认 TEMP 在本机不可写，必须换到工作区。
_HERE = Path(__file__).resolve().parent.parent
_TMP = _HERE / ".tmp-frida"
_TMP.mkdir(parents=True, exist_ok=True)
for _k in ("TMP", "TEMP", "TMPDIR"):
    os.environ[_k] = str(_TMP)

import frida  # noqa: E402  (必须在改完 env 之后再导入)

TARGET = "QQ.exe"

JS = r"""
const out = { modules: 0, candidates: [], sqliteExports: [], sqliteModules: [] };
const mods = Process.enumerateModules();
out.modules = mods.length;
const cand = mods.filter(function (m) {
  return /sqlite|wrapper|nt_|qq|proton|major/i.test(m.name) || /sqlite/i.test(m.path);
});
out.candidates = cand.map(function (m) {
  return { name: m.name, base: m.base.toString(), size: m.size, path: m.path };
});
const want = /^sqlite3_/;
for (const m of cand) {
  if (m.size > 80 * 1024 * 1024) continue;
  let exps;
  try { exps = Module.enumerateExportsSync(m.name); } catch (e) { continue; }
  const hits = [];
  for (const e of exps) {
    if (want.test(e.name)) hits.push({ name: e.name, address: e.address.toString() });
  }
  if (hits.length > 0) {
    out.sqliteExports.push({ module: m.name, count: hits.length, sample: hits.slice(0, 40) });
  }
}
// 有些宿主把 sqlite 静态编进模块、不导出；再按字符串粗扫一次模块名，便于人工判断
out.sqliteModules = mods
  .filter(function (m) { return /sqlite/i.test(m.name) || /sqlite/i.test(m.path); })
  .map(function (m) { return { name: m.name, size: m.size, path: m.path }; });
send(out);
"""


def find_targets(session) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    for p in session.enumerate_processes():
        if p.name.lower() == TARGET.lower():
            found.append((p.pid, p.name))
    return found


def integrity_label() -> str:
    """看当前进程的完整性级别：Low 表示被降权（注入会被强制策略拦），Medium 说明跑在宿主里。"""
    import ctypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    advapi.OpenProcessToken.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
    advapi.OpenProcessToken.restype = ctypes.c_int
    advapi.GetTokenInformation.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32),
    ]
    advapi.GetTokenInformation.restype = ctypes.c_int
    token = ctypes.c_void_p()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        return "unknown"
    label = ctypes.c_void_p(0)
    size = ctypes.c_ulong(0)
    # GetTokenInformation(TokenIntegrityLevel=25) 第一次调用只为拿长度
    advapi.GetTokenInformation(token, 25, None, 0, ctypes.byref(size))
    buf = ctypes.create_string_buffer(size.value)
    if not advapi.GetTokenInformation(token, 25, buf, size.value, ctypes.byref(size)):
        return "unknown"
    sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
    sub = ctypes.cast(sid + 8, ctypes.POINTER(ctypes.c_ulong))[0]
    return {0x1000: "Low", 0x2000: "Medium", 0x3000: "High", 0x4000: "System"}.get(sub, hex(sub))


def main() -> int:
    print(json.dumps({"integrity": integrity_label()}, ensure_ascii=False))
    session = frida.get_local_device()
    procs = find_targets(session)
    if not procs:
        print(json.dumps({"ok": False, "error": "没有找到 QQ.exe 进程"}, ensure_ascii=False))
        return 2
    results = []
    for pid, name in procs:
        entry: dict[str, object] = {"pid": pid, "name": name}
        t0 = time.time()
        try:
            s = session.attach(pid)
            try:
                script = s.create_script(JS)
                box: list[dict] = []
                script.on("message", lambda m, data: box.append(m))
                script.load()
                deadline = time.time() + 25
                while time.time() < deadline and not box:
                    time.sleep(0.1)
                entry["ms"] = int((time.time() - t0) * 1000)
                if box:
                    payload = box[0].get("payload")
                    entry["ok"] = True
                    entry["report"] = payload
                else:
                    entry["ok"] = False
                    entry["error"] = "脚本 25s 内没有回消息"
            finally:
                s.detach()
        except Exception as exc:  # noqa: BLE001 - 侦察脚本要把失败也原样带回来
            entry["ok"] = False
            entry["error"] = f"{type(exc).__name__}: {exc}"
            entry["ms"] = int((time.time() - t0) * 1000)
        results.append(entry)
        # 只认真看第一个进程，避免 12 个进程全注入（少一分崩溃风险）
        break
    print(json.dumps({"ok": True, "target": TARGET, "results": results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
