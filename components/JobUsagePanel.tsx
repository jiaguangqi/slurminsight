
import React, { useCallback, useEffect, useState } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts';
import { Activity, Cpu, HardDrive, Zap, RefreshCw, Network, Cable, MemoryStick, Gauge } from 'lucide-react';
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

// 网络速率：作业面板看的是瞬时吞吐，统一走 B/s 的紧凑写法
const formatRate = (bytesPerSecond: number | null) => {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 ** 2) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  if (bytesPerSecond < 1024 ** 3) return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`;
  return `${(bytesPerSecond / 1024 ** 3).toFixed(2)} GB/s`;
};

const StatBox: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: string;
  lines: string[];
}> = ({ icon, label, value, tone, lines }) => (
  <div className="rounded-xl bg-white border border-slate-100 p-3">
    <div className="flex items-center gap-1.5 text-slate-500">
      {icon}
      <span className="text-[9px] font-black uppercase tracking-widest">{label}</span>
    </div>
    <p className={`mt-1.5 text-lg font-black leading-none tabular-nums ${tone || 'text-slate-900'}`}>{value}</p>
    {lines.filter(Boolean).map((line) => (
      <p key={line} className="mt-1 text-[10px] font-bold text-slate-500 tabular-nums truncate" title={line}>{line}</p>
    ))}
  </div>
);
const formatPercent = (value: number | null) => (value === null || value === undefined ? '—' : `${value.toFixed(1)}%`);

// 浅色主题下的曲线配色：比深色底时各暗一档，保证白底上的对比度
// 统一图表外壳：标题 + 固定高度容器，无数据时给占位文案
const ChartBlock: React.FC<{
  title: string;
  hasData: boolean;
  empty: string;
  height?: string;
  children: React.ReactElement;
}> = ({ title, hasData, empty, height = 'h-36', children }) => (
  <div>
    <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-1.5">{title}</p>
    <div className={`${height} w-full`}>
      {hasData ? (
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      ) : (
        <div className="h-full flex items-center justify-center text-[10px] font-bold text-slate-500">{empty}</div>
      )}
    </div>
  </div>
);

const GPU_COLORS = ['#10b981', '#ec4899', '#f59e0b', '#3b82f6', '#a855f7', '#ef4444', '#14b8a6', '#84cc16'];

const TOOLTIP_STYLE = { backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 11 };
const TOOLTIP_LABEL_STYLE = { color: '#475569' };
const AXIS_TICK = { fill: '#475569', fontSize: 9 };

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
  const gpuMemoryPctSeries = usage?.gpuMemoryPctSeries || [];
  const hasGpuMemorySeries = gpuMemorySeries.some((row) => gpuDevices.some((device) => row[`${device.key}m`] !== null && row[`${device.key}m`] !== undefined));
  const hasGpuMemoryPctSeries = gpuMemoryPctSeries.some((row) => gpuDevices.some((device) => row[`${device.key}mp`] !== null && row[`${device.key}mp`] !== undefined));
  const series = usage?.series || [];
  const network = usage?.network;
  const hasCpuSeries = series.some((point) => point.cpuCores !== null);
  const hasMemorySeries = series.some((point) => point.memoryBytes !== null);
  const hasEthSeries = series.some((point) => point.ethRx !== null || point.ethTx !== null);
  const hasIbSeries = series.some((point) => point.ibRx !== null || point.ibTx !== null);

  // 把"实际用量"折成利用率百分比，供曲线纵轴直接读成 %（申请值作为 100% 基准）
  const allocatedCpus = cpu?.allocated ?? null;
  const requestedMem = memory?.requestedBytes ?? null;
  const pctSeries = series.map((point) => ({
    ...point,
    cpuPct: point.cpuCores !== null && allocatedCpus ? (point.cpuCores / allocatedCpus) * 100 : null,
    memPct: point.memoryBytes !== null && requestedMem ? (point.memoryBytes / requestedMem) * 100 : null,
  }));
  const hasCpuPctSeries = pctSeries.some((point) => point.cpuPct !== null);
  const hasMemPctSeries = pctSeries.some((point) => point.memPct !== null);
  const lastOf = (key: 'ethRx' | 'ethTx' | 'ibRx' | 'ibTx') => {
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const value = series[i][key];
      if (value !== null && value !== undefined) return value;
    }
    return null;
  };
  const sumOf = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

  // GPU 汇总：利用率取各卡均值，显存利用率按"已用 / 总显存"求，避免单卡口径偏差
  const gpuSummary = (() => {
    const utils = gpus.map((gpu) => gpu.utilization).filter((v): v is number => v !== null && v !== undefined);
    const memTotals = gpus.map((gpu) => gpu.memoryTotalBytes).filter((v): v is number => v !== null && v !== undefined);
    const memUsedSum = gpus.reduce((sum, gpu) => sum + (gpu.memoryBytes ?? 0), 0);
    const memTotalSum = memTotals.reduce((sum, v) => sum + v, 0);
    return {
      util: utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null,
      memPct: memTotalSum > 0 ? (memUsedSum / memTotalSum) * 100 : null,
      memUsed: memUsedSum || null,
      memTotal: memTotalSum || null,
      model: gpus.length > 0 ? `${gpus.length} 卡` : null,
    };
  })();

  const cpuPercent = cpu?.current !== null && cpu?.current !== undefined && cpu?.allocated
    ? (cpu.current / cpu.allocated) * 100
    : null;
  const memoryPercent = memory?.peak !== null && memory?.peak !== undefined && memory?.requestedBytes
    ? (memory.peak / memory.requestedBytes) * 100
    : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2 flex items-center gap-2 border-b border-slate-200 shrink-0">
        <Activity size={12} className="text-slate-500" />
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">时间范围</span>
        <div className="flex bg-slate-100 rounded-lg p-0.5">
          {RANGES.map((range) => (
            <button
              key={range.seconds}
              onClick={() => setRangeSeconds(range.seconds)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-black transition-all ${rangeSeconds === range.seconds ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {range.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-white border border-slate-200 text-slate-600 text-[10px] font-black hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {error && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-[11px] font-bold text-rose-700">
            读取失败：{error}
          </div>
        )}

        <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
          <StatBox
            icon={<Cpu size={11} />}
            label="CPU 利用率"
            value={formatPercent(cpuPercent)}
            tone={cpuPercent !== null && cpuPercent > 75 ? 'text-emerald-600' : 'text-amber-600'}
            lines={[
              `实际 ${formatCores(cpu?.current ?? null)} / 申请 ${cpu?.allocated ?? '—'} 核`,
              `均值 ${formatCores(cpu?.average ?? null)} · 峰值 ${formatCores(cpu?.peak ?? null)}`,
            ]}
          />
          <StatBox
            icon={<HardDrive size={11} />}
            label="内存利用率"
            value={formatPercent(memoryPercent)}
            tone="text-blue-600"
            lines={[
              `峰值 ${formatBytes(memory?.peak ?? null)} / 申请 ${formatBytes(memory?.requestedBytes ?? null)}`,
              `均值 ${formatBytes(memory?.average ?? null)}`,
            ]}
          />
          <StatBox
            icon={<Network size={11} />}
            label="以太网 IO"
            value={hasEthSeries ? formatRate(sumOf(lastOf('ethRx'), lastOf('ethTx'))) : '—'}
            tone={hasEthSeries ? 'text-sky-600' : 'text-slate-400'}
            lines={[
              `下行 ${formatRate(lastOf('ethRx'))} · 上行 ${formatRate(lastOf('ethTx'))}`,
              network ? `节点级 · ${network.nodes.length} 个节点合计` : '节点级',
            ]}
          />
          <StatBox
            icon={<Cable size={11} />}
            label="IB 网络 IO"
            value={hasIbSeries ? formatRate(sumOf(lastOf('ibRx'), lastOf('ibTx'))) : '—'}
            tone={hasIbSeries ? 'text-violet-600' : 'text-slate-400'}
            lines={[
              `下行 ${formatRate(lastOf('ibRx'))} · 上行 ${formatRate(lastOf('ibTx'))}`,
              hasIbSeries ? '节点级 · 含 ib* / ibp* HCA 口' : '该节点未上报 IB 网卡',
            ]}
          />
          {gpus.length > 0 || requestedGpus > 0 ? (
            <StatBox
              icon={<Zap size={11} />}
              label="GPU 利用率"
              value={formatPercent(gpuSummary.util)}
              tone="text-emerald-600"
              lines={[
                `${gpus.length} 卡监控映射 / 申请 ${requestedGpus || gpus.length} 卡`,
                'DCGM 设备利用率（整卡）',
              ]}
            />
          ) : null}
          {gpus.length > 0 || requestedGpus > 0 ? (
            <StatBox
              icon={<MemoryStick size={11} />}
              label="GPU 显存利用率"
              value={formatPercent(gpuSummary.memPct)}
              tone="text-fuchsia-600"
              lines={[
                `已用 ${formatBytes(gpuSummary.memUsed)} / 共 ${formatBytes(gpuSummary.memTotal)}`,
                'FB_USED / (FB_USED + FB_FREE)',
              ]}
            />
          ) : null}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-3">
          <ChartBlock title="CPU 利用率" hasData={hasCpuPctSeries} empty="暂无 CPU 采样数据">
            <AreaChart data={pctSeries} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="jobCpuPctFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="ts" tickFormatter={chartTime} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis tickFormatter={(value) => `${Math.round(Number(value))}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                formatter={(value: any, _name: any, item: any) => [`${Number(value).toFixed(1)}%（${formatCores(item?.payload?.cpuCores ?? null)} 核）`, 'CPU']}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
              />
              <ReferenceLine y={100} stroke="#94a3b8" strokeDasharray="5 4" />
              <Area type="monotone" dataKey="cpuPct" stroke="#0ea5e9" strokeWidth={1.8} fill="url(#jobCpuPctFill)" isAnimationActive={false} connectNulls />
            </AreaChart>
          </ChartBlock>

          <ChartBlock title="内存利用率" hasData={hasMemPctSeries} empty="暂无内存采样数据">
            <AreaChart data={pctSeries} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="jobMemPctFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="ts" tickFormatter={chartTime} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis tickFormatter={(value) => `${Math.round(Number(value))}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                formatter={(value: any, _name: any, item: any) => [`${Number(value).toFixed(1)}%（${formatBytes(item?.payload?.memoryBytes ?? null)}）`, '内存']}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
              />
              <ReferenceLine y={100} stroke="#94a3b8" strokeDasharray="5 4" />
              <Area type="monotone" dataKey="memPct" stroke="#8b5cf6" strokeWidth={1.8} fill="url(#jobMemPctFill)" isAnimationActive={false} connectNulls />
            </AreaChart>
          </ChartBlock>

          <ChartBlock title={`以太网网络 IO${network && network.nodes.length > 1 ? `（${network.nodes.length} 节点合计）` : '（节点级）'}`} hasData={hasEthSeries} empty="该节点未上报以太网流量">
            <LineChart data={series} margin={{ top: 4, right: 6, left: 2, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="ts" tickFormatter={chartTime} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis tickFormatter={(value) => `${formatBytesCompact(Number(value))}/s`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                formatter={(value: any, name: any) => [formatRate(Number(value)), name]}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
              />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              <Line type="monotone" dataKey="ethRx" name="下行" stroke="#0ea5e9" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="ethTx" name="上行" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ChartBlock>

          <ChartBlock title={`IB 网络 IO${network && network.nodes.length > 1 ? `（${network.nodes.length} 节点合计）` : '（节点级）'}`} hasData={hasIbSeries} empty="该节点未上报 IB 网卡流量">
            <LineChart data={series} margin={{ top: 4, right: 6, left: 2, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="ts" tickFormatter={chartTime} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis tickFormatter={(value) => `${formatBytesCompact(Number(value))}/s`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                formatter={(value: any, name: any) => [formatRate(Number(value)), name]}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
              />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              <Line type="monotone" dataKey="ibRx" name="下行" stroke="#8b5cf6" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="ibTx" name="上行" stroke="#14b8a6" strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ChartBlock>
        </div>

        {(gpus.length > 0 || requestedGpus > 0) && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Zap size={11} className="text-slate-500" />
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-600">
                GPU（设备利用率）{requestedGpus > 0 ? `· 监控映射 ${gpus.length} / 申请 ${requestedGpus}` : ''}
              </p>
            </div>
            {gpus.length === 0 && (
              <p className="text-[10px] font-bold text-slate-500 bg-white border border-slate-200 rounded-lg px-2.5 py-2">
                监控数据中未找到该作业的 GPU 映射（作业可能刚启动，或该节点的 GPU 未上报作业归属）。
              </p>
            )}
            <div className="space-y-1">
              {gpus.map((gpu) => (
                <div key={`${gpu.hostname}-${gpu.gpu}`} className="flex items-center justify-between rounded-lg bg-white border border-slate-100 px-2.5 py-1.5">
                  <span className="text-[10px] font-mono font-bold text-slate-700">{gpu.hostname} / GPU {gpu.gpu}</span>
                  <span className="flex items-center gap-3 text-[10px] font-black">
                    <span className="text-emerald-600">{formatPercent(gpu.utilization)}</span>
                    <span className="text-slate-500">{formatBytes(gpu.memoryBytes)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasGpuSeries && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-3">
            <ChartBlock title="GPU 利用率" hasData={hasGpuSeries} empty="暂无 GPU 采样数据">
              <LineChart data={gpuUtilSeries} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="ts" tickFormatter={chartTime} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={40} />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                  formatter={(value: any, name: any) => [`${Number(value).toFixed(0)}%`, name]}
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                />
                <Legend wrapperStyle={{ fontSize: 9 }} />
                {gpuDevices.map((device, index) => (
                  <Line key={device.key} type="monotone" dataKey={device.key} name={device.label} stroke={GPU_COLORS[index % GPU_COLORS.length]} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ChartBlock>

            <ChartBlock title="GPU 显存利用率" hasData={hasGpuMemoryPctSeries} empty="暂无显存采样数据">
              <LineChart data={gpuMemoryPctSeries} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="ts" tickFormatter={chartTime} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={40} />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                  formatter={(value: any, name: any) => [`${Number(value).toFixed(0)}%`, name]}
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                />
                <Legend wrapperStyle={{ fontSize: 9 }} />
                {gpuDevices.map((device, index) => (
                  <Line key={device.key} type="monotone" dataKey={`${device.key}mp`} name={device.label} stroke={GPU_COLORS[index % GPU_COLORS.length]} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ChartBlock>
          </div>
        )}

        {gpuDevices.length > 0 && hasGpuMemorySeries && (
          <ChartBlock title="GPU 显存占用（作业实际用量）" hasData={hasGpuMemorySeries} empty="暂无显存采样数据" height="h-28">
            <LineChart data={gpuMemorySeries} margin={{ top: 4, right: 6, left: 2, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="ts" tickFormatter={chartTime} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis tickFormatter={(value) => formatBytesCompact(Number(value))} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
              <Tooltip
                labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                formatter={(value: any, name: any) => [formatBytes(Number(value)), name]}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
              />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              {gpuDevices.map((device, index) => (
                <Line key={device.key} type="monotone" dataKey={`${device.key}m`} name={device.label} stroke={GPU_COLORS[index % GPU_COLORS.length]} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ChartBlock>
        )}

        <p className="text-[9px] font-bold text-slate-500 leading-relaxed pt-1">
          CPU / 内存利用率 = 实际 ÷ 申请（cgroup 指标）。网络 IO 取自作业所在节点的 node_exporter 网卡计数器，
          按设备名区分以太网（enp/eno/ens…）与 IB（ib0/ib1…）——cgroup 不提供作业级网络计数，故为<b>节点级</b>参考值，
          多节点作业为各节点之和。GPU 利用率与显存利用率来自 DCGM 设备指标，显存占用曲线为作业级统计。数据每 10 秒刷新。
        </p>
      </div>
    </div>
  );
};

export default JobUsagePanel;
