import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const captureId = "smoke-replay-loopback";
const requestBody = JSON.stringify({ message: "hello replay", count: 3 });
const requestHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Replay-Smoke": "loopback-assertion",
  "X-Trace-Id": "trace-replay-smoke",
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});

const client = new Client({ name: "packetcapture-replay-loopback-smoke-test", version: "0.1.0" });
let server;
let tempDir;

try {
  tempDir = await mkdtemp(join(tmpdir(), "packetcapture-replay-smoke-"));
  const capturePath = join(tempDir, "loopback-capture.json");
  await writeFile(capturePath, JSON.stringify(buildCapture(), null, 2), "utf8");

  const loopback = await startLoopbackServer();
  server = loopback.server;

  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const name of ["import_capture_file", "list_sessions", "replay_http_request"]) {
    assert(toolNames.has(name), `missing MCP tool: ${name}`);
  }

  const imported = await callJson("import_capture_file", {
    path: capturePath,
    format: "json",
    captureId,
  });
  assertEqual(imported.sessionCount, 1, "imported session count");

  const listed = await callJson("list_sessions", { captureId, limit: 1 });
  assertEqual(listed.sessions.length, 1, "listed session count");
  const sessionId = listed.sessions[0]?.id;
  assert(sessionId, "missing replay session id");

  const blockedOriginalUrlReplay = await callJson("replay_http_request", {
    captureId,
    sessionId,
    execute: true,
  });
  assertEqual(blockedOriginalUrlReplay.result?.executed, false, "original URL replay blocked");
  assert(
    blockedOriginalUrlReplay.result?.response?.error?.includes("allowOriginalUrl=true"),
    `original URL replay did not explain allowOriginalUrl guard: ${blockedOriginalUrlReplay.result?.response?.error}`,
  );
  assertEqual(loopback.requests.length, 0, "blocked replay should not reach loopback");

  const targetPath = "/replay-target?case=loopback";
  const replayed = await callJson("replay_http_request", {
    captureId,
    sessionId,
    execute: true,
    urlOverride: `${loopback.origin}${targetPath}`,
    timeoutMs: 5000,
    maxResponseBytes: 10000,
    followRedirects: false,
    allowPrivateNetwork: true,
  });

  assertEqual(replayed.result?.executed, true, "replay executed");
  assert(!replayed.result?.response?.error, `replay returned error: ${replayed.result?.response?.error}`);
  assertEqual(replayed.result?.response?.status, 201, "replay response status");
  assertEqual(replayed.result?.response?.headers?.["x-replay-response"], "loopback-ok", "replay response header");

  const responseBody = parseJson(replayed.result?.response?.body, "replay response body");
  assertEqual(responseBody.ok, true, "replay response ok");
  assertEqual(responseBody.method, "POST", "replay response method echo");
  assertEqual(responseBody.path, targetPath, "replay response path echo");
  assertEqual(responseBody.bodyLength, Buffer.byteLength(requestBody), "replay response body length echo");

  assertEqual(loopback.requests.length, 1, "loopback received request count");
  const received = loopback.requests[0];
  assertEqual(received.method, "POST", "loopback received method");
  assertEqual(received.url, targetPath, "loopback received url");
  assertEqual(headerValue(received.headers, "accept"), requestHeaders.Accept, "loopback received accept header");
  assertEqual(headerValue(received.headers, "content-type"), requestHeaders["Content-Type"], "loopback received content-type header");
  assertEqual(headerValue(received.headers, "x-replay-smoke"), requestHeaders["X-Replay-Smoke"], "loopback received custom header");
  assertEqual(headerValue(received.headers, "x-trace-id"), requestHeaders["X-Trace-Id"], "loopback received trace header");
  assertEqual(received.body, requestBody, "loopback received body");

  console.log("replay loopback smoke ok: imported capture, executed replay, and asserted server request plus MCP response");
} finally {
  await Promise.allSettled([
    client.close(),
    closeServer(server),
    tempDir ? rm(tempDir, { recursive: true, force: true }) : undefined,
  ]);
}

function buildCapture() {
  return {
    sessions: [
      {
        request: {
          method: "POST",
          url: "http://127.0.0.1/original-capture-path?source=smoke",
          headers: requestHeaders,
          body: requestBody,
        },
        response: {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: "{\"captured\":true}",
        },
      },
    ],
  };
}

async function startLoopbackServer() {
  const requests = [];
  const localServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });

    res.statusCode = 201;
    res.statusMessage = "Created";
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Replay-Response", "loopback-ok");
    res.end(JSON.stringify({
      ok: true,
      method: req.method,
      path: req.url,
      bodyLength: Buffer.byteLength(body),
    }));
  });

  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });

  const address = localServer.address();
  assert(address && typeof address === "object", "loopback server did not bind to a TCP port");
  return {
    server: localServer,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

async function callJson(name, args) {
  const text = await callText(name, args);
  return parseJson(text, `tool ${name} response`);
}

async function callText(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const item = result.content[0];
  assert(item?.type === "text", `tool ${name} did not return text content`);
  return item.text;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${text}`, { cause: error });
  }
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

async function closeServer(localServer) {
  if (!localServer) return;
  await new Promise((resolve, reject) => {
    localServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
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
