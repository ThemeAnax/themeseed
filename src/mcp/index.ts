#!/usr/bin/env node
/**
 * `themeseed-mcp` — the MCP server entry point, speaking JSON-RPC over stdio.
 *
 * stdout belongs to the protocol. Diagnostics go to stderr via `logger`, and
 * the config file is read quietly for the same reason.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadUserEnv } from '../config/env.js';
import { logger } from '../core/logger.js';
import { readVersion } from '../core/version.js';
import { createThemeseedServer } from './server.js';

// Provider keys come from ~/.themeseed/.env, not the working directory: an
// editor launches this server wherever it likes, and a relative lookup there
// finds a different file every time, or none.
loadUserEnv();

async function main(): Promise<void> {
  const version = await readVersion();
  const server = createThemeseedServer(version);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info(`themeseed MCP server ${version} ready on stdio`);
}

main().catch((err) => {
  logger.error('themeseed MCP server failed to start:', err);
  process.exit(1);
});
