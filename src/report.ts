import type { CaptureAnalysis, CaptureDataset, FindingSeverity } from "./types.js";

export function renderMarkdownReport(capture: CaptureDataset, analysis: CaptureAnalysis): string {
  const lines: string[] = [];
  lines.push(`# Packet Capture Analysis Report`);
  lines.push("");
  lines.push(`- Capture ID: \`${capture.id}\``);
  lines.push(`- Source: \`${capture.source}\``);
  lines.push(`- Format: \`${capture.format}\``);
  lines.push(`- Imported At: ${capture.importedAt}`);
  lines.push(`- Sessions: ${analysis.summary.totalSessions}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Hosts: ${analysis.summary.hosts}`);
  lines.push(`- Total request bytes: ${analysis.summary.totalRequestBytes}`);
  lines.push(`- Total response bytes: ${analysis.summary.totalResponseBytes}`);
  if (analysis.summary.averageDurationMs !== undefined) lines.push(`- Average duration: ${analysis.summary.averageDurationMs}ms`);
  lines.push(`- Methods: ${formatRecord(analysis.summary.methods)}`);
  lines.push(`- Status classes: ${formatRecord(analysis.summary.statusClasses)}`);
  lines.push(`- Content types: ${formatRecord(analysis.summary.contentTypes)}`);
  lines.push("");

  lines.push("## Top Hosts");
  lines.push("");
  if (analysis.topHosts.length === 0) {
    lines.push("No hosts found.");
  } else {
    for (const item of analysis.topHosts) lines.push(`- ${item.host}: ${item.count}`);
  }
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  const counts = countFindings(analysis);
  lines.push(`- Critical: ${counts.critical}`);
  lines.push(`- High: ${counts.high}`);
  lines.push(`- Medium: ${counts.medium}`);
  lines.push(`- Low: ${counts.low}`);
  lines.push(`- Info: ${counts.info}`);
  lines.push("");

  if (analysis.findings.length === 0) {
    lines.push("No findings detected by the built-in rules.");
  } else {
    for (const finding of analysis.findings.slice(0, 100)) {
      lines.push(`### [${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push("");
      lines.push(`- Category: ${finding.category}`);
      if (finding.sessionId) lines.push(`- Session: \`${finding.sessionId}\``);
      lines.push(`- Evidence: ${finding.evidence}`);
      lines.push(`- Recommendation: ${finding.recommendation}`);
      lines.push("");
    }
    if (analysis.findings.length > 100) lines.push(`_Truncated ${analysis.findings.length - 100} additional findings._`);
  }

  lines.push("## Slowest Sessions");
  lines.push("");
  for (const session of analysis.slowestSessions) {
    lines.push(`- ${session.durationMs}ms ${session.status ?? "-"} ${session.method} ${session.url} (\`${session.sessionId}\`)`);
  }
  if (analysis.slowestSessions.length === 0) lines.push("No timing data available.");
  lines.push("");

  lines.push("## Largest Responses");
  lines.push("");
  for (const session of analysis.largestResponses) {
    lines.push(`- ${session.responseSizeBytes} bytes ${session.status ?? "-"} ${session.method} ${session.url} (\`${session.sessionId}\`)`);
  }
  if (analysis.largestResponses.length === 0) lines.push("No response size data available.");
  lines.push("");

  return lines.join("\n");
}

function formatRecord(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function countFindings(analysis: CaptureAnalysis): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of analysis.findings) counts[finding.severity] += 1;
  return counts;
}
