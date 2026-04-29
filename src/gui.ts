#!/usr/bin/env node
import { startGuiServer } from "./guiServer.js";

async function main(): Promise<void> {
  const server = await startGuiServer();
  console.error(`PacketCapture-MCP GUI listening at ${server.url}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
