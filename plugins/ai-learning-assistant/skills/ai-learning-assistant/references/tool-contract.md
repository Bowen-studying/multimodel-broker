# 普通 Chat 的 GitHub 读写约定

由当前 Chat 使用官方 GitHub 工具执行，不假定本地四工具存在。get_learning_context / save_learning_record / apply_confirmed_state_change / get_save_receipt 是学习职责；桌面维护 profile 可提供同名工具，普通 Chat 使用以下实际连接能力。

## 读取上下文

仓库 Bowen-studying/ai-learning-system，日常目标分支为 master；测试与验收使用开发测试上下文明确指定的已存在隔离分支。本轮入口已固定 target commit 时直接复用，不重新取 head 替换；仅新对话首次启动且尚无固定版本时，用 GitHub fetch 的 refs/heads/<目标分支> 或 branches/<目标分支> 端点获得并固定 commit SHA。用 fetch_file(ref=该SHA) 和 fetch(contents/tree URL带同一ref) 读取上下文，保留返回的 path/blob SHA。目录处理截断/分页，不能拿搜索不命中证明不存在。

401/403/连接错误不等于404。404也先确认仓库/分支可读。缺工具先搜索宿主 GitHub 能力，不编造调用。
### Course Registry 与 courseId

在同一 `contextCommit` 下先读取 `00_学习系统/COURSE_REGISTRY.md`。新记录的 `courseId` 必须是 registry 中的 canonical id；通过显示名称、旧 `course` 字段或路径得到的只是兼容解析，不能写成新的身份。Registry 不保存 mastery 或实时进度，写入范围仍限于既有 Sessions 与经明确授权的维护文件。

## 写入范围与格式

日常仅 create_file 创建 `00_学习系统/90_Sessions/chat-<operationId>.md`，不修改已有文件、不 delete、不 update_ref。一个记录包含证据、接续与计划进度，单次文件提交足以恢复；GitHub commit 和回读 blob 构成回执，不依赖第二个回执文件。

operationId 首次准备时固定，使用安全 sessionId + 检查点序号；可用可见会话标识的安全片段，没有则首次选唯一安全 sessionId 并一直复用。仅 ASCII 字母数字下划线连字符，长度不超100。同名不同内容停止，不能换 id 避开冲突。

严格采用 [记录格式](record-format.md)，保留原话、真实提示；不含凭据或无关个人内容。日期不确定明示 unknown，不伪造。synthetic 测试只入显式隔离分支，日常排除。

## 保存与核验

1. 固定 id、路径并准备内容；查同一路径。已有且完整内容完全相同则回读核验并复用，不创建；已有不同内容返回 IDEMPOTENCY_CONFLICT，不覆盖。
2. 新写前再次读分支 head，与 contextCommit 比较。若发生变化且从未尝试创建，固定新 commit，在该同一版本完整重读 START_HERE.md、四份运行文档（TEACHING.md、context-and-plan.md、record-format.md、tool-contract.md）和相关学习上下文（包括新增记录及协议/计划），再协调接续，在同 id 草稿更新 contextCommit 并重新定稿。普通的下一次检查点也检查 head；未变化就复用本轮已读版本，不单独替换某份指令或计划。一旦尝试创建（包括超时），冻结原字节，先恢复核验原操作，不修改内容、不用新 id 绕过冲突。
3. 用 create_file 指定 repository_full_name、branch、固定path、完整content和简短提交说明；不把学生原话或晋级判断放进提交消息。
4. 用返回 commit SHA 作为 ref 回读该文件，核对完整内容与实际 blob SHA，再回读当前分支该文件，确保仍同一内容。通过 GitHub fetch 的 commits/<sha> 端点读取 parents（宿主 fetch_commit 若省略 parents，不能臆造）；核实唯一父版本是 contextCommit 且目标路径在父版本不存在。再查 commits?path=<编码路径>&sha=<固定当前head>&per_page=1，最新触及该文件的提交须仍是原创建提交，防止改后还原。核验前后head须一致；移动则补核验。若创建期间发生竞态，报告“已落地但基于旧上下文，待协调”。通过才标 github_verified。回执保留 path/原创建commit/blob/当前head 和不可变 GitHub链接，不自己生成 SHA。
5. create 超时或结果不明：查询同一路径。完整匹配则从该文件提交历史取得真实写入 commit，再核验；不存在则保留待重试且 id 不变；内容不同报冲突。连接失败不是未写入，不能盲目重发。
6. 已有相同内容的重试不要求当前 head 仍等于旧 contextCommit；核对它真实创建的 commit 和内容，不重复写。返回提交但回读失败时说“提交已返回，核验未完成”，保留 commit/id，仅补回读。

新对话从 GitHub 文件和提交重新核验，不依据旧回答的“已保存”。历史普通 Markdown 可读为来源，不冒充新格式验证记录。

## 实际边界

create_file 防止同一路径静默覆盖，但 head读取到创建之间没有全仓库 compare-and-swap。record 保留依据的 contextCommit，只代表当时事实；并行记录要合并事实、保留不兼容接续。正式状态仍走原确认/审批。

GitHub app 授权可能宽于本 Markdown 约定；路径边界依靠本指令与宿主审批，不是服务端强制隔离，不能为了省事降低权限设置。

电脑离线或 Vault 脏不影响云端核验。Broker可选维护四工具的 github_mirror_verified / local_verified 只证明本地，不能替代远端回读。不要要求学生清理Git。

