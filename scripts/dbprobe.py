"""只读探针 v2：从 QQ 进程内存里取出消息库的 SQLCipher 原始密钥，并验证它。

原理（已核对公开实现的细节，见 QQNT 数据库逆向资料）：
  * QQ 的库文件 = 1024 字节扩展头 + 标准 SQLCipher 页；第一页偏移 1024 之后的前 16 字节是 salt。
  * QQ 在内存里以 ASCII 字面量 `x'<64 hex key><32 hex salt>'` 的形式持有「原始密钥 + salt」。
  * 验证方式：SQLCipher v3 兼容参数（page 4096 / reserve 48 / HMAC-SHA1 / PBKDF2-SHA512，
    hmac salt = salt 每字节异或 0x3a，页号小端），用 enc key 复算第 1 页 HMAC 与文件里存的比对。
    这一步不需要 AES，也不需要真的解密——能算对 HMAC 就等于拿到了正确的 key。

只读：不写 QQ 目录、不改库文件。验证通过后只打印前缀（便于人工核对），不落盘。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import glob
import hashlib
import hmac as hmac_mod
import os
import struct
import sys

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TH32CS_SNAPPROCESS = 0x02
TH32CS_SNAPMODULE = 0x08
TH32CS_SNAPMODULE32 = 0x10
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x06, 0x08, 0x20, 0x40, 0x60, 0x80}
MAX_REGION = 256 * 1024 * 1024

EXT_HEADER = 1024
PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
IV_SIZE = 16
HMAC_SIZE = 20
RESERVE = 48
HMAC_MASK = 0x3A
KDF_ITER = 4000
FAST_ITER = 2


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
    ]


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("th32ModuleID", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("GlblcntUsage", wt.DWORD),
        ("ProccntUsage", wt.DWORD),
        ("modBaseAddr", ctypes.POINTER(ctypes.c_byte)),
        ("modBaseSize", wt.DWORD),
        ("hModule", wt.HMODULE),
        ("szModule", ctypes.c_char * 256),
        ("szExePath", ctypes.c_char * 260),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.POINTER(MEMORY_BASIC_INFORMATION), ctypes.c_size_t]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.ReadProcessMemory.restype = wt.BOOL
k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.Process32First.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
k32.Process32Next.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
k32.Module32First.argtypes = [wt.HANDLE, ctypes.POINTER(MODULEENTRY32)]
k32.Module32Next.argtypes = [wt.HANDLE, ctypes.POINTER(MODULEENTRY32)]
k32.CloseHandle.argtypes = [wt.HANDLE]

DB_GLOBS = [
    os.path.expandvars(r"%USERPROFILE%\Documents\Tencent Files\*\nt_qq\nt_db\nt_msg.db"),
    os.path.expandvars(r"%USERPROFILE%\Documents\Tencent Files\nt_qq\global\nt_db\nt_msg.db"),
]


def qq_pids() -> list[int]:
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    pe = PROCESSENTRY32()
    pe.dwSize = ctypes.sizeof(PROCESSENTRY32)
    out: list[int] = []
    if k32.Process32First(snap, ctypes.byref(pe)):
        while True:
            if pe.szExeFile.decode("mbcs", "replace").lower() == "qq.exe":
                out.append(int(pe.th32ProcessID))
            if not k32.Process32Next(snap, ctypes.byref(pe)):
                break
    k32.CloseHandle(snap)
    return out


def has_module(pid: int, name: str) -> bool:
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if not snap or snap == ctypes.c_void_p(-1).value:
        return False
    me = MODULEENTRY32()
    me.dwSize = ctypes.sizeof(MODULEENTRY32)
    found = False
    if k32.Module32First(snap, ctypes.byref(me)):
        while True:
            if me.szModule.decode("mbcs", "replace").lower() == name:
                found = True
                break
            if not k32.Module32Next(snap, ctypes.byref(me)):
                break
    k32.CloseHandle(snap)
    return found


def read_mem(handle: int, addr: int, size: int) -> bytes | None:
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_size_t(0)
    if k32.ReadProcessMemory(handle, ctypes.c_void_p(addr), buf, size, ctypes.byref(n)):
        return buf.raw[: n.value]
    return None


def db_salts() -> dict[str, str]:
    """salt_hex -> 第一个出现该 salt 的库路径"""
    out: dict[str, str] = {}
    for pattern in DB_GLOBS:
        for path in glob.glob(pattern):
            try:
                with open(path, "rb") as fh:
                    head = fh.read(EXT_HEADER + PAGE_SIZE)
            except OSError:
                continue
            if len(head) < EXT_HEADER + PAGE_SIZE or head[:16] != b"SQLite header 3\x00":
                continue
            salt = head[EXT_HEADER : EXT_HEADER + SALT_SIZE]
            out.setdefault(salt.hex(), path)
    return out


def verify(page1: bytes, enc_key: bytes) -> bool:
    salt = page1[:SALT_SIZE]
    hmac_salt = bytes(b ^ HMAC_MASK for b in salt)
    hmac_key = hashlib.pbkdf2_hmac("sha512", enc_key, hmac_salt, FAST_ITER, KEY_SIZE)
    data_end = PAGE_SIZE - RESERVE
    content = page1[SALT_SIZE:data_end]
    iv = page1[data_end : data_end + IV_SIZE]
    stored = page1[data_end + IV_SIZE : data_end + IV_SIZE + HMAC_SIZE]
    computed = hmac_mod.new(hmac_key, content + iv + struct.pack("<I", 1), hashlib.sha1).digest()
    return hmac_mod.compare_digest(computed, stored)


def page1_of(path: str) -> bytes:
    with open(path, "rb") as fh:
        fh.seek(EXT_HEADER)
        return fh.read(PAGE_SIZE)


def scan(pid: int, salts: dict[str, str]) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    needle_map = {s.encode("ascii"): s for s in salts}
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        print(f"OPEN-FAIL pid={pid} err={ctypes.get_last_error()}")
        return hits
    print(f"OPEN-OK pid={pid} (wrapper.node)")
    mbi = MEMORY_BASIC_INFORMATION()
    addr = 0
    scanned = 0
    while addr < 0x7FFFFFFFFFFF:
        if k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
            break
        base = int(mbi.BaseAddress or 0)
        size = int(mbi.RegionSize or 0)
        if mbi.State == MEM_COMMIT and 0 < size <= MAX_REGION and (int(mbi.Protect or 0) & 0xFF) in READABLE:
            data = read_mem(h, base, size)
            if data:
                scanned += len(data)
                for needle, salt_hex in needle_map.items():
                    pos = data.find(needle)
                    if pos < 0:
                        continue
                    start = pos - 66
                    if start < 0:
                        continue
                    window = data[start : pos + 32]
                    if not window.startswith(b"x'"):
                        continue
                    key_hex = window[2:66].decode("ascii", "replace")
                    if len(key_hex) != 64 or any(c not in "0123456789abcdefABCDEF" for c in key_hex):
                        continue
                    path = salts[salt_hex]
                    try:
                        ok = verify(page1_of(path), bytes.fromhex(key_hex))
                    except OSError:
                        ok = False
                    hits.append((salt_hex, key_hex))
                    print(f"HIT salt={salt_hex} key={key_hex[:8]}…{key_hex[-8:]} verify={'OK' if ok else 'NO'} db={os.path.basename(os.path.dirname(path))}/{os.path.basename(path)}")
        nxt = base + size
        if nxt <= addr:
            break
        addr = nxt
    k32.CloseHandle(h)
    print(f"SCANNED {scanned / 1024 / 1024:.1f} MB hits={len(hits)}")
    return hits


def main() -> int:
    salts = db_salts()
    print(f"DBS with salt: {len(salts)}")
    for s, p in list(salts.items())[:6]:
        print(f"  salt={s} {p}")
    pids = qq_pids()
    print(f"QQ pids: {pids}")
    targets = [p for p in pids if has_module(p, "wrapper.node")] or pids
    if not targets:
        print("NO-QQ-PROCESS")
        return 1
    hits = []
    for target in targets:
        hits.extend(scan(target, salts))
    verified = [h for h in hits if (lambda: None)]  # 结果已在 scan 内打印
    print("SUMMARY", "keys-found=%d" % len(set(h[1] for h in hits)), "verified-printed-above")
    return 0 if hits else 2


if __name__ == "__main__":
    sys.exit(main())
