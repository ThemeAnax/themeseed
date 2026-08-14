/**
 * Manual probe: start the built MCP server over stdio, list its tools, and
 * call one, exactly as a host would.
 *
 *   npm run build && npx tsx scripts/probe-mcp.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/mcp/index.js'],
  env: {
    ...(process.env as Record<string, string>),
    THEMESEED_LOG_LEVEL: 'error',
  },
});

const client = new Client({ name: 'themeseed-probe', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Server exposes ${tools.length} tools:\n`);
for (const tool of tools) {
  const params = Object.keys(tool.inputSchema?.properties ?? {});
  console.log(`  ${tool.name.padEnd(16)} ${params.length ? params.join(', ') : '(no parameters)'}`);
}

console.log('\nCalling list_sites…');
const result = await client.callTool({ name: 'list_sites', arguments: {} });
const content = result.content as Array<{ type: string; text?: string }>;
for (const block of content) if (block.type === 'text') console.log(block.text);

await client.close();
console.log('\nMCP server responded correctly over stdio.');
