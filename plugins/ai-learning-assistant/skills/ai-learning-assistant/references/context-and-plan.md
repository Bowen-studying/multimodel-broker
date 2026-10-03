# 上下文、资料和计划

正式能力只从原 Current_Learning_State 及明确生效审批读取。Sessions保存学习证据与接续，不另建 current-state.json。最新写入不等于最新发生：historical_backfill 保留发生时间/来源，只补背景；更新的真实课次优先。纠错明确引用原证据，保留历史。

复用本轮入口已固定的目标分支与 target commit，不在本引用中重新取 head。若需要刷新，入口和四份运行文档（TEACHING.md、context-and-plan.md、record-format.md、tool-contract.md）以及相关协议、计划、状态、证据都须在新固定的同一 commit 完整重读，再切换依据。

旧 CURRENT_STATE 的“先问上次做到哪题”若已有 Session 回答，就主动接续；旧“暂无证据”不抹掉后来作答，后来作答也不自动晋级。按课程和日期读近期记录，再沿来源补足；若最近记录有 `continuation.recovery`，以其 anchor 定位、先做 minimalAction，并跳过 `doNotRepeat` 中已有证据支持的工作。旧 Markdown 缺 id/精确提示/日期时保留文件、章节、原话引用，不伪造。最近30条仍不清楚时继续查相关来源；只有真实矛盾无法解时问一个必要问题。

## 共用学习路径与三条轴

规划路径、讲解、练习、历史回填和复盘共用同一 commit 下的协议、课程地图、计划、正式状态及相关 Sessions。计划或地图已有概念标识就沿用；没有时用其可定位章节/目标名称，不自建另一套概念库。选课与选概念时说明它对应哪个已有目标，不能让最近聊天话题替代完整计划。

启动先处理用户本次明确要求；否则优先最近未完成验证、已有 delayed/transfer 缺口和既有计划/记录中已经到期的复习，再考虑新概念。两者都到期时按先修阻塞与既有优先级安排短复核，其余保留 nextStep。只把已有日期明确的安排称为“到期”；没有复习日期就不编造 FSRS/SM-2 排期或宣称逾期。新概念所需基础缺失时先补讲并检验该缺口；历史摘要不足以证明先修已满足，也不要求与新概念无关的所有旧内容先全部掌握。

三条轴是从既有计划与证据重建的事实视图，不是新能力量表：

| 轴 | 依据与边界 |
| --- | --- |
| 课堂进度 | 原目标下的 pending / explained / practiced / verified；只说明本次活动到哪一步。 |
| 自主学习 | 学生自述、实际提交的笔记/作业及可定位来源；自述未核实就明确标注，不能据此推定 H0 或独立能力。 |
| 已独立验证 | 对应概念的真实新题/变式、原话、提示程度与结果；沿用原协议和现有记录对独立验证的条件，未有证据就保留未验证。 |

同一概念可以同时是“课堂已讲解、自述课后读过、独立验证未完成”。三轴在本事件 summary 中写必要事实，plan.items 仍只写本次目标进展；原五级正式能力不由三轴自动换算，不添加概率掌握率。复述、教师示范、动画完成或复习次数均不能代替独立证据。

## Evidence & retention v1

证据链沿用现有 evidence，不另建表：`baseline → immediate → delayed → transfer` 只是可选的观察阶段标签。`delayed` 必须来自真实间隔后的新题或变式，并通过 `retestOf` 连接到早先 evidenceId；`transfer` 检查陌生但相关情境。旧记录没有阶段字段时保持未知，不能回推成 immediate，也不能把一次当场 verified 当作延迟保持。

每条重要证据都要区分它支持什么、不能证明什么，使用 `evidenceLimits.supports` 与 `evidenceLimits.doesNotProve`。一次独立作答最多说明该题及明确条件下的表现；它不能自动证明几天后的保持、陌生情境迁移或未被题目区分的误解。不得用这些边界字段创建 mastery 分数或新的正式能力等级。

周复盘把 retention 放进既有 `week_review`：检查近期当场 verified 且没有 delayed/transfer 复测的高价值 evidence，优先安排一个真实变式；若复盘当下没有新作答，就在 `retentionReview.pendingRetestEvidenceIds` 与 `continuation.nextStep` 留下待办，不写成已保持。只使用记录中实际存在的日期判断到期，不创建后台调度器或第二份周报。

## Course Registry 与 canonical courseId

先在目标 commit 读取 `00_学习系统/COURSE_REGISTRY.md`，用用户请求、Session 路径或 registry 兼容别名解析唯一 `courseId`，再读取该课程的 Plan 与相关 Sessions。新记录只使用 registry 的 canonical `courseId`；旧记录的 `course`、中文课程名和历史 Markdown 只用于兼容读取，不作为新身份。

Registry 只回答“这是什么课、Plan 在哪里、Sessions 如何定位、教材如何 live resolve”，不保存课堂进度、能力等级、掌握率或当前状态。详细进度仍从 append-only Sessions、课程 Plan 和既有正式状态重建；不要为每门课建立第二份 current-state 或 mastery 数据库。

## 材料科学基础

现有入口 `费曼学习/04_周复盘/2026-09-12_材料科学基础周末复盘.md`，每次实时核对及寻找更新计划。目标包含 lattice+motif、motif/化学式/primitive/conventional cell、Miller指数和方向/晶面族、晶体/非晶有序、陌生结构迁移。历史讲解不代表全部完成，不能因最近只聊 g(r) 就丢掉 Miller。

当前历史回填 g(r) 未作答，只是 Exposure；“提示后解释”不能仅凭摘要记为 Assisted Application。默认先复核已讲过而未独立验证的 lattice/motif/cell 关系，再接未完 g(r)，其余保留。读到更新真实记录则用它。原计划时间段是参考；用户后来要求完整概念块教学优先，必要时一节只完成一个块。

## Drive

用当前对话实际可用的 Google Drive 工具；不复制认证，不将本机路径当云文件。依 SOURCE_INDEX 定位 `AI学习资料/材料科学基础`；同名文件夹先读父目录metadata确认，再按文件名、时间、大小、内容选版本，不选搜索第一条。

找到后实际 fetch。partial_text、截断或未提取图表只记录读到部分，具体页/图未见不能声称看过。需要图示用宿主可用能力；资料不可读时说明具体缺口，继续可用内容，不编教材引用。用户说最新/刚上传/更新时每次live refresh，尚未云同步要如实说；不拿旧资料充新版本。保存实际URL、修改时间与 read/index_only/unavailable。

PPT/PPTX 路由必须按 MIME 与扩展名区分：`application/vnd.google-apps.presentation` 才能调用原生 Slides 的 outline/text 工具；`.ppt`/`.pptx`（包括返回 `docs.google.com/presentation/d/...` 外观链接但 MIME 仍为 PowerPoint 的文件）必须用 Drive `fetch` 读取原始文件。二进制 fetch 返回空 `content` 但带 `file_uri`/下载引用时，只能记为 `read`/`partial_text` 的原始文件已取得，不能声称已读到幻灯片文字；连接器对大文件解码失败时记为 `unavailable`，改用精确文件 ID/文件 URL重试一次，不把失败当成文件不存在。需要课堂文字时，应由可用的 Office/PPTX 提取或视觉读取能力另行处理，并把实际页码、标题或“仅取得原文件”写入 sources.note。

教材引用落到实际文件 URL/文件标识和可见定位：PDF 页、PPT 页、章节/标题、图号或时间戳，并在 sources.note 保存版本与读取范围。连接器未返回页码时引用实际可见标题或原文片段并说明页码未知；搜索摘要只算 index_only。讲解中让学生能区分教材结论、教师推导和示意例子。

当讲解明确基于用户提供或课程资料，且原资料中已有相关视觉内容（如电路图、I-U/I-V 曲线、波形、结构图、流程图、实验装置图等）时，必须把该原图或对应页截图**直接以内联图片形式呈现在当前聊天区中**，并且按讲解顺序**夹在与它对应的文字段落之间**：先给必要的一两句上下文 → 紧接对应原图 → 紧接对该图的解释；不要把多张图统一堆在回答顶部或底部。实现时应优先使用**同一多模态输出流**按顺序交错发送文字与图片（例如在一次可混合 text/image 的输出中依次发送文字→原图→解释→下一段文字→下一张原图→解释），避免使用 sandbox Markdown 图片链接、文件卡片或会被宿主聚合成独立工具块的图片输出，因为这些方式不能保证视觉上与文字交错。不能只给 filecite、链接或让用户点击打开，也不自行重绘、用 ASCII 图替代、生成新图或交互图。原图是默认讲解载体。只有原资料中没有该图、原图无法读取或分辨，或用户明确要求重新绘制/补充可视化时，才可生成或绘制，并明确标注为“补充示意”，不能冒充教材原图。此规则跨所有课程通用；工具效果不算学习证据。

## 复盘与信号

周末/四周复盘在下一次启动检查真实学习日期、已完成复盘，不靠后台。除 KEEP/CHANGE/STOP/TEST 外，至少查看一项 delayed retention 缺口或已完成的 delayed/transfer 复测；选2–4项写入本次Session并指向计划/证据，必要时用 `retentionReview` 记录 reviewed/completed/pending evidenceId。能力/优先级仅提建议。

Learning Signal优先保存在同一Session的learningSignal，周复盘同时读取原learning-signals.md和Sessions信号；旧Signal保留。这避免每个检查点竞争写全局文件，也不建立第二份状态。

工作日只随实际活动保存必要证据、困难和接续，不要求额外填完整复盘表。周末复盘从这些同源记录挑选断点、已有到期复习和 delayed retention 缺口；旧答案用来源引用，不复制为本次新 evidence。只有当场新作答才增加新证据；周复盘的安排本身不算保持证据。任一模式遇到待核验操作先恢复同一 operationId，再保存确实新增的活动。

