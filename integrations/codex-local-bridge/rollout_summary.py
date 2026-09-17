import json, sys, collections, pathlib

def summarize(path):
    types = collections.Counter()
    meta = None
    enc_prefixes = []
    models = collections.Counter()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            t = rec.get("type")
            types[t] += 1
            if t == "session_meta":
                meta = rec.get("payload", {})
            payload = rec.get("payload", rec)
            if isinstance(payload, dict):
                # responses-item style records
                item = payload.get("item") if isinstance(payload.get("item"), dict) else payload
                if isinstance(item, dict):
                    it = item.get("type")
                    if it:
                        types[f"item:{it}"] += 1
                    if item.get("model"):
                        models[item["model"]] += 1
                    enc = item.get("encrypted_content")
                    if isinstance(enc, str):
                        enc_prefixes.append(enc[:40])
    print(f"文件: {pathlib.Path(path).name}")
    if meta:
        keys = {k: meta.get(k) for k in ("id", "model", "model_provider", "provider", "cwd", "cli_version", "originator", "source", "thread_source") if k in meta}
        print("  session_meta:", json.dumps(keys, ensure_ascii=False))
    print("  记录类型:", dict(types))
    if models:
        print("  item 里出现的 model:", dict(models))
    print(f"  encrypted_content 出现 {len(enc_prefixes)} 次; 样例前缀: {enc_prefixes[:3]}")
    print()

for p in sys.argv[1:]:
    summarize(p)
