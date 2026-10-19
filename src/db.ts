import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DB_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'ops_database.sqlite');
export const db: Database.Database = new Database(DB_PATH);

// Initialize schema and mock seed data
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'down')),
      replicas INTEGER NOT NULL,
      cpu_usage_pct REAL NOT NULL,
      memory_usage_pct REAL NOT NULL,
      latency_p99_ms REAL NOT NULL,
      error_rate_pct REAL NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS incident_logs (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('P1', 'P2', 'P3', 'P4')),
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'investigating', 'mitigated', 'resolved')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      target_service TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('approved', 'rejected', 'executed', 'failed')),
      justification TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS business_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_date DATE NOT NULL UNIQUE,
      total_orders INTEGER NOT NULL,
      gross_revenue_usd REAL NOT NULL,
      payment_failure_rate_pct REAL NOT NULL,
      active_users INTEGER NOT NULL
    );
  `);

  // Seed sample enterprise services if empty
  const count = db.prepare('SELECT COUNT(*) as total FROM services').get() as { total: number };
  if (count.total === 0) {
    const insertService = db.prepare(`
      INSERT INTO services (id, name, environment, status, replicas, cpu_usage_pct, memory_usage_pct, latency_p99_ms, error_rate_pct)
      VALUES (@id, @name, @environment, @status, @replicas, @cpu_usage_pct, @memory_usage_pct, @latency_p99_ms, @error_rate_pct)
    `);

    const seedServices = [
      { id: 'svc-auth', name: 'auth-gateway', environment: 'production', status: 'healthy', replicas: 4, cpu_usage_pct: 32.5, memory_usage_pct: 45.0, latency_p99_ms: 45.2, error_rate_pct: 0.02 },
      { id: 'svc-checkout', name: 'checkout-api', environment: 'production', status: 'degraded', replicas: 6, cpu_usage_pct: 78.4, memory_usage_pct: 82.1, latency_p99_ms: 420.5, error_rate_pct: 3.85 },
      { id: 'svc-payments', name: 'payment-processor', environment: 'production', status: 'healthy', replicas: 3, cpu_usage_pct: 22.0, memory_usage_pct: 38.5, latency_p99_ms: 110.0, error_rate_pct: 0.10 },
      { id: 'svc-inventory', name: 'inventory-sync', environment: 'staging', status: 'healthy', replicas: 2, cpu_usage_pct: 15.3, memory_usage_pct: 28.0, latency_p99_ms: 60.0, error_rate_pct: 0.00 },
      { id: 'svc-search', name: 'search-indexer', environment: 'production', status: 'healthy', replicas: 4, cpu_usage_pct: 41.2, memory_usage_pct: 60.4, latency_p99_ms: 85.0, error_rate_pct: 0.05 }
    ];

    for (const svc of seedServices) {
      insertService.run(svc);
    }

    // Seed initial incident
    const insertIncident = db.prepare(`
      INSERT INTO incident_logs (id, service_id, severity, summary, status)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertIncident.run('INC-1082', 'svc-checkout', 'P2', 'High latency and elevated error rate during peak traffic window', 'investigating');

    // Seed business metrics
    const insertMetric = db.prepare(`
      INSERT INTO business_metrics (metric_date, total_orders, gross_revenue_usd, payment_failure_rate_pct, active_users)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertMetric.run('2026-10-17', 14250, 345800.50, 0.42, 28400);
    insertMetric.run('2026-10-18', 15890, 398200.00, 0.38, 31200);
    insertMetric.run('2026-10-19', 11200, 281450.75, 1.25, 29800);
  }
}
