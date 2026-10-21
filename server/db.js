import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptSecret, decryptSecret, isEncrypted } from './secret.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_CFG_FILE = path.join(DATA_DIR, 'db.json');

const defaultDbConfig = {
  connectionString: process.env.PG_CONN || '',
  ssl: false,
  intervalSeconds: 300,
  retentionDays: 365
};

export const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
};

let dbConfigHadPlaintextSecret = false;

export const loadDbConfig = () => {
  ensureDataDir();
  if (!fs.existsSync(DB_CFG_FILE)) {
    fs.writeFileSync(DB_CFG_FILE, JSON.stringify(defaultDbConfig, null, 2), { mode: 0o600 });
    return { ...defaultDbConfig };
  }
  try {
    const raw = fs.readFileSync(DB_CFG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.connectionString && !isEncrypted(parsed.connectionString)) {
      dbConfigHadPlaintextSecret = true;
    }
    return {
      ...defaultDbConfig,
      ...parsed,
      connectionString: decryptSecret(parsed.connectionString || defaultDbConfig.connectionString),
    };
  } catch {
    return { ...defaultDbConfig };
  }
};

export const saveDbConfig = (cfg) => {
  ensureDataDir();
  const onDisk = { ...cfg, connectionString: encryptSecret(cfg.connectionString) };
  fs.writeFileSync(DB_CFG_FILE, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
};

export let dbConfig = loadDbConfig();
if (dbConfigHadPlaintextSecret && dbConfig.connectionString) {
  saveDbConfig(dbConfig);
  console.log('Encrypted the stored PostgreSQL connection string at rest');
}
export let pool = dbConfig.connectionString ? new Pool({ connectionString: dbConfig.connectionString, ssl: dbConfig.ssl }) : null;

export const resetPoolWithConfig = async (cfg) => {
  dbConfig = { ...dbConfig, ...cfg };
  saveDbConfig(dbConfig);
  if (pool) {
    try { await pool.end(); } catch {}
  }
  pool = dbConfig.connectionString ? new Pool({ connectionString: dbConfig.connectionString, ssl: dbConfig.ssl }) : null;
  return pool;
};

export const testDbConnection = async (cfg) => {
  const tempPool = new Pool({ connectionString: cfg.connectionString, ssl: cfg.ssl });
  try {
    await tempPool.query('SELECT 1');
  } finally {
    await tempPool.end();
  }
};

export const initTables = async () => {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partition_history (
      id SERIAL PRIMARY KEY,
      ts BIGINT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      allocated INT NOT NULL,
      total INT NOT NULL,
      pending INT NOT NULL,
      utilization REAL NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partition_ts ON partition_history(ts);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_partition_name_ts ON partition_history(name, ts);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_history (
      id SERIAL PRIMARY KEY,
      ts BIGINT NOT NULL,
      jobid TEXT NOT NULL,
      name TEXT,
      partition TEXT,
      user_name TEXT,
      state TEXT,
      cpus INT,
      gpus INT,
      shards INT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_ts ON job_history(ts);`);
};

// Keeps the history tables bounded: drops rows older than the retention window.
export const purgeOldHistory = async (retentionDays) => {
  if (!pool) return null;
  const days = Number(retentionDays) || 365;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const partitionRes = await pool.query('DELETE FROM partition_history WHERE ts < $1', [cutoff]);
  const jobRes = await pool.query('DELETE FROM job_history WHERE ts < $1', [cutoff]);
  return { cutoff, partitionRows: partitionRes.rowCount, jobRows: jobRes.rowCount };
};
