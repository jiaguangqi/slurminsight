import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock, Database, RefreshCw, ScrollText, Server, ShieldCheck, XCircle } from 'lucide-react';
import { slurmService, ServiceLogSummary, ServiceStatus } from '../services/slurmService.ts';

const REFRESH_MS = 15000;
const LOG_REFRESH_MS = 60000;

const us = (value?: number | null, digits = 1) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1000000) return `${(value / 1000000).toFixed(digits)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(digits)} ms`;
  return `${Math.round(value)} µs`;
};

const bytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
};

const SERVICE_LABELS: Record<string, string> = {
  slurmctld: 'slurmctld',
  slurmdbd: 'slurmdbd',
  munge: 'munge',
  slurmd: 'slurmd',
  mariadb: 'mariadb',
  mysqld: 'mysqld',
};

const serviceTone = (unit: string, state: string) => {
  if (state === 'active') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  if (state === 'failed' || state === 'error') return 'bg-rose-50 text-rose-700 border-rose-100';
  if (unit === 'slurmd' || unit === 'mariadb' || unit === 'mysqld') return 'bg-slate-50 text-slate-500 border-slate-100';
  return 'bg-amber-50 text-amber-700 border-amber-100';
};

const StatTile: React.FC<{ label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'bad' }> = ({ label, value, hint, tone }) => (
  <div className={`rounded-2xl border p-4 ${
    tone === 'bad' ? 'border-rose-200 bg-rose-50/60' : tone === 'warn' ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-white'
  }`}>
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">{label}</p>
    <p className={`mt-1.5 text-xl font-black leading-none ${tone === 'bad' ? 'text-rose-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900'}`}>{value}</p>
    {hint && <p className="mt-1 text-[10px] font-bold text-slate-500">{hint}</p>}
  </div>
);

const ServiceHealth: React.FC = () => {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [logs, setLogs] = useState<ServiceLogSummary | null>(null);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await slurmService.fetchServiceStatus();
      setStatus(data);
      setLastSync(new Date());
      setError(null);
    } catch (err: any) {
      setError(err?.message || '无法获取服务状态');
    }
  }, []);

  const loadLogs = useCallback(async (h: number) => {
    try {
      const data = await slurmService.fetchServiceLogs(h);
      setLogs(data);
    } catch (err: any) {
      setLogs(null);
      setError(err?.message || '无法读取日志');
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { loadLogs(hours); }, [hours, loadLogs]);

  useEffect(() => {
    const t1 = setInterval(loadStatus, REFRESH_MS);
    const t2 = setInterval(() => loadLogs(hours), LOG_REFRESH_MS);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [loadStatus, loadLogs, hours]);

  const refreshAll = async () => {
    setLoading(true);
    await Promise.all([loadStatus(), loadLogs(hours)]);
    setLoading(false);
  };

  const scheduler = status?.scheduler;
  const cycleTone = (scheduler?.cycleLastUs || 0) > 500000 ? 'bad' : (scheduler?.cycleLastUs || 0) > 100000 ? 'warn' : 'ok';
  const dbdTone = (scheduler?.dbdQueue || 0) > 0 ? 'bad' : 'ok';
  const clockTone = (scheduler?.clockLatencyUs || 0) > 1000 ? 'warn' : 'ok';

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight">Service Health</h2>
          <p className="text-slate-500 font-medium">Slurm 核心服务、高可用主备与数据库同步状态。</p>
        </div>
        <div className="flex items-center gap-3">
          {lastSync && (
            <span className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
              <Clock size={14} /> {lastSync.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refreshAll}
            disabled={loading}
            className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-black text-sm transition-all shadow-sm ${
              loading ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : 'bg-slate-900 text-white hover:bg-slate-800 active:scale-95'
            }`}
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4">
          <AlertTriangle size={18} className="text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-black text-rose-700">数据获取失败</p>
            <p className="text-xs font-medium text-rose-600 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* 主备节点 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {(status?.hosts || []).map((host) => {
          const controller = status?.controllers.find((c) => c.host === host.host);
          const role = host.host === status?.primary ? 'Primary' : host.host === status?.backup ? 'Backup' : 'Node';
          const down = controller?.state === 'DOWN' || !host.reachable;
          const ctldLog = host.files.find((f) => f.path.includes('slurmctld'));
          return (
            <div key={host.host} className={`bg-white rounded-3xl border p-6 shadow-sm ${down ? 'border-rose-200' : 'border-slate-200'}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-2xl ${down ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>
                    <Server size={20} />
                  </div>
                  <div>
                    <p className="text-lg font-black text-slate-900 leading-tight">{host.host}</p>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">{role} Controller</p>
                  </div>
                </div>
                <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-black ${
                  down ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'
                }`}>
                  {down ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
                  {host.reachable ? (controller?.state || 'UNKNOWN') : 'UNREACHABLE'}
                </span>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {Object.entries(host.services).map(([unit, state]) => (
                  <span key={unit} className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold ${serviceTone(unit, state)}`}>
                    {SERVICE_LABELS[unit] || unit}
                    <span className="ml-1 opacity-60">{state}</span>
                  </span>
                ))}
              </div>

              {host.dbError && (
                <div className="mt-4 flex items-start gap-2 rounded-xl bg-rose-50 border border-rose-100 px-3 py-2">
                  <AlertTriangle size={13} className="text-rose-600 mt-0.5 shrink-0" />
                  <p className="text-[11px] font-bold text-rose-700 leading-relaxed">
                    slurmdbd 无法连接本地数据库，正在重试。切换到此节点后记账将不可用。
                  </p>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span className="truncate">slurmctld.log</span>
                <span className="shrink-0 ml-3">
                  {ctldLog ? `${bytes(ctldLog.size)} · ${new Date(ctldLog.mtime).toLocaleString()}` : '无法读取'}
                </span>
              </div>
            </div>
          );
        })}
      </section>

      {/* 调度器 */}
      <section className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-5">
          <Activity size={16} className="text-blue-600" />
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">调度器健康</h3>
          <span className="ml-auto text-[10px] font-bold text-slate-500">来自 sdiag，每 15 秒刷新</span>
        </div>
        {scheduler?.error ? (
          <p className="text-xs font-bold text-rose-600">sdiag 读取失败：{scheduler.error}</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <StatTile label="调度周期(最近)" value={us(scheduler?.cycleLastUs)} tone={cycleTone as any} />
            <StatTile label="调度周期(平均)" value={us(scheduler?.cycleMeanUs)} />
            <StatTile label="调度周期(峰值)" value={us(scheduler?.cycleMaxUs)} />
            <StatTile label="调度队列深度" value={String(scheduler?.queueLength ?? '—')} hint={`${scheduler?.cyclePerMinute ?? '—'} 次/分钟`} />
            <StatTile label="Backfill 深度" value={String(scheduler?.backfillDepth ?? '—')} hint={`队列 ${scheduler?.backfillQueue ?? '—'}${scheduler?.backfillActive ? ' · 运行中' : ''}`} />
            <StatTile label="DBD 队列" value={String(scheduler?.dbdQueue ?? '—')} tone={dbdTone as any} hint={`线程 ${scheduler?.serverThreads ?? '—'}`} />
            <StatTile label="时钟延迟" value={us(scheduler?.clockLatencyUs)} tone={clockTone as any} hint="gettimeofday" />
          </div>
        )}
        {scheduler?.jobs && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-6 gap-3">
            {([
              ['提交', scheduler.jobs.submitted],
              ['启动', scheduler.jobs.started],
              ['完成', scheduler.jobs.completed],
              ['取消', scheduler.jobs.canceled],
              ['失败', scheduler.jobs.failed],
              ['当前运行 / 等待', `${scheduler.jobs.running} / ${scheduler.jobs.pending}`],
            ] as Array<[string, number | string]>).map(([label, value]) => (
              <div key={label} className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-[10px] font-bold text-slate-500">{label}</p>
                <p className="text-sm font-black text-slate-800">{value}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 数据库 */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm lg:col-span-1">
          <div className="flex items-center gap-2 mb-4">
            <Database size={16} className="text-violet-600" />
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">记账数据库</h3>
          </div>
          <dl className="space-y-2.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="font-bold text-slate-500">DBD 主机</dt>
              <dd className="font-black text-slate-800 text-right">{status?.dbd.config?.accountingHost || '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="font-bold text-slate-500">DBD RPC</dt>
              <dd className="font-black text-slate-800">{us(status?.dbd.cluster?.rpcUs)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="font-bold text-slate-500">Rollup 最近</dt>
              <dd className="font-black text-slate-800">{us(status?.dbd.rollup?.lastCycleUs)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="font-bold text-slate-500">Rollup 峰值</dt>
              <dd className="font-black text-slate-800">{us(status?.dbd.rollup?.maxCycleUs)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="font-bold text-slate-500">最后运行</dt>
              <dd className="font-bold text-slate-600 text-right">{status?.dbd.rollup?.lastRanAt || '—'}</dd>
            </div>
          </dl>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <ScrollText size={16} className="text-slate-600" />
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">控制器日志分析</h3>
            <div className="ml-auto flex bg-slate-100 rounded-lg p-0.5">
              {[1, 6, 24, 72].map((h) => (
                <button
                  key={h}
                  onClick={() => setHours(h)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-black transition-all ${hours === h ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                >
                  {h}H
                </button>
              ))}
            </div>
          </div>

          {!logs ? (
            <p className="text-xs font-bold text-slate-500 py-6 text-center">加载中…</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mb-4">
                <span className="px-3 py-1.5 rounded-lg bg-slate-100 text-[11px] font-black text-slate-700">共 {logs.total.toLocaleString()} 行</span>
                <span className={`px-3 py-1.5 rounded-lg text-[11px] font-black ${logs.byLevel.error > 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>
                  error {logs.byLevel.error.toLocaleString()}
                </span>
                <span className={`px-3 py-1.5 rounded-lg text-[11px] font-black ${logs.byLevel.warning > 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                  warning {logs.byLevel.warning.toLocaleString()}
                </span>
                {logs.byLevel.fatal > 0 && (
                  <span className="px-3 py-1.5 rounded-lg bg-rose-600 text-[11px] font-black text-white">fatal {logs.byLevel.fatal}</span>
                )}
                {logs.coveredFrom && (
                  <span className="text-[10px] font-bold text-slate-500">
                    {logs.coveredFrom.slice(11, 19)} – {(logs.coveredTo || '').slice(11, 19)}
                  </span>
                )}
                <span className="ml-auto text-[10px] font-bold text-slate-500">{logs.host}</span>
              </div>

              {logs.topMessages.length > 0 && (
                <div className="space-y-1.5 mb-4">
                  {logs.topMessages.slice(0, 5).map((item) => (
                    <div key={item.pattern} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2">
                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-white text-[10px] font-black text-slate-600 border border-slate-200">
                        ×{item.count.toLocaleString()}
                      </span>
                      <span className="truncate text-[11px] font-mono text-slate-600" title={item.sample}>{item.pattern}</span>
                    </div>
                  ))}
                </div>
              )}

              {logs.confNodes.length > 0 && (
                <div className="mb-4 rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-2.5">
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                    配置不一致的节点 · 共 {logs.confNodeTotal ?? logs.confNodes.length} 台
                  </p>
                  <p className="mt-1 text-[11px] font-bold text-amber-800 leading-relaxed">
                    {logs.confNodes.map((n) => `${n.node}(${n.count})`).join('、')}
                  </p>
                </div>
              )}

              <div className="rounded-xl border border-slate-100 overflow-hidden">
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-50">
                  {logs.recentErrors.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs font-bold text-emerald-600">该时间窗口内没有错误日志</p>
                  ) : logs.recentErrors.slice(0, 20).map((item, idx) => (
                    <div key={`${item.ts}-${idx}`} className="px-3 py-2">
                      <p className="text-[10px] font-bold text-slate-500 font-mono">{item.ts}</p>
                      <p className="text-[11px] font-mono text-slate-700 break-words">{item.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={16} className="text-emerald-600" />
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">高可用配置</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
          <div>
            <p className="font-bold text-slate-500">控制器</p>
            <p className="font-black text-slate-800 mt-1">
              {(status?.dbd.config?.haHosts || []).map((h, i) => `${i === 0 ? 'Primary' : 'Backup'} ${h.host}${h.ip ? ` (${h.ip})` : ''}`).join(' · ') || '—'}
            </p>
          </div>
          <div>
            <p className="font-bold text-slate-500">集群名</p>
            <p className="font-black text-slate-800 mt-1">{status?.dbd.config?.clusterName || '—'}</p>
          </div>
          <div>
            <p className="font-bold text-slate-500">状态保存目录</p>
            <p className="font-mono font-bold text-slate-700 mt-1 truncate" title={status?.dbd.config?.stateSaveLocation || ''}>
              {status?.dbd.config?.stateSaveLocation || '—'}
            </p>
          </div>
          <div>
            <p className="font-bold text-slate-500">当前主控</p>
            <p className="font-black text-slate-800 mt-1">{status?.controllers.find((c) => c.role === 'primary')?.host || '—'}</p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default ServiceHealth;
