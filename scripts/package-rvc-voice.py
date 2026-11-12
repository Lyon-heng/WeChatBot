"""把一个训练好的 RVC 权重打包成 FeiyuVoice-RVC 发布布局（可被 /v1/voice-conversion 直接使用）。

用法：
  python package-rvc-voice.py --pth logs/rabbit/rabbit.pth --index logs/rabbit/added_x.index \
      --out models/Rabbit-RVC --id Rabbit-RVC-v1 --template models/FeiyuVoice-RVC \
      --applio <Applio 根目录>

打包后会：复制运行入口与运行时固定清单 → 写入 manifest.json / configuration.json →
按 FeiyuVoice-RVC 的算法计算 pth/index 的 sha256 与网络张量摘要 → 生成 files_sha256.json。
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

TEMPLATE_FILES = [
    "run_rvc.py",
    "apply_breath.py",
    "Convert.ps1",
    "Apply-Breath.ps1",
    "regions.example.json",
    "runtime.template.json",
    "runtime_pins.json",
    "requirements-tools.txt",
    "NOTICE.md",
    "COPYRIGHT.md",
]
SKIP_NAMES = {"files_sha256.json", "outputs"}


def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tensor_digest(applio, pth):
    """与 run_rvc.py 完全一致：遍历排序后的 net_g.state_dict()。"""
    applio = Path(applio).resolve()
    os.environ.setdefault("APPLIO_CONFIG_FILE", str(applio / "configs" / "applio_settings.json"))
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    sys.path.insert(0, str(applio))
    cwd = os.getcwd()
    os.chdir(applio)
    try:
        import torch
        from rvc.infer.infer import VoiceConverter

        converter = VoiceConverter()
        converter.get_vc(str(Path(pth).resolve()), 0)
        digest = hashlib.sha256()
        for key, tensor in sorted(converter.net_g.state_dict().items()):
            digest.update(key.encode())
            digest.update(tensor.detach().float().cpu().contiguous().numpy().tobytes())
        return digest.hexdigest()
    finally:
        os.chdir(cwd)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pth", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--sample-rate", type=int, default=40000)
    parser.add_argument("--template", required=True, help="FeiyuVoice-RVC 包目录，用于复用运行入口")
    parser.add_argument("--applio", required=True, help="Applio 根目录")
    parser.add_argument("--index-rate", type=float, default=0.3)
    parser.add_argument("--protect", type=float, default=0.33)
    parser.add_argument("--skip-tensor-digest", action="store_true")
    args = parser.parse_args()

    pth = Path(args.pth).resolve()
    index = Path(args.index).resolve()
    out = Path(args.out).resolve()
    template = Path(args.template).resolve()
    if not pth.is_file():
        raise SystemExit("缺少 pth: " + str(pth))
    if not index.is_file():
        raise SystemExit("缺少 index: " + str(index))
    out.mkdir(parents=True, exist_ok=True)

    for name in TEMPLATE_FILES:
        source = template / name
        if source.is_file():
            shutil.copy2(source, out / name)
    for name in ("runtime.local.json",):
        source = template / name
        if source.is_file():
            shutil.copy2(source, out / name)

    pth_name = args.id + ".pth"
    index_name = args.id + ".index"
    shutil.copy2(pth, out / pth_name)
    shutil.copy2(index, out / index_name)

    digest = "" if args.skip_tensor_digest else tensor_digest(args.applio, out / pth_name)

    manifest = {
        "schema": "feiyu-rvc-release-v1",
        "id": args.id,
        "version": args.version,
        "model": {
            "pth": pth_name,
            "pth_sha256": sha(out / pth_name),
            "index": index_name,
            "index_sha256": sha(out / index_name),
        },
        "model_tensor_digest": digest,
        "inference": {
            "pitch_shift": 0,
            "index_rate": args.index_rate,
            "protect": args.protect,
            "volume_envelope": 1,
            "f0_method": "rmvpe",
        },
        "sample_rate": args.sample_rate,
        "seed": 42,
        "speaker_id": 0,
        "RVC_version": "v2",
        "F0": True,
        "breath_attenuation": {
            "depth_db": -24.0,
            "ramp": "cosine-shaped dB gain",
            "manual_regions_required": True,
            "automatic_detection": False,
            "normalize_after": False,
        },
        "environment_bundled": False,
        "training_data_bundled": False,
        "new_training_updates": 0,
    }
    write_json(out / "manifest.json", manifest)
    write_json(
        out / "configuration.json",
        {
            "model_type": "rvc",
            "model_version": "v2",
            "sample_rate": args.sample_rate,
            "inference_entry": "run_rvc.py",
            "hosted_inference": False,
        },
    )

    records = {}
    for path in sorted(out.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(out)
        if relative.parts[0] in SKIP_NAMES or relative.name == "files_sha256.json":
            continue
        records[relative.as_posix()] = {"sha256": sha(path), "bytes": path.stat().st_size}
    write_json(out / "files_sha256.json", records)

    print(json.dumps({
        "package": args.id,
        "version": args.version,
        "out": str(out),
        "files": len(records),
        "pth_sha256": manifest["model"]["pth_sha256"],
        "index_sha256": manifest["model"]["index_sha256"],
        "model_tensor_digest": digest,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
