# R1 + R2 本地中继

中继只处理设备、通道、HTTP 帧和连接存活。`REGISTRY_DO` 为注册表，`RELAY_DO` 为每设备连接对象；SQLite 迁移为 v1。注册表只持久化三种凭据的 SHA-256 哈希及时间戳，设备上限 100。

## 使用

```sh
cd relay
npm run typecheck
npm run test
npx wrangler dev --port 8799 --log-level error
```

另开终端，在仓库根目录：

```sh
npm run build
node dist/cli/index.js relay setup --url http://127.0.0.1:8799 --name local
node dist/cli/index.js relay start --url http://127.0.0.1:8799
node dist/cli/index.js relay status --url http://127.0.0.1:8799
node dist/cli/index.js relay url
```

设备注册仅创建 `~/.broker-relay-device.json`，权限 600；文件存在时拒绝覆盖。`setup` 与 `url` 仅输出设备标识、脱敏路径、URL 长度与 SHA-256 指纹、token 长度。默认读取已有的 `~/.broker-m1-token` 与 `~/.broker-agent-token`，要求权限为 600。`start` 前台运行，Ctrl-C 停止；`stop` 仅解释操作方式，不管理其他进程。

本地验收：`node scripts/relay-local-e2e.mjs`。脚本先确认 8799 空闲，仅启动并清理自己的 Wrangler 进程组；复用已有本地注册时不修改凭据文件。Wrangler 默认本地持久化目录 `.wrangler/` 已忽略。若保留设备凭据却删除本地注册表，认证会失败；脚本不会自动覆盖凭据。开发访问日志可能包含能力 URL，因此脚本关闭访问日志，不保存子进程输出。

## 协议与实现选择

两侧 `protocol.ts` 是相同的纯函数实现，共享 `fixtures/frames.json` 固定十种帧。请求由中继生成 UUID，默认截止时间 60000 ms，响应块最多 49152 原始字节（65536 base64 字符），序号从零连续递增。HTTP 方法、状态和 MCP 会话头沿传输链路传递；客户端替换鉴权头，仅向固定的 loopback `/mcp` 目标使用本地 token，禁止跟随重定向。

Node 22 全局 WebSocket 不支持自定义 Authorization 头。Worker 的连接入口接受标准 `Authorization: Bearer`，也接受单个 `Sec-WebSocket-Protocol: broker-relay.<agentConnectionToken>`，返回相同子协议；内置 WebSocket 客户端采用后者。此凭据不放 URL，不进入存储或应用日志。HTTP 状态查询仍使用 Bearer。公网通道分别验证各自 token，不能互用。

连接后立即 hello，20 秒心跳；60 秒未确认则客户端重连，服务端通过时间判断与 DO alarm 标记离线并允许接管。重连退避为 250 ms 至 10 秒。断线时已交付的 pending 请求只排队 `outcome_unknown`，未交付的只排队 `req.error/notDelivered`，从不重新发送请求。公网上已等待的请求在断线时获得 502；尚未交付的离线请求获得 503。未返回响应头的超时请求获得 504；HTTP 响应头已发出后无法更改状态码，此时终止响应流。

测试用例运行真实 workerd，但已安装的测试池内置较旧运行时，会将兼容日期回退到 2025-10-11。配置保持任务书要求的 2026-09-16；Wrangler 本地端到端另行实测。测试池旧版本的 SQLite 隔离栈存在清理错误，因此设置 `isolatedStorage:false`，每例显式清空注册表，连接用例关闭自己的 socket；不更改依赖版本范围。

## 范围与下一步

本批包含验收所需 `/mcp/<deviceId>/<channel>/<token>` 转发入口，不包含任何工具或业务处理。本次未部署 Cloudflare 账号，未获得真实 workers.dev 地址。R3 需要部署、验证永久 URL、通过 readonly 的真实业务调用，再在明确授权下验证 agent 写入；当前 quick tunnel 继续保留。R4 还需全面验证 HTTP 兼容性、长时 SSE、背压与流量限制；当前请求体上限为 49152 字节，响应按块读取，但尚未加入跨 WebSocket 消费者的背压协议。

仓库原有 `dependencies` 并非空，另有既有 optional dependency；本次不改变这些声明，不新增 broker 运行时依赖。
