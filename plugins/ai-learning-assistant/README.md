# AI学习助手教学源

本目录维护 AI 学习助手的教学规则源文件。普通 Chat 运行时直接读取 `ai-learning-system` 中由本目录导出的五份文档；本目录不保存课堂记录、能力状态、课程进度数据库、Google Drive 教材或任何凭据。

课程身份以 `00_学习系统/COURSE_REGISTRY.md` 的 canonical `courseId` 为准。修改 `SKILL.md` 或 `references/` 后，使用仓库脚本导出到目标学习系统：

```text
node scripts/export-github-entry.mjs --destination-root <ai-learning-system checkout>
```

导出脚本只生成：

- `00_学习系统/AI_LEARNING_ASSISTANT/TEACHING.md`
- `00_学习系统/AI_LEARNING_ASSISTANT/assessment.md`
- `00_学习系统/AI_LEARNING_ASSISTANT/context-and-plan.md`
- `00_学习系统/AI_LEARNING_ASSISTANT/record-format.md`
- `00_学习系统/AI_LEARNING_ASSISTANT/tool-contract.md`
- `00_学习系统/AI_LEARNING_ASSISTANT/export-manifest.json`

五份运行文档的维护源在这里；`COURSE_REGISTRY.md`、课程 Plan、Sessions 和正式能力状态仍由 `ai-learning-system` 维护，不从 Broker 导出。context-and-plan.md 核对指定资料的实质内容与实际讲解覆盖；assessment.md 按听者可理解性和专业准确完整性诊断作答、引导表达，并逐项核对任务标准、原话与提示条件。Markdown 执行与导出测试不等于程序化掌握判定。
