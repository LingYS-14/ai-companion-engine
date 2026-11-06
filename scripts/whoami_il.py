import ctypes
import ctypes.wintypes as w
import json
import subprocess
import sys

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
advapi = ctypes.WinDLL("advapi32", use_last_error=True)
kernel.OpenProcess.restype = ctypes.c_void_p
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.GetCurrentProcess.restype = ctypes.c_void_p
advapi.OpenProcessToken.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
advapi.OpenProcessToken.restype = ctypes.c_int
advapi.GetTokenInformation.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
advapi.GetTokenInformation.restype = ctypes.c_int


def il_of_handle(h: int) -> str:
    token = ctypes.c_void_p()
    if not advapi.OpenProcessToken(ctypes.c_void_p(h), 0x0008, ctypes.byref(token)):
        return f"open-token-fail-{ctypes.get_last_error()}"
    need = ctypes.c_uint32(0)
    advapi.GetTokenInformation(token, 25, None, 0, ctypes.byref(need))
    buf = ctypes.create_string_buffer(need.value)
    if not advapi.GetTokenInformation(token, 25, buf, need.value, ctypes.byref(need)):
        return f"gti-fail-{ctypes.get_last_error()}"
    sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
    sub = ctypes.cast(sid + 8, ctypes.POINTER(ctypes.c_ulong))[0]
    return {0x1000: "Low", 0x2000: "Medium", 0x3000: "High", 0x4000: "System"}.get(sub, hex(sub))


def il_of_pid(pid: int) -> str:
    h = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not h:
        return f"openproc-fail-{ctypes.get_last_error()}"
    try:
        return il_of_handle(h)
    finally:
        kernel.CloseHandle(h)


def pids(names: set[str]) -> list[tuple[int, str]]:
    out = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, errors="ignore"
    ).stdout
    found = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() in names:
            found.append((int(parts[1]), parts[0]))
    return found


targets = {n.lower() for n in ("QQ.exe", "explorer.exe", "dsh.exe", "electron.exe", "node.exe")}
rows = [{"pid": 0, "name": "self", "il": il_of_handle(kernel.GetCurrentProcess())}]
for pid, name in pids(targets)[:12]:
    rows.append({"pid": pid, "name": name, "il": il_of_pid(pid)})

sched = subprocess.run(
    ["C:/Windows/System32/schtasks.exe", "/query", "/tn", "NothingHere"],
    capture_output=True, text=True, errors="ignore",
)
rows.append({"schtasks_exit": sched.returncode, "out": (sched.stdout + sched.stderr).strip()[:200]})
print(json.dumps(rows, ensure_ascii=False, indent=2))
sys.exit(0)
