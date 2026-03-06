import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
import ldap from 'ldapjs';
import bcrypt from 'bcryptjs';
import { pool, initTables, dbConfig, resetPoolWithConfig, testDbConnection, saveDbConfig } from './db.js';

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '0.0.0.0';
app.use(express.json({ limit: '1mb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const defaultAuthState = () => ({
  admin: {
    username: 'admin',
    passwordHash: bcrypt.hashSync('P@ssw0rd01!', 8),
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

const loadAuthState = () => {
  ensureDataDir();
  if (!fs.existsSync(AUTH_FILE)) {
    const defaults = defaultAuthState();
    fs.writeFileSync(AUTH_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaultAuthState(), ...parsed };
  } catch (err) {
    console.error('Failed to load auth config, regenerating defaults', err);
    const defaults = defaultAuthState();
    fs.writeFileSync(AUTH_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
};

const saveAuthState = (state) => {
  ensureDataDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
};

let authState = loadAuthState();
const sessionStore = new Map(); // token -> { username, role, menus, partitions }

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

const parseTresCounts = ({ tresPerNode = '', tresReq = '', tresAlloc = '', nodes = 1 }) => {
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
  const gpu = perNodeGpu ? perNodeGpu * (nodes || 1) : extract(tresReq || tresAlloc, 'gpu');
  const shard = perNodeShard ? perNodeShard * (nodes || 1) : extract(tresReq || tresAlloc, 'shard');

  return { gpu, shard };
};

const fetchTresFromSacct = async (jobId) => {
  try {
    const { stdout } = await execAsync(
      `sacct -j ${jobId} -P -o ReqTRES -n | head -n 1`,
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
  try {
    const { stdout } = await execAsync(`id -Gn ${username}`);
    return stdout.trim().split(/\s+/).filter(Boolean);
  } catch (err) {
    console.warn('Failed to get groups for user', username, err.message);
    return [];
  }
};

const getPartitionAcls = async () => {
  try {
    const { stdout } = await execAsync('scontrol show partition -o');
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
      if (pool) {
        const rows = partitions.map(p => [now, p.name, p.type, p.allocated, p.total, p.pending, p.utilization]);
        pool.query(
          'INSERT INTO partition_history (ts, name, type, allocated, total, pending, utilization) VALUES ' +
          rows.map((_, i) => `($${i*7+1}, $${i*7+2}, $${i*7+3}, $${i*7+4}, $${i*7+5}, $${i*7+6}, $${i*7+7})`).join(','),
          rows.flat()
        ).catch(err => console.warn('Scheduler persist partition history failed', err.message));
      }
      if (pool) {
        const jobRows = jobs.slice(0, 500).map(j => [now, j.jobId, j.name, j.partition, j.user, j.state, j.cpus || 0, j.gpus || 0, j.shards || 0]);
        pool.query(
          'INSERT INTO job_history (ts, jobid, name, partition, user_name, state, cpus, gpus, shards) VALUES ' +
          jobRows.map((_, i) => `($${i*9+1}, $${i*9+2}, $${i*9+3}, $${i*9+4}, $${i*9+5}, $${i*9+6}, $${i*9+7}, $${i*9+8}, $${i*9+9})`).join(','),
          jobRows.flat()
        ).catch(err => console.warn('Scheduler persist job history failed', err.message));
      }
    } catch (err) {
      console.warn('Scheduler run failed', err.message);
    }
  }, intervalMs);
};

const safeExec = async (command) => {
  const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024, timeout: 12000 });
  return stdout;
};

const fetchPendingByPartition = async () => {
  try {
    const out = await safeExec("squeue -t PENDING -h -o '%P'");
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
  const out = await safeExec("sinfo -N -h -o '%N|%t|%C|%G|%P|%E'");
  return out
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

const fetchPartitions = async (nodes, jobs) => {
  const pendingMap = await fetchPendingByPartition();
  const { running: gpuRunningMap, pending: gpuPendingMap, runningShards, pendingShards } = buildGpuMaps(jobs);

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
      nodes: entry.nodes,
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

const fetchJobsFromJson = async () => {
  const out = await safeExec('squeue --json');
  const parsed = JSON.parse(out);
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const result = [];
  for (const j of jobs) {
    const baseCounts = parseTresCounts({
      tresPerNode: j.tres_per_node || '',
      tresReq: j.tres_req_str || '',
      tresAlloc: j.tres_alloc_str || '',
      nodes: j.num_nodes ?? 1,
    });
    let counts = baseCounts;
    let tresStrExtra = '';

    const isJupyter = (j.partition || '').toLowerCase() === 'jupyter';
    const missingGpuInfo = (!baseCounts.gpu && !baseCounts.shard) && isJupyter;
    if (missingGpuInfo) {
      const sacctData = await fetchTresFromSacct(j.job_id ?? j.jobId ?? '');
      tresStrExtra = sacctData.tresString;
      counts = sacctData.counts;
    }

    result.push({
    jobId: String(j.job_id ?? ''),
    name: j.name ?? '',
    partition: j.partition ?? '',
    user: j.user_name ?? j.user ?? '',
    state: (j.job_state || 'PENDING').toUpperCase(),
    time: j.run_time ?? j.time ?? '0:00',
    timeLimit: j.time_limit ?? 'UNLIMITED',
    nodes: j.num_nodes ?? 1,
    cpus: j.cpus ?? j.num_cpus ?? 0,
    nodelist: j.node_list ?? j.nodes ?? '',
    nodesExpanded: expandNodeList(j.node_list ?? j.nodes ?? ''),
    priority: String(j.priority ?? ''),
    reason: j.state_reason ?? '',
    memory: j.memory ?? '',
    reqTres: j.tres_alloc_str ?? j.tres_req_str ?? '',
    tresExtra: tresStrExtra || undefined,
    gpus: counts.gpu || undefined,
    shards: counts.shard || (counts.gpu ? counts.gpu * 2 : undefined),
    submitTime: j.submit_time ?? '',
    endTime: j.end_time ?? '',
    workDir: j.work_dir ?? '',
    });
  }
  return result;
};

const fetchJobsFromFormat = async () => {
  const format = "%i|%P|%j|%u|%T|%M|%l|%D|%C|%R|%m|%b|%V|%e|%Z|%Q";
  const out = await safeExec(`squeue -h -o '${format}'`);
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
        nodelist: reasonOrNode,
        nodesExpanded: expandNodeList(reasonOrNode),
        priority: priority || '0',
        reason: reasonOrNode,
        memory,
        reqTres,
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

const fetchJobs = async () => {
  try {
    return await fetchJobsFromJson();
  } catch (err) {
    console.warn('squeue --json unavailable, falling back to formatted output:', err.message);
    return await fetchJobsFromFormat();
  }
};

// -------- Auth --------
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    if (username === authState.admin.username) {
      if (!bcrypt.compareSync(password, authState.admin.passwordHash)) throw new Error('Invalid admin password');
      const token = crypto.randomBytes(24).toString('hex');
      sessionStore.set(token, { username, role: 'admin', menus: authState.admin.menus, partitions: authState.admin.partitions });
      return res.json({ token, role: 'admin', menus: authState.admin.menus, partitions: authState.admin.partitions });
    }

    const profile = await ldapValidateAcrossServers(username, password);
    if (profile.uidNumber < (authState.ldap?.minUid || 500)) {
      throw new Error('User not allowed (uidNumber too low)');
    }
    const perms = authState.userPermissions[username] || {};
    const token = crypto.randomBytes(24).toString('hex');
    sessionStore.set(token, { username, role: 'user', menus: perms.menus || null, partitions: perms.partitions || null });
    res.json({ token, role: 'user', menus: perms.menus || null, partitions: perms.partitions || null });
  } catch (err) {
    console.error('Login failed', err);
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
  authState.admin.passwordHash = bcrypt.hashSync(newPassword, 8);
  saveAuthState(authState);
  res.json({ ok: true });
});

app.post('/api/admin/ldap-config', requireAuth, requireAdmin, (req, res) => {
  const { servers, minUid } = req.body || {};
  authState.ldap.servers = Array.isArray(servers) ? servers.slice(0, 2) : authState.ldap.servers;
  authState.ldap.minUid = minUid || authState.ldap.minUid || 500;
  saveAuthState(authState);
  res.json({ ok: true, ldap: authState.ldap });
});

app.get('/api/admin/ldap-config', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ldap: authState.ldap });
});

app.post('/api/admin/collector-config', requireAuth, requireAdmin, (req, res) => {
  const { intervalSeconds } = req.body || {};
  if (intervalSeconds && intervalSeconds >= 60) {
    dbConfig.intervalSeconds = intervalSeconds;
    saveDbConfig(dbConfig);
    if (dbConfig.connectionString) {
      startScheduler(intervalSeconds * 1000);
    }
  }
  res.json({ ok: true, intervalSeconds: dbConfig.intervalSeconds });
});

app.post('/api/admin/ldap-test', requireAuth, requireAdmin, async (req, res) => {
  const payloadServers = Array.isArray(req.body?.servers) ? req.body.servers.slice(0, 2) : null;
  const servers = payloadServers || authState.ldap?.servers || [];
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
  const list = Array.isArray(servers) ? servers.slice(0, 2) : authState.ldap.servers;
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

app.get('/api/partitions', requireAuth, async (req, res) => {
  try {
    const nodes = await fetchNodes();
    const jobs = await fetchJobs();
    let partitions = await fetchPartitions(nodes, jobs);
    const now = Date.now();
    if (pool) {
      const rows = partitions.map(p => [now, p.name, p.type, p.allocated, p.total, p.pending, p.utilization]);
      pool.query(
        'INSERT INTO partition_history (ts, name, type, allocated, total, pending, utilization) VALUES ' +
        rows.map((_, i) => `($${i*7+1}, $${i*7+2}, $${i*7+3}, $${i*7+4}, $${i*7+5}, $${i*7+6}, $${i*7+7})`).join(','),
        rows.flat()
      ).catch(err => console.warn('Failed to persist partition history', err.message));
    }
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
    const now = Date.now();
    if (pool) {
      const rows = jobs.slice(0, 500).map(j => [now, j.jobId, j.name, j.partition, j.user, j.state, j.cpus || 0, j.gpus || 0, j.shards || 0]);
      pool.query(
        'INSERT INTO job_history (ts, jobid, name, partition, user_name, state, cpus, gpus, shards) VALUES ' +
        rows.map((_, i) => `($${i*9+1}, $${i*9+2}, $${i*9+3}, $${i*9+4}, $${i*9+5}, $${i*9+6}, $${i*9+7}, $${i*9+8}, $${i*9+9})`).join(','),
        rows.flat()
      ).catch(err => console.warn('Failed to persist job history', err.message));
    }
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

// Static frontend
app.get('/api/history/partitions', requireAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  const { start, end, name } = req.query;
  const params = [];
  let where = 'WHERE 1=1';
  if (start) { params.push(parseInt(start, 10)); where += ` AND ts >= $${params.length}`; }
  if (end) { params.push(parseInt(end, 10)); where += ` AND ts <= $${params.length}`; }
  if (name) { params.push(String(name)); where += ` AND name = $${params.length}`; }
  if (req.user.role !== 'admin') {
    const allowed = await computeAllowedPartitionsForUser(req.user.username, req.user.partitions || null);
    if (allowed) {
      params.push(allowed);
      where += ` AND name = ANY($${params.length})`;
    }
  }
  const { rows } = await pool.query(`SELECT ts, name, type, allocated, total, pending, utilization FROM partition_history ${where} ORDER BY ts DESC LIMIT 5000`, params);
  res.json(rows);
});

app.get('/api/history/jobs', requireAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not configured' });
  const { start, end, user } = req.query;
  const params = [];
  let where = 'WHERE 1=1';
  if (start) { params.push(parseInt(start, 10)); where += ` AND ts >= $${params.length}`; }
  if (end) { params.push(parseInt(end, 10)); where += ` AND ts <= $${params.length}`; }
  if (req.user.role !== 'admin') {
    params.push(req.user.username);
    where += ` AND user_name = $${params.length}`;
  } else if (user) {
    params.push(String(user));
    where += ` AND user_name = $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT ts, jobid, name, partition, user_name as user, state, cpus, gpus, shards FROM job_history ${where} ORDER BY ts DESC LIMIT 5000`, params);
  res.json(rows);
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
    console.log(`Background collector started, interval ${intervalMs / 1000}s`);
  }
  console.log(`SlurmClusterInsight server running at http://${HOST}:${PORT}`);
});
