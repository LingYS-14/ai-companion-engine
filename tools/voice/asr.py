"""离线 ASR：faster-whisper 转写音频（wav/mp3/amr 等，非 wav 用内置 ffmpeg 解码）。

用法: python tools/voice/asr.py <audio-path> [model-dir-or-name]
输出一行 JSON：{"text": "...", "language": "zh", "duration": 1.2}；失败写 stderr、退出码非 0。
"""
import json
import os
import subprocess
import sys
import tempfile
import wave


def to_pcm16k(path: str) -> str:
    """统一解成 16k 单声道 wav；wav 直接返回，避免多一次转码。"""
    if path.lower().endswith(".wav"):
        return path
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    # 本机 Temp 目录不可写（宿主按低完整性标签运行），优先落在音频旁边，
    # 退而用之 ACE_TMP/TMP；绝不再用 tempfile.gettempdir() 的默认可写假设。
    out_dir = os.environ.get("ACE_TMP") or os.path.dirname(os.path.abspath(path)) or "."
    out = os.path.join(out_dir, f".ase-asr-{os.getpid()}.wav")
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "wav", out],
        check=True,
    )
    return out


def read_wav(path: str):
    import numpy as np

    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, "只支持 16bit 单声道 wav"
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: asr.py <audio> [model]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "tiny"
    from faster_whisper import WhisperModel

    wav = to_pcm16k(path)
    audio = read_wav(wav)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        audio,
        language="zh",
        vad_filter=True,
        beam_size=1,
        condition_on_previous_text=False,
        # 偏置：简体 + 常用专名，tiny/base 对「AI助手」这类音译很飘
        initial_prompt="用户，AI助手，崩坏三。以下是简体中文对话。",
    )
    text = "".join(seg.text for seg in segments).strip()
    print(json.dumps({"text": text, "language": info.language, "duration": round(info.duration, 2)}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
