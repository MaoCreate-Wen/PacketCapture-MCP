import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";

const REQUIRED_REPORT_HEADINGS = [
  "# Packet Capture Analysis Report",
  "## Summary",
  "## Top Hosts",
  "## Findings",
  "## Slowest Sessions",
  "## Largest Responses",
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});

const client = new Client({ name: "packetcapture-smoke-test", version: "0.1.0" });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["import_capture_file", "import_curl", "analyze_reqable_inbox", "start_reqable_report_server", "wait_for_reqable_traffic", "generate_report", "get_http_exchange", "build_replay_request", "replay_http_request"]) {
    assert(toolNames.has(name), `missing MCP tool: ${name}`);
  }

  const harImport = await callJson("import_capture_file", {
    path: "examples/sample.har",
    format: "har",
    captureId: "smoke-har",
  });
  assertEqual(harImport.sessionCount, 1, "HAR session count");

  const harAnalysis = await callJson("analyze_capture", { captureId: "smoke-har", maxFindings: 20 });
  assertEqual(harAnalysis.summary.totalSessions, 1, "HAR analysis total sessions");
  assertHasCategories(harAnalysis, ["transport", "secret", "cookie", "privacy"]);

  const harSessions = await callJson("list_sessions", { captureId: "smoke-har", limit: 1 });
  assertEqual(harSessions.sessions.length, 1, "HAR listed session count");
  const harExchange = await callJson("get_http_exchange", {
    captureId: "smoke-har",
    sessionId: harSessions.sessions[0].id,
    includeBodies: true,
    bodyLimit: 24,
    redactSensitive: false,
    includeRawText: true,
  });
  assertHttpExchange(harExchange, {
    label: "HAR exchange",
    method: "POST",
    urlFragment: "/login",
    status: 200,
    requestHeaders: ["content-type", "authorization"],
    responseHeaders: ["content-type", "set-cookie"],
    requestBodySnippet: "username",
    responseBodySnippet: "email",
    expectTruncation: true,
  });

  const harReplayPlan = await callJson("build_replay_request", {
    captureId: "smoke-har",
    sessionId: harSessions.sessions[0].id,
  });
  assertReplayPlan(harReplayPlan, {
    label: "HAR replay plan",
    method: "POST",
    urlFragment: "/login?access_token=secret-token-123456",
    requestHeaders: ["content-type"],
    requestBodySnippet: "username",
    forbiddenRequestHeaders: ["authorization", "cookie"],
  });

  const curlImport = await callJson("import_curl", {
    captureId: "smoke-curl",
    command: "curl -X POST -H 'Content-Type: application/json' -H 'X-Api-Key: sample-api-key-123456' --data '{\"username\":\"demo\",\"password\":\"curl-secret-value\"}' 'https://api.example.test/v1/login?token=query-token-123456'",
  });
  assertEqual(curlImport.sessionCount, 1, "cURL session count");

  const curlAnalysis = await callJson("analyze_capture", { captureId: "smoke-curl", maxFindings: 20 });
  assertEqual(curlAnalysis.summary.totalSessions, 1, "cURL analysis total sessions");
  assertHasCategories(curlAnalysis, ["secret"]);

  const reqableInbox = await callJson("analyze_reqable_inbox", {
    inboxDir: "examples",
    eventsFile: "reqable-bridge-sample.ndjson",
    captureId: "smoke-reqable",
    maxFindings: 50,
  });
  assertEqual(reqableInbox.capture.sessionCount, 2, "Reqable bridge session count");
  assertEqual(reqableInbox.analysis.summary.totalSessions, 2, "Reqable bridge analysis total sessions");
  assertEqual(reqableInbox.analysis.summary.statusClasses["2xx"], 1, "Reqable bridge 2xx count");
  assertEqual(reqableInbox.analysis.summary.statusClasses["5xx"], 1, "Reqable bridge 5xx count");
  assertHasCategories(reqableInbox.analysis, ["availability", "performance", "secret", "cookie", "privacy"]);

  const report = await callText("generate_report", { captureId: "smoke-reqable", format: "markdown" });
  for (const heading of REQUIRED_REPORT_HEADINGS) {
    assert(report.includes(heading), `report missing heading: ${heading}`);
  }
  assert(report.includes("- Sessions: 2"), "report missing Reqable session count");

  const listed = await callJson("list_captures", {});
  assertEqual(listed.captures.length, 3, "stored capture count");

  const live = await callJson("start_reqable_report_server", {
    port: 0,
    captureId: "smoke-live",
    recentLimit: 20,
  });
  assert(live.running, "live report server did not start");
  assert(live.ingestUrls?.har, "missing HAR ingest URL");
  assert(live.ingestUrls?.bridge, "missing bridge ingest URL");

  const harContent = await readFile("examples/sample.har", "utf8");
  const harPost = await postJson(live.ingestUrls.har, harContent, { "content-type": "application/json" });
  assertEqual(harPost.importedSessions, 1, "live HAR import sessions");
  assertEqual(harPost.sourceType, "har", "live HAR source type");

  const bridgeRecord = {
    schema: "reqable-mcp-bridge.v2.ndjson",
    id: "live-bridge-1",
    startedAt: "2026-04-28T00:02:00.000Z",
    durationMs: 88,
    request: {
      method: "POST",
      url: "https://api.example.test/live?token=live-query-token-123456",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{\"search\":\"live request body that should be truncated\",\"page\":1}",
    },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: "{\"ok\":true,\"email\":\"live.user@example.test\",\"note\":\"response body should be truncated\"}",
    },
  };
  const bridgePost = await postJson(live.ingestUrls.bridge, JSON.stringify(bridgeRecord), {
    "content-type": "application/json",
    "x-reqable-mcp-source": "script-bridge",
  });
  assertEqual(bridgePost.importedSessions, 1, "live bridge import sessions");
  assertEqual(bridgePost.sourceType, "reqable-bridge", "live bridge source type");

  const realtime = await callJson("wait_for_reqable_traffic", {
    afterSequence: 0,
    timeoutMs: 1000,
    limit: 10,
  });
  assertEqual(realtime.events.length, 2, "live realtime event count");
  assertEqual(realtime.currentSequence, 2, "live realtime current sequence");
  assertEqual(realtime.events[0].sourceType, "har", "first realtime source type");
  assertEqual(realtime.events[1].sourceType, "reqable-bridge", "second realtime source type");
  assert(realtime.events[0].sessions[0]?.sessionId, "missing live HAR realtime sessionId");
  assert(realtime.events[1].sessions[0]?.sessionId, "missing live bridge realtime sessionId");

  const liveHarExchange = await callJson("get_http_exchange", {
    captureId: "smoke-live",
    sessionId: realtime.events[0].sessions[0].sessionId,
    includeBodies: true,
    bodyLimit: 24,
    redactSensitive: false,
    includeRawText: true,
  });
  assertHttpExchange(liveHarExchange, {
    label: "live HAR exchange",
    method: "POST",
    urlFragment: "/login",
    status: 200,
    requestHeaders: ["content-type", "authorization"],
    responseHeaders: ["content-type", "set-cookie"],
    requestBodySnippet: "username",
    responseBodySnippet: "email",
    expectTruncation: true,
  });

  const liveBridgeExchange = await callJson("get_http_exchange", {
    captureId: "smoke-live",
    sessionId: realtime.events[1].sessions[0].sessionId,
    includeBodies: true,
    bodyLimit: 24,
    redactSensitive: false,
    includeRawText: true,
  });
  assertHttpExchange(liveBridgeExchange, {
    label: "live bridge exchange",
    method: "POST",
    urlFragment: "/live",
    status: 200,
    requestHeaders: ["content-type", "accept"],
    responseHeaders: ["content-type"],
    requestBodySnippet: "search",
    responseBodySnippet: "email",
    expectTruncation: true,
  });

  const liveAnalysis = await callJson("analyze_reqable_report_capture", {
    captureId: "smoke-live",
    maxFindings: 50,
  });
  assertEqual(liveAnalysis.capture.sessionCount, 2, "live capture session count");

  await callJson("stop_reqable_report_server", {});

  console.log("smoke ok: imports, replay planning, realtime Reqable receiver, analysis, and report assertions passed");
} finally {
  await client.close();
}

async function callJson(name, args) {
  const text = await callText(name, args);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`tool ${name} returned non-JSON text: ${text}`, { cause: error });
  }
}

async function callText(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const item = result.content[0];
  assert(item?.type === "text", `tool ${name} did not return text content`);
  return item.text;
}

function assertHasCategories(analysis, expectedCategories) {
  const categories = new Set(analysis.findings.map((finding) => finding.category));
  for (const category of expectedCategories) {
    assert(categories.has(category), `missing finding category: ${category}`);
  }
}

function assertHttpExchange(payload, expected) {
  const exchange = unwrapExchange(payload);
  const request = exchange.request ?? {
    method: exchange.method,
    url: exchange.url,
    headers: exchange.requestHeaders,
    body: exchange.requestBody,
    rawText: exchange.requestRawText,
  };
  const response = exchange.response ?? {
    status: exchange.status,
    statusText: exchange.statusText,
    headers: exchange.responseHeaders,
    body: exchange.responseBody,
    rawText: exchange.responseRawText,
  };
  const requestText = flattenText(request);
  const responseText = flattenText(response);
  const exchangeText = flattenText(exchange);

  assert(textIncludes(requestText, expected.method), `${expected.label} missing request method`);
  assert(textIncludes(exchangeText, expected.urlFragment) || textIncludes(requestText, expected.urlFragment), `${expected.label} missing request URL`);
  assert(textIncludes(responseText, String(expected.status)), `${expected.label} missing response status`);

  for (const header of expected.requestHeaders) {
    assert(textIncludes(requestText, header), `${expected.label} missing request header: ${header}`);
  }
  for (const header of expected.responseHeaders) {
    assert(textIncludes(responseText, header), `${expected.label} missing response header: ${header}`);
  }

  assert(textIncludes(requestText, expected.requestBodySnippet), `${expected.label} missing request body snippet`);
  assert(textIncludes(responseText, expected.responseBodySnippet), `${expected.label} missing response body snippet`);
  if (expected.expectTruncation) {
    assert(hasTruncationInfo(exchange) || textIncludes(exchangeText, "truncated"), `${expected.label} missing body truncation information`);
  }
}

function assertReplayPlan(payload, expected) {
  const plan = unwrapReplayPlan(payload);
  const request = plan.request ?? plan.replayRequest ?? plan;
  const method = request.method ?? plan.method;
  const url = request.url ?? plan.url ?? plan.targetUrl;
  const headers = collectHeaderEntries([
    request.replayHeaders,
    request.effectiveHeaders,
    request.safeHeaders,
    request.headers,
    plan.replayHeaders,
    plan.effectiveHeaders,
    plan.safeHeaders,
    plan.headers,
  ]);
  const headerNames = new Set(headers.map(([name]) => name.toLowerCase()));
  const bodyPreview = findReplayBodyPreview(plan);

  assertEqual(String(method).toUpperCase(), expected.method, `${expected.label} method`);
  assert(textIncludes(String(url), expected.urlFragment), `${expected.label} missing URL fragment`);
  assert(bodyPreview.length > 0, `${expected.label} missing bodyPreview`);
  assert(textIncludes(bodyPreview, expected.requestBodySnippet), `${expected.label} missing request body preview snippet`);

  for (const header of expected.requestHeaders) {
    assert(headerNames.has(header), `${expected.label} missing request header: ${header}`);
  }
  for (const header of expected.forbiddenRequestHeaders) {
    assert(!headerNames.has(header), `${expected.label} unexpectedly included sensitive request header: ${header}`);
  }
}

function unwrapExchange(payload) {
  return payload.exchange ?? payload.httpExchange ?? payload.session ?? payload;
}

function unwrapReplayPlan(payload) {
  return payload.plan ?? payload.replayPlan ?? payload.requestPlan ?? payload;
}

function collectHeaderEntries(candidates) {
  for (const candidate of candidates) {
    const entries = normalizeHeaders(candidate);
    if (entries.length > 0) return entries;
  }
  return [];
}

function normalizeHeaders(headers) {
  if (headers === undefined || headers === null) return [];
  if (Array.isArray(headers)) {
    return headers.flatMap((header) => {
      if (Array.isArray(header) && header.length >= 2) return [[String(header[0]), String(header[1])]];
      if (header && typeof header === "object" && "name" in header) return [[String(header.name), String(header.value ?? "")]];
      if (typeof header === "string") {
        const separator = header.indexOf(":");
        if (separator > 0) return [[header.slice(0, separator).trim(), header.slice(separator + 1).trim()]];
      }
      return [];
    });
  }
  if (typeof headers === "object") {
    return Object.entries(headers).map(([name, value]) => [name, String(value)]);
  }
  return [];
}

function findReplayBodyPreview(value, path = []) {
  if (value === undefined || value === null || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const preview = findReplayBodyPreview(item, path);
      if (preview) return preview;
    }
    return "";
  }

  for (const [key, item] of Object.entries(value)) {
    const keyLower = key.toLowerCase();
    const nextPath = [...path, keyLower];
    const isPreviewKey = keyLower === "bodypreview" || keyLower === "requestbodypreview" || (keyLower === "preview" && path.includes("body"));
    if (isPreviewKey && typeof item === "string") return item;
    const nestedPreview = findReplayBodyPreview(item, nextPath);
    if (nestedPreview) return nestedPreview;
  }
  return "";
}

function flattenText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.toLowerCase();
  return JSON.stringify(value).toLowerCase();
}

function textIncludes(text, fragment) {
  return text.includes(String(fragment).toLowerCase());
}

function hasTruncationInfo(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.toLowerCase().includes("truncat");
  if (Array.isArray(value)) return value.some((item) => hasTruncationInfo(item));
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => {
    if (key.toLowerCase().includes("truncat")) {
      if (typeof item === "boolean") return item;
      if (typeof item === "number") return item > 0;
      if (typeof item === "string") return item.length > 0;
      return hasTruncationInfo(item);
    }
    return hasTruncationInfo(item);
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function postJson(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`POST ${url} returned non-JSON text: ${text}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${text}`);
  }
  return parsed;
}
