
import React, { useCallback, useEffect, useState } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts';
import { Activity, Cpu, HardDrive, Zap, RefreshCw } from 'lucide-react';
import { slurmService, JobUsage } from '../services/slurmService.ts';

interface JobUsagePanelProps {
  jobId: string;
  requestedGpus?: number;
  refreshMs?: number;
}

const RANGES = [
  { label: '1H', seconds: 3600 },
  { label: '6H', seconds: 6 * 3600 },
  { label: '24H', seconds: 24 * 3600 },
];

// Compact axis labels: the panel is narrow and "60.00 GB" wraps inside the Y axis.
const formatBytesCompact = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes === 0) return '0';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)}G`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}M`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}K`;
  return String(bytes);
};

// Decimal units (1 GB = 1e9 B) so the numbers line up with the Grafana memory panel.
const formatBytes = (bytes: number | null) => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
};

const formatCores = (value: number | null) => (value === null || value === undefined ? '—' : value.toFixed(1));
const formatPercent = (value: number | null) => (value === null || value === undefined ? '—' : `${value.toFixed(1)}%`);

const GPU_COLORS = ['#34d399', '#f472b6', '#fbbf24', '#60a5fa', '#c084fc', '#f87171', '#2dd4bf', '#a3e635'];

const chartTime = (ts: number) => {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const JobUsagePanel: React.FC<JobUsagePanelProps> = ({ jobId, requestedGpus = 0, refreshMs = 10000 }) => {
  const [rangeSeconds, setRangeSeconds] = useState(3600);
  const [usage, setUsage] = useState<JobUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await slurmService.fetchJobUsage(jobId, rangeSeconds);
      setUsage(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || '读取资源使用数据失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [jobId, rangeSeconds]);

  useEffect(() => {
    setUsage(null);
    setError(null);
    load();
    const timer = setInterval(() => load(true), refreshMs);
    return () => clearInterval(timer);
  }, [load, refreshMs]);

  const cpu = usage?.cpu;
  const memory = usage?.memory;
  const gpus = usage?.gpus || [];
  const gpuDevices = usage?.gpuDevices || [];
  const gpuUtilSeries = usage?.gpuUtilSeries || [];
  const gpuMemorySeries = usage?.gpuMemorySeries || [];
  const hasGpuSeries = gpuDevices.length > 0 && gpuUtilSeries.length > 0;
  const hasGpuMemorySeries = gpuMemorySeries.some((row) => gpuDevices.some((device) => row[`${device.key}m`] !== null && row[`${device.key}m`] !== undefined));
  const series = usage?.series || [];
  const hasCpuSeries = series.some((point) => point.cpuCores !== null);
  const hasMemorySeries = series.some((point) => point.memoryBytes !== null);

  const cpuPercent = cpu?.current !== null && cpu?.current !== undefined && cpu?.allocated
    ? (cpu.current / cpu.allocated) * 100
    : null;
  const memoryPercent = memory?.peak !== null && memory?.peak !== undefined && memory?.requestedBytes
    ? (memory.peak / memory.requestedBytes) * 100
    : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-slate-950">
      <div className="px-4 py-2 flex items-center gap-2 border-b border-slate-800 shrink-0">
        <Activity size={12} className="text-slate-500" />
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">时间范围</span>
        <div className="flex bg-slate-900 rounded-lg p-0.5">
          {RANGES.map((range) => (
            <button
              key={range.seconds}
              onClick={() => setRangeSeconds(range.seconds)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-black transition-all ${rangeSeconds === range.seconds ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {range.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 text-slate-300 text-[10px] font-black hover:bg-slate-700 disabled:opacity-60"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {error && (
          <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] font-bold text-rose-300">
            读取失败：{error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-3">
            <div className="flex items-center gap-1.5 text-slate-500">
              <Cpu size={11} />
              <span className="text-[9px] font-black uppercase tracking-widest">CPU</span>
            </div>
            <p className="mt-1.5 text-lg font-black text-slate-100 leading-none">
              {formatCores(cpu?.current ?? null)}
              <span className="text-[10px] font-bold text-slate-500 ml-1">/ {cpu?.allocated ?? '—'} 核</span>
            </p>
            <p className="mt-1 text-[10px] font-bold text-slate-500">
              均值 {formatCores(cpu?.average ?? null)} · 峰值 {formatCores(cpu?.peak ?? null)}
            </p>
            <p className={`mt-0.5 text-[10px] font-black ${cpuPercent !== null && cpuPercent > 75 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {formatPercent(cpuPercent)} 的实际占用率
            </p>
          </div>

          <div className="rounded-xl bg-slate-900 border border-slate-800 p-3">
            <div className="flex items-center gap-1.5 text-slate-500">
              <HardDrive size={11} />
              <span className="text-[9px] font-black uppercase tracking-widest">内存</span>
            </div>
            <p className="mt-1.5 text-lg font-black text-slate-100 leading-none">
              {formatBytes(memory?.peak ?? null)}
              <span className="text-[10px] font-bold text-slate-500 ml-1">峰值</span>
            </p>
            <p className="mt-1 text-[10px] font-bold text-slate-500">
              申请 {formatBytes(memory?.requestedBytes ?? null)}
            </p>
            <p className="mt-0.5 text-[10px] font-black text-sky-400">
              用掉申请的 {formatPercent(memoryPercent)}
            </p>
          </div>
        </div>

        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1.5">CPU 实际使用（核）</p>
          <div className="h-32 w-full">
            {hasCpuSeries ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
                  <defs>
                    <linearGradient id="jobCpuFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                  <XAxis dataKey="ts" tickFormatter={chartTime} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={40} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip
                    labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                    formatter={(value: any) => [`${Number(value).toFixed(1)} 核`, '实际']}
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, fontSize: 11 }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  {cpu?.allocated ? <ReferenceLine y={cpu.allocated} stroke="#475569" strokeDasharray="5 4" /> : null}
                  <Area type="monotone" dataKey="cpuCores" stroke="#38bdf8" strokeWidth={1.8} fill="url(#jobCpuFill)" isAnimationActive={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[10px] font-bold text-slate-600">暂无 CPU 采样数据</div>
            )}
          </div>
        </div>

        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1.5">内存实际使用</p>
          <div className="h-32 w-full">
            {hasMemorySeries ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 6, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="jobMemFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                  <XAxis dataKey="ts" tickFormatter={chartTime} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={40} />
                  <YAxis tickFormatter={(value) => formatBytesCompact(Number(value))} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip
                    labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                    formatter={(value: any) => [formatBytes(Number(value)), '实际']}
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, fontSize: 11 }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Area type="monotone" dataKey="memoryBytes" stroke="#a78bfa" strokeWidth={1.8} fill="url(#jobMemFill)" isAnimationActive={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[10px] font-bold text-slate-600">暂无内存采样数据</div>
            )}
          </div>
        </div>

        {(gpus.length > 0 || requestedGpus > 0) && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Zap size={11} className="text-slate-500" />
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">
                GPU（设备利用率）{requestedGpus > 0 ? `· 监控映射 ${gpus.length} / 申请 ${requestedGpus}` : ''}
              </p>
            </div>
            {gpus.length === 0 && (
              <p className="text-[10px] font-bold text-slate-500 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-2">
                监控数据中未找到该作业的 GPU 映射（作业可能刚启动，或该节点的 GPU 未上报作业归属）。
              </p>
            )}
            <div className="space-y-1">
              {gpus.map((gpu) => (
                <div key={`${gpu.hostname}-${gpu.gpu}`} className="flex items-center justify-between rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1.5">
                  <span className="text-[10px] font-mono font-bold text-slate-300">{gpu.hostname} / GPU {gpu.gpu}</span>
                  <span className="flex items-center gap-3 text-[10px] font-black">
                    <span className="text-emerald-400">{formatPercent(gpu.utilization)}</span>
                    <span className="text-slate-500">{formatBytes(gpu.memoryBytes)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasGpuSeries && (
          <>
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Zap size={11} className="text-slate-500" />
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">GPU 利用率曲线</p>
              </div>
              <div className="h-32 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={gpuUtilSeries} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                    <XAxis dataKey="ts" tickFormatter={chartTime} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={40} />
                    <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip
                      labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                      formatter={(value: any, name: any) => [`${Number(value).toFixed(0)}%`, name]}
                      contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, fontSize: 11 }}
                      labelStyle={{ color: '#94a3b8' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 9 }} />
                    {gpuDevices.map((device, index) => (
                      <Line key={device.key} type="monotone" dataKey={device.key} name={device.label} stroke={GPU_COLORS[index % GPU_COLORS.length]} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Zap size={11} className="text-slate-500" />
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">GPU 显存曲线（作业占用）</p>
              </div>
              <div className="h-32 w-full">
                {hasGpuMemorySeries ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={gpuMemorySeries} margin={{ top: 4, right: 6, left: 2, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                      <XAxis dataKey="ts" tickFormatter={chartTime} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={40} />
                      <YAxis tickFormatter={(value) => formatBytesCompact(Number(value))} tick={{ fill: '#64748b', fontSize: 9 }} axisLine={false} tickLine={false} width={44} />
                      <Tooltip
                        labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                        formatter={(value: any, name: any) => [formatBytes(Number(value)), name]}
                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, fontSize: 11 }}
                        labelStyle={{ color: '#94a3b8' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 9 }} />
                      {gpuDevices.map((device, index) => (
                        <Line key={device.key} type="monotone" dataKey={`${device.key}m`} name={device.label} stroke={GPU_COLORS[index % GPU_COLORS.length]} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-[10px] font-bold text-slate-600">暂无显存采样数据</div>
                )}
              </div>
            </div>
          </>
        )}

        <p className="text-[9px] font-bold text-slate-600 leading-relaxed pt-1">
          CPU 由 cgroup 累计时间换算为核数，内存为 cgroup 实际占用；申请值来自 Slurm 请求。GPU 利用率为整卡设备指标，显存为作业级统计。数据每 10 秒刷新。
        </p>
      </div>
    </div>
  );
};

export default JobUsagePanel;
