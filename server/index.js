import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
import ldap from 'ldapjs';
import bcrypt from 'bcryptjs';
import { pool, initTables, dbConfig, resetPoolWithConfig, testDbConnection, saveDbConfig, purgeOldHistory } from './db.js';
import { encryptSecret, decryptSecret, isEncrypted } from './secret.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '0.0.0.0';
app.use(express.json({ limit: '1mb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
};

const adminPasswordFromEnv = process.env.ADMIN_PASSWORD || '';

const buildAuthState = (passwordHash) => ({
  admin: {
    username: 'admin',
    passwordHash,
    menus: null, // null = all
    partitions: null,
  },
  ldap: {
    servers: [
      { url: '', baseDn: '', bindDn: '', bindPassword: '' },
      { url: '', baseDn: '', bindDn: '', bindPassword: '' }
    ],
    minUid: 500
  },
  userPermissions: {} // { username: { menus: [], partitions: [] } }
});

const defaultAuthState = () => {
  const password = adminPasswordFromEnv || crypto.randomBytes(12).toString('base64url');
  // Only used the first time auth.json is created; ADMIN_PASSWORD overrides the generated value.
  return buildAuthState(bcrypt.hashSync(password, 10));
};

const encryptLdapSecrets = (state) => {
  const copy = structuredClone(state);
  (copy.ldap?.servers || []).forEach((server) => {
    server.bindPassword = encryptSecret(server.bindPassword);
  });
  return copy;
};

const decryptLdapSecrets = (state) => {
  (state.ldap?.servers || []).forEach((server) => {
    server.bindPassword = decryptSecret(server.bindPassword);
  });
  return state;
};

const writeAuthFile = (state) => {
  ensureDataDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(encryptLdapSecrets(state), null, 2), { mode: 0o600 });
};

let authFileHadPlaintextSecrets = false;

const loadAuthState = () => {
  ensureDataDir();
  if (!fs.existsSync(AUTH_FILE)) {
    const defaults = defaultAuthState();
    writeAuthFile(defaults);
    console.log('Initial admin account created from defaults; set ADMIN_PASSWORD to control the bootstrap password.');
    return defaults;
  }
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if ((parsed?.ldap?.servers || []).some((s) => s.bindPassword && !isEncrypted(s.bindPassword))) {
      authFileHadPlaintextSecrets = true;
    }
    const base = buildAuthState(parsed?.admin?.passwordHash || '');
    return decryptLdapSecrets({
      admin: { ...base.admin, ...(parsed.admin || {}) },
      ldap: { ...base.ldap, ...(parsed.ldap || {}) },
      userPermissions: parsed.userPermissions || {},
    });
  } catch (err) {
    console.error('Failed to load auth config, regenerating defaults', err);
    const defaults = defaultAuthState();
    writeAuthFile(defaults);
    return defaults;
  }
};

const saveAuthState = (state) => {
  writeAuthFile(state);
};

let authState = loadAuthState();
if (authFileHadPlaintextSecrets) {
  saveAuthState(authState);
  console.log('Encrypted the stored LDAP bind password at rest');
}
const sessionStore = new Map(); // token -> { username, role, menus, partitions }

// -------- Login throttling --------
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // key -> { count, firstAt }

const loginAttemptKey = (req, username) => `${req.ip || ''}|${username || ''}`;

const isLoginThrottled = (key) => {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
};

const recordLoginFailure = (key) => {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
};

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, LOGIN_WINDOW_MS).unref();

// -------- Helpers --------
const normalizeState = (raw = '') => {
  const val = raw.toLowerCase();
  if (val.includes('mix')) return 'mixed';
  if (val.includes('alloc')) return 'allocated';
  if (val.includes('idle')) return 'idle';
  if (val.includes('drain')) return 'drained';
  if (val.includes('down')) return 'down';
  if (val.includes('maint')) return 'maint';
  return 'idle';
};

const isGPU = (value = '') => /gpu/i.test(value);

const parseTresCounts = ({ tresPerNode = '', tresReq = '', tresAlloc = '', tresPerTask = '', nodes = 1, tasks = 1 }) => {
  const extract = (source, key) => {
    const regexes = [
      new RegExp(`${key}[:=]([0-9]+)`, 'i'),
      new RegExp(`gres/${key}[:=]([0-9]+)`, 'i')
    ];
    for (const r of regexes) {
      const m = source.match(r);
      if (m) return parseInt(m[1], 10) || 0;
    }
    return 0;
  };

  const perNodeGpu = extract(tresPerNode, 'gpu');
  const perNodeShard = extract(tresPerNode, 'shard');
  const perTaskGpu = extract(tresPerTask, 'gpu');
  const perTaskShard = extract(tresPerTask, 'shard');
  const gpu = perNodeGpu
    ? perNodeGpu * (nodes || 1)
    : perTaskGpu
      ? perTaskGpu * (tasks || 1)
      : extract(tresReq || tresAlloc, 'gpu');
  const shard = perNodeShard
    ? perNodeShard * (nodes || 1)
    : perTaskShard
      ? perTaskShard * (tasks || 1)
      : extract(tresReq || tresAlloc, 'shard');

  return { gpu, shard };
};

const fetchTresFromSacct = async (jobId) => {
  try {
    const { stdout } = await execAsync(
      `/usr/bin/sacct -j ${jobId} -P -o ReqTRES -n | head -n 1`,
      { maxBuffer: 1024 * 1024, timeout: 8000 }
    );
    const tres = (stdout || '').trim();
    const counts = parseTresCounts({ tresReq: tres });
    return { tresString: tres, counts };
  } catch (err) {
    console.warn(`sacct fetch failed for job ${jobId}:`, err.message);
    return { tresString: '', counts: { gpu: 0, shard: 0 } };
  }
};

const sanitizeJobId = (jobId) => {
  const id = String(jobId || '').trim();
  if (!id || !/^[\w.\-]+$/.test(id)) {
    throw new Error('Invalid jobId');
  }
  return id;
};

const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim() || '';
  if (!token || !sessionStore.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = sessionStore.get(token);
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

const ldapFetchUser = async (serverCfg, username, password) => {
  if (!serverCfg?.url || !serverCfg?.baseDn) {
    throw new Error('LDAP server not configured');
  }
  const client = ldap.createClient({ url: serverCfg.url });
  let userDn = '';

  const isTemplate = serverCfg.bindDn && serverCfg.bindDn.includes('{username}');
  const hasService = serverCfg.bindDn && !isTemplate;

  // Step 1: if service account, bind first
  if (hasService) {
    await new Promise((resolve, reject) => {
      client.bind(serverCfg.bindDn, serverCfg.bindPassword || '', (err) => (err ? reject(err) : resolve()));
    });
  }

  // Step 2: locate user DN (if not template)
  if (isTemplate) {
    userDn = serverCfg.bindDn.replace('{username}', username);
  } else {
    userDn = await new Promise((resolve, reject) => {
      const opts = {
        scope: 'sub',
        filter: `(uid=${username})`,
        attributes: ['uid', 'uidNumber', 'cn', 'dn']
      };
      let found = null;
      client.search(serverCfg.baseDn, opts, (err, res) => {
        if (err) return reject(err);
        res.on('searchEntry', (e) => { found = e.object; });
        res.on('error', reject);
        res.on('end', () => {
          if (!found || !found.dn) return reject(new Error('LDAP user not found'));
          resolve(found.dn);
        });
      });
    });
  }

  // Step 3: bind as user with provided password to verify
  await new Promise((resolve, reject) => {
    client.bind(userDn, password, (err) => (err ? reject(err) : resolve()));
  });

  // Step 4: fetch attributes
  const entry = await new Promise((resolve, reject) => {
    const opts = {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['uid', 'uidNumber', 'cn']
    };
    let found = null;
    client.search(userDn, opts, (err, res) => {
      if (err) return reject(err);
      res.on('searchEntry', (e) => { found = e.object; });
      res.on('error', reject);
      res.on('end', () => resolve(found));
    });
  });
  client.unbind();
  if (!entry) throw new Error('LDAP user not found');
  return {
    uid: entry.uid || username,
    uidNumber: parseInt(entry.uidNumber, 10) || 0,
    cn: entry.cn || ''
  };
};

const ldapValidateAcrossServers = async (username, password) => {
  const servers = authState.ldap?.servers || [];
  const active = servers.filter((s) => s?.url);
  if (active.length === 0) throw new Error('LDAP servers not configured');

  const profiles = [];
  for (const srv of active) {
    const profile = await ldapFetchUser(srv, username, password);
    profiles.push(profile);
  }
  if (profiles.length === 2) {
    if (profiles[0].uid !== profiles[1].uid || profiles[0].uidNumber !== profiles[1].uidNumber) {
      throw new Error('LDAP servers returned inconsistent user data');
    }
  }
  return profiles[0];
};

const ldapPing = async (serverCfg) => {
  if (!serverCfg?.url) throw new Error('LDAP server not configured');
  const client = ldap.createClient({ url: serverCfg.url });
  const bindDn = serverCfg.bindDn || '';
  const bindPassword = serverCfg.bindPassword || '';
  await new Promise((resolve, reject) => {
    client.bind(bindDn, bindPassword, (err) => (err ? reject(err) : resolve()));
  });
  if (serverCfg.baseDn) {
    await new Promise((resolve, reject) => {
      client.search(serverCfg.baseDn, { scope: 'base' }, (err, res) => {
        if (err) return reject(err);
        res.on('error', reject);
        res.on('end', () => resolve(null));
      });
    });
  }
  client.unbind();
  return { bindDnUsed: bindDn, baseDnUsed: serverCfg.baseDn || '' };
};

const getUserGroups = async (username) => {
  if (!/^[A-Za-z0-9._@-]+$/.test(username || '')) {
    console.warn('Skipping group lookup for unexpected username format');
    return [];
  }
  try {
    const { stdout } = await execFileAsync('id', ['-Gn', '--', username]);
    return stdout.trim().split(/\s+/).filter(Boolean);
  } catch (err) {
    console.warn('Failed to get groups for user', username, err.message);
    return [];
  }
};

const getPartitionAcls = async () => {
  try {
    const { stdout } = await execAsync('/usr/bin/scontrol show partition -o');
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = Object.fromEntries(
          line.split(/\s+/).map((kv) => {
            const [k, v] = kv.split('=', 2);
            return [k, v];
          })
        );
        return {
          name: parts.PartitionName,
          allowAccounts: parts.AllowAccounts || 'ALL',
          allowGroups: parts.AllowGroups || 'ALL'
        };
      });
  } catch (err) {
    console.warn('Failed to fetch partition ACLs, fallback to no ACL filter', err.message);
    return [];
  }
};

const computeAllowedPartitionsForUser = async (username, explicitList) => {
  if (explicitList && Array.isArray(explicitList)) return explicitList;
  const acls = await getPartitionAcls();
  if (!acls.length) return null; // no ACL info -> allow all
  const groups = await getUserGroups(username);
  const allow = acls
    .filter((acl) => {
      const acc = (acl.allowAccounts || 'ALL').split(',').filter(Boolean);
      const grp = (acl.allowGroups || 'ALL').split(',').filter(Boolean);

      const accountOk = acc.includes('ALL') || acc.includes(username);
      const groupOk = grp.includes('ALL') || grp.some((g) => groups.includes(g));
      return accountOk && groupOk;
    })
    .map((acl) => acl.name);
  return allow.length ? allow : null;
};

// --------- Background scheduler for snapshots ---------
const insertPartitionSnapshot = (partitions, now) => {
  if (!pool || !partitions.length) return Promise.resolve();
  const rows = partitions.map(p => [now, p.name, p.type, p.allocated, p.total, p.pending, p.utilization]);
  return pool.query(
    'INSERT INTO partition_history (ts, name, type, allocated, total, pending, utilization) VALUES ' +
    rows.map((_, i) => `($${i*7+1}, $${i*7+2}, $${i*7+3}, $${i*7+4}, $${i*7+5}, $${i*7+6}, $${i*7+7})`).join(','),
    rows.flat()
  );
};

const insertJobSnapshot = (jobs, now) => {
  if (!pool || !jobs.length) return Promise.resolve();
  const rows = jobs.slice(0, 500).map(j => [now, j.jobId, j.name, j.partition, j.user, j.state, j.cpus || 0, j.gpus || 0, j.shards || 0]);
  return pool.query(
    'INSERT INTO job_history (ts, jobid, name, partition, user_name, state, cpus, gpus, shards) VALUES ' +
    rows.map((_, i) => `($${i*9+1}, $${i*9+2}, $${i*9+3}, $${i*9+4}, $${i*9+5}, $${i*9+6}, $${i*9+7}, $${i*9+8}, $${i*9+9})`).join(','),
    rows.flat()
  );
};

let purgeTimer = null;
const startRetentionPurge = () => {
  if (purgeTimer) clearInterval(purgeTimer);
  const runPurge = async () => {
    try {
      const result = await purgeOldHistory(dbConfig.retentionDays);
      if (result && (result.partitionRows || result.jobRows)) {
        console.log(`Retention purge removed ${result.partitionRows} partition rows and ${result.jobRows} job rows older than ${dbConfig.retentionDays} days`);
      }
    } catch (err) {
      console.warn('Retention purge failed', err.message);
    }
  };
  runPurge();
  purgeTimer = setInterval(runPurge, 24 * 60 * 60 * 1000);
  purgeTimer.unref();
};

let schedulerTimer = null;
const startScheduler = (intervalMs) => {
  if (!pool || !dbConfig.connectionString) return;
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(async () => {
    try {
      const nodes = await fetchNodes();
      const jobs = await fetchJobs();
      const partitions = await fetchPartitions(nodes, jobs);
      const now = Date.now();
      insertPartitionSnapshot(partitions, now)
        .catch(err => console.warn('Scheduler persist partition history failed', err.message));
      insertJobSnapshot(jobs, now)
        .catch(err => console.warn('Scheduler persist job history failed', err.message));
    } catch (err) {
      console.warn('Scheduler run failed', err.message);
    }
  }, intervalMs);
  schedulerTimer.unref();
};

// 集群的 squeue 是包装脚本，会重写输出并逐行处理，--json 会被破坏且极慢；这里直连真实二进制。
const SQUEUE_BIN = '/usr/bin/squeue';

const safeExec = async (command) => {
  const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024, timeout: 12000 });
  return stdout;
};

const fetchJobScript = async (jobId) => {
  const id = sanitizeJobId(jobId);
  try {
    const { stdout } = await execAsync(`/usr/bin/sacct -j ${id} -B`, { maxBuffer: 10 * 1024 * 1024, timeout: 12000 });
    return (stdout || '').trim();
  } catch (err) {
    console.warn(`Failed to fetch job script for ${id}:`, err.message);
    throw err;
  }
};

const fetchPendingByPartition = async () => {
  try {
    const out = await safeExec(`${SQUEUE_BIN} -t PENDING -h -o '%P'`);
    const map = new Map();
    out
      .trim()
      .split('\n')
      .forEach((line) => {
        const key = line.trim().replace('*', '');
        if (!key) return;
        map.set(key, (map.get(key) || 0) + 1);
      });
    return map;
  } catch (err) {
    console.warn('Failed to fetch pending jobs, defaulting to 0', err.message);
    return new Map();
  }
};

const fetchNodes = async () => {
  // Node list with CPU/GPU/partition membership and reason (if any)
  const out = await safeExec("/usr/bin/sinfo -N -h -o '%N|%t|%C|%G|%P|%E'");
  const nodes = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', stateRaw = '', cpus = '', gresRaw = '(null)', partitionRaw = '', reasonRaw = ''] = line.split('|');
      const [alloc = 0, idle = 0, other = 0, total = 0] = cpus.split('/').map((n) => parseInt(n, 10) || 0);
      const load = total ? Math.round((alloc / total) * 100) : 0;
      const gpuMatches = (gresRaw || '').match(/gpu[:=]([0-9]+)/ig) || [];
      const totalGpus = gpuMatches.reduce((max, m) => {
        const num = parseInt(m.split(/[:=]/)[1], 10);
        return Math.max(max, isNaN(num) ? 0 : num);
      }, 0);
      const shardMatches = (gresRaw || '').match(/shard[:=]([0-9]+)/ig) || [];
      const totalShards = shardMatches.reduce((max, m) => {
        const num = parseInt(m.split(/[:=]/)[1], 10);
        return Math.max(max, isNaN(num) ? 0 : num);
      }, 0);
      return {
        name,
        state: normalizeState(stateRaw),
        load,
        cpus,
        gres: gresRaw || '(null)',
        partition: (partitionRaw || '').replace('*', ''),
        reason: (reasonRaw || '').trim() || undefined,
        totalGpus,
        totalShards,
      };
    });

  // sinfo only reports configured GRES; per-node allocated GPUs live in scontrol.
  try {
    const { stdout: detail } = await execAsync('/usr/bin/scontrol show node -o', { maxBuffer: 16 * 1024 * 1024, timeout: 12000 });
    const gpuUsage = new Map();
    detail.split('\n').forEach((line) => {
      const name = line.match(/NodeName=(\S+)/)?.[1];
      if (!name) return;
      const total = line.match(/CfgTRES=[^\s]*gres\/gpu=(\d+)/)?.[1];
      const alloc = line.match(/AllocTRES=[^\s]*gres\/gpu=(\d+)/)?.[1];
      if (total || alloc) gpuUsage.set(name, { total: jsonNumber(total), allocated: jsonNumber(alloc) });
    });
    nodes.forEach((node) => {
      const usage = gpuUsage.get(node.name);
      if (usage) {
        node.gpusTotal = usage.total;
        node.gpusAllocated = usage.allocated;
      }
    });
  } catch (err) {
    console.warn('scontrol show node failed, per-node GPU allocation unavailable:', err.message);
  }

  return nodes;
};

const buildGpuMaps = (jobs) => {
  const running = new Map();
  const pending = new Map();
  const runningShards = new Map();
  const pendingShards = new Map();
  jobs.forEach((j) => {
    const g = j.gpus || 0;
    const s = j.shards || 0;
    const shardEquivalent = s > 0 ? s : (g > 0 ? g * 2 : 0);
    if (j.state === 'PENDING') {
      if (g) pending.set(j.partition, (pending.get(j.partition) || 0) + g);
      if (shardEquivalent) {
        pendingShards.set(j.partition, (pendingShards.get(j.partition) || 0) + shardEquivalent);
      }
    } else if (j.state === 'RUNNING') {
      if (g) running.set(j.partition, (running.get(j.partition) || 0) + g);
      if (shardEquivalent) {
        runningShards.set(j.partition, (runningShards.get(j.partition) || 0) + shardEquivalent);
      }
    }
  });
  return { running, pending, runningShards, pendingShards };
};

const expandGpuIndices = (spec) => {
  const out = [];
  (spec || '').split(',').forEach((part) => {
    const [start, end] = part.split('-').map((n) => parseInt(n, 10));
    if (!Number.isFinite(start)) return;
    if (Number.isFinite(end) && end >= start) {
      for (let i = start; i <= end; i += 1) out.push(i);
    } else {
      out.push(start);
    }
  });
  return out;
};

const buildGpuCards = (jobs) => {
  const cards = new Map();
  jobs
    .filter((job) => job.state === 'RUNNING')
    .forEach((job) => {
      const nodeList = job.nodesExpanded?.length ? job.nodesExpanded : String(job.nodelist || '').split(',');
      const details = job.gresDetail || [];
      if (details.length === 0) return;
      nodeList.forEach((nodeName, idx) => {
        if (!nodeName) return;
        const detail = details[idx] || (nodeList.length === 1 ? details[0] : null);
        if (!detail) return;
        const match = detail.match(/IDX:([0-9,\-]+)/);
        if (!match) return;
        if (!cards.has(nodeName)) cards.set(nodeName, new Map());
        expandGpuIndices(match[1]).forEach((index) => {
          cards.get(nodeName).set(index, { index, jobId: job.jobId, name: job.name, user: job.user });
        });
      });
    });
  return cards;
};

const fetchPartitions = async (nodes, jobs) => {
  const pendingMap = await fetchPendingByPartition();
  const { running: gpuRunningMap, pending: gpuPendingMap, runningShards, pendingShards } = buildGpuMaps(jobs);
  const gpuCards = buildGpuCards(jobs);

  // 聚合：按分区名合并，避免 sinfo 多行状态导致重复卡片
  const partitionAgg = new Map();

  nodes.forEach((node) => {
    const parts = (node.partition || '').split(',').map((p) => p.replace('*', '').trim()).filter(Boolean);
    const partitions = parts.length > 0 ? parts : ['default'];
    const [alloc = 0, , , total = 0] = (node.cpus || '0/0/0/0').split('/').map((n) => parseInt(n, 10) || 0);

    partitions.forEach((p) => {
      if (!partitionAgg.has(p)) {
        partitionAgg.set(p, {
          name: p,
          allocated: 0,
          total: 0,
          nodes: [],
          gresSet: new Set(),
          totalGpus: 0,
          totalShards: 0,
        });
      }
      const entry = partitionAgg.get(p);
      entry.allocated += alloc;
      entry.total += total;
      entry.totalGpus += node.totalGpus || 0;
      entry.totalShards += node.totalShards || 0;
      entry.nodes.push({ ...node, partition: undefined });
      if (node.gres && node.gres !== '(null)') {
        entry.gresSet.add(node.gres);
      }
    });
  });

  return Array.from(partitionAgg.values()).map((entry) => {
    const isGpuPart = Array.from(entry.gresSet).some((g) => isGPU(g)) || isGPU(entry.name);
    const pendingCount = pendingMap.get(entry.name) || 0;

    let allocated = entry.allocated;
    let total = entry.total || entry.nodes.length;
    let pending = pendingCount;

    if (isGpuPart) {
      const isJupyter = entry.name.toLowerCase() === 'jupyter';
      if (isJupyter) {
        allocated = runningShards.get(entry.name) || 0;
        total = entry.totalShards || entry.nodes.length;
        pending = pendingShards.get(entry.name) || pendingCount;
        if (total < allocated) total = allocated;
      } else {
        allocated = gpuRunningMap.get(entry.name) || 0;
        total = entry.totalGpus || entry.nodes.length;
        pending = gpuPendingMap.get(entry.name) || pendingCount;
        if (total < allocated) total = allocated;
      }
    }

    const utilization = total ? (allocated / total) * 100 : 0;

    return {
      id: `${entry.name}-${Date.now()}`,
      name: entry.name,
      type: isGpuPart ? 'GPU' : 'CPU',
      allocated,
      total,
      pending,
      utilization,
      timestamp: Date.now(),
      nodes: isGpuPart
        ? entry.nodes.map((node) => {
            const usage = gpuCards.get(node.name);
            return usage ? { ...node, gpuCards: Array.from(usage.values()) } : node;
          })
        : entry.nodes,
      nodeCount: entry.nodes.length,
      gres: Array.from(entry.gresSet).join(','),
    };
  });
};

const expandNodeList = (nodelist = '') => {
  if (!nodelist) return [];
  const parts = nodelist.split(',').map((p) => p.trim()).filter(Boolean);
  const expanded = [];

  parts.forEach((part) => {
    const match = part.match(/^(.*)\[(.+)\]$/);
    if (match) {
      const prefix = match[1];
      const body = match[2];
      body.split(',').forEach((range) => {
        const [start, end] = range.split('-');
        if (end) {
          const padLen = end.length;
          const s = parseInt(start, 10);
          const e = parseInt(end, 10);
          for (let i = s; i <= e; i++) {
            expanded.push(`${prefix}${String(i).padStart(padLen, '0')}`);
          }
        } else {
          expanded.push(`${prefix}${start}`);
        }
      });
    } else {
      expanded.push(part);
    }
  });

  return expanded;
};

const parseGpuCount = ({ tresPerNode = '', tresReq = '', tresAlloc = '', nodes = 1 }) => {
  const perNodeMatch =
    tresPerNode.match(/gpu[:=]([0-9]+)/i) ||
    tresPerNode.match(/gres\/gpu[:=]([0-9]+)/i);
  if (perNodeMatch) {
    const perNode = parseInt(perNodeMatch[1], 10) || 0;
    return perNode * (nodes || 1);
  }
  const reqMatch =
    tresReq.match(/gpu[:=]([0-9]+)/i) ||
    tresReq.match(/gres\/gpu[:=]([0-9]+)/i) ||
    tresAlloc.match(/gpu[:=]([0-9]+)/i);
  return reqMatch ? parseInt(reqMatch[1], 10) || 0 : 0;
};

// Mirrors the translations the squeue wrapper applies, so both data paths read the same.
const KNOWN_REASON_LABELS = [
  [/ReqNodeNotAvail|UnavailableNodes/, '节点不可用'],
  [/QOSMaxCpuPerUserLimit|QOSMaxJobsPerUserLimit|JobArrayTaskLimit/, '超限等待'],
  [/Dependency/, '依赖作业未完成'],
  [/^Resources|^Priority/, '等待资源'],
];

const translateReason = (reason) => {
  if (!reason) return '';
  const match = KNOWN_REASON_LABELS.find(([pattern]) => pattern.test(reason));
  return match ? match[1] : reason;
};

// Slurm 23.11 emits numbers as { set, infinite, number } objects and states as arrays.
const jsonNumber = (value, fallback = 0) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof value === 'object') {
    if (value.infinite === true) return fallback;
    if (typeof value.number === 'number') return value.number;
    if (typeof value.number === 'string') {
      const n = Number(value.number);
      return Number.isFinite(n) ? n : fallback;
    }
  }
  return fallback;
};

const jsonString = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? String(value[0]) : fallback;
  if (typeof value === 'object') {
    if (value.name !== undefined) return String(value.name);
    if (value.number !== undefined) return String(jsonNumber(value, fallback));
  }
  return fallback;
};

const formatElapsed = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}-${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const formatEpochLocal = (epochSeconds) => {
  if (!epochSeconds) return '';
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const fetchJobsFromJson = async () => {
  const { stdout: out } = await execAsync(`${SQUEUE_BIN} --json`, { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  const parsed = JSON.parse(out);
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = [];
  for (const j of jobs) {
    const baseCounts = parseTresCounts({
      tresPerNode: jsonString(j.tres_per_node) || '',
      tresPerTask: jsonString(j.tres_per_task) || '',
      tresReq: jsonString(j.tres_req_str) || '',
      tresAlloc: jsonString(j.tres_alloc_str) || '',
      nodes: jsonNumber(j.node_count, jsonNumber(j.num_nodes, 1)) || 1,
      tasks: jsonNumber(j.tasks, jsonNumber(j.num_tasks, 1)) || 1,
    });
    let counts = baseCounts;
    let tresStrExtra = '';

    const partitionName = jsonString(j.partition);
    const isJupyter = partitionName.toLowerCase() === 'jupyter';
    const missingGpuInfo = (!baseCounts.gpu && !baseCounts.shard) && isJupyter;
    if (missingGpuInfo) {
      const sacctData = await fetchTresFromSacct(j.job_id ?? j.jobId ?? '');
      tresStrExtra = sacctData.tresString;
      counts = sacctData.counts;
    }

    const state = jsonString(j.job_state, 'PENDING').toUpperCase();
    const nodeCount = jsonNumber(j.node_count, jsonNumber(j.num_nodes, 0));
    const nodeList = jsonString(j.node_list) || jsonString(j.job_resources?.nodes) || jsonString(j.nodes);
    const startTime = jsonNumber(j.start_time, 0);
    const timeLimitMinutes = jsonNumber(j.time_limit, 0);
    const memoryPerNode = jsonNumber(j.memory_per_node, 0);
    const memoryPerCpu = jsonNumber(j.memory_per_cpu, 0);
    const cpus = jsonNumber(j.cpus, jsonNumber(j.num_cpus, 0)) || jsonNumber(j.minimum_cpus_per_node, 0) * (nodeCount || 1);

    result.push({
      jobId: jsonString(j.job_id),
      name: jsonString(j.name),
      partition: partitionName,
      user: jsonString(j.user_name) || jsonString(j.user),
      state,
      time: state === 'RUNNING' ? formatElapsed(nowSeconds - startTime) : '0:00',
      timeLimit: j.time_limit?.infinite ? 'UNLIMITED' : formatElapsed(timeLimitMinutes * 60),
      nodes: nodeCount || 1,
      cpus,
      nodelist: nodeList,
      nodesExpanded: expandNodeList(nodeList),
      priority: String(jsonNumber(j.priority, 0)),
      reason: (() => {
        const raw = jsonString(j.state_reason);
        return raw && raw !== 'None' ? translateReason(raw) : '';
      })(),
      memory: memoryPerNode ? `${memoryPerNode}M` : (memoryPerCpu && cpus ? `${memoryPerCpu * cpus}M` : ''),
      reqTres: jsonString(j.tres_req_str) || jsonString(j.tres_alloc_str),
      tresExtra: tresStrExtra || undefined,
      gpus: counts.gpu || undefined,
      shards: counts.shard || (counts.gpu ? counts.gpu * 2 : undefined),
      gresDetail: Array.isArray(j.gres_detail) ? j.gres_detail : [],
      submitTime: formatEpochLocal(jsonNumber(j.submit_time, 0)),
      endTime: formatEpochLocal(jsonNumber(j.end_time, 0)) || 'NONE',
      // squeue --json leaves work_dir null, but command holds the script path inside the submit directory.
      workDir: jsonString(j.work_dir)
        || (jsonString(j.command) ? path.dirname(jsonString(j.command)) : ''),
    });
  }
  return result;
};

const TERMINAL_JOB_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE', 'REVOKED']);

const fetchJobsFromFormat = async () => {
  const format = "%i|%P|%j|%u|%T|%M|%l|%D|%C|%R|%m|%b|%V|%e|%Z|%Q";
  const out = await safeExec(`${SQUEUE_BIN} -h -o '${format}'`);
  const lines = out.trim().split('\n').filter(Boolean);
  const jobs = await Promise.all(lines.map(async (line) => {
      const [
        jobId = '',
        partition = '',
        name = '',
        user = '',
        state = 'PENDING',
        time = '0:00',
        timeLimit = 'UNLIMITED',
        nodes = '0',
        cpus = '0',
        reasonOrNode = '',
        memory = '',
        reqTres = '',
        submitTime = '',
        endTime = '',
        workDir = '',
        priority = '',
      ] = line.split('|');
      const baseCounts = parseTresCounts({
        tresPerNode: reqTres || '',
        tresReq: reqTres || '',
        tresAlloc: reqTres || '',
        nodes: parseInt(nodes, 10) || 1,
      });
      let counts = baseCounts;
      let tresStrExtra = '';
      const isJupyter = (partition || '').toLowerCase() === 'jupyter';
      const missingGpuInfo = (!baseCounts.gpu && !baseCounts.shard) && isJupyter;
      if (missingGpuInfo) {
        const sacctData = await fetchTresFromSacct(jobId);
        tresStrExtra = sacctData.tresString;
        counts = sacctData.counts;
      }

      const isPending = state === 'PENDING';
      const tres = reqTres && reqTres !== 'N/A' ? reqTres : '';

      return {
        jobId,
        name,
        partition,
        user,
        state,
        time,
        timeLimit,
        nodes: parseInt(nodes, 10) || 0,
        cpus: parseInt(cpus, 10) || 0,
        nodelist: isPending ? '' : reasonOrNode,
        nodesExpanded: isPending ? [] : expandNodeList(reasonOrNode),
        priority: priority || '0',
        reason: isPending ? translateReason(reasonOrNode) : '',
        memory,
        reqTres: tres,
        submitTime,
        endTime,
        workDir,
        tresExtra: tresStrExtra || undefined,
        gpus: counts.gpu || undefined,
        shards: counts.shard || (counts.gpu ? counts.gpu * 2 : undefined),
      };
    }));
  return jobs;
};

let jobsJsonFallbackLogged = false;
const JOBS_TTL_MS = 5000;
let jobsCache = { at: 0, data: null, pending: null };

const loadJobs = async () => {
  try {
    // squeue --json briefly reports just-finished jobs; the queue view only shows active ones.
    return (await fetchJobsFromJson()).filter((job) => !TERMINAL_JOB_STATES.has(job.state));
  } catch (err) {
    if (!jobsJsonFallbackLogged) {
      jobsJsonFallbackLogged = true;
      console.warn('squeue --json unavailable, falling back to formatted output:', err.message, '(further occurrences suppressed until restart)');
    }
    return await fetchJobsFromFormat();
  }
};

const fetchJobs = async () => {
  if (jobsCache.data && Date.now() - jobsCache.at < JOBS_TTL_MS) return jobsCache.data;
  if (jobsCache.pending) return jobsCache.pending;
  jobsCache.pending = loadJobs()
    .then((data) => {
      jobsCache = { at: Date.now(), data, pending: null };
      return data;
    })
    .catch((err) => {
      jobsCache.pending = null;
      throw err;
    });
  return jobsCache.pending;
};

// -------- Auth --------
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const attemptKey = loginAttemptKey(req, username);
  if (isLoginThrottled(attemptKey)) {
    return res.status(429).json({ error: 'Too many login attempts, please try again later' });
  }

  try {
    if (username === authState.admin.username) {
      if (!bcrypt.compareSync(password, authState.admin.passwordHash)) throw new Error('Invalid admin password');
      loginAttempts.delete(attemptKey);
      const token = crypto.randomBytes(24).toString('hex');
      sessionStore.set(token, { username, role: 'admin', menus: authState.admin.menus, partitions: authState.admin.partitions });
      return res.json({ token, role: 'admin', menus: authState.admin.menus, partitions: authState.admin.partitions });
    }

    const profile = await ldapValidateAcrossServers(username, password);
    if (profile.uidNumber < (authState.ldap?.minUid || 500)) {
      throw new Error('User not allowed (uidNumber too low)');
    }
    loginAttempts.delete(attemptKey);
    const perms = authState.userPermissions[username] || {};
    const token = crypto.randomBytes(24).toString('hex');
    sessionStore.set(token, { username, role: 'user', menus: perms.menus || null, partitions: perms.partitions || null });
    res.json({ token, role: 'user', menus: perms.menus || null, partitions: perms.partitions || null });
  } catch (err) {
    recordLoginFailure(attemptKey);
    console.error('Login failed', err.message);
    res.status(401).json({ error: 'Authentication failed', details: err.message });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (token) sessionStore.delete(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

app.post('/api/admin/password', requireAuth, requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword) return res.status(400).json({ error: 'Missing newPassword' });
  if (!bcrypt.compareSync(oldPassword || '', authState.admin.passwordHash)) return res.status(400).json({ error: 'Old password incorrect' });
  authState.admin.passwordHash = bcrypt.hashSync(newPassword, 12);
  saveAuthState(authState);
  res.json({ ok: true });
});

const mergeLdapServers = (incoming) => {
  const stored = authState.ldap?.servers || [];
  return incoming.slice(0, 2).map((server, index) => {
    const previous = stored[index] || {};
    const url = server?.url || '';
    const bindDn = server?.bindDn || '';
    // A blank password means "leave the stored one alone", but only for the same server/bind DN.
    const sameTarget = previous.url === url && previous.bindDn === bindDn;
    return {
      url,
      baseDn: server?.baseDn || '',
      bindDn,
      bindPassword: server?.bindPassword || (sameTarget ? previous.bindPassword || '' : ''),
    };
  });
};

const maskLdapConfig = () => ({
  servers: (authState.ldap?.servers || []).map((server) => ({
    url: server.url || '',
    baseDn: server.baseDn || '',
    bindDn: server.bindDn || '',
    bindPassword: '',
    hasBindPassword: Boolean(server.bindPassword),
  })),
  minUid: authState.ldap?.minUid,
});

const resolveLdapServers = (payloadServers) => {
  if (!Array.isArray(payloadServers)) return authState.ldap?.servers || [];
  return payloadServers.slice(0, 2).map((server, index) => {
    const previous = authState.ldap?.servers?.[index] || {};
    const sameTarget = previous.url === (server?.url || '') && previous.bindDn === (server?.bindDn || '');
    return {
      ...server,
      bindPassword: server?.bindPassword || (sameTarget ? previous.bindPassword || '' : ''),
    };
  });
};

app.post('/api/admin/ldap-config', requireAuth, requireAdmin, (req, res) => {
  const { servers, minUid } = req.body || {};
  if (Array.isArray(servers)) authState.ldap.servers = mergeLdapServers(servers);
  authState.ldap.minUid = minUid || authState.ldap.minUid || 500;
  saveAuthState(authState);
  res.json({ ok: true, ldap: maskLdapConfig() });
});

app.get('/api/admin/ldap-config', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ldap: maskLdapConfig() });
});

app.post('/api/admin/collector-config', requireAuth, requireAdmin, (req, res) => {
  const { intervalSeconds, retentionDays } = req.body || {};
  if (intervalSeconds && intervalSeconds >= 60) {
    dbConfig.intervalSeconds = intervalSeconds;
  }
  if (retentionDays) {
    const days = parseInt(retentionDays, 10);
    if (Number.isFinite(days) && days >= 7) dbConfig.retentionDays = days;
  }
  saveDbConfig(dbConfig);
  if (dbConfig.connectionString) {
    startScheduler((dbConfig.intervalSeconds || 300) * 1000);
    startRetentionPurge();
  }
  res.json({ ok: true, intervalSeconds: dbConfig.intervalSeconds, retentionDays: dbConfig.retentionDays });
});

app.post('/api/admin/ldap-test', requireAuth, requireAdmin, async (req, res) => {
  const payloadServers = Array.isArray(req.body?.servers) ? req.body.servers.slice(0, 2) : null;
  const servers = resolveLdapServers(payloadServers);
  const active = servers.filter((s) => s?.url);
  if (active.length === 0) return res.status(400).json({ ok: false, error: 'LDAP servers not configured' });

  const results = [];
  for (const srv of active) {
    try {
      const info = await ldapPing(srv);
      results.push({ url: srv.url, ok: true, bindDn: info.bindDnUsed, baseDn: info.baseDnUsed });
    } catch (err) {
      console.error('LDAP test failed', srv.url, err);
      results.push({ url: srv.url, ok: false, error: err.message, bindDn: srv.bindDn || '', baseDn: srv.baseDn || '' });
    }
  }

  // If two servers, check minimal consistency via DN/uid if bindDn has {username}
  let consistency = 'skip';
  if (active.length === 2) {
    consistency = results.every(r => r.ok) ? 'pass' : 'failed';
  }

  const allOk = results.every(r => r.ok);
  res.json({ ok: allOk, results, consistency });
});

app.post('/api/admin/user-permissions', requireAuth, requireAdmin, (req, res) => {
  const { username, menus, partitions } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });
  authState.userPermissions[username] = {
    menus: Array.isArray(menus) ? menus : null,
    partitions: Array.isArray(partitions) ? partitions : null
  };
  saveAuthState(authState);
  res.json({ ok: true });
});

app.post('/api/admin/ldap-ping', requireAuth, requireAdmin, async (req, res) => {
  const { servers } = req.body || {};
  const list = resolveLdapServers(Array.isArray(servers) ? servers.slice(0, 2) : null);
  try {
    const results = [];
    for (const srv of list) {
      if (!srv?.url) { results.push({ ok: false, error: 'url missing' }); continue; }
      try {
        await ldapPing(srv);
        results.push({ ok: true, url: srv.url });
      } catch (err) {
        results.push({ ok: false, url: srv.url, error: err.message });
      }
    }
    res.json({ ok: results.every(r => r.ok), results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/db-config', requireAuth, requireAdmin, (_req, res) => {
  res.json({ db: dbConfig });
});

app.post('/api/admin/db-test', requireAuth, requireAdmin, async (req, res) => {
  const cfg = req.body?.db || dbConfig;
  try {
    if (!cfg.connectionString) throw new Error('Missing connectionString');
    await testDbConnection(cfg);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/db-config', requireAuth, requireAdmin, async (req, res) => {
  const cfg = req.body?.db || {};
  if (!cfg.connectionString) return res.status(400).json({ error: 'Missing connectionString' });
  try {
    await testDbConnection(cfg);
    await resetPoolWithConfig(cfg);
    await initTables();
    if (dbConfig.connectionString) {
      startScheduler((dbConfig.intervalSeconds || 300) * 1000);
    }
    res.json({ ok: true, db: dbConfig });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// -------- Routes --------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// -------- Slurm controller (slurmctld) status --------
const parseControllerStatus = (text) =>
  (text || '')
    .split('\n')
    .map((line) => {
      const match = line.match(/Slurmctld\(([^)]+)\)\s+at\s+(\S+)\s+is\s+(\w+)/i);
      if (!match) return null;
      return { role: match[1].toLowerCase(), host: match[2], state: match[3].toUpperCase() };
    })
    .filter(Boolean);

let controllerStatusCache = { at: 0, data: [] };

const fetchControllerStatus = async () => {
  if (controllerStatusCache.data.length && Date.now() - controllerStatusCache.at < 30000) {
    return controllerStatusCache.data;
  }
  let output = '';
  try {
    const { stdout } = await execFileAsync('/usr/bin/scontrol', ['ping'], { timeout: 8000, maxBuffer: 1024 * 1024 });
    output = stdout;
  } catch (err) {
    output = err.stdout || '';
    console.warn('scontrol ping failed:', err.message);
  }
  const parsed = parseControllerStatus(output);
  controllerStatusCache = { at: Date.now(), data: parsed };
  return parsed;
};

app.get('/api/cluster/health', requireAuth, async (_req, res) => {
  try {
    res.json({ controllers: await fetchControllerStatus(), timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read controller status', details: err.message });
  }
});

// -------- Slurm service / HA health --------
const SERVICE_HOSTS = new Set(['mgt03', 'mgt02']);
const SERVICE_UNITS = ['slurmctld', 'slurmdbd', 'munge', 'slurmd', 'mariadb', 'mysqld'];

const sshExec = async (host, remote, timeoutMs = 9000) => {
  if (!SERVICE_HOSTS.has(host)) throw new Error(`host ${host} is not allowed`);
  const { stdout } = await execFileAsync('/usr/bin/ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=4',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    host,
    remote,
  ], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

const HOST_STATE_SCRIPT = [
  `systemctl is-active ${SERVICE_UNITS.join(' ')} 2>/dev/null | paste -sd,`,
  "echo '@@FILES'",
  "stat -c '%n|%s|%Y' /var/log/slurmctld/slurmctld.log /var/log/slurmdbd.log 2>/dev/null",
  "echo '@@DBD'",
  "tail -n 4 /var/log/slurmdbd.log 2>/dev/null",
].join('; ');

const parseHostState = (host, stdout) => {
  const [statePart, rest = ''] = stdout.split('@@FILES');
  const [filePart, dbdPart = ''] = rest.split('@@DBD');
  const states = (statePart || '').trim().split(',');
  const services = {};
  SERVICE_UNITS.forEach((unit, i) => { services[unit] = (states[i] || 'unknown').trim(); });
  const files = (filePart || '').trim().split('\n').filter(Boolean).map((row) => {
    const [path, size, mtime] = row.split('|');
    return { path, size: jsonNumber(size), mtime: jsonNumber(mtime) * 1000 };
  });
  const dbdTail = (dbdPart || '').trim().split('\n').filter(Boolean);
  const now = Date.now();
  const dbdLastAt = dbdTail.reduce((latest, line) => {
    const match = line.match(/^\[([^\]]+)\]/);
    const ts = match ? Date.parse(match[1]) : NaN;
    return Number.isFinite(ts) && ts > latest ? ts : latest;
  }, 0);
  const dbError = dbdTail.some((line) => {
    const match = line.match(/^\[([^\]]+)\]/);
    const ts = match ? Date.parse(match[1]) : NaN;
    const recent = Number.isFinite(ts) && now - ts < 10 * 60 * 1000;
    return recent && /mysql_real_connect failed|database must be up/i.test(line);
  });
  return { host, reachable: true, services, files, dbdTail, dbdLastAt: dbdLastAt || null, dbError };
};

const collectHostState = async (host) => {
  try {
    return parseHostState(host, await sshExec(host, HOST_STATE_SCRIPT));
  } catch (err) {
    return { host, reachable: false, error: err.message, services: {}, files: [], dbdTail: [], dbError: false };
  }
};

const parseHaHosts = (configText) => {
  const hosts = [];
  for (const match of (configText || '').matchAll(/^SlurmctldHost\[(\d+)\]\s*=\s*(\S+)/gm)) {
    const [name, ip = ''] = match[2].split('(');
    hosts.push({ index: jsonNumber(match[1]), host: name, ip: ip.replace(')', '') });
  }
  return hosts.sort((a, b) => a.index - b.index);
};

const configValue = (configText, key) => {
  const match = (configText || '').match(new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm'));
  return match ? match[1].trim() : null;
};

const parseDbRollup = (text) => {
  const block = (text || '').split(/^Cluster '%?/m)[0];
  const pick = (label) => {
    const match = block.match(new RegExp(label + ':\\s+(\\d+)'));
    return match ? Number(match[1]) : null;
  };
  const ran = block.match(/Internal DBD rollup last ran (.+?)\s*\(\d+\)/);
  return {
    lastCycleUs: pick('Last cycle'),
    maxCycleUs: pick('Max cycle'),
    meanCycleUs: pick('Mean cycle'),
    lastRanAt: ran ? ran[1].trim() : null,
  };
};

const runSlurmJson = async (bin, args, timeoutMs = 9000) => {
  const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

let serviceStatusCache = { at: 0, data: null };

const buildServiceStatus = async () => {
  const [controllers, hosts, scheduler, dbd] = await Promise.all([
    fetchControllerStatus().catch(() => []),
    Promise.all([...SERVICE_HOSTS].map(collectHostState)),
    runSlurmJson('/usr/bin/sdiag', ['--json'])
      .then((out) => {
        const s = JSON.parse(out).statistics || {};
        return {
          cycleLastUs: jsonNumber(s.schedule_cycle_last),
          cycleMeanUs: jsonNumber(s.schedule_cycle_mean),
          cycleMaxUs: jsonNumber(s.schedule_cycle_max),
          cyclePerMinute: jsonNumber(s.schedule_cycle_per_minute),
          queueLength: jsonNumber(s.schedule_queue_length),
          backfillDepth: jsonNumber(s.bf_depth_mean),
          backfillQueue: jsonNumber(s.bf_queue_len),
          backfillActive: s.bf_active === true,
          dbdQueue: jsonNumber(s.dbd_agent_queue_size),
          serverThreads: jsonNumber(s.server_thread_count),
          clockLatencyUs: jsonNumber(s.gettimeofday_latency),
          jobs: {
            submitted: jsonNumber(s.jobs_submitted),
            started: jsonNumber(s.jobs_started),
            completed: jsonNumber(s.jobs_completed),
            canceled: jsonNumber(s.jobs_canceled),
            failed: jsonNumber(s.jobs_failed),
            pending: jsonNumber(s.jobs_pending),
            running: jsonNumber(s.jobs_running),
          },
          since: s.req_time_start ? jsonNumber(s.req_time_start) * 1000 : null,
        };
      })
      .catch((err) => ({ error: err.message })),
    Promise.all([
      runSlurmJson('/usr/bin/scontrol', ['show', 'config'])
        .then((out) => ({
          haHosts: parseHaHosts(out),
          accountingHost: configValue(out, 'AccountingStorageHost'),
          accountingPort: jsonNumber(configValue(out, 'AccountingStoragePort')),
          clusterName: configValue(out, 'ClusterName'),
          stateSaveLocation: configValue(out, 'StateSaveLocation'),
        }))
        .catch((err) => ({ error: err.message })),
      runSlurmJson('/usr/bin/sacctmgr', ['-nP', 'show', 'cluster', 'format=Cluster,ControlHost,ControlPort,RPC'])
        .then((out) => {
          const [cluster = '', controlHost = '', controlPort = '', rpc = ''] = out.trim().split('\n')[0]?.split('|') || [];
          return { cluster, controlHost, controlPort: jsonNumber(controlPort), rpcUs: jsonNumber(rpc) };
        })
        .catch((err) => ({ error: err.message })),
      runSlurmJson('/usr/bin/sacctmgr', ['-nP', 'show', 'stats'])
        .then((out) => parseDbRollup(out))
        .catch((err) => ({ error: err.message })),
    ]).then(([config, cluster, rollup]) => ({ config, cluster, rollup })),
  ]);

  return {
    controllers,
    primary: controllers.find((c) => c.role === 'primary')?.host || null,
    backup: controllers.find((c) => c.role === 'backup')?.host || null,
    hosts,
    scheduler,
    dbd,
    timestamp: Date.now(),
  };
};

app.get('/api/services/status', requireAuth, requireAdmin, async (_req, res) => {
  if (serviceStatusCache.data && Date.now() - serviceStatusCache.at < 15000) {
    return res.json({ ...serviceStatusCache.data, cached: true });
  }
  try {
    const data = await buildServiceStatus();
    serviceStatusCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error('Failed to collect service status', err);
    res.status(500).json({ error: 'Failed to collect service status', details: err.message });
  }
});

const LOG_SOURCES = {
  ctld: '/var/log/slurmctld/slurmctld.log',
  dbd: '/var/log/slurmdbd.log',
};

const LOG_LEVELS = ['fatal', 'error', 'warning'];

const parseLogLevel = (message) => {
  const head = message.trimStart();
  for (const level of LOG_LEVELS) {
    if (head.startsWith(level + ':')) return level;
  }
  if (/^error|failed/i.test(head)) return 'error';
  return 'info';
};

const normalizeLogMessage = (message) =>
  message
    .replace(/Node \S+ appears to have a different slurm\.conf/, 'Node <name> appears to have a different slurm.conf')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/\b\d+\b/g, 'N')
    .trim()
    .slice(0, 110);

const summarizeLog = (host, source, hours, limit, stdout) => {
  const lines = (stdout || '').split('\n').filter(Boolean);
  const byLevel = { fatal: 0, error: 0, warning: 0, info: 0 };
  const families = new Map();
  const confNodes = new Map();
  const recentErrors = new Map();
  let firstTs = null;
  let lastTs = null;

  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!match) continue;
    const [, ts, message] = match;
    if (!firstTs) firstTs = ts;
    lastTs = ts;
    const level = parseLogLevel(message);
    byLevel[level] = (byLevel[level] || 0) + 1;

    const conf = message.match(/Node (\S+) appears to have a different slurm\.conf/);
    if (conf) confNodes.set(conf[1], (confNodes.get(conf[1]) || 0) + 1);

    if (level === 'error' || level === 'fatal') {
      const pattern = normalizeLogMessage(message);
      const entry = families.get(pattern) || { pattern, count: 0, sample: message.slice(0, 200) };
      entry.count += 1;
      families.set(pattern, entry);
      recentErrors.delete(pattern);
      recentErrors.set(pattern, { ts, level, message: message.slice(0, 240) });
      if (recentErrors.size > 1000) {
        recentErrors.delete(recentErrors.keys().next().value);
      }
    }
  }

  return {
    host,
    source,
    hours,
    total: lines.length,
    coveredFrom: firstTs,
    coveredTo: lastTs,
    byLevel,
    topMessages: [...families.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    confNodes: [...confNodes.entries()].map(([node, count]) => ({ node, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    confNodeTotal: confNodes.size,
    recentErrors: [...recentErrors.values()].slice(-limit).reverse(),
    generatedAt: Date.now(),
  };
};

const logCache = new Map();

app.get('/api/services/logs', requireAuth, requireAdmin, async (req, res) => {
  const source = req.query.source === 'dbd' ? 'dbd' : 'ctld';
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
  const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 60));
  const host = SERVICE_HOSTS.has(req.query.host) ? req.query.host : (serviceStatusCache.data?.primary || 'mgt03');
  const key = `${host}:${source}:${hours}:${limit}`;
  const hit = logCache.get(key);
  if (hit && Date.now() - hit.at < 20000) return res.json(hit.data);

  try {
    let stdout;
    if (source === 'dbd') {
      stdout = await sshExec(host, `tail -n 2000 ${LOG_SOURCES.dbd}`, 10000);
    } else {
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19);
      const program = "'$0 ~ /^\\[[0-9]{4}-/ { ts = substr($0,2,23); keep = (ts >= d) } keep { print }'";
      stdout = await sshExec(host, `awk -v d='${since}' ${program} ${LOG_SOURCES.ctld} | tail -n 80000`, 20000);
    }
    const data = summarizeLog(host, source, hours, limit, stdout);
    logCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('Failed to read service logs', err);
    res.status(502).json({ error: 'Failed to read service logs', details: err.message, host, source });
  }
});

app.get('/api/partitions', requireAuth, async (req, res) => {
  try {
    const nodes = await fetchNodes();
    const jobs = await fetchJobs();
    let partitions = await fetchPartitions(nodes, jobs);
    insertPartitionSnapshot(partitions, Date.now())
      .catch(err => console.warn('Failed to persist partition history', err.message));
    let allowed = null;
    if (req.user.role !== 'admin') {
      allowed = await computeAllowedPartitionsForUser(req.user.username, req.user.partitions || null);
    }
    if (allowed) {
      partitions = partitions.filter(p => allowed.includes(p.name));
    }
    res.json(partitions);
  } catch (err) {
    console.error('Failed to fetch partitions', err);
    res.status(500).json({ error: 'Failed to fetch partitions', details: err.message });
  }
});

app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    const jobs = await fetchJobs();
    insertJobSnapshot(jobs, Date.now())
      .catch(err => console.warn('Failed to persist job history', err.message));
    let filtered = jobs;
    if (req.user.role !== 'admin') {
      filtered = filtered.filter(j => j.user === req.user.username);
      const allowed = req.user.partitions || null;
      if (allowed) filtered = filtered.filter(j => allowed.includes(j.partition));
    }
    res.json(filtered);
  } catch (err) {
    console.error('Failed to fetch jobs', err);
    res.status(500).json({ error: 'Failed to fetch jobs', details: err.message });
  }
});

app.get('/api/jobs/:jobId/script', requireAuth, async (req, res) => {
  const rawId = req.params.jobId;
  if (!rawId) return res.status(400).json({ error: 'Missing jobId' });

  try {
    const jobId = sanitizeJobId(rawId);
    const jobs = await fetchJobs();
    const job = jobs.find((j) => String(j.jobId) === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (req.user.role !== 'admin') {
      const allowed = await computeAllowedPartitionsForUser(req.user.username, req.user.partitions || null);
      const partitionAllowed = !allowed || allowed.includes(job.partition);
      if (job.user !== req.user.username || !partitionAllowed) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const script = await fetchJobScript(jobId);
    res.json({ script });
  } catch (err) {
    const status = err.message === 'Invalid jobId' ? 400 : 500;
    console.error('Failed to fetch job script', err);
    res.status(status).json({ error: 'Failed to fetch job script', details: err.message });
  }
});

// -------- Job resource usage (VictoriaMetrics) --------
const VM_URL = process.env.VM_URL || 'http://172.22.2.150:8428';

const vmFetch = async (path, params) => {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${VM_URL}${path}?${query}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`VictoriaMetrics HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.status !== 'success') throw new Error(payload.error || 'VictoriaMetrics query failed');
  return payload.data?.result || [];
};

const vmInstant = async (query) => {
  const result = await vmFetch('/api/v1/query', { query });
  const first = result[0];
  if (!first) return null;
  const value = Number(first.value?.[1]);
  return Number.isFinite(value) ? value : null;
};

const vmRangeSeries = async (query, start, end, step) => {
  const result = await vmFetch('/api/v1/query_range', {
    query,
    start: String(start),
    end: String(end),
    step: String(step),
  });
  return result.map((series) => ({
    metric: series.metric || {},
    points: (series.values || [])
      .map(([ts, raw]) => ({ ts: Number(ts) * 1000, value: Number(raw) }))
      .filter((point) => Number.isFinite(point.value)),
  }));
};

const vmRange = async (query, start, end, step) => {
  const series = await vmRangeSeries(query, start, end, step);
  return series[0]?.points || [];
};

const summarizeSeries = (points) => {
  if (!points.length) return { current: null, average: null, peak: null };
  const values = points.map((point) => point.value);
  return {
    current: values[values.length - 1],
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
  };
};

const parseRequestedMemoryBytes = (reqTres = '') => {
  const match = String(reqTres).match(/(?:^|[, ])mem=([0-9.]+)([KMGT])?/i);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] || 'M').toUpperCase();
  const factor = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit] || 1024 ** 2;
  return Math.round(amount * factor);
};

const fetchJobGpuTargets = async (jobId) => {
  const mappings = await vmFetch('/api/v1/query', { query: `node_cr_gpu_jobinfo{job_id="${jobId}"}` });
  const seen = new Set();
  const targets = [];
  mappings.forEach((item) => {
    const hostname = item.metric?.hostname;
    const gpu = item.metric?.gpu;
    if (!hostname || gpu === undefined) return;
    const key = `${hostname}/${gpu}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ hostname, gpu });
  });
  return targets;
};

const fetchJobGpuUsage = async (jobId, targets) => {
  const gpus = await Promise.all(targets.slice(0, 16).map(async ({ hostname, gpu }) => {
    const [util, jobMemory] = await Promise.all([
      vmInstant(`DCGM_FI_DEV_GPU_UTIL{hostname="${hostname}",gpu="${gpu}"}`).catch(() => null),
      vmInstant(`sum(node_cr_job_gpu_memory{job_id="${jobId}",gpu="${gpu}"})`).catch(() => null),
    ]);
    return { hostname, gpu, utilization: util, memoryBytes: jobMemory };
  }));
  return gpus;
};

const fetchJobGpuSeries = async (jobId, targets, start, end, step) => {
  if (!targets.length) return { devices: [], util: [], memory: [] };
  const devices = targets.slice(0, 8).map((target, index) => ({
    key: `g${index}`,
    label: `${target.hostname} / GPU ${target.gpu}`,
    ...target,
  }));

  const byHost = new Map();
  devices.forEach((device) => {
    if (!byHost.has(device.hostname)) byHost.set(device.hostname, []);
    byHost.get(device.hostname).push(device.gpu);
  });

  const [utilBatches, memorySeries] = await Promise.all([
    Promise.all(Array.from(byHost.entries()).map(([hostname, gpus]) =>
      vmRangeSeries(`DCGM_FI_DEV_GPU_UTIL{hostname="${hostname}",gpu=~"${gpus.join('|')}"}`, start, end, step)
        .then((rows) => ({ hostname, rows }))
        .catch(() => ({ hostname, rows: [] }))
    )),
    vmRangeSeries(`sum by (gpu) (node_cr_job_gpu_memory{job_id="${jobId}"})`, start, end, step).catch(() => []),
  ]);

  const rows = new Map();
  const ensure = (ts) => {
    if (!rows.has(ts)) rows.set(ts, { ts });
    return rows.get(ts);
  };

  utilBatches.forEach(({ hostname, rows: batches }) => {
    batches.forEach((series) => {
      const gpu = series.metric?.gpu;
      const device = devices.find((item) => item.hostname === hostname && item.gpu === gpu);
      if (!device) return;
      series.points.forEach((point) => { ensure(point.ts)[device.key] = point.value; });
    });
  });

  // GPU memory only carries a gpu label; attribute it when the job lives on a single host.
  const singleHost = new Set(devices.map((device) => device.hostname)).size === 1;
  if (singleHost) {
    memorySeries.forEach((series) => {
      const gpu = series.metric?.gpu;
      const device = devices.find((item) => item.gpu === gpu);
      if (!device) return;
      series.points.forEach((point) => { ensure(point.ts)[`${device.key}m`] = point.value; });
    });
  }

  return {
    devices: devices.map(({ key, label }) => ({ key, label })),
    util: Array.from(rows.values()).sort((a, b) => a.ts - b.ts),
    memory: Array.from(rows.values()).sort((a, b) => a.ts - b.ts),
  };
};

app.get('/api/jobs/:jobId/usage', requireAuth, async (req, res) => {
  try {
    const jobId = sanitizeJobId(req.params.jobId);
    const jobs = await fetchJobs();
    const job = jobs.find((item) => String(item.jobId) === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (req.user.role !== 'admin') {
      const allowed = await computeAllowedPartitionsForUser(req.user.username, req.user.partitions || null);
      const partitionAllowed = !allowed || allowed.includes(job.partition);
      if (job.user !== req.user.username || !partitionAllowed) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const rangeSeconds = Math.min(Math.max(parseInt(req.query.range, 10) || 3600, 300), 7 * 24 * 3600);
    const step = Math.max(30, Math.ceil(rangeSeconds / 120));
    const end = Math.floor(Date.now() / 1000);
    const start = end - rangeSeconds;
    const selector = `jobId="${jobId}"`;

    const gpuTargets = await fetchJobGpuTargets(jobId).catch(() => []);
    const [cpuPoints, memoryPoints, rssPoints, allocatedCpus, gpus, gpuSeries] = await Promise.all([
      vmRange(`sum(rate(cgroup_cpu_usage_percpu{${selector}}[2m]))/1e9`, start, end, step),
      vmRange(`sum(cgroup_memory_used_bytes{${selector}})`, start, end, step),
      vmRange(`sum(cgroup_memory_rss_bytes{${selector}})`, start, end, step).catch(() => []),
      vmInstant(`max(cgroup_cpus{${selector}})`).catch(() => null),
      fetchJobGpuUsage(jobId, gpuTargets).catch(() => []),
      fetchJobGpuSeries(jobId, gpuTargets, start, end, step).catch(() => ({ devices: [], util: [], memory: [] })),
    ]);

    const cpuStats = summarizeSeries(cpuPoints);
    const memoryStats = summarizeSeries(memoryPoints);
    const rssPeak = rssPoints.length ? Math.max(...rssPoints.map((point) => point.value)) : null;
    const requestedMemory = parseRequestedMemoryBytes(job.reqTres || job.memory || '');

    const bucket = new Map();
    [...cpuPoints, ...memoryPoints].forEach((point) => {
      if (!bucket.has(point.ts)) bucket.set(point.ts, { ts: point.ts, cpuCores: null, memoryBytes: null });
    });
    cpuPoints.forEach((point) => { bucket.get(point.ts).cpuCores = point.value; });
    memoryPoints.forEach((point) => { bucket.get(point.ts).memoryBytes = point.value; });
    const series = Array.from(bucket.values()).sort((a, b) => a.ts - b.ts);

    res.json({
      jobId,
      rangeSeconds,
      step,
      cpu: {
        allocated: allocatedCpus,
        ...cpuStats,
      },
      memory: {
        requestedBytes: requestedMemory,
        ...memoryStats,
        rssPeakBytes: rssPeak,
      },
      gpus,
      gpuDevices: gpuSeries.devices,
      gpuUtilSeries: gpuSeries.util,
      gpuMemorySeries: gpuSeries.memory,
      series,
      source: VM_URL,
    });
  } catch (err) {
    const status = err.message === 'Invalid jobId' ? 400 : 502;
    console.error('Failed to read job usage', err.message);
    res.status(status).json({ error: 'Failed to read job usage', details: err.message });
  }
});

// -------- Job output logs --------
const LOG_TAIL_BYTES = 96 * 1024;

const scontrolJobField = (text, name) => {
  const pattern = '(?:^|\\n)\\s*' + name + '=([^\\n]+)';
  const match = text.match(new RegExp(pattern));
  return match ? match[1].trim() : '';
};

const resolveJobLogPaths = async (jobId) => {
  const { stdout } = await execFileAsync('/usr/bin/scontrol', ['show', 'job', jobId], {
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const userIdRaw = scontrolJobField(stdout, 'UserId');
  const uidMatch = userIdRaw.match(/\((\d+)\)/);
  const expand = (value) => (value || '')
    .replace(/%[jJ]/g, jobId)
    .replace(/%[xX]/g, scontrolJobField(stdout, 'JobName'));
  return {
    workDir: expand(scontrolJobField(stdout, 'WorkDir')),
    stdoutPath: expand(scontrolJobField(stdout, 'StdOut')),
    stderrPath: expand(scontrolJobField(stdout, 'StdErr')),
    uid: uidMatch ? parseInt(uidMatch[1], 10) : null,
  };
};

// Only the last chunk of the file is returned: job outputs can reach hundreds of MB.
const readLogTail = async (filePath, uid) => {
  const realPath = await fs.promises.realpath(filePath);
  const stat = await fs.promises.stat(realPath);
  if (!stat.isFile()) throw new Error('Log path is not a regular file');
  // The dashboard runs as root; refuse anything the job owner does not own.
  if (uid === null) throw new Error('Cannot determine job owner from scontrol');
  if (stat.uid !== uid) {
    throw new Error('Log file is not owned by the job owner');
  }
  const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  if (length > 0) {
    const handle = await fs.promises.open(realPath, 'r');
    try {
      await handle.read(buffer, 0, length, start);
    } finally {
      await handle.close();
    }
  }
  let content = buffer.toString('utf8');
  if (start > 0) {
    const firstBreak = content.indexOf('\n');
    content = firstBreak === -1 ? '' : content.slice(firstBreak + 1);
  }
  return {
    path: realPath,
    content,
    size: stat.size,
    mtime: stat.mtimeMs,
    truncated: start > 0,
  };
};

app.get('/api/jobs/:jobId/log', requireAuth, async (req, res) => {
  const stream = req.query.stream === 'err' ? 'err' : 'out';
  try {
    const jobId = sanitizeJobId(req.params.jobId);
    const jobs = await fetchJobs();
    const job = jobs.find((item) => String(item.jobId) === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (req.user.role !== 'admin') {
      const allowed = await computeAllowedPartitionsForUser(req.user.username, req.user.partitions || null);
      const partitionAllowed = !allowed || allowed.includes(job.partition);
      if (job.user !== req.user.username || !partitionAllowed) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const paths = await resolveJobLogPaths(jobId);
    const target = stream === 'err' ? paths.stderrPath : paths.stdoutPath;
    if (!target) return res.status(404).json({ error: `No ${stream} log configured for this job`, stream });

    const fallbackUid = paths.uid;
    try {
      const data = await readLogTail(target, fallbackUid);
      return res.json({ stream, exists: true, ...data });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.json({ stream, exists: false, path: target, content: '', size: 0, mtime: null, truncated: false });
      }
      throw err;
    }
  } catch (err) {
    const status = err.message === 'Invalid jobId' ? 400 : 500;
    console.error('Failed to read job log', err);
    res.status(status).json({ error: 'Failed to read job log', details: err.message });
  }
});

// Static frontend
const HISTORY_BUCKETS = [60, 300, 900, 1800, 3600, 6 * 3600, 12 * 3600, 24 * 3600, 7 * 24 * 3600];

// Picks a bucket size so a long range still returns a chart-friendly number of points.
const pickHistoryBucketMs = (spanMs, maxPoints) => {
  const raw = Math.max(Math.ceil(spanMs / maxPoints), 60 * 1000);
  const rawSeconds = Math.ceil(raw / 1000);
  const match = HISTORY_BUCKETS.find((seconds) => seconds >= rawSeconds);
  return (match || HISTORY_BUCKETS[HISTORY_BUCKETS.length - 1]) * 1000;
};

const parseRange = (req) => {
  const now = Date.now();
  const start = parseInt(req.query.start, 10);
  const end = parseInt(req.query.end, 10);
  const safeEnd = Number.isFinite(end) && end > 0 ? end : now;
  const safeStart = Number.isFinite(start) && start > 0 ? start : safeEnd - 24 * 60 * 60 * 1000;
  return { start: Math.min(safeStart, safeEnd), end: safeEnd };
};

app.get('/api/history/partitions', requireAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  try {
    const { start, end } = parseRange(req);
    const bucketMs = pickHistoryBucketMs(end - start, 480);
    const params = [bucketMs, start, end];
    let where = 'WHERE ts >= $2 AND ts <= $3';
    if (req.query.name) {
      params.push(String(req.query.name));
      where += ` AND name = $${params.length}`;
    }
    if (req.user.role !== 'admin') {
      const allowed = await computeAllowedPartitionsForUser(req.user.username, req.user.partitions || null);
      if (allowed) {
        params.push(allowed);
        where += ` AND name = ANY($${params.length})`;
      }
    }
    const { rows } = await pool.query(
      `SELECT ((ts / $1::bigint) * $1::bigint) AS ts,
              name,
              type,
              ROUND(AVG(allocated))::int AS allocated,
              ROUND(AVG(total))::int AS total,
              ROUND(AVG(pending))::int AS pending,
              ROUND(AVG(utilization)::numeric, 2)::float AS utilization
         FROM partition_history
         ${where}
        GROUP BY 1, name, type
        ORDER BY 1 ASC`,
      params
    );
    res.json(rows.map((row) => ({ ...row, ts: Number(row.ts), bucketMs })));
  } catch (err) {
    console.error('Failed to load partition history', err);
    res.status(500).json({ error: 'Failed to load partition history', details: err.message });
  }
});

app.get('/api/history/jobs', requireAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  try {
    const { start, end } = parseRange(req);
    const params = [start, end];
    let where = 'WHERE ts >= $1 AND ts <= $2';
    if (req.user.role !== 'admin') {
      params.push(req.user.username);
      where += ` AND user_name = $${params.length}`;
    } else if (req.query.user) {
      params.push(String(req.query.user));
      where += ` AND user_name = $${params.length}`;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5000, 1), 50000);
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ts, jobid, name, partition, user_name as user, state, cpus, gpus, shards
         FROM job_history ${where}
        ORDER BY ts DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(rows.map((row) => ({ ...row, ts: Number(row.ts) })));
  } catch (err) {
    console.error('Failed to load job history', err);
    res.status(500).json({ error: 'Failed to load job history', details: err.message });
  }
});

app.use(express.static(DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

app.listen(PORT, HOST, () => {
  initTables().catch(err => console.error('Failed to init DB tables', err));
  if (dbConfig.connectionString) {
    const intervalMs = (dbConfig.intervalSeconds || 300) * 1000;
    startScheduler(intervalMs);
    startRetentionPurge();
    console.log(`Background collector started, interval ${intervalMs / 1000}s, retention ${dbConfig.retentionDays || 365}d`);
  }
  console.log(`SlurmClusterInsight server running at http://${HOST}:${PORT}`);
});
