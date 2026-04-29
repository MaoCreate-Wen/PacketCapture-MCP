# PacketCapture-MCP 操作手册

PacketCapture-MCP 是一个基于 TypeScript/Node.js 的 MCP 服务器，用于导入、实时接收、浏览、分析和重放 HTTP 抓包数据。项目当前重点支持 Reqable 抓包工作流，同时也支持 HAR、JSON 和 cURL 输入。

## 1. 功能概览

PacketCapture-MCP 提供以下能力：

- 导入 HAR 1.2、Reqable/common JSON、cURL、Reqable bridge NDJSON。
- 启动本地 Reqable Report Server，实时接收 Reqable 推送的完整 HTTP 会话。
- 长轮询监听新流量事件，适合 MCP 客户端持续观察目标应用流量。
- 浏览 capture 数据集和 HTTP session。
- 获取完整请求报文和对应响应报文。
- 按 URL、host、method、status、headers、body 搜索 HTTP exchange。
- 对全量 capture 或单个 HTTP exchange 做安全、隐私、性能分析。
- 生成 Markdown 或 JSON 报告。
- 基于已捕获请求生成重放计划，并在显式授权后执行请求重放。

## 2. 环境要求

- Windows、macOS 或 Linux。
- Node.js 20 或更高版本。
- npm。
- 可选：Reqable，用于实时抓包和 Report Server 推送。

安装依赖：

```powershell
npm install
```

构建项目：

```powershell
npm run build
```

开发模式启动 MCP server：

```powershell
npm run dev
```

生产模式启动 MCP server：

```powershell
npm run build
npm start
```

## 3. MCP 客户端接入

本项目是 stdio MCP server。常见 MCP 客户端可以使用以下命令启动：

```json
{
  "command": "node",
  "args": [
    "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP\\dist\\index.js"
  ]
}
```

开发阶段也可以直接使用 tsx：

```json
{
  "command": "npx",
  "args": [
    "tsx",
    "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP\\src\\index.ts"
  ]
}
```

推荐生产使用 `dist/index.js`，因为 MCP 客户端启动更稳定，也避免运行时 TypeScript 编译成本。

### 3.1 IDE / MCP 客户端发现与启动

`package.json` 提供了面向 MCP 客户端的稳定启动脚本：

```powershell
npm run mcp:start
```

该脚本等价于 `node dist/index.js`，适合 IDE、Claude Desktop、Cursor、Windsurf 或其他 MCP 客户端在已构建后启动本地 server。开发时可以使用：

```powershell
npm run mcp:dev
```

推荐在客户端配置里优先使用 npm 脚本，避免直接绑定到后续可能变化的实现路径：

```json
{
  "command": "npm",
  "args": [
    "--prefix",
    "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
    "run",
    "mcp:start"
  ]
}
```

更多可复制配置见 [`docs/mcp-client-config.md`](docs/mcp-client-config.md)，覆盖 Claude Desktop、Cursor、VS Code/Cline、VS Code/Roo Code，并同时提供直接运行 `dist/index.js` 与通过 `npm start` 启动两种模板。基础 JSON 示例位于 [`examples/mcp-client-config.dist-node.json`](examples/mcp-client-config.dist-node.json) 和 [`examples/mcp-client-config.npm-start.json`](examples/mcp-client-config.npm-start.json)。

## 4. 推荐工作流

典型操作顺序：

1. 启动 MCP server。
2. 使用 Reqable Report Server 实时接收流量，或导入已有 HAR/JSON/cURL。
3. 使用 `list_captures` 查看当前 MCP 进程内的数据集。
4. 使用 `list_sessions` 或 `wait_for_reqable_traffic` 找到目标 session。
5. 使用 `get_http_exchange` 获取完整请求与响应。
6. 使用 `analyze_capture` 或 `analyze_http_exchange` 执行分析。
7. 使用 `generate_report` 生成报告。
8. 需要复现请求时，先用 `build_replay_request` 查看计划，再用 `replay_http_request` 执行。
9. 使用 `clear_capture` 清理不再需要的内存数据。

## 5. Reqable 实时监听配置

### 5.1 启动本地 Report Server

在 MCP 客户端中调用：

```text
start_reqable_report_server({
  "host": "127.0.0.1",
  "port": 9419,
  "captureId": "reqable-report-live"
})
```

返回结果中重点关注：

- `receiverUrl`：默认接收地址。
- `ingestUrls.har`：Reqable Report Server 推送 HAR JSON 的地址。
- `ingestUrls.bridge`：Reqable bridge script 推送单条 HTTP transaction 的地址。
- `captureId`：实时导入后的数据集 ID。

如果端口冲突，可以传 `port: 0` 让系统自动分配端口：

```text
start_reqable_report_server({
  "port": 0,
  "captureId": "reqable-report-live"
})
```

查看服务状态：

```text
get_reqable_report_server_status({})
```

停止服务：

```text
stop_reqable_report_server({})
```

### 5.2 在 Reqable 中配置 Report Server

1. 打开 Reqable。
2. 确认代理或抓包模式已经启用。
3. 进入 Reqable 的 Report Server 配置入口。
4. 将 URL 设置为 MCP 返回的 `ingestUrls.har`。
5. 保存配置。
6. 访问目标应用或网页，产生 HTTP/HTTPS 流量。
7. 回到 MCP 客户端调用 `wait_for_reqable_traffic` 等待新事件。

监听新流量：

```text
wait_for_reqable_traffic({
  "afterSequence": 0,
  "timeoutMs": 30000,
  "limit": 50
})
```

持续监听时，把上一次返回的 `currentSequence` 作为下一次 `afterSequence`：

```text
wait_for_reqable_traffic({
  "afterSequence": 12,
  "timeoutMs": 30000,
  "limit": 50
})
```

直接拉取最近事件：

```text
get_reqable_realtime_events({
  "afterSequence": 0,
  "limit": 50
})
```

### 5.3 分析实时 capture

Reqable 推送进来的会话会保存到 `captureId` 对应的数据集中，例如 `reqable-report-live`。

```text
analyze_reqable_report_capture({
  "captureId": "reqable-report-live",
  "maxFindings": 200
})
```

生成 Markdown 报告：

```text
generate_report({
  "captureId": "reqable-report-live",
  "format": "markdown"
})
```

## 6. Reqable Bridge 脚本模式

Report Server 是优先推荐路径。Bridge 脚本模式适用于需要 Reqable 脚本把 HTTP transaction 写入本地 NDJSON inbox，或同时 POST 到 MCP receiver 的场景。

### 6.1 准备 bridge 脚本

```text
prepare_reqable_automation({
  "installPath": "C:\\Program Files\\Reqable",
  "overwriteScript": true
})
```

或者只生成脚本：

```text
write_reqable_bridge_script({
  "receiverUrl": "<ingestUrls.bridge>",
  "overwrite": true
})
```

查看 bridge 配置：

```text
get_reqable_bridge_config({})
```

查看 inbox 状态：

```text
get_reqable_inbox_status({})
```

### 6.2 环境变量

可以通过环境变量覆盖默认路径：

```powershell
$env:REQABLE_MCP_INBOX="C:\path\to\reqable-inbox"
$env:REQABLE_MCP_EVENTS_FILE="events.ndjson"
$env:REQABLE_MCP_RECEIVER_URL="http://127.0.0.1:9419/reqable/report/<token>/bridge"
```

也可以在工具参数里传入：

```text
get_reqable_inbox_status({
  "inboxDir": "C:\\path\\to\\reqable-inbox",
  "eventsFile": "events.ndjson"
})
```

### 6.3 导入 bridge inbox

```text
import_reqable_inbox({
  "inboxDir": "examples",
  "eventsFile": "reqable-bridge-sample.ndjson",
  "captureId": "reqable-inbox-demo",
  "archive": false
})
```

导入并直接分析：

```text
analyze_reqable_inbox({
  "inboxDir": "examples",
  "eventsFile": "reqable-bridge-sample.ndjson",
  "captureId": "reqable-inbox-demo",
  "archive": false,
  "maxFindings": 100
})
```

`archive: true` 会在成功导入后归档当前事件文件，并创建新的空事件文件，适合批处理。

## 7. 导入已有抓包文件

### 7.1 导入 HAR

```text
import_capture_file({
  "path": "examples/sample.har",
  "format": "har",
  "captureId": "sample-har"
})
```

### 7.2 自动识别格式

```text
import_capture_file({
  "path": "C:\\captures\\target.har",
  "format": "auto",
  "captureId": "target-capture"
})
```

支持格式：

- `har`
- `json`
- `curl`
- `auto`

### 7.3 导入 cURL

```text
import_curl({
  "captureId": "curl-demo",
  "command": "curl -X POST -H 'Content-Type: application/json' --data '{\"username\":\"demo\"}' 'https://api.example.test/v1/login'"
})
```

cURL 导入通常只有请求，没有真实响应；适合构建请求样本、分析敏感参数或执行受控重放。

## 8. 浏览 Capture 和 Session

列出所有 capture：

```text
list_captures({})
```

列出 session：

```text
list_sessions({
  "captureId": "sample-har",
  "offset": 0,
  "limit": 50
})
```

按 host 过滤：

```text
list_sessions({
  "captureId": "sample-har",
  "host": "api.example.test",
  "limit": 50
})
```

按方法和状态分类过滤：

```text
list_sessions({
  "captureId": "sample-har",
  "method": "POST",
  "statusClass": "2xx",
  "limit": 50
})
```

按关键词搜索：

```text
list_sessions({
  "captureId": "sample-har",
  "keyword": "login",
  "limit": 50
})
```

查看单个 session：

```text
get_session({
  "captureId": "sample-har",
  "sessionId": "<session-id>",
  "includeBodies": false
})
```

包含 body：

```text
get_session({
  "captureId": "sample-har",
  "sessionId": "<session-id>",
  "includeBodies": true,
  "bodyLimit": 8000
})
```

## 9. 完整请求与响应报文分析

获取一个完整 HTTP exchange：

```text
get_http_exchange({
  "captureId": "sample-har",
  "sessionId": "<session-id>",
  "includeBodies": true,
  "bodyLimit": 8000,
  "redactSensitive": true,
  "includeRawText": true
})
```

参数说明：

- `includeBodies`：是否返回请求体和响应体。
- `bodyLimit`：每个 body 最大返回字符数。
- `redactSensitive`：是否脱敏 token、cookie、authorization、password、email、phone 等信息。
- `includeRawText`：是否返回重构后的 HTTP-like raw text。

搜索完整 exchange：

```text
search_http_exchanges({
  "captureId": "sample-har",
  "keyword": "qwen",
  "includeBodies": false,
  "includeRawText": false,
  "limit": 50
})
```

只搜 body：

```text
search_http_exchanges({
  "captureId": "sample-har",
  "body": "access_token",
  "includeBodies": true,
  "bodyLimit": 4000,
  "limit": 20
})
```

只搜 header：

```text
search_http_exchanges({
  "captureId": "sample-har",
  "header": "authorization",
  "limit": 20
})
```

分析单个 exchange：

```text
analyze_http_exchange({
  "captureId": "sample-har",
  "sessionId": "<session-id>",
  "maxFindings": 50,
  "includeBodies": true,
  "bodyLimit": 8000,
  "redactSensitive": true,
  "includeRawText": true
})
```

## 10. 自动分析与报告

分析整个 capture：

```text
analyze_capture({
  "captureId": "sample-har",
  "maxFindings": 200
})
```

分析结果包含：

- 请求总数。
- host、method、status class、content-type 统计。
- 请求和响应体积统计。
- 平均耗时。
- 慢请求列表。
- 大响应列表。
- 安全、隐私、性能 findings。

生成 Markdown 报告：

```text
generate_report({
  "captureId": "sample-har",
  "format": "markdown"
})
```

生成 JSON 报告：

```text
generate_report({
  "captureId": "sample-har",
  "format": "json"
})
```

常见 finding 类型：

- `transport`：明文 HTTP 或传输安全问题。
- `secret`：token、API key、password、access_token 等敏感信息。
- `cookie`：Cookie 安全属性缺失。
- `privacy`：邮箱、手机号等个人信息。
- `availability`：5xx 或服务端异常。
- `performance`：慢请求、大响应。

## 11. 请求重放

请求重放分为两步：先构建计划，再显式执行。默认不会发送网络请求。

### 11.1 构建重放计划

```text
build_replay_request({
  "captureId": "sample-har",
  "sessionId": "<session-id>"
})
```

计划会返回：

- `method`
- `url`
- `headers`
- `bodyPreview`
- `bodyBytes`
- `removedHeaders`
- `warnings`

默认会移除：

- `Authorization`
- `Proxy-Authorization`
- `Cookie`
- `Set-Cookie`
- `X-Api-Key`
- token、secret、password、api-key 类 header
- `Host`
- `Content-Length`
- `Transfer-Encoding`
- `Connection`
- 其他 hop-by-hop header
- HTTP/2 pseudo header

### 11.2 重放到受控环境

推荐把请求重放到本地、测试或 staging 服务：

```text
replay_http_request({
  "captureId": "sample-har",
  "sessionId": "<session-id>",
  "execute": true,
  "urlOverride": "https://staging.example.com/replay-target",
  "timeoutMs": 30000,
  "maxResponseBytes": 256000,
  "followRedirects": false
})
```

重放到本地服务需要显式允许私有网络：

```text
replay_http_request({
  "captureId": "sample-har",
  "sessionId": "<session-id>",
  "execute": true,
  "urlOverride": "http://127.0.0.1:3000/replay-target",
  "allowPrivateNetwork": true,
  "headerOverrides": {
    "X-Replay-Test": "1",
    "Content-Type": "application/json"
  },
  "bodyOverride": "{\"username\":\"demo\"}"
})
```

### 11.3 重放原始 URL

默认禁止直接执行原始捕获 URL，避免误打生产服务。确实需要时必须显式声明：

```text
replay_http_request({
  "captureId": "sample-har",
  "sessionId": "<session-id>",
  "execute": true,
  "allowOriginalUrl": true
})
```

如果原始 URL 是 localhost、内网、link-local 或 reserved 地址，还需要：

```text
"allowPrivateNetwork": true
```

### 11.4 重放参数

- `urlOverride`：覆盖目标 URL。
- `methodOverride`：覆盖 HTTP method。
- `headerOverrides`：新增或替换 header。
- `removeHeaders`：删除指定 header。
- `bodyOverride`：覆盖请求体。
- `includeSensitiveHeaders`：是否带上捕获到的敏感 header，默认 `false`。
- `timeoutMs`：请求超时，最大 120000。
- `maxResponseBytes`：响应体保留上限，最大 10485760。
- `followRedirects`：是否跟随重定向，默认 `false`。
- `allowOriginalUrl`：是否允许执行原始 URL，默认 `false`。
- `allowPrivateNetwork`：是否允许 localhost/内网/link-local/reserved 地址，默认 `false`。

## 12. 清理数据

清理单个 capture：

```text
clear_capture({
  "captureId": "sample-har"
})
```

清理当前 MCP 进程内所有 capture：

```text
clear_capture({})
```

注意：capture 存储在 MCP server 进程内存中。重启 MCP server 后，内存中的 capture 会丢失，需要重新导入或重新接收。

## 13. 验证和测试

类型检查：

```powershell
npm run check
```

构建：

```powershell
npm run build
```

完整 smoke test：

```powershell
npm run build
node examples\smoke-test.mjs
```

请求重放本地回环测试：

```powershell
npm run build
node examples\replay-loopback-smoke-test.mjs
```

推荐提交前至少运行：

```powershell
npm run check
npm run build
node examples\smoke-test.mjs
node examples\replay-loopback-smoke-test.mjs
```

## 14. 故障排查

### 14.1 MCP 客户端看不到工具

处理步骤：

1. 确认已运行 `npm run build`。
2. 确认 MCP 配置指向 `dist/index.js`。
3. 确认 Node.js 版本不低于 20。
4. 重启 MCP 客户端。

### 14.2 Reqable 没有推送流量

处理步骤：

1. 调用 `get_reqable_report_server_status({})` 确认 server 正在运行。
2. 确认 Reqable Report Server URL 使用的是 `ingestUrls.har`。
3. 确认 Reqable 正在捕获目标应用流量。
4. 调用 `wait_for_reqable_traffic` 等待新事件。
5. 如果端口被占用，使用 `port: 0` 重新启动 receiver。

### 14.3 HTTPS 报文没有 body 或内容不可读

可能原因：

- Reqable 未正确安装或信任 CA 证书。
- 目标应用启用了证书固定。
- Reqable 只捕获 CONNECT 隧道，没有解密 HTTPS 内容。
- 导出的 HAR/JSON 本身没有包含 body。

### 14.4 `captureId` 找不到

处理步骤：

1. 调用 `list_captures({})` 查看当前进程内 capture。
2. 确认 MCP server 没有重启。
3. 如果已重启，需要重新导入文件或重新接收 Reqable 流量。

### 14.5 请求重放被阻止

常见原因：

- 没有传 `execute: true`。
- 没有传 `urlOverride`，且没有 `allowOriginalUrl: true`。
- 目标是 localhost、内网或 link-local，但没有 `allowPrivateNetwork: true`。
- URL 不是 `http` 或 `https`。
- header name 或 method 不是合法 HTTP token。

### 14.6 GitHub push 失败

处理步骤：

1. 检查远端：`git remote -v`。
2. 检查分支：`git status --short --branch`。
3. 检查网络是否能访问 GitHub。
4. 确认 Git Credential Manager 中有 GitHub 凭据。

## 15. 安全注意事项

抓包数据经常包含：

- Bearer token
- Cookie
- API key
- 用户名和密码
- 邮箱、手机号、地址等个人信息
- 生产环境业务数据

操作建议：

- 不要提交真实抓包文件。
- 不要把真实报告直接贴到公开 issue、PR 或聊天记录。
- 默认使用 `redactSensitive: true`。
- 获取完整 body 时设置合理的 `bodyLimit`。
- 请求重放优先使用 `urlOverride` 指向本地、测试或 staging 环境。
- 不要在未确认授权的情况下对生产环境执行重放。
- `.env`、Reqable inbox、真实 capture 目录应保持在版本控制之外。

## 16. 常用命令速查

```powershell
npm install
npm run check
npm run build
npm start
```

```text
start_reqable_report_server({ "port": 9419, "captureId": "reqable-report-live" })
get_reqable_report_server_status({})
wait_for_reqable_traffic({ "afterSequence": 0, "timeoutMs": 30000 })
list_captures({})
list_sessions({ "captureId": "reqable-report-live", "limit": 50 })
get_http_exchange({ "captureId": "reqable-report-live", "sessionId": "<session-id>", "includeBodies": true, "redactSensitive": true })
analyze_capture({ "captureId": "reqable-report-live", "maxFindings": 200 })
generate_report({ "captureId": "reqable-report-live", "format": "markdown" })
build_replay_request({ "captureId": "reqable-report-live", "sessionId": "<session-id>" })
replay_http_request({ "captureId": "reqable-report-live", "sessionId": "<session-id>", "execute": true, "urlOverride": "https://staging.example.com/replay-target" })
clear_capture({ "captureId": "reqable-report-live" })
```

## 17. 仓库信息

当前远端仓库：

```text
https://github.com/MaoCreate-Wen/PacketCapture-MCP.git
```
