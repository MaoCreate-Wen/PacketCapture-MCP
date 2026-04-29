import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { parseCaptureContent } from "./parsers.js";
import { parseReqableBridgeNdjson } from "./reqableBridge.js";
import { getCapture, saveCapture } from "./store.js";
import type { CaptureDataset, HttpSession } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9419;
const DEFAULT_CAPTURE_ID = "reqable-report-live";
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_RECENT_LIMIT = 200;
const gzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliAsync = promisify(brotliDecompress);

interface ActiveReportServer {
  server: Server;
  host: string;
  port: number;
  path: string;
  token: string;
  receiverUrl: string;
  captureId: string;
  maxBytes: number;
  startedAt: string;
  receivedReports: number;
  acceptedReports: number;
  rejectedReports: number;
  receivedSessions: number;
  sequence: number;
  recentLimit: number;
  recentEvents: RealtimeTrafficEvent[];
  waiters: RealtimeWaiter[];
  lastReceivedAt?: string;
  lastError?: string;
  lastImport?: ReportServerImportSummary;
}

export interface StartReportServerOptions {
  host?: string;
  port?: number;
  path?: string;
  token?: string;
  captureId?: string;
  maxBytes?: number;
  recentLimit?: number;
}

export interface ReportServerStatus {
  running: boolean;
  host?: string;
  port?: number;
  path?: string;
  receiverUrl?: string;
  captureId?: string;
  maxBytes?: number;
  startedAt?: string;
  receivedReports?: number;
  acceptedReports?: number;
  rejectedReports?: number;
  receivedSessions?: number;
  sequence?: number;
  recentEventCount?: number;
  lastReceivedAt?: string;
  lastError?: string;
  lastImport?: ReportServerImportSummary;
  ingestUrls?: {
    har: string;
    bridge: string;
    status: string;
  };
  supportedContentEncodings: string[];
  notes: string[];
}

export interface ReportServerImportSummary {
  captureId: string;
  importedSessions: number;
  totalSessions: number;
  contentEncoding: string;
  contentLengthBytes: number;
  decompressedBytes: number;
  receivedAt: string;
  sourceType: ReportIngestSourceType;
}

export type ReportIngestSourceType = "har" | "reqable-bridge";

export interface RealtimeTrafficEvent {
  sequence: number;
  receivedAt: string;
  captureId: string;
  sourceType: ReportIngestSourceType;
  importedSessions: number;
  totalSessions: number;
  sessions: RealtimeSessionSummary[];
}

export interface RealtimeSessionSummary {
  sessionId: string;
  index: number;
  method: string;
  url: string;
  scheme?: string;
  host?: string;
  path?: string;
  query?: string;
  protocol?: string;
  status?: number;
  durationMs?: number;
  requestContentType?: string;
  responseContentType?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
  requestHeaderCount: number;
  responseHeaderCount: number;
  hasRequestBody: boolean;
  hasResponseBody: boolean;
}

export interface RealtimeEventsResult {
  running: boolean;
  captureId?: string;
  currentSequence: number;
  fromSequence: number;
  events: RealtimeTrafficEvent[];
  hasMore: boolean;
}

export interface WaitForTrafficOptions {
  afterSequence?: number;
  timeoutMs?: number;
  limit?: number;
}

interface RealtimeWaiter {
  afterSequence: number;
  limit: number;
  resolve: (result: RealtimeEventsResult) => void;
  timeout: NodeJS.Timeout;
}

interface ReportServerMergeResult {
  capture: CaptureDataset;
  importedSessions: HttpSession[];
}

let active: ActiveReportServer | undefined;

export async function startReportServer(options: StartReportServerOptions = {}): Promise<ReportServerStatus> {
  if (active) return getReportServerStatus();

  const host = options.host ?? process.env.REQABLE_MCP_REPORT_HOST ?? DEFAULT_HOST;
  const port = Number(options.port ?? process.env.REQABLE_MCP_REPORT_PORT ?? DEFAULT_PORT);
  const token = options.token ?? process.env.REQABLE_MCP_REPORT_TOKEN ?? randomBytes(12).toString("hex");
  const path = normalizePath(options.path ?? process.env.REQABLE_MCP_REPORT_PATH ?? `/reqable/report/${token}`);
  const captureId = options.captureId?.trim() || process.env.REQABLE_MCP_REPORT_CAPTURE_ID || DEFAULT_CAPTURE_ID;
  const maxBytes = Number(options.maxBytes ?? process.env.REQABLE_MCP_REPORT_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  const recentLimit = clampInteger(Number(options.recentLimit ?? process.env.REQABLE_MCP_REPORT_RECENT_LIMIT ?? DEFAULT_RECENT_LIMIT), 10, 5000);

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  const startedAt = new Date().toISOString();
  active = {
    server,
    host,
    port,
    path,
    token,
    receiverUrl: "",
    captureId,
    maxBytes,
    startedAt,
    receivedReports: 0,
    acceptedReports: 0,
    rejectedReports: 0,
    receivedSessions: 0,
    sequence: 0,
    recentLimit,
    recentEvents: [],
    waiters: [],
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    active = undefined;
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  active.port = actualPort;
  active.receiverUrl = `http://${host}:${actualPort}${path}`;
  return getReportServerStatus();
}

export async function stopReportServer(): Promise<ReportServerStatus> {
  if (!active) return getReportServerStatus();

  const current = active;
  active = undefined;
  for (const waiter of current.waiters.splice(0)) {
    clearTimeout(waiter.timeout);
    waiter.resolve(emptyRealtimeResult(current.captureId, current.sequence, waiter.afterSequence));
  }
  await new Promise<void>((resolve, reject) => {
    current.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  return getReportServerStatus();
}

export function getReportServerStatus(): ReportServerStatus {
  return {
    running: Boolean(active),
    host: active?.host,
    port: active?.port,
    path: active?.path,
    receiverUrl: active?.receiverUrl,
    captureId: active?.captureId,
    maxBytes: active?.maxBytes,
    startedAt: active?.startedAt,
    receivedReports: active?.receivedReports,
    acceptedReports: active?.acceptedReports,
    rejectedReports: active?.rejectedReports,
    receivedSessions: active?.receivedSessions,
    sequence: active?.sequence,
    recentEventCount: active?.recentEvents.length,
    lastReceivedAt: active?.lastReceivedAt,
    lastError: active?.lastError,
    lastImport: active?.lastImport,
    ingestUrls: active ? buildIngestUrls(active) : undefined,
    supportedContentEncodings: supportedContentEncodings(),
    notes: [
      "Configure Reqable Tools > Report Server to POST HAR JSON to ingestUrls.har or receiverUrl.",
      "The generated Reqable script bridge can POST session JSON directly to ingestUrls.bridge.",
      "Use wait_for_reqable_traffic for long-poll realtime updates and analyze_capture for findings.",
    ],
  };
}

export function getRealtimeTrafficEvents(options: { afterSequence?: number; limit?: number } = {}): RealtimeEventsResult {
  const state = active;
  if (!state) return emptyRealtimeResult(undefined, 0, options.afterSequence);
  return realtimeResult(state, options.afterSequence ?? 0, normalizeLimit(options.limit));
}

export async function waitForRealtimeTraffic(options: WaitForTrafficOptions = {}): Promise<RealtimeEventsResult> {
  const state = active;
  const afterSequence = Math.max(0, Math.floor(options.afterSequence ?? 0));
  const limit = normalizeLimit(options.limit);
  const timeoutMs = clampInteger(Math.floor(options.timeoutMs ?? 30000), 0, 120000);

  if (!state) return emptyRealtimeResult(undefined, 0, afterSequence);

  const immediate = realtimeResult(state, afterSequence, limit);
  if (immediate.events.length > 0 || timeoutMs === 0) return immediate;

  return await new Promise((resolve) => {
    const waiter: RealtimeWaiter = {
      afterSequence,
      limit,
      resolve,
      timeout: setTimeout(() => {
        removeWaiter(state, waiter);
        resolve(realtimeResult(state, afterSequence, limit));
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const state = active;
  if (!state) {
    writeJson(response, 503, { ok: false, error: "Report server is not active." });
    return;
  }

  const path = requestPath(request.url);
  if (request.method === "GET" && isKnownPath(state, path)) {
    writeJson(response, 200, getReportServerStatus());
    return;
  }

  if (request.method !== "POST" || !isKnownPath(state, path)) {
    writeJson(response, 404, { ok: false, error: "Not found." });
    return;
  }

  state.receivedReports += 1;
  state.lastReceivedAt = new Date().toISOString();

  try {
    const body = await readLimitedBody(request, state.maxBytes);
    const encoding = headerText(request.headers["content-encoding"]) || "identity";
    const decoded = await decodeBody(body, encoding);
    const content = decoded.toString("utf8").trim();

    if (!content) {
      throw httpError(400, "Empty report body.");
    }

    const sourceType = detectSourceType(request, path, content);
    const parsed = parseRealtimeContent(content, sourceType, state.lastReceivedAt);
    const merged = mergeIntoLiveCapture(state, parsed, sourceType);
    const summary: ReportServerImportSummary = {
      captureId: merged.capture.id,
      importedSessions: parsed.sessions.length,
      totalSessions: merged.capture.sessionCount,
      contentEncoding: encoding,
      contentLengthBytes: body.length,
      decompressedBytes: decoded.length,
      receivedAt: state.lastReceivedAt,
      sourceType,
    };

    state.acceptedReports += 1;
    state.receivedSessions += parsed.sessions.length;
    state.lastImport = summary;
    state.lastError = undefined;
    publishRealtimeEvent(state, merged.importedSessions, summary);

    writeJson(response, 202, { ok: true, ...summary });
  } catch (error) {
    const statusCode = isHttpError(error) ? error.statusCode : 400;
    const message = error instanceof Error ? error.message : String(error);
    state.rejectedReports += 1;
    state.lastError = message;
    writeJson(response, statusCode, { ok: false, error: message });
  }
}

function mergeIntoLiveCapture(state: ActiveReportServer, parsed: CaptureDataset, sourceType: ReportIngestSourceType): ReportServerMergeResult {
  const existing = safeGetCapture(state.captureId);
  const existingSessions = existing?.sessions ?? [];
  const existingIds = new Set(existingSessions.map((session) => session.id));
  const appended = parsed.sessions.map((session, index) => withReportServerMetadata(session, existingSessions.length + index, existingIds, sourceType));
  const importedAt = existing?.importedAt ?? new Date().toISOString();
  const reports = typeof existing?.metadata.reports === "number" ? existing.metadata.reports + 1 : 1;

  const capture: CaptureDataset = {
    id: state.captureId,
    source: `reqable-report-server:${state.receiverUrl}`,
    format: "reqable-report-server",
    importedAt,
    sessionCount: existingSessions.length + appended.length,
    sessions: [...existingSessions, ...appended],
    metadata: {
      ...(existing?.metadata ?? {}),
      parser: "reqable-report-server",
      receiverUrl: state.receiverUrl,
      reports,
      lastReportAt: state.lastReceivedAt,
      lastReportSessions: parsed.sessions.length,
      lastReportSource: parsed.source,
      lastSourceType: sourceType,
    },
  };

  return {
    capture: saveCapture(capture),
    importedSessions: appended,
  };
}

function withReportServerMetadata(session: HttpSession, sourceIndex: number, existingIds: Set<string>, sourceType: ReportIngestSourceType): HttpSession {
  let id = session.id;
  let suffix = 1;
  while (existingIds.has(id)) {
    id = `${session.id}-${suffix}`;
    suffix += 1;
  }
  existingIds.add(id);

  return {
    ...session,
    id,
    sourceIndex,
    requestSizeBytes: session.requestSizeBytes ?? byteLength(session.requestBody),
    responseSizeBytes: session.responseSizeBytes ?? byteLength(session.responseBody),
    notes: uniqueStrings([...session.notes, `Imported from Reqable realtime ${sourceType} POST.`]),
  };
}

function safeGetCapture(id: string): CaptureDataset | undefined {
  try {
    return getCapture(id);
  } catch {
    return undefined;
  }
}

async function readLimitedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw httpError(413, `Report body exceeds maxBytes (${maxBytes}).`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function decodeBody(body: Buffer, encodingHeader: string): Promise<Buffer> {
  const encoding = encodingHeader.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).at(-1) ?? "identity";
  if (encoding === "identity" || encoding === "") return body;
  if (encoding === "gzip" || encoding === "x-gzip") return gzipAsync(body);
  if (encoding === "deflate" || encoding === "x-deflate") return inflateAsync(body);
  if (encoding === "br") return brotliAsync(body);
  if (encoding === "zstd") {
    const dynamicZlib = await import("node:zlib") as unknown as { zstdDecompress?: (input: Buffer, callback: (error: Error | null, result: Buffer) => void) => void };
    if (dynamicZlib.zstdDecompress) return promisify(dynamicZlib.zstdDecompress)(body);
    throw httpError(415, "zstd content encoding is not supported by this Node.js runtime.");
  }
  throw httpError(415, `Unsupported content encoding: ${encodingHeader}`);
}

function parseRealtimeContent(content: string, sourceType: ReportIngestSourceType, receivedAt: string): CaptureDataset {
  if (sourceType === "reqable-bridge") {
    return parseReqableBridgeNdjson(normalizeBridgePayload(content), {
      source: `reqable-realtime-bridge:${receivedAt}`,
    });
  }

  return parseCaptureContent(content, {
    source: `reqable-report-server:${receivedAt}`,
    format: "har",
  });
}

function normalizeBridgePayload(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("\n")) return trimmed;
  return trimmed;
}

function detectSourceType(request: IncomingMessage, path: string, content: string): ReportIngestSourceType {
  if (path.endsWith("/bridge") || path.endsWith("/events")) return "reqable-bridge";

  const sourceHeader = headerText(request.headers["x-reqable-mcp-source"])?.toLowerCase();
  if (sourceHeader?.includes("bridge") || sourceHeader?.includes("script")) return "reqable-bridge";

  const contentType = headerText(request.headers["content-type"])?.toLowerCase() ?? "";
  if (contentType.includes("x-ndjson") || contentType.includes("ndjson")) return "reqable-bridge";

  const parsed = parseJson(content);
  if (isRecord(parsed)) {
    if (typeof parsed.schema === "string" && parsed.schema.startsWith("reqable-mcp-bridge.")) return "reqable-bridge";
    if (isRecord(parsed.request) && !isRecord(parsed.log)) return "reqable-bridge";
  }

  return "har";
}

function publishRealtimeEvent(state: ActiveReportServer, importedSessions: HttpSession[], summary: ReportServerImportSummary): void {
  const event: RealtimeTrafficEvent = {
    sequence: state.sequence + 1,
    receivedAt: summary.receivedAt,
    captureId: summary.captureId,
    sourceType: summary.sourceType,
    importedSessions: summary.importedSessions,
    totalSessions: summary.totalSessions,
    sessions: importedSessions.map((session, index) => summarizeRealtimeSession(session, summary.totalSessions - importedSessions.length + index)),
  };

  state.sequence = event.sequence;
  state.recentEvents.push(event);
  if (state.recentEvents.length > state.recentLimit) {
    state.recentEvents.splice(0, state.recentEvents.length - state.recentLimit);
  }

  for (const waiter of state.waiters.splice(0)) {
    clearTimeout(waiter.timeout);
    waiter.resolve(realtimeResult(state, waiter.afterSequence, waiter.limit));
  }
}

function summarizeRealtimeSession(session: HttpSession, index: number): RealtimeSessionSummary {
  const parsedUrl = parseUrl(session.url);
  return {
    sessionId: session.id,
    index,
    method: session.method,
    url: session.url,
    scheme: session.scheme ?? parsedUrl?.protocol.replace(":", ""),
    host: session.host ?? parsedUrl?.host,
    path: session.path ?? parsedUrl?.pathname,
    query: session.query ?? (parsedUrl?.search ? parsedUrl.search.slice(1) : undefined),
    protocol: session.protocol,
    status: session.status,
    durationMs: session.durationMs,
    requestContentType: session.requestContentType ?? headerValue(session.requestHeaders, "content-type"),
    responseContentType: session.responseContentType ?? headerValue(session.responseHeaders, "content-type"),
    requestSizeBytes: session.requestSizeBytes ?? byteLength(session.requestBody),
    responseSizeBytes: session.responseSizeBytes ?? byteLength(session.responseBody),
    requestHeaderCount: Object.keys(session.requestHeaders).length,
    responseHeaderCount: Object.keys(session.responseHeaders).length,
    hasRequestBody: hasBody(session.requestBody, session.requestSizeBytes),
    hasResponseBody: hasBody(session.responseBody, session.responseSizeBytes),
  };
}

function realtimeResult(state: ActiveReportServer, afterSequence: number, limit: number): RealtimeEventsResult {
  const eventsAfterCursor = state.recentEvents.filter((event) => event.sequence > afterSequence);
  const events = eventsAfterCursor.slice(0, limit);
  return {
    running: true,
    captureId: state.captureId,
    currentSequence: state.sequence,
    fromSequence: afterSequence,
    events,
    hasMore: eventsAfterCursor.length > events.length,
  };
}

function emptyRealtimeResult(captureId: string | undefined, currentSequence: number, afterSequence = 0): RealtimeEventsResult {
  return {
    running: false,
    captureId,
    currentSequence,
    fromSequence: Math.max(0, Math.floor(afterSequence)),
    events: [],
    hasMore: false,
  };
}

function removeWaiter(state: ActiveReportServer, waiter: RealtimeWaiter): void {
  const index = state.waiters.indexOf(waiter);
  if (index >= 0) state.waiters.splice(index, 1);
}

function supportedContentEncodings(): string[] {
  const encodings = ["identity", "gzip", "deflate", "br"];
  const zlibWithZstd = process.versions.node ? true : false;
  if (zlibWithZstd) encodings.push("zstd if supported by the Node.js runtime");
  return encodings;
}

function buildIngestUrls(state: ActiveReportServer): { har: string; bridge: string; status: string } {
  const base = `http://${state.host}:${state.port}${state.path}`;
  return {
    har: base,
    bridge: `${base}/bridge`,
    status: base,
  };
}

function isKnownPath(state: ActiveReportServer, path: string): boolean {
  return path === state.path || path === `${state.path}/bridge` || path === `${state.path}/events`;
}

function requestPath(url: string | undefined): string {
  if (!url) return "/";
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url.split("?")[0] || "/";
  }
}

function normalizePath(path: string): string {
  const normalized = path.trim();
  if (!normalized) return "/reqable/report";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeLimit(value: number | undefined): number {
  return clampInteger(Math.floor(value ?? 50), 1, 500);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface HttpError extends Error {
  statusCode: number;
}

function httpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && typeof (error as Partial<HttpError>).statusCode === "number";
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function byteLength(value?: string): number | undefined {
  return value !== undefined ? Buffer.byteLength(value) : undefined;
}

function hasBody(value?: string, sizeBytes?: number): boolean {
  return (value !== undefined && value.length > 0) || (sizeBytes !== undefined && sizeBytes > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
