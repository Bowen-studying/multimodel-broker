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



所有核心字段均必填，只有 `occurredAt`、`learningSignal`、`proposedStateUpdate`、`continuation.recovery`、`retentionReview` 可省略。未有可读计划时 reference=null 且 items=[]；不假称计划已确认。sources 可为空。recordedAt 使用宿主实际日期/时钟，只有日期就用 YYYY-MM-DD，不编造午夜；能读当前时钟时用带时区的 ISO 时间。历史 occurredAt 保留已知原发生日期/范围，不知则写 unknown。失败重试不更新这些时间。同日顺序不清时查 GitHub 提交顺序/依据链；并行冲突保留候选，不靠 id 字母顺序猜先后。

- operationId/sessionId：ASCII 字母数字开头，之后仅字母数字、下划线、连字符，最多100字符。整个会话沿用 sessionId，每个新事件递增序号。不得重复同一次证据。
- courseId：使用既有课程的 canonical id；材料科学基础为 materials-science。
- kind：checkpoint / pause / close / historical_backfill / week_review。有实际新作答的周复盘可成为新接续；只是回顾旧记录的摘要不覆盖最近课堂。
- continuation：nextStep 具体，unverified 最多20项。
- evidence 最多20项，每项至少使用：
  `{"evidenceId":"唯一安全id","activity":"reconstruction","question":"实际问题","studentAnswer":"学生原话","hintLevel":"H2","outcome":"partial","feedback":"依据和未解决之处","sourceTurn":"来源对话链接及能定位的轮次或独特原话"}`。
  `activity` 是 reconstruction / practice / independent_verification / transfer；`outcome` 是 unverified / partial / verified / needs_correction。`hintLevel` 是 H0-H4 或 unknown。不得把教师示范写成 studentAnswer。独立证据必须有真实新题与无关键提示作答；unknown 不能证明独立。
- Evidence & Retention v1 在不改变 `chat-learning-record/v1` 的前提下增加可选字段：
  `evidencePhase` 为 baseline / immediate / delayed / transfer；delayed 必须是经过真实间隔后的新题或变式，并用 `retestOf` 指向较早 Session 中的 evidenceId。`transfer` 表示陌生但相关情境，不等同于 delayed。
  `evidenceLimits` 形如 `{"supports":["这次作答支持的具体判断"],"doesNotProve":["这次作答仍不能证明的保持、迁移或边界"]}`；两组各最多5项。新记录的 independent_verification / transfer 或 outcome=verified 应填写它们；旧记录缺少这些字段时不回填、不判 invalid。
- 中断或跨设备恢复时，可在 `continuation` 下增加 `recovery`：`{"anchor":"最近已确认的 evidenceId、记录或计划目标","minimalAction":"下一次先做的最小动作","doNotRepeat":["已有证据支持、无需重做的事项"]}`。它是接续提示，不是第二份状态；无中断时省略。
- `kind=week_review` 时可增加 `retentionReview`：`{"reviewedEvidenceIds":["本次检查的旧 evidenceId"],"completedRetestEvidenceIds":["本事件新建的 delayed/transfer evidenceId"],"pendingRetestEvidenceIds":["仍待延迟复测的旧 evidenceId"],"nextStep":"下一项具体复测动作"}`。没有新作答时 `completedRetestEvidenceIds=[]`，不能把计划当成保持证据。
- plan.items 最多30项，每项 `{"goal":"原计划目标","status":"practiced","evidenceIds":["本事件证据id"]}`，status 为 pending / explained / practiced / verified。它是**本事件增量**，不是整套计划快照。verified 需本事件中 H0 的 independent_verification 或 transfer 且 outcome=verified；只引用本事件的 evidenceId。无新进展时 items=[]。整体进度从原计划和全部相关记录重建，省略不表示退步，也不许重写先前事件。
- sources 最多20项，location/status/note 均必填；status 为 read / index_only / unavailable。仅列出文件名或取得未解析的原文件不等于 read，记 index_only 并注明内容未读；实际读取部分内容时可记 read，但须在 note 写明范围和未见图表，不冒称读完整本。partial_text 只可描述工具返回的读取限制，不能写成新的 status 枚举。
- learningSignal / proposedStateUpdate 是可选文字，不是已执行的能力变更。ALLOW_STATE_UPDATE 必须 false。synthetic=true 只能用于开发明确指定的隔离测试分支，日常接续排除。

## 作答判定留证（沿用 v1 字段）

每次评价先执行同版本 [学习程度判定规范](assessment.md)。重要作答的 `feedback` 写清目标与判据来源，并逐项保存“必要要求 → 学生原话/作品定位 → 满足、部分、矛盾或未观察到”，最后写关键缺口、内容结论、实际提示条件和下一步。全部必要内容满足且无关键错误才能使用 `outcome=verified`，不能只写“差不多/基本正确”。不添加新的 JSON 字段或总分。

`reconstruction` / `practice` 的 verified 仅表示该次活动内容达标，提示依赖必须保留，不能称为独立掌握。`independent_verification` / `transfer` 的 verified 还需 H0、有效新题及未泄露的关键解法。`plan.items.status=verified` 须有相应独立证据覆盖该 goal 的全部必要内容；只验证子目标时明确子目标，不能用部分证据验证整章。

未完成项用 `continuation.unverified` 和 `nextStep` 接续；`evidenceLimits` 说明此次支持与未证明的范围。保持原始 question/studentAnswer，不把事后新增要求、教师补全或多轮被提示的片段改造成独立作答。旧记录缺少此种 feedback 结构仍可读取，不补猜、不批量重写；正式能力变更继续走原确认规则。

## 材料覆盖与表达帮助（沿用 v1 字段）

按 [指定资料的内容覆盖](context-and-plan.md#指定资料的内容覆盖) 留下可恢复的范围、定位和处理增量，不新增 coverage、role、expressionScore、掌握率或状态文件。听者视角与专业复核是同一作答的检查方式，不创建重复 evidence；实际作答或后续新重构才按真实活动留证。

| 事实 | 既有字段与写法 |
| --- | --- |
| 本次指定材料与实际读取范围 | sources.location 存真实文件 URL/标识；sources.note 存版本、页/图/章节、已读取与待核查部分，不能用文件已取得替代内容已读 |
| 内容映射与覆盖核对 | summary 按实际来源分组写“来源定位→实质知识/独有条件→原目标→实际讲解或学习页定位→本次处理/缺口”；首次记已核查范围，后续只记变化并引用旧 Session 路径及分组 |
| 原课程目标的新增教学进展 | plan.items 沿用原目标和现有 status；只有实际发生的讲解才记 explained，已准备学习页不等于已讲解，已教不等于 verified |
| 表达组织与专业内容的诊断 | 对应作答的 feedback 分清“表述未清楚/尚无法判断”与“已观察到知识错误”，注明教师实际给出的澄清、组织框架、关系提示或范例及最高 hintLevel |
| 未教、未核查与学生待修复项 | continuation.unverified 用文字注明缺口类型、范围和详细清单的实际记录定位；nextStep 指向下一具体核查、补讲或作答任务，未教/未核查本身不构成学生答错证据 |
| 当前证据边界 | evidenceLimits 说明知识内容、表达组织及独立性中实际证明和未证明的部分；学生只认可教师整理稿，不据此虚构新的独立表达 |

组织框架是否构成关键帮助，依本次被评能力与实际供给判断，不能一律记 H0；若评的是自主组织论证，教师给出结构也可能帮助了目标能力。studentAnswer 始终保留原话，教师润色、重排或补出的解释只能作为反馈或教学事实。没有新测评作答的资料核查/备课记录使用 evidence=[]；plan.items 也只留本事件真实增量，不给每条资料清单虚构学生证据或新正式目标。对未教内容若已有实际作答，仍按真实回答评价，同时分开记录教师待补教学和已观察到的学生错误，不因未教而抹去真实作答。

严格保持既有上限：sources 20项、plan.items 30项、continuation.unverified 20项、evidence 20项，长文字字段12000字符、短字段1000字符。资料多时按原章节/模块分组，组内保留每个不同实质内容的来源定位、独有条件及处理；分组只压缩导航，不合并抹去未完成项。同一资料可在一项 sources 中写本次读取范围，完整内容明细放入有定位的 summary；超出单字段或单记录上限时按自然章节分批保存**真实新增**的覆盖核查/教学事件，每批沿用正常 operationId 冻结、重试和回读规则。

跨批次用实际 Session 路径和其中的章节/页范围分组定位连接明细；续接记录保留尚未处理的全部范围以及各组详细清单位置，较多缺口可按原模块分组后引用明细。不能只写“其余以后再说”、截去第21项以后的内容，或用“已覆盖某章”替代该章未完成清单。已有明细与学生证据只引用，不复制成新事件；未核验保存的批次明确待恢复，不能宣称覆盖记录完整可恢复。恢复时沿这些定位读取各批增量，未出现在新记录中不表示已完成、删除或退步。

## 命题用途与后续任务（沿用 v1 字段）

按同版本 [命题、诊断与巩固](question-design.md) 记录真实任务与作答，不新增 questionType、role、questionQualityScore、调度状态或 activity 枚举。多视角检查同一份答案仍只是一条实际作答证据。

- question 保留实际出示的题干、必要受众、资源和完成要求；题型标签、事后追问或教师答案不能补写成原题已经告知的要求。
- feedback 简记本题主要用途、原目标与来源、实际观察、候选原因的依据、必要项结论和下一步。错误选项不直接等于稳定误解；题目条件或答案键存在问题时，注明受影响范围保持 unverified，不能以此给学生制造 needs_correction。独立成立的子项仍据实评价。
- evidenceLimits 限定本题对知识、表达、执行、独立、保持或迁移的支持范围；选择题只收选择时不能据此补出机制理解。题内提供例题或错误解答是任务条件，对独立性的影响按被评能力和实际帮助判断；能找错不自动证明能从零完成。
- evidencePhase、retestOf 按真实发生时间、任务与旧证据使用；诊断、提取或自信报告不是新的 activity。提示已给、答案已暴露的作答按实际 reconstruction/practice 等类型记录，不靠“复测/迁移”命名升级。
- continuation 保留具体下一任务的目标、要区分的规则、必要未教内容和既有复习时点；恢复时先读真实旧证据，向学生发题前不复述将被检验的关键答案。未确定时点不编造已确认日期，不自动创建提醒。
- 只有备题、安排复习、教师自解或验题而没有新测评作答时，evidence=[]，必要信息放 summary 或 continuation，不创造学生能力、练习或保持进展。已有记录通过新事实接续，不覆盖历史题目与原话。

## 概念与三轴记录（沿用 v1）

概念关联用现有文本字段表达，不增加 conceptId、masteryScore 或轴状态等 JSON 字段。上述可选字段只补充证据阶段、边界和恢复关系，不是新的能力等级或掌握率。summary 在必要时写“概念关联：本事件 evidenceId → 现有课程地图概念标识/计划章节目标”；没有现成标识就引用实际章节名称，不创建新课程图。question 和 studentAnswer 保留真实原话，不能为了加标签改写；sourceTurn 保留可定位的原对话轮次。若 plan.items 有本次相关目标，用 goal 和本事件 evidenceIds 连起计划与作答。

summary 同时简要区分本次发生的“课堂进度；自主学习事实及其来源/自述未核实；独立验证对应 evidenceId 或未验证”。只写有变化的事实，不复制整套历史状态，不把“没有本次记录”写成“从未学习”。教材定位存 sources.location 和 sources.note，未核实的自学不猜提示等级，也不将自述包装成独立验证。原五级能力与 H0–H4 口径保持不变。

例：学生在一轮里回答后说“先到这里”，先如实判断这次作答，把原话作为一个 evidence，连同 nextStep 存入 pause。若刚才检查点已保存同一作答，pause 的 evidence=[]、items=[]，只记新接续。不要为了满足格式复制旧答案或伪造独立验证。

内容限制：单个长文字字段最多12000字符，短字段最多1000字符；`evidence` 最多20项，`evidenceLimits.supports` 和 `doesNotProve` 各最多5项，`retentionReview` 的每个 evidenceId 列表最多20项，`continuation.recovery.doNotRepeat` 最多10项；不得存凭据。普通 Chat 按本 Markdown 检查格式与内容；文档被读取、格式符合约定或导出检查通过，均不等于已经运行独立评分器或程序化验证了学生掌握程度。
