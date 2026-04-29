export type HeaderMap = Record<string, string>;

export interface HttpSession {
  id: string;
  sourceIndex: number;
  method: string;
  url: string;
  scheme?: string;
  host?: string;
  path?: string;
  query?: string;
  protocol?: string;
  startedAt?: string;
  durationMs?: number;
  status?: number;
  statusText?: string;
  requestHeaders: HeaderMap;
  responseHeaders: HeaderMap;
  requestBody?: string;
  responseBody?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
  requestContentType?: string;
  responseContentType?: string;
  notes: string[];
}

export interface CaptureDataset {
  id: string;
  source: string;
  format: string;
  importedAt: string;
  sessionCount: number;
  sessions: HttpSession[];
  metadata: Record<string, unknown>;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  severity: FindingSeverity;
  category: string;
  title: string;
  evidence: string;
  recommendation: string;
  sessionId?: string;
}

export interface CaptureAnalysis {
  captureId: string;
  summary: {
    totalSessions: number;
    hosts: number;
    methods: Record<string, number>;
    statusClasses: Record<string, number>;
    contentTypes: Record<string, number>;
    totalRequestBytes: number;
    totalResponseBytes: number;
    averageDurationMs?: number;
  };
  topHosts: Array<{ host: string; count: number }>;
  slowestSessions: Array<{ sessionId: string; method: string; url: string; durationMs: number; status?: number }>;
  largestResponses: Array<{ sessionId: string; method: string; url: string; responseSizeBytes: number; status?: number }>;
  findings: Finding[];
}
