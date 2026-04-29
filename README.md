# PacketCapture-MCP

PacketCapture-MCP is a TypeScript MCP server for importing HTTP capture data,
browsing sessions, running built-in security/privacy/performance checks, and
generating Markdown or JSON reports.

## Import Paths

### Reqable Report Server live receiver

Start the local MCP receiver and configure Reqable Tools > Report Server to POST
completed HTTP sessions as HAR JSON to `ingestUrls.har` or `receiverUrl`:

```text
start_reqable_report_server({ "port": 9419, "captureId": "reqable-report-live" })
get_reqable_report_server_status({})
wait_for_reqable_traffic({ "afterSequence": 0, "timeoutMs": 30000 })
analyze_reqable_report_capture({ "captureId": "reqable-report-live" })
```

The receiver binds to `127.0.0.1` by default, enforces a per-report body size
limit, and stores imported sessions in the current MCP process memory. It does
not start Reqable or control the GUI.

For realtime monitoring, keep the receiver running and repeatedly call
`wait_for_reqable_traffic` with the last returned `currentSequence`. Each
completed Reqable session increments the sequence and returns compact session
summaries without sending full bodies back into context.

### HAR or JSON file

For browser DevTools HAR files, Reqable HAR exports, or common HTTP session JSON
exports:

```text
import_capture_file({ "path": "examples/sample.har", "format": "har", "captureId": "sample" })
list_sessions({ "captureId": "sample", "limit": 20 })
analyze_capture({ "captureId": "sample" })
generate_report({ "captureId": "sample", "format": "markdown" })
```

Use `format: "auto"` when the extension or source format is not fixed.

### Reqable Script bridge

Run `prepare_reqable_automation` or `write_reqable_bridge_script` to create a
passive Python bridge script and an inbox directory. Load the generated script in
Reqable scripting. The script appends one HTTP transaction per line to an NDJSON
file and can also POST each completed session directly to the live receiver.

Typical workflow:

```text
start_reqable_report_server({})
get_reqable_report_server_status({})
write_reqable_bridge_script({ "receiverUrl": "<ingestUrls.bridge>", "overwrite": true })
get_reqable_inbox_status({})
wait_for_reqable_traffic({ "afterSequence": 0, "timeoutMs": 30000 })
analyze_reqable_inbox({ "captureId": "reqable-live" })
generate_report({ "captureId": "reqable-live", "format": "markdown" })
```

Inbox paths can be overridden with `REQABLE_MCP_INBOX` and
`REQABLE_MCP_EVENTS_FILE`, or with the `inboxDir` and `eventsFile` tool
arguments. The direct POST target can be embedded with `receiverUrl` or supplied
at Reqable script runtime with `REQABLE_MCP_RECEIVER_URL`.

## MCP Tool Workflow

1. Start live capture with `start_reqable_report_server`, or import data with
   `import_capture_file`, `import_curl`, or `analyze_reqable_inbox`.
2. Use `list_captures` to find capture IDs in the current MCP process.
3. Use `wait_for_reqable_traffic` or `get_reqable_realtime_events` to follow new
   sessions as Reqable sends them.
4. Use `list_sessions` and `get_session` to inspect individual HTTP sessions.
5. Run `analyze_capture` to get structured findings and summary statistics.
6. Run `generate_report` to produce Markdown or JSON output.
7. Use `clear_capture` when local in-memory captures are no longer needed.

## 请求重放

Use `build_replay_request` to turn an imported session into a replay plan before
anything is sent on the network:

```text
build_replay_request({
  "captureId": "sample",
  "sessionId": "<session-id-from-list_sessions>"
})
```

Replay planning is safe by default. The plan keeps the captured method, URL,
non-sensitive request headers, and a bounded `bodyPreview`, but excludes
sensitive headers such as `Authorization` and `Cookie` unless you explicitly
override them. Building a plan does not send a request.

Use `replay_http_request` with `execute: true` only when you intentionally want
the server to make the HTTP request:

```text
replay_http_request({
  "captureId": "sample",
  "sessionId": "<session-id-from-list_sessions>",
  "execute": true,
  "urlOverride": "https://staging.example.com/replay-target"
})
```

For safer testing, point replay traffic at a local test service and override the
target details as needed:

```text
replay_http_request({
  "captureId": "sample",
  "sessionId": "<session-id-from-list_sessions>",
  "execute": true,
  "urlOverride": "http://127.0.0.1:3000/replay-target",
  "allowPrivateNetwork": true,
  "headerOverrides": {
    "X-Replay-Test": "1",
    "Content-Type": "application/json"
  },
  "bodyOverride": "{\"username\":\"demo\",\"dryRun\":true}"
})
```

`execute: true` is guarded: replaying the captured original URL also requires
`allowOriginalUrl: true`, and localhost/private/link-local targets require
`allowPrivateNetwork: true`. Treat overrides as intentional disclosure points.
Add credentials, cookies, or production URLs only when the target environment is
approved for replay.

## 完整报文分析

Use `get_http_exchange` when you need the full request and matching response for
one session, including method, URL, status, headers, and optionally bodies or
raw HTTP-like text:

```text
get_http_exchange({
  "captureId": "sample",
  "sessionId": "<session-id-from-list_sessions-or-realtime-event>",
  "includeBodies": true,
  "bodyLimit": 8000,
  "redactSensitive": true,
  "includeRawText": true
})
```

- `includeBodies`: include request and response bodies. Leave this `false` for
  metadata-only inspection.
- `bodyLimit`: maximum body characters returned per request or response. Bodies
  longer than this should include truncation metadata or a truncation marker.
- `redactSensitive`: mask common secrets such as authorization values, cookies,
  tokens, API keys, passwords, emails, and phone numbers before returning text.
- `includeRawText`: include reconstructed raw request/response text for LLM or
  manual protocol review. Structured fields remain useful when raw text is not
  needed.

Full exchanges can contain credentials, session cookies, bearer tokens, private
payloads, and user data. Prefer `redactSensitive: true`, keep `bodyLimit` small
unless you need evidence from a large payload, and avoid pasting raw exchanges
into chat, issues, commits, or reports unless the data is synthetic or already
approved for sharing.

## Validation

Install dependencies and build:

```sh
npm install
npm run build
```

Run the smoke validation:

```sh
npm run build && node examples/smoke-test.mjs
```

The smoke test imports HAR, inline cURL, and Reqable bridge NDJSON fixtures, then
starts the realtime receiver and POSTs synthetic HAR and bridge events through
the same HTTP paths Reqable uses. It asserts session counts, realtime sequence
events, finding categories, and required report headings without using a real
Reqable GUI.

## Security and Privacy

Packet captures often contain credentials, cookies, tokens, email addresses,
phone numbers, and production data. Do not commit real captures or generated
reports that contain secrets or private user data.

Keep `.env` files and local Reqable inbox directories out of version control.
Use short-lived, synthetic fixtures for tests. Review generated reports before
sharing them outside the machine where the capture was collected.
