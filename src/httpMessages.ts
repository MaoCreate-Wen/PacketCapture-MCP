import { Buffer } from "node:buffer";
import type { HeaderMap, HttpSession } from "./types.js";

const DEFAULT_BODY_LIMIT_BYTES = 8_192;
const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "token",
  "password",
]);

const SENSITIVE_BODY_KEY_SOURCE = String.raw`(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|[A-Za-z0-9_.-]*(?:api[-_]?key|apikey|token|password|secret)[A-Za-z0-9_.-]*)`;

export interface HttpMessageFormatOptions {
  includeBodies?: boolean;
  bodyLimit?: number;
  redactSensitive?: boolean;
  includeRawText?: boolean;
}

export interface FormattedHttpMessage {
  startLine: string;
  headers: HeaderMap;
  body: string;
  bodyIncluded: boolean;
  bodyTruncated: boolean;
  bodyBytes: number;
  rawText: string;
}

export interface FormattedHttpExchange {
  request: FormattedHttpMessage;
  response: FormattedHttpMessage;
}

interface NormalizedOptions {
  includeBodies: boolean;
  bodyLimit: number;
  redactSensitive: boolean;
  includeRawText: boolean;
}

export function formatHttpExchange(session: HttpSession, options: HttpMessageFormatOptions = {}): FormattedHttpExchange {
  const normalizedOptions = normalizeOptions(options);

  const request = formatMessage({
    startLine: formatRequestStartLine(session, normalizedOptions.redactSensitive),
    headers: session.requestHeaders,
    body: session.requestBody,
    sizeBytes: session.requestSizeBytes,
    options: normalizedOptions,
  });

  const response = formatMessage({
    startLine: formatResponseStartLine(session),
    headers: session.responseHeaders,
    body: session.responseBody,
    sizeBytes: session.responseSizeBytes,
    options: normalizedOptions,
  });

  return { request, response };
}

export const buildHttpExchange = formatHttpExchange;

function normalizeOptions(options: HttpMessageFormatOptions): NormalizedOptions {
  return {
    includeBodies: options.includeBodies ?? false,
    bodyLimit: normalizeBodyLimit(options.bodyLimit),
    redactSensitive: options.redactSensitive ?? true,
    includeRawText: options.includeRawText ?? false,
  };
}

function normalizeBodyLimit(bodyLimit: number | undefined): number {
  if (bodyLimit === undefined) return DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isFinite(bodyLimit)) return DEFAULT_BODY_LIMIT_BYTES;
  return Math.max(0, Math.floor(bodyLimit));
}

function formatMessage(input: {
  startLine: string;
  headers: HeaderMap;
  body?: string;
  sizeBytes?: number;
  options: NormalizedOptions;
}): FormattedHttpMessage {
  const headers = formatHeaders(input.headers, input.options.redactSensitive);
  const bodyBytes = bodyByteLength(input.body, input.sizeBytes);
  const bodyResult = formatBody(input.body, input.options);
  const rawText = input.options.includeRawText ? buildRawText(input.startLine, headers, bodyResult.body) : "";

  return {
    startLine: input.startLine,
    headers,
    body: bodyResult.body,
    bodyIncluded: bodyResult.included,
    bodyTruncated: bodyResult.truncated,
    bodyBytes,
    rawText,
  };
}

function formatHeaders(headers: HeaderMap, redactSensitive: boolean): HeaderMap {
  const formatted: HeaderMap = {};

  for (const [name, value] of Object.entries(headers)) {
    const safeName = sanitizeHeaderName(name);
    const safeValue = sanitizeHeaderValue(value);
    formatted[safeName] = redactSensitive && isSensitiveHeaderName(safeName) ? REDACTED_VALUE : safeValue;
  }

  return formatted;
}

function formatBody(body: string | undefined, options: NormalizedOptions): { body: string; included: boolean; truncated: boolean } {
  if (body === undefined || !options.includeBodies) {
    return { body: "", included: false, truncated: false };
  }

  const redactedBody = options.redactSensitive ? redactSensitiveBody(body) : body;
  const truncatedBody = truncateUtf8(redactedBody, options.bodyLimit);

  return {
    body: truncatedBody.text,
    included: true,
    truncated: truncatedBody.truncated,
  };
}

function buildRawText(startLine: string, headers: HeaderMap, body: string): string {
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return [startLine, ...headerLines, "", body].join("\r\n");
}

function formatRequestStartLine(session: HttpSession, redactSensitive: boolean): string {
  const method = sanitizeStartLinePart(session.method || "GET").toUpperCase();
  const target = redactSensitive ? redactSensitiveBody(requestTarget(session)) : requestTarget(session);
  const protocol = formatHttpProtocol(session.protocol);
  return `${method} ${sanitizeStartLinePart(target)} ${protocol}`;
}

function formatResponseStartLine(session: HttpSession): string {
  const protocol = formatHttpProtocol(session.protocol);
  const status = session.status === undefined ? "" : String(session.status);
  const statusText = sanitizeStartLinePart(session.statusText ?? "");
  return [protocol, status, statusText].filter((part) => part.length > 0).join(" ");
}

function requestTarget(session: HttpSession): string {
  if (session.path) {
    return `${session.path}${formatQuery(session.query)}`;
  }

  try {
    const url = new URL(session.url);
    return `${url.pathname || "/"}${url.search}`;
  } catch {
    return session.url || "/";
  }
}

function formatQuery(query: string | undefined): string {
  if (!query) return "";
  return query.startsWith("?") ? query : `?${query}`;
}

function formatHttpProtocol(protocol: string | undefined): string {
  const value = protocol?.trim();
  if (!value) return "HTTP/1.1";

  if (/^https?\/\d(?:\.\d+)?$/i.test(value)) {
    return value.replace(/^http/i, "HTTP");
  }

  if (/^h2$/i.test(value)) return "HTTP/2";
  if (/^\d(?:\.\d+)?$/.test(value)) return `HTTP/${value}`;
  return sanitizeStartLinePart(value);
}

function sanitizeStartLinePart(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function sanitizeHeaderName(name: string): string {
  const sanitized = name.replace(/[:\r\n]/g, "").trim();
  return sanitized || "x-empty-header";
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function bodyByteLength(body: string | undefined, sizeBytes: number | undefined): number {
  if (sizeBytes !== undefined && Number.isFinite(sizeBytes) && sizeBytes >= 0) return Math.floor(sizeBytes);
  if (body !== undefined) return Buffer.byteLength(body, "utf8");
  return 0;
}

function truncateUtf8(value: string, limitBytes: number): { text: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= limitBytes) return { text: value, truncated: false };
  if (limitBytes <= 0) return { text: "", truncated: totalBytes > 0 };

  const parts: string[] = [];
  let usedBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > limitBytes) break;
    parts.push(character);
    usedBytes += characterBytes;
  }

  return { text: parts.join(""), truncated: true };
}

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized)
    || normalized.includes("token")
    || normalized.includes("password")
    || normalized.includes("api-key")
    || normalized.includes("apikey");
}

function redactSensitiveBody(body: string): string {
  let redacted = body;

  redacted = redacted.replace(
    new RegExp(`(^|\\r?\\n)(${SENSITIVE_BODY_KEY_SOURCE})(\\s*:\\s*)([^\\r\\n]*)`, "gi"),
    (_match: string, prefix: string, key: string, separator: string) => `${prefix}${key}${separator}${REDACTED_VALUE}`,
  );

  redacted = redacted.replace(
    new RegExp(`(["']?${SENSITIVE_BODY_KEY_SOURCE}["']?\\s*:\\s*)"(?:(?:\\\\.)|[^"\\\\])*"`, "gi"),
    (_match: string, prefix: string) => `${prefix}"${REDACTED_VALUE}"`,
  );

  redacted = redacted.replace(
    new RegExp(`(["']?${SENSITIVE_BODY_KEY_SOURCE}["']?\\s*:\\s*)'(?:(?:\\\\.)|[^'\\\\])*'`, "gi"),
    (_match: string, prefix: string) => `${prefix}'${REDACTED_VALUE}'`,
  );

  redacted = redacted.replace(
    new RegExp(`(^|[&?;\\s,{])(${SENSITIVE_BODY_KEY_SOURCE})(\\s*[=:]\\s*)([^&;\\s,}]+)`, "gi"),
    (_match: string, prefix: string, key: string, separator: string) => `${prefix}${key}${separator}${REDACTED_VALUE}`,
  );

  return redacted;
}
