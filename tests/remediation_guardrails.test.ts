import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// db.ts opens ./data/ops_database.sqlite relative to cwd at import time; use an isolated temp cwd
// so these tests never share state with the other suite running in parallel.
const originalCwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-'));

type Db = typeof import('../src/db.js')['db'];
let db: Db;
let client: Client;

const base = {
  operator_id: 'tester@ops.ai',
  justification: 'Automated test justification text',
};

async function call(name: string, args: Record<string, unknown>) {
  const res: any = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, text: res.content[0].text as string };
}

const audits = (service: string) =>
  db.prepare('SELECT * FROM audit_logs WHERE target_service = ? ORDER BY rowid').all(service) as any[];

beforeAll(async () => {
  process.chdir(tmpDir);
  const dbMod = await import('../src/db.js');
  const { registerMetricsTools } = await import('../src/tools/metrics.js');
  const { registerOpsTools } = await import('../src/tools/ops.js');
  process.chdir(originalCwd);
  db = dbMod.db;
  dbMod.initDatabase();

  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerMetricsTools(server);
  registerOpsTools(server);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterAll(async () => {
  await client.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('execute_remediation guardrails', () => {
  it('blocks production changes without confirm_production, leaves the service untouched and writes a rejected audit row', async () => {
    const before = db.prepare("SELECT * FROM services WHERE id = 'svc-checkout'").get() as any;
    const r = await call('execute_remediation', { ...base, service_id: 'svc-checkout', action: 'restart_service' });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('POLICY GUARDRAIL BLOCKED');
    const after = db.prepare("SELECT * FROM services WHERE id = 'svc-checkout'").get() as any;
    expect(after.status).toBe(before.status);
    expect(after.error_rate_pct).toBe(before.error_rate_pct);

    const rows = audits('svc-checkout');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('rejected');
    expect(rows[0].justification).toContain('Missing explicit confirm_production');
    expect(r.text).toContain(rows[0].id);
  });

  it('returns an error for an unknown service and writes no audit row', async () => {
    const r = await call('execute_remediation', { ...base, service_id: 'svc-ghost', action: 'purge_cache' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("'svc-ghost' was not found");
    expect(audits('svc-ghost')).toHaveLength(0);
  });

  it('rejects out-of-range replicas and too-short justification at the schema level', async () => {
    const tooMany = await call('execute_remediation', { ...base, service_id: 'svc-inventory', action: 'scale_replicas', replicas: 21 });
    const zero = await call('execute_remediation', { ...base, service_id: 'svc-inventory', action: 'scale_replicas', replicas: 0 });
    const shortJust = await call('execute_remediation', { ...base, service_id: 'svc-inventory', action: 'purge_cache', justification: 'too short' });

    for (const r of [tooMany, zero, shortJust]) expect(r.isError).toBe(true);
    expect(audits('svc-inventory')).toHaveLength(0);
    expect((db.prepare("SELECT replicas FROM services WHERE id = 'svc-inventory'").get() as any).replicas).toBe(2);
  });

  it('scale_replicas without replicas errors out and does not modify the service', async () => {
    const r = await call('execute_remediation', { ...base, service_id: 'svc-inventory', action: 'scale_replicas' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"replicas" is mandatory');
    expect((db.prepare("SELECT replicas FROM services WHERE id = 'svc-inventory'").get() as any).replicas).toBe(2);
  });

  it('executes a confirmed production purge_cache: cuts memory by 30% and records an executed audit entry', async () => {
    const before = db.prepare("SELECT * FROM services WHERE id = 'svc-checkout'").get() as any;
    const r = await call('execute_remediation', { ...base, service_id: 'svc-checkout', action: 'purge_cache', confirm_production: true });

    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.success).toBe(true);
    expect(body.environment).toBe('production');

    const after = db.prepare("SELECT * FROM services WHERE id = 'svc-checkout'").get() as any;
    expect(after.memory_usage_pct).toBeCloseTo(before.memory_usage_pct * 0.7, 5);

    const executed = audits('svc-checkout').filter((a) => a.status === 'executed');
    expect(executed).toHaveLength(1);
    expect(executed[0].id).toBe(body.audit_id);

    const trail = JSON.parse((await call('get_audit_trail', { target_service: 'svc-checkout' })).text);
    expect(trail.records.map((x: any) => x.id)).toContain(body.audit_id);
  });
});

describe('read tools filters', () => {
  it('get_active_incidents hides resolved incidents unless explicitly requested', async () => {
    db.prepare("INSERT INTO incident_logs (id, service_id, severity, summary, status) VALUES ('INC-OLD', 'svc-auth', 'P4', 'old', 'resolved')").run();

    const def = JSON.parse((await call('get_active_incidents', {})).text);
    expect(def.incidents.map((i: any) => i.id)).not.toContain('INC-OLD');

    const resolved = JSON.parse((await call('get_active_incidents', { status: 'resolved' })).text);
    expect(resolved.incidents.map((i: any) => i.id)).toEqual(['INC-OLD']);
  });

  it('get_service_health and get_business_summary validate and filter inputs', async () => {
    const stagingOnly = JSON.parse((await call('get_service_health', { environment: 'staging' })).text);
    expect(stagingOnly.services.every((s: any) => s.environment === 'staging')).toBe(true);
    expect(stagingOnly.services.length).toBeGreaterThan(0);

    expect((await call('get_business_summary', { limit_days: 0 })).isError).toBe(true);
    expect((await call('get_business_summary', { limit_days: 31 })).isError).toBe(true);

    const two = JSON.parse((await call('get_business_summary', { limit_days: 2 })).text);
    expect(two.metrics.map((m: any) => m.metric_date)).toEqual(['2026-10-19', '2026-10-18']);
  });

  it('scale_replicas updates replicas and marks the service healthy (regression: SQL quoting)', async () => {
    const r = await call('execute_remediation', { ...base, service_id: 'svc-checkout', action: 'scale_replicas', replicas: 7, confirm_production: true });
    expect(r.isError).toBe(false);
    const after = db.prepare("SELECT * FROM services WHERE id = 'svc-checkout'").get() as any;
    expect(after.replicas).toBe(7);
    expect(after.status).toBe('healthy');
  });

  it('restart_service resets the service to healthy (regression: SQL quoting)', async () => {
    const r = await call('execute_remediation', { ...base, service_id: 'svc-checkout', action: 'restart_service', confirm_production: true });
    expect(r.isError).toBe(false);
    const after = db.prepare("SELECT * FROM services WHERE id = 'svc-checkout'").get() as any;
    expect(after.status).toBe('healthy');
    expect(after.cpu_usage_pct).toBe(25);
  });
});
