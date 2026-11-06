"""查 QQ 进程的缓解策略（ACG / 强制签名 / 禁止远程镜像），判断"注入不可能"是策略级还是反调试级。

只读：OpenProcess(QUERY_LIMITED_INFORMATION) + GetProcessMitigationPolicy + QueryFullProcessImageName。
"""

import ctypes
import json
import sys
import ctypes.wintypes as w

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.OpenProcess.restype = ctypes.c_void_p
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.GetProcessMitigationPolicy.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t]
kernel.GetProcessMitigationPolicy.restype = ctypes.c_int
kernel.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
kernel.QueryFullProcessImageNameW.restype = ctypes.c_int

# Windows 10/11 PROCESS_MITIGATION_*_POLICY（每个 4 字节）
POLICIES = {
    0: "DEP",
    1: "ASLR",
    2: "DynamicCode(ACG)",
    3: "StrictHandleCheck",
    4: "SystemCallDisable",
    6: "ExtensionPointDisable",
    7: "ControlFlowGuard",
    8: "BinarySignature",
    10: "ImageLoad",
    12: "PayloadRestriction",
    13: "ChildProcess",
    14: "SideChannelIsolation",
}


def bits(buf: bytes) -> str:
    v = int.from_bytes(buf, "little")
    flags = [name for bit, name in enumerate(
        ["PROHIBIT_DYNAMIC_CODE" if False else f"bit{bit}" for bit in range(32)]) if v >> bit & 1]
    return f"raw=0x{v:08x} " + ",".join(flags)


def main() -> int:
    import subprocess

    out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, errors="ignore").stdout
    pids = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == "qq.exe":
            pids.append(int(parts[1]))
    rows = []
    for pid in pids[:3]:
        h = kernel.OpenProcess(0x1000, False, pid)
        if not h:
            rows.append({"pid": pid, "open": False, "err": ctypes.get_last_error()})
            continue
        try:
            buf = ctypes.create_string_buffer(32)
            n = w.DWORD(260)
            path = ctypes.create_unicode_buffer(260)
            ok = kernel.QueryFullProcessImageNameW(ctypes.c_void_p(h), 0, path, ctypes.byref(n))
            row = {"pid": pid, "image": path.value if ok else "?", "policies": {}}
            for pol, label in POLICIES.items():
                b = ctypes.create_string_buffer(4)
                got = kernel.GetProcessMitigationPolicy(ctypes.c_void_p(h), pol, b, 4)
                row["policies"][label] = bits(b.raw) if got else f"err{ctypes.get_last_error()}"
            rows.append(row)
        finally:
            kernel.CloseHandle(ctypes.c_void_p(h))
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
