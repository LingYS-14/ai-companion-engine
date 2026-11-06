#!/usr/bin/env bash
# 抓取 QQ 发来的《解决用.docx》：按 sha256 变化检测新版本，归档 + 转文本。
# 用法: ./capture.sh [timeout_sec]   （默认 90）
# 退出码: 0 = 抓到新版本；1 = 超时无变化
set -u
DL="/c/Users/user/Downloads/解决用.docx"
IN="/c/AI/_audit/in"
STATE="$IN/.last_hash"
PY="/c/Users/user/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe"
[ -x "$PY" ] || PY="python"
TIMEOUT="${1:-90}"
mkdir -p "$IN"
LAST=""; [ -f "$STATE" ] && LAST="$(cat "$STATE")"

deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f "$DL" ]; then
    H="$(sha256sum "$DL" | cut -d' ' -f1)"
    if [ "$H" != "$LAST" ]; then
      TS="$(date +%H%M%S)"
      OUT="$IN/solve-$TS.docx"
      cp "$DL" "$OUT"
      echo "$H" > "$STATE"
      echo "CAPTURED $OUT sha256=$H size=$(stat -c%s "$OUT")"
      PYTHONIOENCODING=utf-8 "$PY" /c/AI/qq-ops/read_docx.py "$OUT" > "$IN/solve-$TS.txt" 2>&1 \
        && echo "TEXT $IN/solve-$TS.txt lines=$(wc -l < "$IN/solve-$TS.txt")" \
        || echo "TEXT-FAILED (用 docx 读取工具处理)"
      exit 0
    fi
  fi
  sleep 2
done
echo "TIMEOUT no new version (last=$LAST)"
exit 1
