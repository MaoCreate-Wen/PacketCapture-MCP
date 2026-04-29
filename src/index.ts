#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeCapture } from "./analyzer.js";
import { startGuiServer } from "./guiServer.js";
import { buildHttpExchange } from "./httpMessages.js";
import { parseCaptureContent, parseCurlCapture } from "./parsers.js";
import { buildReplayRequest, replayHttpRequest, type ReplayRequestOptions, type ReplayRequestPlan, type ReplayResult } from "./replay.js";
import { ensureBridgeInbox, getBridgeConfig, getInboxStatus, importReqableInbox, writeReqableBridgeScript } from "./reqableBridge.js";
import { inspectReqableInstall } from "./reqable.js";
import { getRealtimeTrafficEvents, getReportServerStatus, startReportServer, stopReportServer, waitForRealtimeTraffic } from "./reportServer.js";
import { renderMarkdownReport } from "./report.js";
import { findSession, filterSessions, listSessionSummaries } from "./sessions.js";
import { clearCapture, getCapture, listCaptures, saveCapture } from "./store.js";
import type { HeaderMap, HttpSession } from "./types.js";

const server = new McpServer({
  name: "packetcapture-mcp",
  version: "0.1.0",
});

const MAX_REPLAY_TIMEOUT_MS = 120_000;
const MAX_REPLAY_RESPONSE_BYTES = 10 * 1024 * 1024;
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const httpTokenSchema = z.string().regex(HTTP_TOKEN_PATTERN, "Expected a valid HTTP token.");
const httpUrlSchema = z.string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Expected an absolute http(s) URL.");

const httpExchangeOutputSchema = {
  includeBodies: z.boolean().default(false).describe("Include request and response bodies, truncated by bodyLimit. Defaults to false to avoid expanding captured payloads."),
  bodyLimit: z.number().int().min(0).max(200000).default(8000).describe("Maximum body characters to return per request or response body."),
  redactSensitive: z.boolean().default(true).describe("Redact sensitive headers, cookies, tokens, and secret-like values from returned messages."),
  includeRawText: z.boolean().default(false).describe("Include raw HTTP message text when available. Raw text obeys includeBodies, bodyLimit, and redactSensitive."),
};

const replayRequestInputSchema = {
  captureId: z.string().describe("Capture dataset ID."),
  sessionId: z.string().describe("Session ID, or the source-file index when available."),
  urlOverride: httpUrlSchema.optional().describe("Optional absolute http(s) URL to use instead of the captured request URL."),
  methodOverride: httpTokenSchema.optional().describe("Optional HTTP method token to use instead of the captured request method."),
  headerOverrides: z.record(httpTokenSchema, z.string()).default({}).describe("Request headers to add or replace in the replayed request."),
  removeHeaders: z.array(httpTokenSchema).default([]).describe("Request header names to remove from the replayed request."),
  bodyOverride: z.string().optional().describe("Optional request body to use instead of the captured request body."),
  includeSensitiveHeaders: z.boolean().default(false).describe("Include sensitive captured headers such as Cookie and Authorization. Defaults to false."),
  timeoutMs: z.number().int().min(1).max(MAX_REPLAY_TIMEOUT_MS).default(30000).describe("Request timeout in milliseconds."),
  maxResponseBytes: z.number().int().min(0).max(MAX_REPLAY_RESPONSE_BYTES).default(256000).describe("Maximum response body bytes to retain."),
  followRedirects: z.boolean().default(false).describe("Follow HTTP redirects while replaying the request. Defaults to false for safer replay."),
  allowOriginalUrl: z.boolean().default(false).describe("Allow execution against the captured original URL when urlOverride is not provided. Defaults to false."),
  allowPrivateNetwork: z.boolean().default(false).describe("Allow replay targets that are localhost, private, link-local, or otherwise non-public network addresses. Required for local test services."),
};

server.registerTool(
  "inspect_reqable_install",
  {
    title: "Inspect Reqable Install",
    description: "Inspect the local Reqable install path and return capability hints for automated capture analysis. This does not start Reqable or change its configuration.",
    inputSchema: {
      installPath: z.string().optional().describe("Reqable install path. Defaults to C:\\Program Files\\Reqable on Windows."),
    },
  },
  async ({ installPath }) => jsonResult(await inspectReqableInstall(installPath)),
);

server.registerTool(
  "import_capture_file",
  {
    title: "Import Capture File",
    description: "Import a local HAR 1.2 file, Reqable/common JSON export, or cURL text file, then store it in MCP process memory for later analysis.",
    inputSchema: {
      path: z.string().describe("Local capture file path, such as a .har, .json, or .txt export from Reqable."),
      format: z.enum(["auto", "har", "json", "curl"]).default("auto").describe("Input format. Use auto to detect the format from the content."),
      captureId: z.string().optional().describe("Optional custom capture dataset ID."),
    },
  },
  async ({ path, format, captureId }) => {
    const content = await readFile(path, "utf8");
    const capture = saveCapture(parseCaptureContent(content, {
      source: path,
      format: format === "auto" ? undefined : format,
      datasetId: captureId,
    }));
    return jsonResult(summarizeCapture(capture));
  },
);

server.registerTool(
  "import_curl",
  {
    title: "Import cURL",
    description: "Import a cURL command copied from Reqable or a browser and create a single HTTP session capture.",
    inputSchema: {
      command: z.string().describe("Full cURL command text."),
      captureId: z.string().optional().describe("Optional custom capture dataset ID."),
    },
  },
  async ({ command, captureId }) => {
    const capture = saveCapture(parseCurlCapture(command, { datasetId: captureId }));
    return jsonResult(summarizeCapture(capture));
  },
);

server.registerTool(
  "prepare_reqable_automation",
  {
    title: "Prepare Reqable Automation",
    description: "Inspect Reqable, create the MCP inbox, write the Python bridge script, and return the workflow for automated Reqable capture analysis.",
    inputSchema: {
      installPath: z.string().optional().describe("Reqable install path. Defaults to C:\\Program Files\\Reqable on Windows."),
      inboxDir: z.string().optional().describe("Optional inbox directory for bridge NDJSON events."),
      eventsFile: z.string().optional().describe("Optional NDJSON events file name. Defaults to events.ndjson."),
      scriptPath: z.string().optional().describe("Optional output path for the Reqable Python bridge script."),
      receiverUrl: z.string().optional().describe("Optional realtime receiver URL from start_reqable_report_server ingestUrls.bridge."),
      overwriteScript: z.boolean().default(false).describe("Replace an existing bridge script at scriptPath."),
    },
  },
  async ({ installPath, inboxDir, eventsFile, scriptPath, receiverUrl, overwriteScript }) => {
    const [install, bridge] = await Promise.all([
      inspectReqableInstall(installPath),
      writeReqableBridgeScript({ inboxDir, eventsFile, scriptPath, receiverUrl, overwrite: overwriteScript }),
    ]);
    return jsonResult({
      install,
      bridge,
      workflow: [
        "Enable Reqable capture or proxy mode and load the generated Python bridge script.",
        "Generate traffic from the target app or browser.",
        "Call get_reqable_inbox_status to confirm that the NDJSON event file is growing.",
        "Call analyze_reqable_inbox to import the events and return security, privacy, and performance findings.",
        "Call generate_report when you need Markdown or JSON evidence output.",
      ],
    });
  },
);

server.registerTool(
  "run_reqable_automation_check",
  {
    title: "Run Reqable Automation Check",
    description: "Run a read-only orchestration check for automated Reqable capture analysis by combining install inspection, bridge configuration, inbox status, readiness, and next steps.",
    inputSchema: {
      installPath: z.string().optional().describe("Reqable install path. Defaults to C:\\Program Files\\Reqable on Windows."),
      inboxDir: z.string().optional().describe("Optional inbox directory for bridge NDJSON events."),
      eventsFile: z.string().optional().describe("Optional NDJSON events file name. Defaults to events.ndjson."),
    },
  },
  async ({ installPath, inboxDir, eventsFile }) => {
    const [install, bridgeConfig, inboxStatus] = await Promise.all([
      inspectReqableInstall(installPath),
      getBridgeConfig({ inboxDir, eventsFile }),
      getInboxStatus({ inboxDir, eventsFile }),
    ]);
    const activeBytes = inboxStatus.activeFile?.sizeBytes ?? 0;
    return jsonResult({
      install,
      bridgeConfig,
      inboxStatus,
      readiness: {
        reqableInstallFound: install.exists,
        inboxExists: inboxStatus.exists,
        activeEventsFileFound: inboxStatus.activeFile !== undefined,
        activeEventsFileHasData: activeBytes > 0,
        readyToAnalyze: activeBytes > 0,
      },
      recommendedWorkflow: [
        "Preferred live path: call start_reqable_report_server and configure Reqable Tools > Report Server to POST HAR JSON to receiverUrl.",
        "After reports arrive, call analyze_reqable_report_capture or analyze_capture with the returned captureId.",
        "If setup is incomplete, call prepare_reqable_automation to create the inbox and bridge script.",
        "Load the bridge script in Reqable and keep Reqable capture or proxy mode running.",
        "Generate target app or browser traffic.",
        "Call get_reqable_inbox_status until the active NDJSON file has data.",
        "Call analyze_reqable_inbox to import and analyze the captured traffic.",
        "Call generate_report for Markdown or JSON output when evidence needs to be shared.",
      ],
      nextSteps: buildReqableAutomationNextSteps(install.exists, inboxStatus.exists, inboxStatus.activeFile !== undefined, activeBytes),
    });
  },
);

server.registerTool(
  "start_reqable_report_server",
  {
    title: "Start Reqable Report Server",
    description: "Start a localhost HTTP receiver for Reqable Tools > Report Server. Reqable can POST completed HTTP sessions as HAR JSON, which are merged into an in-memory capture dataset.",
    inputSchema: {
      host: z.string().default("127.0.0.1").describe("Bind host for the receiver. Use 127.0.0.1 by default."),
      port: z.number().int().min(0).max(65535).default(9419).describe("Bind port. Use 0 to choose an available port automatically."),
      path: z.string().optional().describe("Receiver path. Defaults to /reqable/report/<token>."),
      token: z.string().optional().describe("Optional token used in the default receiver path."),
      captureId: z.string().default("reqable-report-live").describe("Capture ID used for imported Report Server sessions."),
      maxBytes: z.number().int().min(1024).max(200 * 1024 * 1024).default(25 * 1024 * 1024).describe("Maximum compressed request body size accepted per report."),
      recentLimit: z.number().int().min(10).max(5000).default(200).describe("Maximum number of realtime traffic events retained for polling."),
    },
  },
  async ({ host, port, path, token, captureId, maxBytes, recentLimit }) => jsonResult(await startReportServer({ host, port, path, token, captureId, maxBytes, recentLimit })),
);

server.registerTool(
  "get_reqable_report_server_status",
  {
    title: "Get Reqable Report Server Status",
    description: "Return the current status and receiverUrl for the local Reqable Report Server HAR receiver.",
    inputSchema: {},
  },
  async () => jsonResult(getReportServerStatus()),
);

server.registerTool(
  "stop_reqable_report_server",
  {
    title: "Stop Reqable Report Server",
    description: "Stop the local Reqable Report Server HAR receiver if it is running.",
    inputSchema: {},
  },
  async () => jsonResult(await stopReportServer()),
);

server.registerTool(
  "get_reqable_realtime_events",
  {
    title: "Get Reqable Realtime Events",
    description: "Return recently received Reqable traffic events after a sequence cursor. Use this to poll live traffic without re-reading the full capture.",
    inputSchema: {
      afterSequence: z.number().int().min(0).default(0).describe("Return events with sequence greater than this cursor."),
      limit: z.number().int().min(1).max(500).default(50).describe("Maximum number of realtime events to return."),
    },
  },
  async ({ afterSequence, limit }) => jsonResult(getRealtimeTrafficEvents({ afterSequence, limit })),
);

server.registerTool(
  "wait_for_reqable_traffic",
  {
    title: "Wait For Reqable Traffic",
    description: "Long-poll the live Reqable receiver until new traffic arrives after the sequence cursor or the timeout expires.",
    inputSchema: {
      afterSequence: z.number().int().min(0).default(0).describe("Wait for events with sequence greater than this cursor."),
      timeoutMs: z.number().int().min(0).max(120000).default(30000).describe("Maximum time to wait for new traffic."),
      limit: z.number().int().min(1).max(500).default(50).describe("Maximum number of realtime events to return."),
    },
  },
  async ({ afterSequence, timeoutMs, limit }) => jsonResult(await waitForRealtimeTraffic({ afterSequence, timeoutMs, limit })),
);

server.registerTool(
  "analyze_reqable_report_capture",
  {
    title: "Analyze Reqable Report Capture",
    description: "Analyze the live capture dataset populated by the local Reqable Report Server receiver.",
    inputSchema: {
      captureId: z.string().default("reqable-report-live").describe("Capture ID used when start_reqable_report_server was called."),
      maxFindings: z.number().int().min(1).max(500).default(200).describe("Maximum number of findings to return."),
    },
  },
  async ({ captureId, maxFindings }) => {
    const capture = getCapture(captureId);
    const analysis = analyzeCapture(capture);
    return jsonResult({ capture: summarizeCapture(capture), analysis: { ...analysis, findings: analysis.findings.slice(0, maxFindings) }, reportServer: getReportServerStatus() });
  },
);

server.registerTool(
  "get_reqable_bridge_config",
  {
    title: "Get Reqable Bridge Config",
    description: "Return the inbox path, event file name, and script template path needed for Reqable Python bridge integration.",
    inputSchema: {
      inboxDir: z.string().optional().describe("Optional inbox directory. Defaults to the project reqable-inbox directory or REQABLE_MCP_INBOX."),
      eventsFile: z.string().optional().describe("Optional NDJSON event file name. Defaults to events.ndjson or REQABLE_MCP_EVENTS_FILE."),
      receiverUrl: z.string().optional().describe("Optional realtime receiver URL to include in generated bridge config."),
      ensure: z.boolean().default(true).describe("Create the inbox directory and an empty event file when missing."),
    },
  },
  async ({ inboxDir, eventsFile, receiverUrl, ensure }) => jsonResult(ensure ? await ensureBridgeInbox({ inboxDir, eventsFile, receiverUrl }) : await getBridgeConfig({ inboxDir, eventsFile, receiverUrl })),
);

server.registerTool(
  "get_reqable_inbox_status",
  {
    title: "Get Reqable Inbox Status",
    description: "Return NDJSON file status for the Reqable script bridge inbox.",
    inputSchema: {
      inboxDir: z.string().optional().describe("Optional inbox directory for bridge NDJSON events."),
      eventsFile: z.string().optional().describe("Optional NDJSON events file name. Defaults to events.ndjson."),
    },
  },
  async ({ inboxDir, eventsFile }) => jsonResult(await getInboxStatus({ inboxDir, eventsFile })),
);

server.registerTool(
  "write_reqable_bridge_script",
  {
    title: "Write Reqable Bridge Script",
    description: "Write the Reqable Python bridge script template and create the inbox used to store HTTP transactions as MCP-importable NDJSON.",
    inputSchema: {
      inboxDir: z.string().optional().describe("Optional inbox directory for bridge NDJSON events."),
      eventsFile: z.string().optional().describe("Optional NDJSON events file name. Defaults to events.ndjson."),
      scriptPath: z.string().optional().describe("Optional script output path. Defaults to scripts/reqable-mcp-bridge.py."),
      receiverUrl: z.string().optional().describe("Optional realtime receiver URL from start_reqable_report_server ingestUrls.bridge. It is also overridable at runtime with REQABLE_MCP_RECEIVER_URL."),
      overwrite: z.boolean().default(false).describe("Replace an existing script at scriptPath."),
    },
  },
  async ({ inboxDir, eventsFile, scriptPath, receiverUrl, overwrite }) => jsonResult(await writeReqableBridgeScript({ inboxDir, eventsFile, scriptPath, receiverUrl, overwrite })),
);

server.registerTool(
  "import_reqable_inbox",
  {
    title: "Import Reqable Inbox",
    description: "Import HTTP sessions from the NDJSON inbox written by the Reqable Python bridge script. Optionally archive and clear the active file after import.",
    inputSchema: {
      inboxDir: z.string().optional().describe("Optional inbox directory for bridge NDJSON events."),
      eventsFile: z.string().optional().describe("Optional NDJSON events file name. Defaults to events.ndjson."),
      captureId: z.string().optional().describe("Optional custom capture dataset ID."),
      archive: z.boolean().default(false).describe("After a successful import, archive the active event file and create a new empty file."),
    },
  },
  async ({ inboxDir, eventsFile, captureId, archive }) => {
    const capture = saveCapture(await importReqableInbox({ inboxDir, eventsFile, captureId, archive }));
    return jsonResult(summarizeCapture(capture));
  },
);

server.registerTool(
  "list_captures",
  {
    title: "List Captures",
    description: "List capture datasets imported into the current MCP server process.",
    inputSchema: {},
  },
  async () => jsonResult({ captures: listCaptures() }),
);

server.registerTool(
  "list_sessions",
  {
    title: "List Sessions",
    description: "List paginated HTTP session summaries from a capture dataset, with optional host, method, status class, and keyword filters.",
    inputSchema: {
      captureId: z.string().describe("Capture ID returned by import_capture_file, import_curl, import_reqable_inbox, or analyze_reqable_inbox."),
      offset: z.number().int().min(0).default(0).describe("Zero-based result offset."),
      limit: z.number().int().min(1).max(200).default(50).describe("Maximum number of sessions to return."),
      host: z.string().optional().describe("Filter sessions by request host."),
      method: z.string().optional().describe("Filter sessions by HTTP method."),
      statusClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"]).optional().describe("Filter sessions by response status class."),
      keyword: z.string().optional().describe("Search URLs, request headers, response headers, request bodies, and response bodies."),
    },
  },
  async ({ captureId, offset, limit, host, method, statusClass, keyword }) => {
    const capture = getCapture(captureId);
    const sessions = filterSessions(capture.sessions, { host, method, statusClass, keyword });
    return jsonResult(listSessionSummaries(sessions, offset, limit));
  },
);

server.registerTool(
  "get_session",
  {
    title: "Get Session",
    description: "Return details for one HTTP session. Bodies are omitted by default to avoid sending large payloads into context.",
    inputSchema: {
      captureId: z.string().describe("Capture dataset ID."),
      sessionId: z.string().describe("Session ID, or the source-file index when available."),
      includeBodies: z.boolean().default(false).describe("Include request and response bodies, truncated by bodyLimit."),
      bodyLimit: z.number().int().min(0).max(200000).default(8000).describe("Maximum body characters to return per request or response body."),
    },
  },
  async ({ captureId, sessionId, includeBodies, bodyLimit }) => {
    const session = findSession(getCapture(captureId).sessions, sessionId);
    if (includeBodies) {
      return jsonResult({ session: truncateBodies(session, bodyLimit) });
    }
    const { requestBody: _requestBody, responseBody: _responseBody, ...summary } = session;
    return jsonResult({ session: summary });
  },
);

server.registerTool(
  "get_http_exchange",
  {
    title: "Get HTTP Exchange",
    description: "Return one complete HTTP request and response exchange by captureId and sessionId. Bodies and raw text are omitted by default.",
    inputSchema: {
      captureId: z.string().describe("Capture dataset ID."),
      sessionId: z.string().describe("Session ID, or the source-file index when available."),
      ...httpExchangeOutputSchema,
    },
  },
  async ({ captureId, sessionId, includeBodies, bodyLimit, redactSensitive, includeRawText }) => {
    const capture = getCapture(captureId);
    const session = findSession(capture.sessions, sessionId);
    return jsonResult({
      capture: summarizeCapture(capture),
      exchange: buildHttpExchange(session, { includeBodies, bodyLimit, redactSensitive, includeRawText }),
    });
  },
);

server.registerTool(
  "build_replay_request",
  {
    title: "Build Replay Request",
    description: "Build a sanitized replay request plan for one captured HTTP session without sending network traffic.",
    inputSchema: replayRequestInputSchema,
  },
  async ({
    captureId,
    sessionId,
    urlOverride,
    methodOverride,
    headerOverrides,
    removeHeaders,
    bodyOverride,
    includeSensitiveHeaders,
    timeoutMs,
    maxResponseBytes,
    followRedirects,
    allowOriginalUrl,
    allowPrivateNetwork,
  }) => {
    const capture = getCapture(captureId);
    const session = findSession(capture.sessions, sessionId);
    const replayOptions = {
      urlOverride,
      methodOverride,
      headerOverrides,
      removeHeaders,
      bodyOverride,
      includeSensitiveHeaders,
      timeoutMs,
      maxResponseBytes,
      followRedirects,
      allowOriginalUrl,
      allowPrivateNetwork,
    };
    const plan = await buildReplayPlan(session, replayOptions);
    return jsonResult({
      capture: summarizeCapture(capture),
      session: summarizeSession(session),
      plan,
    });
  },
);

server.registerTool(
  "replay_http_request",
  {
    title: "Replay HTTP Request",
    description: "Replay one captured HTTP request. This tool only sends network traffic when execute is explicitly true.",
    inputSchema: {
      ...replayRequestInputSchema,
      execute: z.boolean().default(false).describe("Must be true to send the replayed HTTP request. When false, only the replay plan and warning are returned."),
    },
  },
  async ({
    captureId,
    sessionId,
    urlOverride,
    methodOverride,
    headerOverrides,
    removeHeaders,
    bodyOverride,
    includeSensitiveHeaders,
    timeoutMs,
    maxResponseBytes,
    followRedirects,
    allowOriginalUrl,
    allowPrivateNetwork,
    execute,
  }) => {
    const capture = getCapture(captureId);
    const session = findSession(capture.sessions, sessionId);
    const replayOptions = {
      urlOverride,
      methodOverride,
      headerOverrides,
      removeHeaders,
      bodyOverride,
      includeSensitiveHeaders,
      timeoutMs,
      maxResponseBytes,
      followRedirects,
      allowOriginalUrl,
      allowPrivateNetwork,
    };
    const plan = await buildReplayPlan(session, replayOptions);
    const base = {
      capture: summarizeCapture(capture),
      session: summarizeSession(session),
      plan,
    };

    if (!execute) {
      return jsonResult({
        ...base,
        warning: "No request was sent. Pass execute: true to replay this HTTP request.",
      });
    }

    const result = await executeReplayPlan(session, replayOptions);
    return jsonResult({ ...base, result });
  },
);

server.registerTool(
  "search_http_exchanges",
  {
    title: "Search HTTP Exchanges",
    description: "Search HTTP exchanges by keyword, host, status, body text, or header text and return matching session summaries. Bodies and raw text are omitted by default.",
    inputSchema: {
      captureId: z.string().describe("Capture dataset ID."),
      offset: z.number().int().min(0).default(0).describe("Zero-based result offset."),
      limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of matching sessions to return."),
      keyword: z.string().optional().describe("Search URLs, request headers, response headers, request bodies, and response bodies."),
      host: z.string().optional().describe("Filter sessions by request host."),
      method: z.string().optional().describe("Filter sessions by HTTP method."),
      status: z.number().int().min(100).max(599).optional().describe("Filter sessions by exact HTTP response status code."),
      statusClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"]).optional().describe("Filter sessions by response status class."),
      body: z.string().optional().describe("Search only request and response body text."),
      header: z.string().optional().describe("Search only request and response header names and values."),
      ...httpExchangeOutputSchema,
    },
  },
  async ({ captureId, offset, limit, keyword, host, method, status, statusClass, body, header, includeBodies, bodyLimit, redactSensitive, includeRawText }) => {
    const capture = getCapture(captureId);
    const baseMatches = filterSessions(capture.sessions, { host, method, statusClass, keyword });
    const matches = baseMatches.filter((session) => {
      if (status !== undefined && session.status !== status) return false;
      if (body && !containsText([session.requestBody, session.responseBody], body)) return false;
      if (header && !containsText([headersToSearchText(session.requestHeaders), headersToSearchText(session.responseHeaders)], header)) return false;
      return true;
    });
    const page = listSessionSummaries(matches, offset, limit);
    const pageSessions = matches.slice(page.offset, page.offset + page.limit);
    const includeExchange = includeBodies || includeRawText;

    return jsonResult({
      capture: summarizeCapture(capture),
      query: { keyword, host, method, status, statusClass, body, header },
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      sessions: page.sessions.map((session, index) => ({
        ...session,
        match: buildSearchMatchSummary(pageSessions[index], { keyword, body, header }),
        ...(includeExchange ? { exchange: buildHttpExchange(pageSessions[index], { includeBodies, bodyLimit, redactSensitive, includeRawText }) } : {}),
      })),
    });
  },
);

server.registerTool(
  "analyze_http_exchange",
  {
    title: "Analyze HTTP Exchange",
    description: "Analyze one HTTP exchange and return the single-session findings with a request and response message summary. Bodies and raw text are omitted by default.",
    inputSchema: {
      captureId: z.string().describe("Capture dataset ID."),
      sessionId: z.string().describe("Session ID, or the source-file index when available."),
      maxFindings: z.number().int().min(1).max(100).default(50).describe("Maximum number of findings to return for this exchange."),
      ...httpExchangeOutputSchema,
    },
  },
  async ({ captureId, sessionId, maxFindings, includeBodies, bodyLimit, redactSensitive, includeRawText }) => {
    const capture = getCapture(captureId);
    const session = findSession(capture.sessions, sessionId);
    const analysis = analyzeCapture({
      ...capture,
      sessionCount: 1,
      sessions: [session],
      metadata: { ...capture.metadata, analyzedSessionId: session.id },
    });
    return jsonResult({
      capture: summarizeCapture(capture),
      session: listSessionSummaries([session], 0, 1).sessions[0],
      exchange: buildHttpExchange(session, { includeBodies, bodyLimit, redactSensitive, includeRawText }),
      analysis: { ...analysis, findings: analysis.findings.slice(0, maxFindings) },
    });
  },
);

server.registerTool(
  "analyze_reqable_inbox",
  {
    title: "Analyze Reqable Inbox",
    description: "Import Reqable bridge NDJSON, save it in memory, and return automated analysis results. Optionally archive the active event file.",
    inputSchema: {
      inboxDir: z.string().optional().describe("Optional inbox directory for bridge NDJSON events."),
      eventsFile: z.string().optional().describe("Optional NDJSON events file name. Defaults to events.ndjson."),
      captureId: z.string().optional().describe("Optional custom capture dataset ID."),
      archive: z.boolean().default(false).describe("After a successful import, archive the active event file and create a new empty file."),
      maxFindings: z.number().int().min(1).max(500).default(200).describe("Maximum number of findings to return."),
    },
  },
  async ({ inboxDir, eventsFile, captureId, archive, maxFindings }) => {
    const capture = saveCapture(await importReqableInbox({ inboxDir, eventsFile, captureId, archive }));
    const analysis = analyzeCapture(capture);
    return jsonResult({ capture: summarizeCapture(capture), analysis: { ...analysis, findings: analysis.findings.slice(0, maxFindings) } });
  },
);

server.registerTool(
  "analyze_capture",
  {
    title: "Analyze Capture",
    description: "Run automated statistics and built-in security, privacy, and performance checks for an imported capture dataset.",
    inputSchema: {
      captureId: z.string().describe("Capture dataset ID."),
      maxFindings: z.number().int().min(1).max(500).default(200).describe("Maximum number of findings to return."),
    },
  },
  async ({ captureId, maxFindings }) => {
    const analysis = analyzeCapture(getCapture(captureId));
    return jsonResult({ ...analysis, findings: analysis.findings.slice(0, maxFindings) });
  },
);

server.registerTool(
  "generate_report",
  {
    title: "Generate Report",
    description: "Generate a Markdown or JSON report for an imported capture dataset.",
    inputSchema: {
      captureId: z.string().describe("Capture dataset ID."),
      format: z.enum(["markdown", "json"]).default("markdown").describe("Report output format."),
    },
  },
  async ({ captureId, format }) => {
    const capture = getCapture(captureId);
    const analysis = analyzeCapture(capture);
    if (format === "json") return jsonResult({ capture: summarizeCapture(capture), analysis });
    return textResult(renderMarkdownReport(capture, analysis));
  },
);

server.registerTool(
  "clear_capture",
  {
    title: "Clear Capture",
    description: "Remove one capture dataset, or all capture datasets, from MCP server memory.",
    inputSchema: {
      captureId: z.string().optional().describe("Capture dataset ID. Omit this to clear every imported dataset."),
    },
  },
  async ({ captureId }) => jsonResult(clearCapture(captureId)),
);

async function main(): Promise<void> {
  if (isGuiEnabled()) {
    const gui = await startGuiServer();
    console.error(`PacketCapture-MCP GUI listening at ${gui.url}`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function isGuiEnabled(): boolean {
  const value = process.env.PACKETCAPTURE_GUI ?? process.env.PACKETCAPTURE_CONSOLE;
  return value === "1" || value?.toLowerCase() === "true";
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function summarizeCapture(capture: ReturnType<typeof getCapture>) {
  return {
    id: capture.id,
    source: capture.source,
    format: capture.format,
    importedAt: capture.importedAt,
    sessionCount: capture.sessionCount,
    metadata: capture.metadata,
  };
}

function summarizeSession(session: HttpSession) {
  return listSessionSummaries([session], 0, 1).sessions[0];
}

async function buildReplayPlan(session: HttpSession, options: ReplayRequestOptions): Promise<ReplayRequestPlan> {
  return await buildReplayRequest(session, options);
}

async function executeReplayPlan(session: HttpSession, options: ReplayRequestOptions): Promise<ReplayResult> {
  return await replayHttpRequest(session, options);
}

function buildReqableAutomationNextSteps(reqableInstallFound: boolean, inboxExists: boolean, activeEventsFileFound: boolean, activeBytes: number): string[] {
  if (!reqableInstallFound) {
    return [
      "Verify the Reqable install path or install Reqable before relying on live capture automation.",
      "You can still import existing HAR, JSON, or cURL exports with import_capture_file or import_curl.",
    ];
  }

  if (!inboxExists || !activeEventsFileFound) {
    return [
      "Call prepare_reqable_automation to create the inbox and write the bridge script.",
      "Load the generated bridge script in Reqable, then generate traffic from the target app or browser.",
    ];
  }

  if (activeBytes <= 0) {
    return [
      "The inbox is ready, but no captured events are present yet.",
      "Keep Reqable capture or proxy mode running, load the bridge script, and generate target traffic.",
      "Call get_reqable_inbox_status again to confirm that the active NDJSON file is growing.",
    ];
  }

  return [
    "The active Reqable bridge event file has data.",
    "Call analyze_reqable_inbox to import the events and run automated findings.",
    "Call generate_report when you need a Markdown or JSON report.",
  ];
}

function truncateBodies<T extends { requestBody?: string; responseBody?: string }>(session: T, limit: number): T {
  return {
    ...session,
    requestBody: truncate(session.requestBody, limit),
    responseBody: truncate(session.responseBody, limit),
  };
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function containsText(values: Array<string | undefined>, keyword: string): boolean {
  const needle = keyword.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(needle));
}

function headersToSearchText(headers: HeaderMap): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function buildSearchMatchSummary(session: HttpSession, query: { keyword?: string; body?: string; header?: string }) {
  return {
    keyword: query.keyword ? {
      url: containsText([session.url], query.keyword),
      requestHeaders: containsText([headersToSearchText(session.requestHeaders)], query.keyword),
      responseHeaders: containsText([headersToSearchText(session.responseHeaders)], query.keyword),
      requestBody: containsText([session.requestBody], query.keyword),
      responseBody: containsText([session.responseBody], query.keyword),
    } : undefined,
    body: query.body ? {
      requestBody: containsText([session.requestBody], query.body),
      responseBody: containsText([session.responseBody], query.body),
    } : undefined,
    header: query.header ? {
      requestHeaders: containsText([headersToSearchText(session.requestHeaders)], query.header),
      responseHeaders: containsText([headersToSearchText(session.responseHeaders)], query.header),
    } : undefined,
  };
}
