import { db } from '../db.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerResources(server: McpServer) {
  // Resource 1: Real-time System Overview
  server.resource(
    'system_overview',
    'ops://status/overview',
    async (uri) => {
      const services = db.prepare('SELECT id, name, environment, status, latency_p99_ms FROM services').all() as any[];
      const incidents = db.prepare('SELECT COUNT(*) as count FROM incident_logs WHERE status != "resolved"').get() as { count: number };

      const content = {
        title: 'Enterprise Infrastructure Status Overview',
        generated_at: new Date().toISOString(),
        total_services: services.length,
        unresolved_incidents: incidents.count,
        services_status: services
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(content, null, 2)
          }
        ]
      };
    }
  );

  // Resource 2: Standard Incident Response Runbook
  server.resource(
    'incident_runbook',
    'ops://runbooks/incident-response',
    async (uri) => {
      const runbookMarkdown = `# Standard Operating Procedure: AI Operator Incident Response

## Severity Classification
- **P1 (Critical):** Core checkout/auth down. Immediate scaling and failover required.
- **P2 (Major):** High latency (p99 > 300ms) or error rate > 2%. Scale replicas or restart pods.
- **P3 (Minor):** Non-blocking component degraded. Investigate logs.
- **P4 (Low):** Minor cosmetic or informational alert.

## Remediation Protocol
1. Query active incidents via \`get_active_incidents\`.
2. Inspect target service health using \`get_service_health\`.
3. Check business impact with \`get_business_summary\`.
4. Apply remediation via \`execute_remediation\` with required confirmation flag.
5. Verify audit log entry via \`get_audit_trail\`.
`;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: runbookMarkdown
          }
        ]
      };
    }
  );
}
