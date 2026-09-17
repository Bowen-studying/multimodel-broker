# R1 + R2 验收记录

验收日期：2026-09-17。以下为最终版本实际执行的命令及合并 stdout/stderr 原始输出，未删改警告、耗时或测试行。三个命令均退出 0。

结论：本批本地验收完成。Worker 8 项测试通过；broker 220 项测试通过，既有 214 项测试及断言未修改，新增 6 项。端到端使用真实 8789/8790 实例的 MCP 初始化和工具枚举，没有执行任何工具调用。强制断线后的假端点计数证明请求未重放。

首次端到端执行已通过注册接口创建 `~/.broker-relay-device.json`（600）；下面最终复验复用该文件，不覆盖任何凭据。脚本保留首次创建路径，CLI `setup` 同样拒绝覆盖既有文件。

## Worker 验收

```sh
cd relay && npm run typecheck && npm run test
```

退出码：0。原始输出：

```text

> multimodel-broker-relay@0.1.0 typecheck
> tsc --noEmit


> multimodel-broker-relay@0.1.0 test
> vitest run


 RUN  v3.2.7 /home/<you>/projects/multimodel-broker/relay

Proxy environment variables detected. We'll use your proxy for fetch requests.
[vpw:info] Starting single runtime for vitest.config.ts...
[mf:warn] The latest compatibility date supported by the installed Cloudflare Workers Runtime is "2025-10-11",
but you've requested "2026-09-16". Falling back to "2025-10-11"...
workerd/jsg/util.c++:395: info: exception = workerd/api/web-socket.c++:779: disconnected: WebSocket peer disconnected
workerd/jsg/util.c++:395: info: exception = workerd/api/web-socket.c++:779: disconnected: WebSocket peer disconnected
workerd/jsg/util.c++:395: info: exception = workerd/api/web-socket.c++:779: disconnected: WebSocket peer disconnected
workerd/jsg/util.c++:395: info: exception = workerd/api/web-socket.c++:779: disconnected: WebSocket peer disconnected
 ✓ tests/worker.test.ts (8 tests) 354ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  14:58:32
   Duration  3.37s (transform 78ms, setup 0ms, collect 139ms, tests 354ms, environment 0ms, prepare 910ms)

[vpw:debug] Shutting down runtimes...
```

## broker 验收

```sh
cd /home/<you>/projects/multimodel-broker && npm run check && npm run build && npm test
```

退出码：0。原始输出：

```text

> multimodel-broker@0.1.0 check
> tsc --noEmit -p tsconfig.json


> multimodel-broker@0.1.0 build
> tsc -p tsconfig.build.json


> multimodel-broker@0.1.0 test
> vitest run


 RUN  v5.0.1 /home/<you>/projects/multimodel-broker

(node:146713) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/unit/worker-health.test.ts (5 tests) 53ms
 ✓ tests/unit/paths.test.ts (16 tests) 72ms
 ✓ tests/unit/trace-store.test.ts (3 tests) 122ms
 ✓ tests/unit/task-manager.test.ts (13 tests) 202ms
(node:146668) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/integration/sqlite-store.test.ts (6 tests) 116ms
 ✓ tests/unit/scheduler.test.ts (3 tests) 99ms
 ✓ tests/unit/openai-compatible.test.ts (10 tests) 310ms
(node:146766) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/unit/config.test.ts (10 tests) 133ms
 ✓ tests/unit/doctor.test.ts (3 tests) 95ms
 ✓ tests/unit/relay-connection.test.ts (3 tests) 79ms
 ✓ tests/integration/codex-provider.test.ts (10 tests) 412ms
   ✓ CodexProvider (10)
     ✓ records real tool events at the default level too, but never reasoning items 372ms
 ✓ tests/unit/router-providers.test.ts (4 tests) 77ms
 ✓ tests/unit/redaction.test.ts (12 tests) 50ms
 ✓ tests/unit/router.test.ts (15 tests) 52ms
 ✓ tests/unit/mock-provider.test.ts (6 tests) 31ms
 ✓ tests/unit/tool-schemas.test.ts (18 tests) 29ms
 ✓ tests/unit/logger.test.ts (2 tests) 24ms
 ✓ tests/unit/relay.test.ts (3 tests) 21ms
 ✓ tests/unit/policy.test.ts (6 tests) 27ms
 ✓ tests/unit/evals.test.ts (5 tests) 10ms
 ✓ tests/unit/annotations.test.ts (16 tests) 15ms
 ✓ tests/integration/mcp-http.test.ts (16 tests) 1212ms
   ✓ mcp http server (15)
     ✓ runs a worker end to end and returns the envelope 313ms
 ✓ tests/integration/idempotency.test.ts (4 tests) 1448ms
   ✓ idempotency (4)
     ✓ returns the same taskId twice and runs the worker only once 337ms
     ✓ returns the existing running task instead of starting a second execution 464ms
     ✓ never starts a second execution for a task another broker process owns (shared SQLite) 390ms
 ✓ tests/integration/provider-retry.test.ts (7 tests) 1470ms
   ✓ provider retry and failure classification (7)
     ✓ retries a 429 and then succeeds 426ms
 ✓ tests/integration/broker-long-task.test.ts (1 test) 1731ms
   ✓ long-running Broker tasks (1)
     ✓ returns quickly, survives handler return, and reuses the same running and completed task 1730ms
 ✓ tests/integration/batch.test.ts (4 tests) 1932ms
   ✓ delegate_batch (4)
     ✓ returns every child outcome and a partial_success parent when one child fails 929ms
     ✓ runs children concurrently but never above maxConcurrency 827ms
 ✓ tests/integration/broker-delegate.test.ts (9 tests) 1948ms
   ✓ Broker delegation (9)
     ✓ routes, completes, records usage, and returns an auditable route and trace 361ms
     ✓ preserves every child outcome when one worker fails and two succeed 739ms
     ✓ retries bounded retryable failures and never retries ambiguous post-send failures 335ms
 ✓ tests/integration/mcp-stdio.test.ts (8 tests) 4239ms
   ✓ mcp stdio server (real child process) (8)
     ✓ returns a taskId for a long task instead of blocking, then completes via get_task 2745ms
     ✓ keeps partial results when one batch child fails 388ms
 ✓ tests/integration/provider-timeout.test.ts (2 tests) 8982ms
   ✓ provider timeout (2)
     ✓ times out a server that never answers and aborts the socket 4635ms
     ✓ does not raise an unhandled rejection when a hung response arrives after the deadline 4346ms

 Test Files  29 passed (29)
      Tests  220 passed (220)
   Start at  14:58:35
   Duration  9.82s (tests 74%, transform 14%, import 12%, worker 1%)

```

## 本地端到端验收

```sh
node scripts/relay-local-e2e.mjs
```

退出码：0。原始输出：

```text
PASS wrangler dev --port 8799 ready
PASS reused existing mode-600 relay device file without modification
deviceId=a80d6926-…
readonly: http://127.0.0.1:8799/mcp/a80d6926-…/readonly/<redacted> URL length=115 sha256=e24e75ef261ae222 token length=43
agent: http://127.0.0.1:8799/mcp/a80d6926-…/agent/<redacted> URL length=112 sha256=241be6c31fae8851 token length=43
connected channels=readonly,agent
PASS status online channels=readonly,agent
PASS readonly initialize HTTP 200
PASS readonly notifications/initialized HTTP 202
PASS readonly tools/list HTTP 200
PASS readonly tools (7): ping, list_workers, run_worker, delegate, delegate_batch, get_task, get_trace
PASS readonly session cleanup HTTP 200
PASS agent initialize HTTP 200
PASS agent notifications/initialized HTTP 202
PASS agent tools/list HTTP 200
PASS agent tools (8): ping, list_workers, run_worker, run_agent, delegate, delegate_batch, get_task, get_trace
PASS agent session cleanup HTTP 200
PASS relay start CLI foreground shutdown
connected channels=readonly,agent
reconnected channels=readonly,agent
PASS forced socket close reconnected and status online
connected channels=readonly,agent
reconnected channels=readonly,agent
PASS no replay: delivered request count=1 after disconnect/reconnect
PASS fresh request after reconnect: total count=2
PASS all local end-to-end assertions
CLEANUP only test relay processes and fake endpoint stopped; existing brokers and tunnels untouched
```

## 未完成/阻塞

- 本批三条本地验收命令没有未通过项。
- 未向真实 Cloudflare 账号部署，未获得或验证永久 workers.dev 地址；本任务的验收按任务书要求使用本地 workerd，无需账号。不能将本地通过等同于生产部署完成。
- 仓库起始状态的 broker dependencies 已含 `@modelcontextprotocol/sdk`、`yaml`、`zod`，并有既有 optional dependency；与任务书“保持为空”的前提不符。本次保持所有依赖声明和锁文件原样，不新增运行时依赖，也不移除既有依赖。
- Node 22 内置 WebSocket 不支持自定义 Authorization 头，因此客户端使用 `broker-relay.<token>` 子协议鉴权；Worker 同时支持任务书指定的 Bearer 头。状态查询使用 Bearer；公网和本地 token 始终分离。子协议凭据不会进入应用日志。
- 已安装测试池的运行时兼容日期回退至 2025-10-11，最终输出原样保留了警告；wrangler.jsonc 仍为 2026-09-16。开发过程中发现旧测试池 SQLite isolated-storage 清理错误，改为单运行时并逐例清空注册表后通过，没有改动依赖版本范围。超时测试在对应 DO 上下文推进时钟，避免跨 DO I/O 错误。
- 已发送 HTTP 响应头后无法把状态改成 504；发生超时则中止流。尚未发送响应头的 pending 超时已用真实 Worker 测试验证为 504。更长时间的 SSE、背压和完整 HTTP 边界测试留待 R4。

## 新增/修改的文件清单

- `relay/.gitignore`
- `relay/R2-VERIFY.md`
- `relay/README.md`
- `relay/fixtures/frames.json`
- `relay/src/device.ts`
- `relay/src/protocol.ts`
- `relay/src/registry.ts`
- `relay/src/tokens.ts`
- `relay/src/worker.ts`
- `relay/tests/worker.test.ts`
- `relay/tsconfig.json`
- `relay/vitest.config.ts`
- `relay/wrangler.jsonc`
- `scripts/relay-local-e2e.mjs`
- `src/cli/index.ts`
- `src/cli/relay.ts`
- `src/relay/client.ts`
- `src/relay/connection.ts`
- `src/relay/protocol.ts`
- `src/relay/registration.ts`
- `tests/unit/relay-connection.test.ts`
- `tests/unit/relay.test.ts`

仓库外仅新增设备凭据文件 `~/.broker-relay-device.json`，权限 600，内容不纳入验收记录或版本控制。构建输出 `dist/` 和 Wrangler 本地注册表 `.wrangler/` 为忽略的生成文件。未提交或推送 git；未更改、停止或重启现有 broker 和 quick tunnel。

## 命令与真实输出摘要

- `cd relay && npm run typecheck && npm run test`：`Tests  8 passed (8)`。
- `cd /home/<you>/projects/multimodel-broker && npm run check && npm run build && npm test`：`Tests  220 passed (220)`。
- `node scripts/relay-local-e2e.mjs`：`PASS all local end-to-end assertions`；`PASS no replay: delivered request count=1 after disconnect/reconnect`。

## 下一步：R3

部署到 Cloudflare 账号并确认永久 workers.dev 地址，使用独立部署设备凭据接入；先验证 readonly 真实业务，再在明确授权下验证 agent 写入。当前注册凭据对应本地 8799 验收环境，不可假称生产地址。继续保留现有 quick tunnel；R4 补齐 HTTP/SSE/背压覆盖，R5 扩展进程和机器级故障恢复实验。
