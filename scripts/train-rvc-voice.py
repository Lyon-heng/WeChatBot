"""一键把一个说话/唱歌素材目录训练成 RVC v2 模型（Applio 后端，GPU 优先）。

调用的四个子步骤与 Applio core.py 完全一致：
  preprocess.py → extract.py → train.py → extract_index.py

示例：
  python train-rvc-voice.py --name rabbit --dataset state/voice/train/rabbit/sep \
      --epochs 150 --batch-size 8
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path


def run(label, command, cwd, env):
    print("\n=== " + label + " ===", flush=True)
    print(" ".join(str(part) for part in command), flush=True)
    result = subprocess.run(command, cwd=str(cwd), env=env)
    if result.returncode != 0:
        raise SystemExit(label + " 失败，退出码 " + str(result.returncode))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--applio", required=True)
    parser.add_argument("--python", required=True, help="带 CUDA torch 的 python.exe")
    parser.add_argument("--deps", required=True, help="额外依赖目录（train-deps）")
    parser.add_argument("--name", required=True)
    parser.add_argument("--dataset", required=True, help="原始音频目录")
    parser.add_argument("--sample-rate", type=int, default=40000)
    parser.add_argument("--epochs", type=int, default=150)
    parser.add_argument("--save-every", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--gpu", default="0")
    parser.add_argument("--cores", default=str(min(8, os.cpu_count() or 4)))
    parser.add_argument("--cut", default="Automatic")
    parser.add_argument("--chunk", default="3.7")
    parser.add_argument("--overlap", default="0.3")
    parser.add_argument("--embedder", default="contentvec")
    parser.add_argument("--vocoder", default="HiFi-GAN")
    args = parser.parse_args()

    applio = Path(args.applio).resolve()
    logs = applio / "logs"
    model_dir = logs / args.name
    dataset = Path(args.dataset).resolve()
    if not dataset.is_dir():
        raise SystemExit("素材目录不存在：" + str(dataset))
    model_dir.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(args.deps).resolve()) + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    env["OMP_NUM_THREADS"] = "4"
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"

    py = args.python
    run("预处理（切片/响度）", [
        py, "-B", str(applio / "rvc/train/preprocess/preprocess.py"),
        str(model_dir), str(dataset), str(args.sample_rate), str(args.cores),
        args.cut, "True", args.chunk, args.overlap, "none",
    ], applio, env)

    run("提取 F0 与特征", [
        py, "-B", str(applio / "rvc/train/extract/extract.py"),
        str(model_dir), "rmvpe", str(args.cores), args.gpu, str(args.sample_rate),
        args.embedder, "", "2",
    ], applio, env)

    g_path = applio / "rvc/models/pretraineds/hifi-gan" / ("f0G" + str(args.sample_rate // 1000) + "k.pth")
    d_path = applio / "rvc/models/pretraineds/hifi-gan" / ("f0D" + str(args.sample_rate // 1000) + "k.pth")
    for path in (g_path, d_path):
        if not path.is_file():
            raise SystemExit("缺少预训练模型：" + str(path))

    run("训练", [
        py, "-B", str(applio / "rvc/train/train.py"),
        args.name, str(args.save_every), str(args.epochs), str(g_path), str(d_path),
        args.gpu, str(args.batch_size), str(args.sample_rate),
        "False", "True", "False", "False", args.vocoder, "False",
    ], applio, env)

    run("生成检索索引", [
        py, "-B", str(applio / "rvc/train/process/extract_index.py"),
        str(model_dir), "Auto",
    ], applio, env)

    weights = sorted(model_dir.glob("*.pth"), key=lambda p: p.stat().st_mtime)
    indexes = sorted(model_dir.glob("added_*.index"), key=lambda p: p.stat().st_mtime)
    if not weights:
        raise SystemExit("训练结束但没有找到 .pth 权重")
    print("\n结果：")
    print("  weight:", weights[-1])
    print("  index :", indexes[-1] if indexes else "(无)")
    print("  files :", len(list(model_dir.glob('*'))))


if __name__ == "__main__":
    main()
