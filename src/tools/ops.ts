import { z } from 'zod';
import { db } from '../db.js';
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerOpsTools(server: McpServer) {
  // Tool 4: Safe Infrastructure Remediation
  server.tool(
    'execute_remediation',
    'Safely trigger operational remediation actions (restart, scale replicas, purge cache) with built-in guardrails and auditing.',
    {
      service_id: z.string().describe('Target service ID (e.g. svc-checkout)'),
      action: z.enum(['restart_service', 'scale_replicas', 'purge_cache']).describe('The remediation action to perform'),
      replicas: z.number().int().min(1).max(20).optional().describe('Required when action is scale_replicas (must be between 1 and 20)'),
      operator_id: z.string().describe('ID or email of the AI Operator or engineer initiating the action'),
      justification: z.string().min(10).describe('Business or technical justification for the remediation action'),
      confirm_production: z.boolean().default(false).describe('Explicit confirmation required if target service is in production')
    },
    async ({ service_id, action, replicas, operator_id, justification, confirm_production }) => {
      // 1. Verify target service exists
      const service = db.prepare('SELECT * FROM services WHERE id = ?').get(service_id) as any;
      if (!service) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error: Target service with ID '${service_id}' was not found in registry.`
            }
          ]
        };
      }

      const auditId = `AUD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

      // 2. Guardrail: Production confirmation check
      if (service.environment === 'production' && !confirm_production) {
        db.prepare(`
          INSERT INTO audit_logs (id, action, target_service, requested_by, environment, status, justification)
          VALUES (?, ?, ?, ?, ?, 'rejected', ?)
        `).run(auditId, action, service_id, operator_id, service.environment, `Blocked: Missing explicit confirm_production flag. Reason: ${justification}`);

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[POLICY GUARDRAIL BLOCKED] Action '${action}' on '${service_id}' (${service.environment}) was REJECTED.\nReason: Production modifications require 'confirm_production: true'. Audit ID: ${auditId}`
            }
          ]
        };
      }

      // 3. Action specific execution
      let executionDetails = '';

      if (action === 'scale_replicas') {
        if (!replicas) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Error: Parameter "replicas" is mandatory when action is "scale_replicas".' }]
          };
        }

        db.prepare(`UPDATE services SET replicas = ?, latency_p99_ms = latency_p99_ms * 0.6, error_rate_pct = error_rate_pct * 0.5, status = 'healthy', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(replicas, service_id);
        executionDetails = `Scaled replicas from ${service.replicas} to ${replicas}. Telemetry stabilized.`;
      } else if (action === 'restart_service') {
        db.prepare(`UPDATE services SET status = 'healthy', cpu_usage_pct = 25.0, error_rate_pct = 0.05, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(service_id);
        executionDetails = `Graceful rolling restart executed. Memory and CPU reset. Service status set to healthy.`;
      } else if (action === 'purge_cache') {
        db.prepare('UPDATE services SET memory_usage_pct = memory_usage_pct * 0.7, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(service_id);
        executionDetails = `In-memory cache purged. Memory usage reduced by 30%.`;
      }

      // 4. Log successful audit trail
      db.prepare(`
        INSERT INTO audit_logs (id, action, target_service, requested_by, environment, status, justification)
        VALUES (?, ?, ?, ?, ?, 'executed', ?)
      `).run(auditId, action, service_id, operator_id, service.environment, `${justification} | Result: ${executionDetails}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                audit_id: auditId,
                action,
                target_service: service_id,
                environment: service.environment,
                operator: operator_id,
                details: executionDetails,
                executed_at: new Date().toISOString()
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // Tool 5: Audit Trail Inspector
  server.tool(
    'get_audit_trail',
    'Query the compliance audit log for past operational interventions.',
    {
      limit: z.number().int().min(1).max(50).default(10).describe('Max log entries to return'),
      target_service: z.string().optional().describe('Filter by target service ID')
    },
    async ({ limit, target_service }) => {
      let query = 'SELECT * FROM audit_logs WHERE 1=1';
      const params: (string | number)[] = [];

      if (target_service) {
        query += ' AND target_service = ?';
        params.push(target_service);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const logs = db.prepare(query).all(...params);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                total_audits: logs.length,
                records: logs
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
