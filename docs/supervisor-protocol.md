# Supervisor Protocol v0（可直接粘给 ChatGPT）

Status: frozen 2026-09-17 (M3.0). Decision record: `docs/decisions/007-supervisor-layer.md`.
Eval set: `docs/evals/`. 第一号回归样例：`docs/evals/fixtures/001-lattice-basis.json`。

## 1. 三种模式

| 模式 | 什么时候用 | Broker 调用 | 谁判定 |
|---|---|---|---|
| `single` | 低风险、改写、格式整理、单点事实 | `run_worker` 或 `delegate` | 不判定 |
| `parallel_compare` | 重要定义、易混淆概念、科研结论、关键代码设计 | `delegate_batch(parallel=true)`，workers=["deepseek","glm"] | 调用方模型逐条比对 |
| `adjudication` | 上面两候选在**关键断言**上冲突 | 沿用同一批候选，必要时补一次同题追问 | 调用方模型逐条裁决 |

规则：`adjudication` 不是第三种调用，而是 `parallel_compare` 的一个结果分支。默认不要自动升级模式；
模式由使用者（或明确的 prompt policy）指定。

## 2. 硬性规则

1. **按主张比较，不做整体打分。** 禁止输出「A 更好 / B 更差」这类结论作为唯一判据。
2. 每条裁决必须给依据（定义、推导、量纲、共享计数、可查证来源），并标注 `supported` /
   `refuted` / `unresolved`。
3. 允许并且必须能说：**两个都错、两个都不完整、两个表述不同但都正确**。
4. 不得编造引用。没有外部依据时标 `needsExternalEvidence: true` 并说明缺什么。
5. 候选的 `taskId`、`usage`（含 `reasoningTokens`）、延迟必须来自工具的原始返回，不得改写或估算。
6. 裁决结果**不写回** Broker（当前 profile 是只读的）；它记录在 `docs/evals/runs/`。

## 3. 固定输出信封（verdict envelope）

先给一段人话结论，然后必须附上这个 JSON 块（字段名固定，缺项填 null/[]）：

```json
{
  "protocol": "supervisor-v0",
  "mode": "parallel_compare",
  "task": "<原文任务>",
  "criticalClaims": ["<把任务拆成可判定的断言>"],
  "candidates": [
    {"worker": "deepseek", "taskId": "...", "latencyMs": 0,
     "usage": {"inputTokens": 0, "outputTokens": 0, "reasoningTokens": null},
     "evidence": [{"type": "provider.response_id", "content": "..."}]}
  ],
  "consensus": ["<两候选一致且正确的断言>"],
  "conflicts": [{"claim": "<断言>", "versions": [{"worker": "glm", "says": "<它实际怎么说的>"}]}],
  "adjudication": [{"claim": "<断言>", "ruling": "supported|refuted|unresolved", "basis": "<依据>", "cite": null}],
  "unresolved": ["<无法定论的项>"],
  "final": "<最终答案>",
  "confidence": "high|medium|low",
  "needsExternalEvidence": false
}
```

## 4. 提示词卡（复制到 ChatGPT 用）

### 4.1 第一条：声明协议

    从现在起，在处理重要或易错问题时使用 Supervisor Protocol v0：
    先用 Multimodel Broker 的 delegate_batch(parallel=true) 让 deepseek 和 glm 分别回答同一个问题，
    不要直接采用任何一份答案。然后按“主张”逐条比较两份候选：
    - 列出共识（两方一致且正确的部分）
    - 列出冲突（逐条写：哪条断言、双方各自怎么说的）
    - 逐条裁决并给出依据（定义/推导/量纲/共享计数/可查来源），标注 supported / refuted / unresolved
    - 如果两个都错或都不完整，直接说，不要为了给出答案而选一个
    - 无法判定的项列入 unresolved，必要时设 needsExternalEvidence
    最后给出你的最终答案和 confidence。
    回答末尾附上固定 JSON 信封（protocol=supervisor-v0），候选的 taskId、usage、reasoningTokens
    和延迟必须取自工具原始返回。

### 4.2 单个任务（把下面第一行换成你的问题）

    用 Supervisor Protocol v0 处理这个问题：「<你的问题>」
    workers 用 ["deepseek","glm"]，先并行取候选，再逐条裁决，最后给最终答案 + JSON 信封。

### 4.3 让结果可归档（跑回归时用）

    把两件事一起贴给我：
    1) delegate_batch 的原始返回（含每个子任务的 taskId、usage、evidence、traceId）
    2) 你的 verdict JSON

## 5. 已知的第一号回归样例（必须能识别）

`docs/evals/fixtures/001-lattice-basis.json`：GLM 在 M2c 里给出 `status: completed` 的错误答案——
把晶格点等同于原子、并把基元说成「构成晶格的单元」。supervisor 必须稳定指出这两处，并按
`crystal structure = lattice + basis` 纠正。
