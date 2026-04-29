import { spawn } from "node:child_process";

const checks = [
  {
    name: "Codex CLI",
    command: cliCommand("codex"),
    args: ["mcp", "get", "packetcapture"],
    expected: ["packetcapture", "enabled: true", "transport: stdio"],
  },
  {
    name: "Claude Code CLI",
    command: cliCommand("claude"),
    args: ["mcp", "get", "packetcapture"],
    expected: ["packetcapture", "Status:", "Connected"],
  },
];

const results = [];

for (const check of checks) {
  const result = await run(check.command, check.args);
  const output = `${result.stdout}\n${result.stderr}`;
  const installed = result.code !== "ENOENT";
  const passed = installed && result.exitCode === 0 && check.expected.every((fragment) => output.includes(fragment));
  results.push({
    name: check.name,
    command: [check.command, ...check.args].join(" "),
    installed,
    exitCode: result.exitCode,
    passed,
  });
}

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}

function run(command, args) {
  return new Promise((resolve) => {
    const commandArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", quoteCommand([command, ...args])]
      : args;
    const executable = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : command;
    const child = spawn(executable, commandArgs, {
      cwd: process.cwd(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: error.code, exitCode: undefined, stdout, stderr: error.message });
    });
    child.on("close", (exitCode) => {
      resolve({ code: undefined, exitCode, stdout, stderr });
    });
  });
}

function cliCommand(name) {
  return name;
}

function quoteCommand(parts) {
  return parts
    .map((part) => (/[\s"]/u.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(" ");
}
