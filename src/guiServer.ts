import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { analyzeCapture } from "./analyzer.js";
import { renderGuiHtml } from "./guiAssets.js";
import { buildHttpExchange } from "./httpMessages.js";
import { parseCaptureContent } from "./parsers.js";
import {
  getRealtimeTrafficEvents,
  getReportServerStatus,
  startReportServer,
  stopReportServer,
  type StartReportServerOptions,
} from "./reportServer.js";
import { findSession, filterSessions, listSessionSummaries } from "./sessions.js";
import { getCapture, listCaptures, saveCapture } from "./store.js";
import type { CaptureDataset } from "./types.js";

const DEFAULT_GUI_HOST = "127.0.0.1";
const DEFAULT_GUI_PORT = 9420;
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface GuiServerOptions {
  host?: string;
  port?: number;
  apiToken?: string;
}

export interface GuiServerHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  apiToken: string;
  close: () => Promise<void>;
}

export async function startGuiServer(options: GuiServerOptions = {}): Promise<GuiServerHandle> {
  const host = options.host ?? process.env.PACKETCAPTURE_GUI_HOST ?? DEFAULT_GUI_HOST;
  const port = Number(options.port ?? process.env.PACKETCAPTURE_GUI_PORT ?? DEFAULT_GUI_PORT);
  const apiToken = options.apiToken ?? process.env.PACKETCAPTURE_GUI_TOKEN ?? randomBytes(16).toString("hex");

  const server = createServer((request, response) => {
    void handleRequest(request, response, { host, port: 0, apiToken });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/`;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void handleRequest(request, response, { host, port: actualPort, apiToken });
  });

  return {
    server,
    host,
    port: actualPort,
    url,
    apiToken,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: { host: string; port: number; apiToken: string },
): Promise<void> {
  try {
    setCommonHeaders(response);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? context.host}`);

    if (request.method === "GET" && url.pathname === "/") {
      return html(response, renderGuiHtml({ apiToken: context.apiToken }));
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.headers["x-packetcapture-gui-token"] !== context.apiToken) {
        return json(response, 403, { error: "Invalid or missing GUI API token." });
      }
      return await handleApi(request, response, url, context);
    }

    return json(response, 404, { error: "Not found." });
  } catch (error) {
    return json(response, 500, { error: formatError(error) });
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: { host: string; port: number; apiToken: string },
): Promise<void> {
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (request.method === "GET" && url.pathname === "/api/server/info") {
    return json(response, 200, {
      name: "packetcapture-mcp",
      version: "0.1.0",
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
      captureCount: listCaptures().length,
      reportServer: getReportServerStatus(),
      gui: {
        host: context.host,
        port: context.port,
        apiTokenRequiredForWrites: true,
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/import/file") {
    const body = await readJsonBody(request);
    const path = requiredString(body.path, "path");
    const format = optionalString(body.format);
    const captureId = optionalString(body.captureId);
    const content = await readFile(path, "utf8");
    const capture = saveCapture(parseCaptureContent(content, {
      source: path,
      format: format === "auto" ? undefined : format,
      datasetId: captureId,
    }));
    return json(response, 200, { capture: summarizeCapture(capture) });
  }

  if (request.method === "GET" && url.pathname === "/api/captures") {
    return json(response, 200, { captures: listCaptures() });
  }

  if (segments[0] === "api" && segments[1] === "captures" && segments[2]) {
    return handleCaptureApi(request, response, url, segments);
  }

  if (request.method === "GET" && url.pathname === "/api/reqable/report-server/status") {
    return json(response, 200, getReportServerStatus());
  }

  if (request.method === "POST" && url.pathname === "/api/reqable/report-server/start") {
    const body = await readJsonBody(request);
    const options: StartReportServerOptions = {
      host: optionalString(body.host),
      port: optionalNumber(body.port),
      path: optionalString(body.path),
      token: optionalString(body.token),
      captureId: optionalString(body.captureId),
      maxBytes: optionalNumber(body.maxBytes),
      recentLimit: optionalNumber(body.recentLimit),
    };
    return json(response, 200, await startReportServer(options));
  }

  if (request.method === "POST" && url.pathname === "/api/reqable/report-server/stop") {
    return json(response, 200, await stopReportServer());
  }

  if (request.method === "GET" && url.pathname === "/api/reqable/realtime-events") {
    return json(response, 200, getRealtimeTrafficEvents({
      afterSequence: numberParam(url, "afterSequence", 0),
      limit: numberParam(url, "limit", 50),
    }));
  }

  return json(response, 404, { error: "API route not found." });
}

function handleCaptureApi(request: IncomingMessage, response: ServerResponse, url: URL, segments: string[]): void {
  const captureId = segments[2] ?? "";
  const capture = getCapture(captureId);

  if (request.method === "GET" && segments.length === 3) {
    return json(response, 200, { capture: summarizeCapture(capture) });
  }

  if (request.method === "GET" && segments[3] === "sessions" && segments.length === 4) {
    const sessions = filterSessions(capture.sessions, {
      host: stringParam(url, "host"),
      method: stringParam(url, "method"),
      statusClass: stringParam(url, "statusClass"),
      keyword: stringParam(url, "keyword"),
    });
    return json(response, 200, listSessionSummaries(sessions, numberParam(url, "offset", 0), numberParam(url, "limit", 50)));
  }

  if (request.method === "GET" && segments[3] === "analysis") {
    const maxFindings = numberParam(url, "maxFindings", 100);
    const analysis = analyzeCapture(capture);
    return json(response, 200, {
      capture: summarizeCapture(capture),
      analysis: { ...analysis, findings: analysis.findings.slice(0, maxFindings) },
    });
  }

  if (request.method === "GET" && segments[3] === "sessions" && segments[4]) {
    const session = findSession(capture.sessions, segments[4]);
    if (segments.length === 5) {
      return json(response, 200, { session });
    }
    if (segments[5] === "exchange") {
      return json(response, 200, {
        capture: summarizeCapture(capture),
        exchange: buildHttpExchange(session, {
          includeBodies: booleanParam(url, "includeBodies", false),
          includeRawText: booleanParam(url, "includeRawText", false),
          redactSensitive: booleanParam(url, "redactSensitive", true),
          bodyLimit: numberParam(url, "bodyLimit", 8000),
        }),
      });
    }
  }

  return json(response, 404, { error: "Capture API route not found." });
}

function summarizeCapture(capture: CaptureDataset) {
  return {
    id: capture.id,
    source: capture.source,
    format: capture.format,
    importedAt: capture.importedAt,
    sessionCount: capture.sessionCount,
    metadata: capture.metadata,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new Error("Request body too large.");
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object request body.");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required string field: ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function numberParam(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanParam(url: URL, name: string, fallback: boolean): boolean {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function html(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body, null, 2));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
