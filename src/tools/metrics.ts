import { z } from 'zod';
import { db } from '../db.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerMetricsTools(server: McpServer) {
  // Tool 1: Service Health & Telemetry
  server.tool(
    'get_service_health',
    'Retrieve real-time telemetry, latency, error rates, and resource utilization for microservices.',
    {
      environment: z.enum(['production', 'staging', 'all']).default('all').describe('Filter by environment'),
      status: z.enum(['all', 'healthy', 'degraded', 'down']).default('all').describe('Filter by health status'),
      service_name: z.string().optional().describe('Filter by specific service name or ID')
    },
    async ({ environment, status, service_name }) => {
      let query = 'SELECT * FROM services WHERE 1=1';
      const params: (string | number)[] = [];

      if (environment !== 'all') {
        query += ' AND environment = ?';
        params.push(environment);
      }

      if (status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
      }

      if (service_name) {
        query += ' AND (name LIKE ? OR id = ?)';
        params.push(`%${service_name}%`, service_name);
      }

      query += " ORDER BY status = 'down' DESC, status = 'degraded' DESC, latency_p99_ms DESC";

      const results = db.prepare(query).all(...params);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                summary: `Found ${results.length} service(s) matching criteria.`,
                timestamp: new Date().toISOString(),
                services: results
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // Tool 2: Incident Logs & Alerting
  server.tool(
    'get_active_incidents',
    'List all open, investigating, or recently mitigated operational incidents.',
    {
      severity: z.enum(['all', 'P1', 'P2', 'P3', 'P4']).default('all').describe('Filter by incident severity'),
      status: z.enum(['all', 'open', 'investigating', 'mitigated', 'resolved']).default('all').describe('Incident status')
    },
    async ({ severity, status }) => {
      let query = `
        SELECT i.*, s.name as service_name, s.environment
        FROM incident_logs i
        JOIN services s ON i.service_id = s.id
        WHERE 1=1
      `;
      const params: string[] = [];

      if (severity !== 'all') {
        query += ' AND i.severity = ?';
        params.push(severity);
      }

      if (status !== 'all') {
        query += ' AND i.status = ?';
        params.push(status);
      } else {
        query += " AND i.status != 'resolved'";
      }

      query += ' ORDER BY i.severity ASC, i.created_at DESC';

      const results = db.prepare(query).all(...params);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                active_incidents_count: results.length,
                incidents: results
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // Tool 3: Business & Transaction Metrics
  server.tool(
    'get_business_summary',
    'Query revenue, transaction counts, and payment gateway failure rates.',
    {
      limit_days: z.number().int().min(1).max(30).default(7).describe('Number of days to inspect')
    },
    async ({ limit_days }) => {
      const results = db.prepare(`
        SELECT * FROM business_metrics
        ORDER BY metric_date DESC
        LIMIT ?
      `).all(limit_days);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                period_days: limit_days,
                metrics: results
              },
              null,
              2
            )
          }
        ]
      };
    }
  );
}
