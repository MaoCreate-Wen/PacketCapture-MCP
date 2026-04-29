import { access, readdir, readFile, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { basename, join } from "node:path";

const DEFAULT_REQABLE_PATH = process.platform === "win32" ? "C:\\Program Files\\Reqable" : "/Applications/Reqable.app";
const MAX_ROOT_FILES = 200;
const MAX_ASSET_FILES = 800;
const MAX_TEXT_READ_BYTES = 256 * 1024;

export interface ReqableInstallInfo {
  installPath: string;
  exists: boolean;
  platform: NodeJS.Platform;
  checkedAt: string;
  executable?: string;
  executableExists?: boolean;
  executableCandidates: ReqableExecutableCandidate[];
  versionHint?: string;
  versionSources: ReqableVersionSource[];
  flutterAssets: ReqableFlutterAssetsInfo;
  capabilityClues: ReqableCapabilityClue[];
  importantFiles: ReqableImportantFile[];
  suggestedWorkflow: string[];
  integrationHints: string[];
  files: string[];
  notes: string[];
}

export interface ReqableExecutableCandidate {
  path: string;
  exists: boolean;
  reason: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface ReqableVersionSource {
  source: string;
  value: string;
}

export interface ReqableFlutterAssetsInfo {
  path: string;
  exists: boolean;
  manifestPath: string;
  manifestExists: boolean;
  assetCount: number;
  sample: string[];
  resources: string[];
  signals: {
    hasHar: boolean;
    hasCurl: boolean;
    hasPython: boolean;
    hasOverride: boolean;
    hasScript: boolean;
    hasReportServer: boolean;
    hasDesktopIntro: boolean;
  };
}

export interface ReqableCapabilityClue {
  name: string;
  available: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  notes: string[];
}

export interface ReqableImportantFile {
  label: string;
  path: string;
  exists: boolean;
  type: "file" | "directory" | "other" | "unknown";
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface ReqableRuntimeStatus {
  installPath: string;
  executable?: string;
  installed: boolean;
  running: boolean;
  processes: ReqableProcessInfo[];
  notes: string[];
}

export interface ReqableProcessInfo {
  pid?: number;
  imageName: string;
  windowTitle?: string;
}

export interface ReqableLaunchResult {
  launched: boolean;
  executable?: string;
  pid?: number;
  error?: string;
}

export async function inspectReqableInstall(installPath = DEFAULT_REQABLE_PATH): Promise<ReqableInstallInfo> {
  const checkedAt = new Date().toISOString();
  const flutterAssetsPath = join(installPath, "data", "flutter_assets");
  const manifestPath = join(flutterAssetsPath, "AssetManifest.json");
  const info: ReqableInstallInfo = {
    installPath,
    exists: false,
    platform: process.platform,
    checkedAt,
    executableCandidates: [],
    versionSources: [],
    flutterAssets: emptyFlutterAssets(flutterAssetsPath, manifestPath),
    capabilityClues: [],
    importantFiles: [],
    suggestedWorkflow: [],
    integrationHints: [],
    files: [],
    notes: [],
  };

  try {
    await access(installPath);
    info.exists = true;
  } catch {
    info.notes.push("Reqable install path is not accessible.");
    info.importantFiles = await buildImportantFileSummary(installPath, undefined, flutterAssetsPath, []);
    info.capabilityClues = buildCapabilityClues(info.flutterAssets, []);
    info.integrationHints = buildIntegrationHints(info.capabilityClues);
    info.suggestedWorkflow = buildSuggestedWorkflow(info);
    return info;
  }

  const rootFiles = await safeList(installPath);
  info.files = rootFiles.slice(0, MAX_ROOT_FILES);

  const executableCandidates = await findReqableExecutableCandidates(installPath, rootFiles);
  info.executableCandidates = executableCandidates;
  const executable = executableCandidates.find((candidate) => candidate.exists);
  if (executable) {
    info.executable = executable.path;
    info.executableExists = true;
  } else {
    info.executableExists = false;
    info.notes.push("No Reqable executable candidate was found.");
  }

  const assetFiles = await safeListRecursive(flutterAssetsPath, 4, MAX_ASSET_FILES);
  const manifestText = await safeReadText(manifestPath);
  info.flutterAssets = buildFlutterAssetsInfo(flutterAssetsPath, manifestPath, assetFiles, manifestText);

  info.versionSources = await collectVersionSources(installPath, info.executable, flutterAssetsPath);
  info.versionHint = info.versionSources[0]?.value;
  if (!info.versionHint) {
    info.notes.push("No version clue was found.");
  }

  info.importantFiles = await buildImportantFileSummary(installPath, info.executable, flutterAssetsPath, assetFiles);
  info.capabilityClues = buildCapabilityClues(info.flutterAssets, rootFiles);
  info.integrationHints = buildIntegrationHints(info.capabilityClues);
  info.suggestedWorkflow = buildSuggestedWorkflow(info);
  info.notes.push("No public Reqable CLI is assumed by this probe. Prefer export files or the Python bridge for automation.");

  return info;
}

export async function findReqableExecutable(installPath = DEFAULT_REQABLE_PATH): Promise<string | undefined> {
  const rootFiles = await safeList(installPath);
  const candidate = (await findReqableExecutableCandidates(installPath, rootFiles)).find((item) => item.exists);
  return candidate?.path;
}

export async function getReqableRuntimeStatus(installPath = DEFAULT_REQABLE_PATH): Promise<ReqableRuntimeStatus> {
  const executable = await findReqableExecutable(installPath);
  const processes = await listReqableProcesses();
  const notes: string[] = [];

  if (!executable) {
    notes.push("Reqable executable was not found.");
  }
  if (process.platform !== "win32") {
    notes.push("Process probing is best effort outside Windows.");
  }

  return {
    installPath,
    executable,
    installed: executable !== undefined,
    running: processes.length > 0,
    processes,
    notes,
  };
}

export async function launchReqable(installPath = DEFAULT_REQABLE_PATH): Promise<ReqableLaunchResult> {
  const executable = await findReqableExecutable(installPath);
  if (!executable) {
    return { launched: false, error: "Reqable executable was not found." };
  }

  try {
    const child = spawn(executable, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { launched: true, executable, pid: child.pid };
  } catch (error) {
    return {
      launched: false,
      executable,
      error: formatError(error),
    };
  }
}

function emptyFlutterAssets(path: string, manifestPath: string): ReqableFlutterAssetsInfo {
  return {
    path,
    exists: false,
    manifestPath,
    manifestExists: false,
    assetCount: 0,
    sample: [],
    resources: [],
    signals: {
      hasHar: false,
      hasCurl: false,
      hasPython: false,
      hasOverride: false,
      hasScript: false,
      hasReportServer: false,
      hasDesktopIntro: false,
    },
  };
}

function buildFlutterAssetsInfo(path: string, manifestPath: string, assetFiles: string[], manifestText: string): ReqableFlutterAssetsInfo {
  const searchable = normalizeSearchText([...assetFiles, manifestText]);
  const resources = assetFiles
    .filter((file) => file.toLowerCase().includes("/resources/") || file.toLowerCase().startsWith("assets/resources/"))
    .slice(0, 80);

  return {
    path,
    exists: assetFiles.length > 0 || manifestText.length > 0,
    manifestPath,
    manifestExists: manifestText.length > 0,
    assetCount: assetFiles.length,
    sample: assetFiles.slice(0, 80),
    resources,
    signals: {
      hasHar: matchesAny(searchable, [/\bhar\b/i, /ic_har/i, /har_/i, /_har/i]),
      hasCurl: matchesAny(searchable, [/\bcurl\b/i, /ic_curl/i]),
      hasPython: matchesAny(searchable, [/\bpython\b/i, /\.py\b/i, /pyodide/i]),
      hasOverride: matchesAny(searchable, [/override/i, /overrides-python\.zip/i, /overrides-version\.json/i]),
      hasScript: matchesAny(searchable, [/\bscript\b/i, /scripts?\//i, /scripting/i]),
      hasReportServer: matchesAny(searchable, [/report[-_/ ]?server/i, /server[-_/ ]?report/i, /report_server/i]),
      hasDesktopIntro: matchesAny(searchable, [/introduce_desktop_app\.md/i]),
    },
  };
}

function buildCapabilityClues(flutterAssets: ReqableFlutterAssetsInfo, rootFiles: string[]): ReqableCapabilityClue[] {
  const rootSearchable = normalizeSearchText(rootFiles);
  const assetEvidence = flutterAssets.sample.concat(flutterAssets.resources);
  const rootEvidence = rootFiles.slice(0, MAX_ROOT_FILES);

  return [
    buildClue(
      "HAR export",
      flutterAssets.signals.hasHar,
      flutterAssets.signals.hasHar ? "medium" : "low",
      findEvidence(assetEvidence, [/har/i]),
      ["Use HAR export as the preferred stable import path for MCP analysis."],
    ),
    buildClue(
      "cURL copy or export",
      flutterAssets.signals.hasCurl,
      flutterAssets.signals.hasCurl ? "medium" : "low",
      findEvidence(assetEvidence, [/curl/i]),
      ["Copied cURL commands can be imported with the import_curl tool."],
    ),
    buildClue(
      "Python scripting",
      flutterAssets.signals.hasPython || rootSearchable.includes("python"),
      flutterAssets.signals.hasPython ? "medium" : "low",
      findEvidence(assetEvidence.concat(rootEvidence), [/python/i, /\.py\b/i, /pyodide/i]),
      ["Python scripting is the best hook for live MCP inbox export when enabled in Reqable."],
    ),
    buildClue(
      "Override bundle",
      flutterAssets.signals.hasOverride,
      flutterAssets.signals.hasOverride ? "high" : "low",
      findEvidence(assetEvidence, [/override/i, /overrides-python\.zip/i, /overrides-version\.json/i]),
      ["Override resources indicate Reqable includes extension or rewrite related assets."],
    ),
    buildClue(
      "Script workflow",
      flutterAssets.signals.hasScript,
      flutterAssets.signals.hasScript ? "medium" : "low",
      findEvidence(assetEvidence, [/script/i, /scripting/i]),
      ["Use the generated MCP bridge script when Reqable scripting is available."],
    ),
    buildClue(
      "Report server",
      flutterAssets.signals.hasReportServer,
      flutterAssets.signals.hasReportServer ? "medium" : "low",
      findEvidence(assetEvidence, [/report[-_/ ]?server/i, /server[-_/ ]?report/i, /report_server/i]),
      ["Report server clues are asset based and should be verified in the Reqable UI before automation depends on them."],
    ),
    buildClue(
      "Local proxy engine",
      rootFiles.some((file) => /reqable_sproxy/i.test(file)),
      rootFiles.some((file) => /reqable_sproxy/i.test(file)) ? "medium" : "low",
      findEvidence(rootEvidence, [/reqable_sproxy/i]),
      ["Local proxy components suggest the desktop app owns proxy capture, not a stable public CLI."],
    ),
  ];
}

function buildClue(name: string, available: boolean, confidence: ReqableCapabilityClue["confidence"], evidence: string[], notes: string[]): ReqableCapabilityClue {
  return {
    name,
    available,
    confidence,
    evidence: evidence.slice(0, 20),
    notes,
  };
}

function buildIntegrationHints(clues: ReqableCapabilityClue[]): string[] {
  const hints: string[] = [];

  for (const clue of clues) {
    if (!clue.available) continue;
    if (clue.name === "HAR export") hints.push("HAR export assets were found; prefer HAR files for repeatable MCP imports.");
    if (clue.name === "cURL copy or export") hints.push("cURL assets were found; copied cURL commands can be imported for request-level analysis.");
    if (clue.name === "Python scripting") hints.push("Python scripting clues were found; the MCP bridge script may be usable for live NDJSON export.");
    if (clue.name === "Override bundle") hints.push("Override bundle assets were found; Reqable likely includes rewrite or extension resources.");
    if (clue.name === "Script workflow") hints.push("Script workflow clues were found; check the Reqable UI for script enablement.");
    if (clue.name === "Report server") hints.push("Report server clues were found in assets; verify the UI before relying on it.");
    if (clue.name === "Local proxy engine") hints.push("Local proxy components were found; treat Reqable as a GUI proxy and export source.");
  }

  if (hints.length === 0) {
    hints.push("No strong automation clue was found. Use manual HAR or cURL export as the safe fallback.");
  }

  return hints;
}

function buildSuggestedWorkflow(info: ReqableInstallInfo): string[] {
  const hasPython = info.capabilityClues.some((clue) => clue.name === "Python scripting" && clue.available);
  const hasHar = info.capabilityClues.some((clue) => clue.name === "HAR export" && clue.available);
  const hasCurl = info.capabilityClues.some((clue) => clue.name === "cURL copy or export" && clue.available);
  const workflow: string[] = [];

  if (!info.exists) {
    return [
      "Install Reqable or pass installPath to the actual installation directory.",
      "After installation, run inspect_reqable_install again before preparing automation.",
    ];
  }

  if (info.executable) {
    workflow.push("Launch Reqable from the detected executable and enable capture for the target app or browser.");
  } else {
    workflow.push("Open Reqable manually, because no executable path was detected.");
  }

  if (hasPython) {
    workflow.push("For live automation, generate the MCP Python bridge and enable it in Reqable scripting.");
    workflow.push("Use get_reqable_inbox_status to confirm events are being written before analysis.");
  }

  if (hasHar) {
    workflow.push("For reliable batch analysis, export selected traffic as HAR and import it with import_capture_file.");
  }

  if (hasCurl) {
    workflow.push("For a single request, copy cURL from Reqable and import it with import_curl.");
  }

  workflow.push("Run analyze_reqable_inbox or analyze_capture, then generate_report when evidence needs to be preserved.");

  return workflow;
}

async function findReqableExecutableCandidates(installPath: string, rootFiles: string[]): Promise<ReqableExecutableCandidate[]> {
  const candidates = uniqueStrings([
    process.platform === "win32" ? join(installPath, "Reqable.exe") : join(installPath, "Contents", "MacOS", "Reqable"),
    ...rootFiles
      .filter((file) => /reqable/i.test(file) && executableNameMatchesPlatform(file))
      .map((file) => join(installPath, file)),
  ]);

  const summaries: ReqableExecutableCandidate[] = [];
  for (const candidate of candidates) {
    const summary = await summarizeExecutableCandidate(candidate, basename(candidate).toLowerCase() === "reqable.exe" ? "default executable name" : "reqable executable name match");
    summaries.push(summary);
  }

  return summaries.sort((left, right) => Number(right.exists) - Number(left.exists));
}

async function summarizeExecutableCandidate(path: string, reason: string): Promise<ReqableExecutableCandidate> {
  try {
    const fileStat = await stat(path);
    return {
      path,
      exists: fileStat.isFile(),
      reason,
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return { path, exists: false, reason };
  }
}

async function collectVersionSources(installPath: string, executable: string | undefined, flutterAssetsPath: string): Promise<ReqableVersionSource[]> {
  const sources: ReqableVersionSource[] = [];
  const overridesVersionPath = join(flutterAssetsPath, "assets", "resources", "overrides-version.json");
  const overridesVersion = await safeReadText(overridesVersionPath);
  if (overridesVersion) {
    sources.push({ source: overridesVersionPath, value: summarizeJsonText(overridesVersion) });
  }

  const packageInfoPath = join(flutterAssetsPath, "assets", "resources", "package-info.json");
  const packageInfo = await safeReadText(packageInfoPath);
  if (packageInfo) {
    sources.push({ source: packageInfoPath, value: summarizeJsonText(packageInfo) });
  }

  if (executable && process.platform === "win32") {
    const versionInfo = await readWindowsExecutableVersion(executable);
    if (versionInfo) {
      sources.push({ source: executable, value: versionInfo });
    }
  }

  const versionNamedFiles = (await safeList(installPath))
    .filter((file) => /version|release|changelog/i.test(file))
    .slice(0, 5);
  for (const file of versionNamedFiles) {
    const absolute = join(installPath, file);
    const content = await safeReadText(absolute);
    if (content) {
      sources.push({ source: absolute, value: firstNonEmptyLine(content) });
    }
  }

  return uniqueVersionSources(sources);
}

async function readWindowsExecutableVersion(executable: string): Promise<string | undefined> {
  const script = [
    "$p=$args[0]",
    "if (Test-Path -LiteralPath $p) {",
    "  $v=(Get-Item -LiteralPath $p).VersionInfo",
    "  [PSCustomObject]@{ProductVersion=$v.ProductVersion;FileVersion=$v.FileVersion;ProductName=$v.ProductName;CompanyName=$v.CompanyName} | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
  const output = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, executable], 2000);
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([key, value]) => `${key}: ${value.trim()}`)
      .join("; ");
  } catch {
    return firstNonEmptyLine(output);
  }
}

async function buildImportantFileSummary(installPath: string, executable: string | undefined, flutterAssetsPath: string, assetFiles: string[]): Promise<ReqableImportantFile[]> {
  const paths: Array<[string, string]> = [
    ["install directory", installPath],
    ["executable", executable ?? (process.platform === "win32" ? join(installPath, "Reqable.exe") : join(installPath, "Contents", "MacOS", "Reqable"))],
    ["flutter assets directory", flutterAssetsPath],
    ["asset manifest", join(flutterAssetsPath, "AssetManifest.json")],
    ["override version", join(flutterAssetsPath, "assets", "resources", "overrides-version.json")],
    ["override python bundle", join(flutterAssetsPath, "assets", "resources", "overrides-python.zip")],
    ["desktop introduction", join(flutterAssetsPath, "assets", "documents", "introduce_desktop_app.md")],
  ];

  const interestingAssets = assetFiles
    .filter((file) => /overrides-python\.zip|overrides-version\.json|introduce_desktop_app\.md|report[-_/ ]?server|ic_har|ic_curl/i.test(file))
    .slice(0, 20);
  for (const asset of interestingAssets) {
    paths.push([`asset: ${asset}`, join(flutterAssetsPath, ...asset.split("/"))]);
  }

  const seen = new Set<string>();
  const summaries: ReqableImportantFile[] = [];
  for (const [label, path] of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(await summarizeImportantFile(label, path));
  }
  return summaries;
}

async function summarizeImportantFile(label: string, path: string): Promise<ReqableImportantFile> {
  try {
    const fileStat = await stat(path);
    return {
      label,
      path,
      exists: true,
      type: fileStat.isFile() ? "file" : fileStat.isDirectory() ? "directory" : "other",
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return {
      label,
      path,
      exists: false,
      type: "unknown",
    };
  }
}

async function listReqableProcesses(): Promise<ReqableProcessInfo[]> {
  if (process.platform === "win32") {
    const output = await execFileText("tasklist.exe", ["/FI", "IMAGENAME eq Reqable.exe", "/FO", "CSV", "/NH"], 2000);
    if (!output || /no tasks are running/i.test(output)) return [];
    return output
      .split(/\r?\n/)
      .map((line) => parseTasklistCsvLine(line))
      .filter((processInfo): processInfo is ReqableProcessInfo => processInfo !== undefined);
  }

  const output = await execFileText("ps", ["-axo", "pid=,comm="], 2000);
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /reqable/i.test(line))
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      return {
        pid: match ? Number(match[1]) : undefined,
        imageName: match ? match[2] : line,
      };
    });
}

function parseTasklistCsvLine(line: string): ReqableProcessInfo | undefined {
  const columns = parseCsvLine(line);
  if (columns.length < 2 || !/reqable/i.test(columns[0] ?? "")) return undefined;
  return {
    imageName: columns[0] ?? "Reqable.exe",
    pid: Number(columns[1]) || undefined,
    windowTitle: columns[8],
  };
}

function parseCsvLine(line: string): string[] {
  const columns: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      columns.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current || line.endsWith(",")) columns.push(current);
  return columns;
}

function executableNameMatchesPlatform(file: string): boolean {
  if (process.platform === "win32") return /\.exe$/i.test(file);
  return !file.includes(".");
}

function normalizeSearchText(values: string[]): string {
  return values.join("\n").toLowerCase();
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function findEvidence(values: string[], patterns: RegExp[]): string[] {
  return values
    .filter((value) => patterns.some((pattern) => pattern.test(value)))
    .slice(0, 20);
}

function summarizeJsonText(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(parsed);
    }
  } catch {
    // Fall through to text summary.
  }
  return firstNonEmptyLine(text);
}

function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 500) ?? "";
}

async function safeReadText(path: string): Promise<string> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_TEXT_READ_BYTES) return "";
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function safeList(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function safeListRecursive(path: string, maxDepth: number, maxEntries: number, prefix = ""): Promise<string[]> {
  if (maxDepth < 0 || maxEntries <= 0) return [];
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: string[] = [];
  for (const entry of entries) {
    if (result.length >= maxEntries) break;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.push(relative);
    if (entry.isDirectory()) {
      const childPath = join(path, entry.name);
      const childEntries = await safeListRecursive(childPath, maxDepth - 1, maxEntries - result.length, relative);
      result.push(...childEntries);
    }
  }
  return result;
}

async function execFileText(file: string, args: string[], timeout: number): Promise<string> {
  return await new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function uniqueVersionSources(sources: ReqableVersionSource[]): ReqableVersionSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.source}\n${source.value}`;
    if (seen.has(key) || source.value.length === 0) return false;
    seen.add(key);
    return true;
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
