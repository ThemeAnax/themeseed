#!/usr/bin/env node
/**
 * `themeseed-mcp` — the MCP server entry point, speaking JSON-RPC over stdio.
 *
 * stdout belongs to the protocol. Diagnostics go to stderr via `logger`, and
 * `dotenv` is loaded quietly for the same reason.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';

import { logger } from '../core/logger.js';
import { readVersion } from '../core/version.js';
import { createThemeseedServer } from './server.js';

dotenv.config({ quiet: true });

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
