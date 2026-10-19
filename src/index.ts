import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initDatabase } from './db.js';
import { registerMetricsTools } from './tools/metrics.js';
import { registerOpsTools } from './tools/ops.js';
import { registerResources } from './tools/resources.js';

async function main() {
  // CRITICAL MCP RULE: Never use console.log on stdout in stdio mode.
  // Stdout is reserved exclusively for JSON-RPC communication.
  console.error('[MCP Ops Bridge] Initializing database and schema...');
  initDatabase();

  const server = new McpServer({
    name: 'mcp-ops-bridge',
    version: '1.0.0'
  });

  console.error('[MCP Ops Bridge] Registering MCP tools and resources...');
  registerMetricsTools(server);
  registerOpsTools(server);
  registerResources(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP Ops Bridge] Server connected to stdio transport. Ready for client connections.');
}

main().catch((err) => {
  console.error('[MCP Ops Bridge] Fatal server error:', err);
  process.exit(1);
});
