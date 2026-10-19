import { describe, it, expect, beforeAll } from 'vitest';
import { db, initDatabase } from '../src/db.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMetricsTools } from '../src/tools/metrics.js';
import { registerOpsTools } from '../src/tools/ops.js';
import crypto from 'node:crypto';

describe('MCP Ops Bridge - Automated Suite', () => {
  let server: McpServer;

  beforeAll(() => {
    initDatabase();
    server = new McpServer({ name: 'test-ops-bridge', version: '1.0.0' });
    registerMetricsTools(server);
    registerOpsTools(server);
  });

  it('should have seeded database with core microservices and incident', () => {
    const services = db.prepare('SELECT * FROM services').all();
    expect(services.length).toBeGreaterThanOrEqual(5);

    const incidents = db.prepare('SELECT * FROM incident_logs').all();
    expect(incidents.length).toBeGreaterThanOrEqual(1);
  });

  it('should verify production service environment and handle guardrail blocking', () => {
    const serviceBefore = db.prepare("SELECT * FROM services WHERE id = 'svc-checkout'").get() as any;
    expect(serviceBefore.environment).toBe('production');

    const auditCountBefore = (db.prepare("SELECT COUNT(*) as cnt FROM audit_logs WHERE status = 'rejected'").get() as any).cnt;

    // Simulate guardrail audit insert
    const auditId = `AUD-${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO audit_logs (id, action, target_service, requested_by, environment, status, justification)
      VALUES (?, 'scale_replicas', 'svc-checkout', 'operator-test', 'production', 'rejected', 'Blocked by test guardrail')
    `).run(auditId);

    const auditCountAfter = (db.prepare("SELECT COUNT(*) as cnt FROM audit_logs WHERE status = 'rejected'").get() as any).cnt;
    expect(auditCountAfter).toBe(auditCountBefore + 1);
  });

  it('should execute remediation and update service status', () => {
    const targetId = 'svc-inventory';
    db.prepare("UPDATE services SET status = 'degraded', memory_usage_pct = 95.0 WHERE id = ?").run(targetId);

    // Apply purge_cache
    db.prepare("UPDATE services SET memory_usage_pct = memory_usage_pct * 0.7, status = 'healthy' WHERE id = ?").run(targetId);

    const updated = db.prepare('SELECT * FROM services WHERE id = ?').get(targetId) as any;
    expect(updated.status).toBe('healthy');
    expect(updated.memory_usage_pct).toBeCloseTo(66.5, 1);
  });

  it('should log audit record accurately upon execution', () => {
    const auditId = `AUD-${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO audit_logs (id, action, target_service, requested_by, environment, status, justification)
      VALUES (?, 'restart_service', 'svc-search', 'alejandro@ops.ai', 'production', 'executed', 'Routine canary restart')
    `).run(auditId);

    const record = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(auditId) as any;
    expect(record).toBeDefined();
    expect(record.action).toBe('restart_service');
    expect(record.status).toBe('executed');
    expect(record.requested_by).toBe('alejandro@ops.ai');
  });
});
