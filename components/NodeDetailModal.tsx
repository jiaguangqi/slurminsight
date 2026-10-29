import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Monitor, AlertTriangle, Cpu, MemoryStick, Zap, Activity, Network, RefreshCw, Server,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, AreaChart, Area,
} from 'recharts';
import { NodeState } from '../types';
import { slurmService } from '../services/slurmService.ts';
import type { CollectorState, NodeDetail, NodeMetricSeries } from '../services/slurmService.ts';

interface NodeDetailModalProps {
  nodeName: string;
  fallback?: {
    state: NodeState;
    cpus?: string;
    gres?: string;
    gpusTotal?: number;
    gpusAllocated?: number;
    memoryTotalMb?: number;
    reason?: string;
  };
  onClose: () => void;
}

const STATE_LABEL: Record<NodeState, string> = {
  idle: '空闲',
  allocated: '全分配',
  mixed: '部分分配',
  drained: '排空',
  down: '宕机',
  maint: '维护',
};

const STATE_STYLE: Record<NodeState, string> = {
  idle: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  allocated: 'bg-orange-50 text-orange-700 border-orange-100',
  mixed: 'bg-amber-50 text-amber-700 border-amber-100',
  drained: 'bg-slate-100 text-slate-600 border-slate-200',
  down: 'bg-rose-50 text-rose-700 border-rose-100',
  maint: 'bg-blue-50 text-blue-700 border-blue-100',
};

const RANGES = [
  { label: '1H', seconds: 3600 },
  { label: '6H', seconds: 21600 },
  { label: '24H', seconds: 86400 },
];

const COLLECTOR_LABEL: Record<string, string> = {
  metrics: 'node_exporter（系统指标）',
  jobs: 'cgroup_exporter（作业资源）',
  gpu: 'DCGM exporter（GPU 指标）',
};

const COLLECTOR_HINT: Record<string, string> = {
  missing: 'Prometheus 里没有该节点对应的采集目标：可能是节点上未部署该采集器，或该节点从未被纳入抓取配置。',
  down: '采集目标存在但最近一次抓取失败：通常是节点上的采集服务未启动、端口不通，或主机不可达。',
};

const formatBytes = (value?: number | null, digits = 1) => {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Math.abs(value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${value < 0 ? '-' : ''}${size.toFixed(index === 0 ? 0 : digits)} ${units[index]}`;
};

const formatPercent = (value?: number | null) => (
  value === undefined || value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`
);

const formatTime = (ts: number) => {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const parseCpus = (value?: string) => {
  const [alloc = 0, idle = 0, other = 0, total = 0] = (value || '0/0/0/0').split('/').map((n) => parseInt(n, 10) || 0);
  return { alloc, idle, other, total };
};

const CHART_COLORS = ['#6366f1', '#f97316', '#10b981', '#ef4444', '#0ea5e9', '#a855f7', '#eab308', '#14b8a6'];

const MetricChart: React.FC<{
  title: string;
  icon?: React.ReactNode;
  data: Array<{ ts: number; [key: string]: number | null }>;
  dataKey: string;
  color: string;
  formatter?: (value: number) => string;
  unit?: string;
  lines?: Array<{ key: string; color: string }>;
}> = ({ title, icon, data, dataKey, color, formatter, unit, lines }) => {
  const hasData = data.length > 0;
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-black text-slate-500 uppercase tracking-wider">
          {icon}
          {title}
        </div>
        {unit && <span className="text-[10px] font-bold text-slate-400">{unit}</span>}
      </div>
      <div className="h-32">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="ts" tickFormatter={formatTime} tick={{ fontSize: 9, fill: '#94a3b8' }} minTickGap={40} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} width={58} axisLine={false} tickLine={false} tickFormatter={(value) => (formatter ? formatter(Number(value)) : String(value))} />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleTimeString()}
                formatter={(value: number, name: string) => [formatter ? formatter(value) : value, name]}
                contentStyle={{ fontSize: 11, borderRadius: 10, border: '1px solid #e2e8f0' }}
              />
              {lines && lines.length > 1 ? (
                lines.map((line) => (
                  <Line key={line.key} type="monotone" dataKey={line.key} stroke={line.color} dot={false} strokeWidth={1.6} name={line.key} />
                ))
              ) : (
                <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.8} fill={`url(#grad-${dataKey})`} dot={false} name={title} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-[11px] font-bold text-slate-300">无采集数据</div>
        )}
      </div>
    </div>
  );
};

const StatTile: React.FC<{ label: string; value: string; sub?: string; icon: React.ReactNode; tone?: string }> = ({ label, value, sub, icon, tone }) => (
  <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3">
    <div className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider ${tone || 'text-slate-400'}`}>
      {icon}
      {label}
    </div>
    <div className="mt-1.5 text-lg font-black text-slate-900 tabular-nums leading-none">{value}</div>
    {sub && <div className="mt-1 text-[10px] font-bold text-slate-400 tabular-nums">{sub}</div>}
  </div>
);

const toPoints = (series?: NodeMetricSeries) => (series?.points || []) as Array<{ ts: number; value: number }>;

const NodeDetailModal: React.FC<NodeDetailModalProps> = ({ nodeName, fallback, onClose }) => {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState(3600);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async (seconds: number, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await slurmService.fetchNodeDetail(nodeName, seconds);
      setDetail(data);
      setError(null);
      setRefreshedAt(new Date());
    } catch (err: any) {
      setError(err?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [nodeName]);

  useEffect(() => { load(range); }, [load, range]);

  useEffect(() => {
    const timer = setInterval(() => { load(range, true); }, 30000);
    return () => clearInterval(timer);
  }, [load, range]);

  const node = detail?.node;
  const state: NodeState = (node?.state || fallback?.state || 'idle') as NodeState;
  const cpus = parseCpus(node?.cpus || fallback?.cpus);
  const gpusTotal = node?.gpusTotal ?? fallback?.gpusTotal ?? 0;
  const gpusAllocated = node?.gpusAllocated ?? fallback?.gpusAllocated ?? 0;
  const isGpu = gpusTotal > 0;
  const monitoring = detail?.monitoring;

  const collectors = useMemo(() => {
    if (!monitoring) return [] as Array<{ key: string; state: CollectorState }>;
    const entries: Array<{ key: string; state: CollectorState }> = [
      { key: 'metrics', state: monitoring.metrics },
      { key: 'jobs', state: monitoring.jobs },
    ];
    if (monitoring.gpu !== 'n/a') entries.push({ key: 'gpu', state: monitoring.gpu });
    return entries;
  }, [monitoring]);

  const problemCollectors = collectors.filter((item) => item.state !== 'ok');

  const cpuData = toPoints(detail?.series.cpuUtil);
  const memData = toPoints(detail?.series.memoryPct);
  const loadData = toPoints(detail?.series.load1);
  const netData = useMemo(() => {
    const rx = toPoints(detail?.series.netRx);
    const tx = toPoints(detail?.series.netTx);
    const bucket = new Map<number, { ts: number; rx: number | null; tx: number | null }>();
    rx.forEach((point) => { if (!bucket.has(point.ts)) bucket.set(point.ts, { ts: point.ts, rx: null, tx: null }); bucket.get(point.ts)!.rx = point.value; });
    tx.forEach((point) => { if (!bucket.has(point.ts)) bucket.set(point.ts, { ts: point.ts, rx: null, tx: null }); bucket.get(point.ts)!.tx = point.value; });
    return Array.from(bucket.values()).sort((a, b) => a.ts - b.ts);
  }, [detail]);

  const gpuLines = useMemo(
    () => (detail?.gpus || []).map((card, index) => ({ key: `gpu${card.index}`, color: CHART_COLORS[index % CHART_COLORS.length] })),
    [detail],
  );

  const memoryTotalBytes = node?.memoryTotalMb ? node.memoryTotalMb * 1024 * 1024 : null;
  const memoryUsedBytes = detail?.series.memoryUsed?.current ?? null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-slate-50 w-full max-w-5xl max-h-[90vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 border border-slate-200">
        <div className="px-7 py-5 border-b border-slate-100 flex items-start justify-between gap-4 bg-white">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className={`p-2.5 rounded-2xl shrink-0 ${state === 'down' ? 'bg-rose-100 text-rose-600' : isGpu ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
              <Monitor size={18} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-black text-slate-900 tracking-tight truncate">{nodeName}</h2>
                <span className={`px-2 py-0.5 rounded-md border text-[10px] font-black ${STATE_STYLE[state]}`}>{STATE_LABEL[state]}</span>
                {problemCollectors.length > 0 && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-rose-200 bg-rose-50 text-[10px] font-black text-rose-600">
                    <AlertTriangle size={10} /> 采集异常
                  </span>
                )}
              </div>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-0.5 truncate">
                {(node?.partitions?.length ? node.partitions.join(' · ') : '未分配分区')}
                {isGpu ? ` · GPU ${gpusAllocated}/${gpusTotal} 张` : ''}
                {refreshedAt ? ` · 更新于 ${refreshedAt.toLocaleTimeString()}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex bg-slate-100 p-0.5 rounded-lg">
              {RANGES.map((item) => (
                <button
                  key={item.label}
                  onClick={() => setRange(item.seconds)}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-black transition-all ${range === item.seconds ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button onClick={() => load(range, true)} className="p-2 rounded-xl text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-all" title="立即刷新">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-all">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-7 py-5 space-y-5">
          {error && (
            <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              节点详情加载失败：{error}
            </div>
          )}

          {problemCollectors.length > 0 && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4 space-y-2">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-rose-700">
                <AlertTriangle size={13} /> 采集服务异常（{problemCollectors.length} 项）
              </div>
              {problemCollectors.map((item) => (
                <div key={item.key} className="rounded-xl bg-white/80 border border-rose-100 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${item.state === 'down' ? 'bg-amber-500' : 'bg-rose-500'}`} />
                    <span className="text-[11px] font-black text-slate-800">{COLLECTOR_LABEL[item.key]}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${item.state === 'down' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                      {item.state === 'down' ? '抓取失败' : '未采集'}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] font-medium text-slate-500 leading-relaxed">
                    {COLLECTOR_HINT[item.state] || ''}
                    {item.key === 'metrics' && monitoring?.ip ? ` 采集目标 IP：${monitoring.ip}。` : ''}
                  </p>
                </div>
              ))}
              {(node?.reason || fallback?.reason) && (
                <p className="text-[10px] font-bold text-rose-600">
                  Slurm 侧状态：{STATE_LABEL[state]}（{node?.reason || fallback?.reason}）。主机不可达或处于维护状态时，节点上不会产生新的采集数据。
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile
              label="CPU 分配"
              icon={<Cpu size={11} />}
              value={`${cpus.alloc}/${cpus.total || '—'}`}
              sub={`实际使用 ${detail?.series.cpuCores?.current !== null && detail?.series.cpuCores?.current !== undefined ? detail.series.cpuCores.current.toFixed(1) : '—'} 核 · ${formatPercent(detail?.series.cpuUtil?.current)}`}
              tone="text-blue-500"
            />
            <StatTile
              label="内存"
              icon={<MemoryStick size={11} />}
              value={formatPercent(detail?.series.memoryPct?.current)}
              sub={`${formatBytes(memoryUsedBytes)} / ${memoryTotalBytes ? formatBytes(memoryTotalBytes) : (fallback?.memoryTotalMb ? formatBytes(fallback.memoryTotalMb * 1024 * 1024) : '—')}`}
              tone="text-emerald-500"
            />
            <StatTile
              label="负载 (Load1)"
              icon={<Activity size={11} />}
              value={detail?.series.load1?.current !== null && detail?.series.load1?.current !== undefined ? detail.series.load1.current.toFixed(2) : '—'}
              sub={detail?.series.load1?.peak !== null && detail?.series.load1?.peak !== undefined ? `区间峰值 ${detail.series.load1.peak.toFixed(2)}` : undefined}
              tone="text-amber-500"
            />
            <StatTile
              label={isGpu ? 'GPU 分配' : '网络 (当前)'}
              icon={isGpu ? <Zap size={11} /> : <Network size={11} />}
              value={isGpu ? `${gpusAllocated}/${gpusTotal}` : formatBytes((detail?.series.netRx?.current || 0) + (detail?.series.netTx?.current || 0), 1) + '/s'}
              sub={isGpu ? `空闲 ${gpusTotal - gpusAllocated} 张` : `下行 ${formatBytes(detail?.series.netRx?.current, 1)}/s · 上行 ${formatBytes(detail?.series.netTx?.current, 1)}/s`}
              tone="text-purple-500"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <MetricChart
              title="CPU 使用率"
              icon={<Cpu size={11} />}
              data={cpuData}
              dataKey="value"
              color="#3b82f6"
              unit="%"
              formatter={(value) => `${Math.round(value)}%`}
            />
            <MetricChart
              title="内存使用率"
              icon={<MemoryStick size={11} />}
              data={memData}
              dataKey="value"
              color="#10b981"
              unit="%"
              formatter={(value) => `${Math.round(value)}%`}
            />
            <MetricChart
              title="负载 Load1"
              icon={<Activity size={11} />}
              data={loadData}
              dataKey="value"
              color="#f59e0b"
              formatter={(value) => value.toFixed(2)}
            />
            <MetricChart
              title="网络吞吐"
              icon={<Network size={11} />}
              data={netData}
              dataKey="rx"
              color="#0ea5e9"
              unit="B/s"
              formatter={(value) => formatBytes(value, 1)}
              lines={[{ key: 'rx', color: '#0ea5e9' }, { key: 'tx', color: '#a855f7' }]}
            />
          </div>

          {isGpu && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {(detail?.gpus || []).map((card) => (
                  <div key={card.index} className="rounded-2xl border border-slate-100 bg-white px-3.5 py-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[11px] font-black text-slate-700">
                        <Zap size={11} className="text-purple-500" /> GPU {card.index}
                      </span>
                      <span className="text-[10px] font-bold text-slate-400 truncate max-w-[7rem]" title={card.modelName}>{card.modelName || ''}</span>
                    </div>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-base font-black text-slate-900 tabular-nums">{formatPercent(card.utilization)}</span>
                      <span className="text-[10px] font-bold text-slate-400">利用率</span>
                    </div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full rounded-full bg-purple-400" style={{ width: `${Math.min(100, Math.max(0, card.utilization || 0))}%` }} />
                    </div>
                    <div className="mt-1.5 text-[10px] font-bold text-slate-400 tabular-nums">
                      显存 {formatBytes(card.memoryUsedBytes)} / {formatBytes(card.memoryTotalBytes)}
                    </div>
                    <div className="mt-0.5 text-[10px] font-bold text-slate-400 tabular-nums">
                      {card.temperature !== undefined ? `${card.temperature.toFixed(0)}°C` : '—'}
                      {card.powerWatts !== undefined ? ` · ${card.powerWatts.toFixed(0)} W` : ''}
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <MetricChart
                  title="GPU 利用率"
                  icon={<Zap size={11} />}
                  data={detail?.gpuUtilSeries || []}
                  dataKey="gpu0"
                  color="#8b5cf6"
                  unit="%"
                  formatter={(value) => `${Math.round(value)}%`}
                  lines={gpuLines}
                />
                <MetricChart
                  title="GPU 显存占用"
                  icon={<MemoryStick size={11} />}
                  data={detail?.gpuMemSeries || []}
                  dataKey="gpu0"
                  color="#a855f7"
                  unit="B"
                  formatter={(value) => formatBytes(value, 1)}
                  lines={gpuLines}
                />
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-slate-100 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-slate-500">
                <Server size={12} /> 运行中的作业
              </div>
              <span className="text-[10px] font-black text-slate-400">{(detail?.jobs || []).length} 个</span>
            </div>
            {(detail?.jobs || []).length === 0 ? (
              <p className="py-8 text-center text-[11px] font-bold text-slate-300">该节点当前没有运行中的作业</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50/60 text-[10px] font-black uppercase tracking-wider text-slate-400">
                      <th className="px-4 py-2.5">作业</th>
                      <th className="px-3 py-2.5">用户</th>
                      <th className="px-3 py-2.5 text-right">CPU 实际</th>
                      <th className="px-3 py-2.5 text-right">内存</th>
                      <th className="px-3 py-2.5 text-right">GPU</th>
                      <th className="px-3 py-2.5 text-right">GPU 利用率</th>
                      <th className="px-3 py-2.5 text-right">运行时长</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {(detail?.jobs || []).map((job) => (
                      <tr key={job.jobId} className="border-t border-slate-50 hover:bg-slate-50/60">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-black text-slate-900">{job.jobId}</span>
                            <span className="font-bold text-slate-600 truncate max-w-[12rem]" title={job.name}>{job.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-bold text-slate-500">{job.user}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-slate-700">
                          {job.cpuCores !== null ? `${job.cpuCores.toFixed(1)} / ${job.cpus ?? '—'}` : `— / ${job.cpus ?? '—'}`}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-slate-700">{formatBytes(job.memoryBytes)}</td>
                        <td className="px-3 py-2 text-right">
                          {job.gpus > 0 ? (
                            <span className="font-mono text-[11px] font-black text-violet-700" title={job.gpuCards.join(', ')}>
                              {job.gpuCards.length > 0 ? job.gpuCards.join(',') : job.gpus}
                              {job.gpuMemoryBytes ? ` · ${formatBytes(job.gpuMemoryBytes)}` : ''}
                            </span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-slate-700">{formatPercent(job.gpuUtilization)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500">{job.runtime || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {detail?.source && (
            <p className="text-[10px] font-bold text-slate-300 text-center">
              数据源：{detail.source} · 采集间隔 {detail.step}s
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default NodeDetailModal;
