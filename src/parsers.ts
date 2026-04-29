import { createHash } from "node:crypto";
import type { CaptureDataset, HeaderMap, HttpSession } from "./types.js";

const TEXT_LIMIT = 256_000;

type UnknownRecord = Record<string, unknown>;

export function parseCaptureContent(content: string, options: { source: string; format?: string; datasetId?: string }): CaptureDataset {
  const requestedFormat = options.format?.toLowerCase();

  if (requestedFormat === "curl" || looksLikeCurl(content)) {
    return datasetFromSessions([parseCurl(content, 0)], options, "curl", { parser: "curl" });
  }

  const json = parseJson(content);
  if (json !== undefined) {
    if (isHar(json)) {
      return datasetFromSessions(parseHar(json), options, "har", { parser: "har" });
    }

    const sessions = parseGenericJson(json);
    if (sessions.length > 0) {
      return datasetFromSessions(sessions, options, requestedFormat ?? "json", { parser: "generic-json" });
    }
  }

  throw new Error("Unsupported capture format. Expected HAR 1.2, Reqable/common JSON, or cURL text.");
}

export function parseCurlCapture(command: string, options: { source?: string; datasetId?: string } = {}): CaptureDataset {
  return datasetFromSessions([parseCurl(command, 0)], { source: options.source ?? "inline-curl", datasetId: options.datasetId }, "curl", { parser: "curl" });
}

function datasetFromSessions(
  sessions: HttpSession[],
  options: { source: string; datasetId?: string },
  format: string,
  metadata: Record<string, unknown>,
): CaptureDataset {
  if (sessions.length === 0) {
    throw new Error("No HTTP sessions found in capture content.");
  }

  const id = options.datasetId?.trim() || createId(`${options.source}:${format}:${Date.now()}`);
  return {
    id,
    source: options.source,
    format,
    importedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    sessions,
    metadata,
  };
}

function parseJson(content: string): unknown | undefined {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function isHar(value: unknown): value is UnknownRecord {
  return isRecord(value) && isRecord(value.log) && Array.isArray(value.log.entries);
}

function parseHar(har: UnknownRecord): HttpSession[] {
  const log = har.log as UnknownRecord;
  const entries = Array.isArray(log.entries) ? log.entries : [];

  return entries.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const request = isRecord(entry.request) ? entry.request : {};
    const response = isRecord(entry.response) ? entry.response : {};
    const url = asString(request.url) || asString(entry.url);
    if (!url) return [];

    const method = normalizeMethod(asString(request.method) || "GET");
    const parsedUrl = parseUrl(url);
    const requestHeaders = normalizeHeaders(request.headers);
    const responseHeaders = normalizeHeaders(response.headers);
    const requestBody = getHarRequestBody(request);
    const responseBody = getHarResponseBody(response);
    const requestPostDataMimeType = asString(getPath(request, ["postData", "mimeType"]));
    const responseMimeType = asString(getPath(response, ["content", "mimeType"]));
    const status = asNumber(response.status);

    return [{
      id: createSessionId(method, url, index, asString(entry.startedDateTime)),
      sourceIndex: index,
      method,
      url,
      scheme: parsedUrl?.protocol.replace(":", ""),
      host: parsedUrl?.host,
      path: parsedUrl?.pathname,
      query: parsedUrl?.search ? parsedUrl.search.slice(1) : undefined,
      protocol: asString((entry as UnknownRecord)._protocol) || asString(request.httpVersion) || asString(response.httpVersion),
      startedAt: asString(entry.startedDateTime),
      durationMs: asNumber(entry.time),
      status,
      statusText: asString(response.statusText),
      requestHeaders,
      responseHeaders,
      requestBody,
      responseBody,
      requestSizeBytes: firstNumber(request.bodySize, entry.requestBodySize) ?? byteLength(requestBody),
      responseSizeBytes: firstNumber(response.bodySize, getPath(response, ["content", "size"]), entry.responseBodySize) ?? byteLength(responseBody),
      requestContentType: headerValue(requestHeaders, "content-type") || requestPostDataMimeType,
      responseContentType: headerValue(responseHeaders, "content-type") || responseMimeType,
      notes: collectNotes([
        getPath(response, ["content", "encoding"]) === "base64" ? "HAR response content is base64 encoded." : undefined,
        requestPostDataMimeType ? `HAR request mimeType: ${requestPostDataMimeType}` : undefined,
      ]),
    } satisfies HttpSession];
  });
}

function parseGenericJson(value: unknown): HttpSession[] {
  const candidates = findSessionCandidates(value);
  const sessions: HttpSession[] = [];

  candidates.forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    const request = firstRecord(candidate.request, candidate.req, candidate.requestInfo, candidate) ?? candidate;
    const response = firstRecord(candidate.response, candidate.res, candidate.responseInfo) ?? {};
    const url = firstString(
      request.url,
      request.uri,
      request.href,
      request.fullUrl,
      request.requestUrl,
      candidate.url,
      candidate.requestUrl,
      getPath(candidate, ["request", "url"]),
    );
    if (!url) return;

    const method = normalizeMethod(firstString(request.method, candidate.method, getPath(candidate, ["request", "method"])) || "GET");
    const parsedUrl = parseUrl(url);
    const requestHeaders = normalizeHeaders(firstValue(request.headers, request.header, candidate.requestHeaders, getPath(candidate, ["request", "headers"])));
    const responseHeaders = normalizeHeaders(firstValue(response.headers, response.header, candidate.responseHeaders, getPath(candidate, ["response", "headers"])));
    const status = firstNumber(response.status, response.statusCode, candidate.status, candidate.statusCode, getPath(candidate, ["response", "status"]));
    const requestBody = limitText(bodyToString(firstValue(request.body, request.data, request.payload, request.content, candidate.requestBody)));
    const responseBody = limitText(bodyToString(firstValue(response.body, response.data, response.payload, response.content, candidate.responseBody)));

    sessions.push({
      id: createSessionId(method, url, index, firstString(candidate.startedAt, candidate.startTime, candidate.timestamp, candidate.time)),
      sourceIndex: index,
      method,
      url,
      scheme: parsedUrl?.protocol.replace(":", ""),
      host: parsedUrl?.host,
      path: parsedUrl?.pathname,
      query: parsedUrl?.search ? parsedUrl.search.slice(1) : undefined,
      protocol: firstString(candidate.protocol, request.protocol, response.protocol, candidate.httpVersion),
      startedAt: firstString(candidate.startedAt, candidate.startTime, candidate.timestamp, candidate.time),
      durationMs: firstNumber(candidate.durationMs, candidate.duration, candidate.time, candidate.elapsed, candidate.cost),
      status,
      statusText: firstString(response.statusText, candidate.statusText),
      requestHeaders,
      responseHeaders,
      requestBody,
      responseBody,
      requestSizeBytes: firstNumber(candidate.requestSizeBytes, candidate.requestBodySizeBytes, candidate.requestSize, request.bodySizeBytes, request.size, request.bodySize) ?? byteLength(requestBody),
      responseSizeBytes: firstNumber(candidate.responseSizeBytes, candidate.responseBodySizeBytes, candidate.responseSize, response.bodySizeBytes, response.size, response.bodySize) ?? byteLength(responseBody),
      requestContentType: headerValue(requestHeaders, "content-type"),
      responseContentType: headerValue(responseHeaders, "content-type"),
      notes: ["Parsed with generic JSON heuristics; verify field mapping for Reqable-specific exports."],
    });
  });

  return sessions;
}

function findSessionCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  const preferredKeys = ["entries", "sessions", "requests", "items", "data", "traffic", "flows", "captures", "records", "list"];
  for (const key of preferredKeys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) {
      const nested = findSessionCandidates(candidate);
      if (nested.length > 0) return nested;
    }
  }

  if (firstString(value.url, value.requestUrl, getPath(value, ["request", "url"]))) return [value];
  return [];
}

function parseCurl(command: string, index: number): HttpSession {
  const tokens = tokenizeShell(command.trim());
  if (tokens.length === 0 || !/^curl(?:\.exe)?$/i.test(tokens[0] ?? "curl")) {
    throw new Error("Expected a cURL command beginning with curl.");
  }

  let method = "GET";
  let url = "";
  const headers: HeaderMap = {};
  const bodyParts: string[] = [];
  const notes: string[] = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const next = tokens[i + 1];

    if (token === "-X" || token === "--request") {
      if (next) method = normalizeMethod(next);
      i += 1;
      continue;
    }

    if (token.startsWith("-X") && token.length > 2) {
      method = normalizeMethod(token.slice(2));
      continue;
    }

    if (token === "-H" || token === "--header") {
      if (next) addHeaderLine(headers, next);
      i += 1;
      continue;
    }

    if (token === "-A" || token === "--user-agent") {
      if (next) headers["User-Agent"] = next;
      i += 1;
      continue;
    }

    if (token === "-u" || token === "--user") {
      if (next) headers.Authorization = "Basic <redacted-from-curl-user>";
      i += 1;
      continue;
    }

    if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--form", "-F"].includes(token)) {
      if (next) bodyParts.push(next);
      if (method === "GET") method = "POST";
      i += 1;
      continue;
    }

    if (token === "-I" || token === "--head") {
      method = "HEAD";
      continue;
    }

    if (token === "--url") {
      if (next) url = next;
      i += 1;
      continue;
    }

    if (!token.startsWith("-") && /^https?:\/\//i.test(token)) {
      url = token;
    }
  }

  if (!url) {
    throw new Error("Could not find URL in cURL command.");
  }

  const parsedUrl = parseUrl(url);
  const requestBody = bodyParts.length > 0 ? bodyParts.join("&") : undefined;

  return {
    id: createSessionId(method, url, index),
    sourceIndex: index,
    method,
    url,
    scheme: parsedUrl?.protocol.replace(":", ""),
    host: parsedUrl?.host,
    path: parsedUrl?.pathname,
    query: parsedUrl?.search ? parsedUrl.search.slice(1) : undefined,
    requestHeaders: headers,
    responseHeaders: {},
    requestBody: limitText(requestBody),
    requestSizeBytes: requestBody ? Buffer.byteLength(requestBody) : undefined,
    requestContentType: headerValue(headers, "content-type"),
    notes: notes.length > 0 ? notes : ["Imported from cURL; no response data is available."],
  };
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === '"') && quote === undefined) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && quote === undefined) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function looksLikeCurl(content: string): boolean {
  return /^\s*curl(?:\.exe)?\s+/i.test(content);
}

function getHarRequestBody(request: UnknownRecord): string | undefined {
  const postData = request.postData;
  if (!isRecord(postData)) return undefined;
  return limitText(bodyToString(postData.text) ?? harParamsToBody(postData.params));
}

function getHarResponseBody(response: UnknownRecord): string | undefined {
  const content = response.content;
  if (!isRecord(content)) return undefined;
  return limitText(bodyToString(content.text));
}

function harParamsToBody(params: unknown): string | undefined {
  if (!Array.isArray(params)) return bodyToString(params);

  const encoded = new URLSearchParams();
  for (const param of params) {
    if (!isRecord(param)) return bodyToString(params);
    const name = firstString(param.name, param.key);
    if (!name || param.fileName !== undefined || param.contentType !== undefined) return bodyToString(params);
    encoded.append(name, bodyToString(firstValue(param.value, param.val)) ?? "");
  }

  return encoded.toString() || undefined;
}

function normalizeHeaders(value: unknown): HeaderMap {
  const headers: HeaderMap = {};

  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        const name = firstString(item.name, item.key);
        const headerValueText = firstString(item.value, item.val);
        if (name && headerValueText !== undefined) headers[name] = headerValueText;
      } else if (typeof item === "string") {
        addHeaderLine(headers, item);
      }
    }
    return headers;
  }

  if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      const text = bodyToString(raw);
      if (text !== undefined) headers[key] = text;
    }
    return headers;
  }

  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) addHeaderLine(headers, line);
  }

  return headers;
}

function addHeaderLine(headers: HeaderMap, line: string): void {
  const index = line.indexOf(":");
  if (index <= 0) return;
  const name = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim();
  if (name) headers[name] = value;
}

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return match?.[1];
}

function bodyToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function limitText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= TEXT_LIMIT) return value;
  return `${value.slice(0, TEXT_LIMIT)}\n...[truncated ${value.length - TEXT_LIMIT} chars]`;
}

function byteLength(value?: string): number | undefined {
  return value === undefined ? undefined : Buffer.byteLength(value);
}

function createSessionId(method: string, url: string, index: number, salt = ""): string {
  return createId(`${index}:${method}:${url}:${salt}`);
}

function createId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase() || "GET";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(...values: unknown[]): UnknownRecord | undefined {
  return values.find(isRecord);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text !== undefined && text.length > 0) return text;
  }
  return undefined;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== undefined && number >= 0) return number;
  }
  return undefined;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function collectNotes(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}
