# Chat 记录格式 v1

写入既有 `00_学习系统/90_Sessions/chat-<operationId>.md`。内容必须是标题 `# AI learning record`、空行、一个 json 代码块。JSON 用两个空格缩进，UTF-8，末尾换行。不要附加第二份总结或虚构 hash。以下是字段说明，实际提交必须替换示例值为读取结果和真实课堂事实；不要将本例当学生证据。

```json
{
  "schema": "chat-learning-record/v1",
  "operationId": "session-unique-001",
  "sessionId": "session-unique",
  "courseId": "materials-science",
  "recordedAt": "2026-09-19T21:00:00+08:00",
  "contextCommit": "真实读取的40位小写commit SHA",
  "kind": "pause",
  "synthetic": false,
  "summary": "本节实际完成情况，不写未发生的验证。",
  "evidence": [],
  "continuation": {
    "nextStep": "下一次可直接开始的具体活动。",
    "unverified": ["仍未验证的目标"]
  },
  "plan": {
    "reference": {
      "path": "费曼学习/04_周复盘/2026-09-12_材料科学基础周末复盘.md",
      "blobSha": "该计划实际返回的40位blob SHA"
    },
    "items": []
  },
  "sources": [
    {"location": "实际读取的资料链接", "status": "read", "note": "文件版本、章节/页码和实际读取范围"}
  ],
  "ALLOW_STATE_UPDATE": false
}
```

### canonical courseId

- `courseId` 是新结构化记录的必填课程身份，必须逐字来自同一提交的 `COURSE_REGISTRY.md`，不能使用显示名称、自由文本或临时缩写。
- `course` 是旧版兼容字段；新记录不依赖它做路由。既有记录中的 `course` 值、旧 Markdown 和旧文件名不重写，只按 registry 兼容映射读取。
- `plan.reference.path` 应指向对应 `courseId` 的正式课程 Plan；`plan.items` 仍然只记录本事件增量，不是课程状态快照。



所有字段均必填，只有 `occurredAt`、`learningSignal`、`proposedStateUpdate` 可省略。未有可读计划时 reference=null 且 items=[]；不假称计划已确认。sources 可为空。recordedAt 使用宿主实际日期/时钟，只有日期就用 YYYY-MM-DD，不编造午夜；能读当前时钟时用带时区的 ISO 时间。历史 occurredAt 保留已知原发生日期/范围，不知则写 unknown。失败重试不更新这些时间。同日顺序不清时查 GitHub 提交顺序/依据链；并行冲突保留候选，不靠 id 字母顺序猜先后。

- operationId/sessionId：ASCII 字母数字开头，之后仅字母数字、下划线、连字符，最多100字符。整个会话沿用 sessionId，每个新事件递增序号。不得重复同一次证据。
- courseId：使用既有课程的 canonical id；材料科学基础为 materials-science。
- kind：checkpoint / pause / close / historical_backfill / week_review。有实际新作答的周复盘可成为新接续；只是回顾旧记录的摘要不覆盖最近课堂。
- continuation：nextStep 具体，unverified 最多20项。
- evidence 最多20项，每项严格使用：
  `{"evidenceId":"唯一安全id","activity":"reconstruction","question":"实际问题","studentAnswer":"学生原话","hintLevel":"H2","outcome":"partial","feedback":"依据和未解决之处","sourceTurn":"来源对话链接及能定位的轮次或独特原话"}`。
  activity 是 reconstruction / practice / independent_verification / transfer；outcome 是 unverified / partial / verified / needs_correction。hintLevel 是 H0-H4 或 unknown。不得把教师示范写成 studentAnswer。独立证据必须有真实新题与无关键提示作答；unknown 不能证明独立。
- plan.items 最多30项，每项 `{"goal":"原计划目标","status":"practiced","evidenceIds":["本事件证据id"]}`，status 为 pending / explained / practiced / verified。它是**本事件增量**，不是整套计划快照。verified 需本事件中 H0 的 independent_verification 或 transfer 且 outcome=verified；只引用本事件的 evidenceId。无新进展时 items=[]。整体进度从原计划和全部相关记录重建，省略不表示退步，也不许重写先前事件。
- sources 最多20项，location/status/note 均必填；status 为 read / index_only / unavailable。仅列出文件名不等于 read。部分读取在 note 写明，不冒称读完整本。
- learningSignal / proposedStateUpdate 是可选文字，不是已执行的能力变更。ALLOW_STATE_UPDATE 必须 false。synthetic=true 只能用于开发明确指定的隔离测试分支，日常接续排除。

## 概念与三轴记录（沿用 v1）

概念关联用现有文本字段表达，不增加 conceptId、masteryScore 或轴状态等 JSON 字段。summary 在必要时写“概念关联：本事件 evidenceId → 现有课程地图概念标识/计划章节目标”；没有现成标识就引用实际章节名称，不创建新课程图。question 和 studentAnswer 保留真实原话，不能为了加标签改写；sourceTurn 保留可定位的原对话轮次。若 plan.items 有本次相关目标，用 goal 和本事件 evidenceIds 连起计划与作答。

summary 同时简要区分本次发生的“课堂进度；自主学习事实及其来源/自述未核实；独立验证对应 evidenceId 或未验证”。只写有变化的事实，不复制整套历史状态，不把“没有本次记录”写成“从未学习”。教材定位存 sources.location 和 sources.note，未核实的自学不猜提示等级，也不将自述包装成独立验证。原五级能力与 H0–H4 口径保持不变。

例：学生在一轮里回答后说“先到这里”，先如实判断这次作答，把原话作为一个 evidence，连同 nextStep 存入 pause。若刚才检查点已保存同一作答，pause 的 evidence=[]、items=[]，只记新接续。不要为了满足格式复制旧答案或伪造独立验证。

内容限制：单个长文字字段最多12000字符，短字段最多1000字符；不得存凭据。普通 Chat 必须执行这些约定；代码 `src/learning/chat-record.ts` 是 broker 的可测试校验/参考实现，读取本 Markdown 不会在 Chat 中自动运行此代码。
