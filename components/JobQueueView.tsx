
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { JobInfo, JobState } from '../types';
import { Search, Hash, User, Layers, PlayCircle, Clock, AlertCircle, Eye, X, Terminal, MapPin, Box, Calendar, RefreshCw, FileText, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { slurmService, JobLogPayload } from '../services/slurmService.ts';
import type { JobUsageSummaryEntry } from '../services/slurmService.ts';
import JobUsagePanel from './JobUsagePanel.tsx';

interface JobQueueViewProps {
  jobs: JobInfo[];
}

type SortBy = 'jobId' | 'priority' | 'time' | 'util';
type GroupBy = 'all' | 'partition' | 'user';

const STATE_COLORS: Record<JobState, string> = {
  RUNNING: 'text-emerald-600 bg-emerald-50 border-emerald-100',
  PENDING: 'text-amber-600 bg-amber-50 border-amber-100',
  COMPLETING: 'text-blue-600 bg-blue-50 border-blue-100',
  CONFIGURING: 'text-slate-500 bg-slate-50 border-slate-100',
  SUSPENDED: 'text-rose-600 bg-rose-50 border-rose-100'
};

const stateColor = (state: JobState | string) =>
  STATE_COLORS[state as JobState] || 'text-slate-500 bg-slate-50 border-slate-200';

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const JobQueueView: React.FC<JobQueueViewProps> = ({ jobs }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [groupBy, setGroupBy] = useState<GroupBy>('all');
  const [sortBy, setSortBy] = useState<SortBy>('jobId');
  const [utilAsc, setUtilAsc] = useState(true);
  const [usage, setUsage] = useState<Record<string, JobUsageSummaryEntry>>({});
  const [usageUpdatedAt, setUsageUpdatedAt] = useState<Date | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobInfo | null>(null);
  const [jobScript, setJobScript] = useState('');
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [scriptCache, setScriptCache] = useState<Record<string, string>>({});
  const selectedJobId = selectedJob?.jobId;
  const cachedScript = selectedJobId ? scriptCache[selectedJobId] : undefined;

  // 'usage' shows live resource consumption, 'out'/'err' show job logs.
  const [panel, setPanel] = useState<'usage' | 'out' | 'err'>('usage');
  const logStream = panel === 'usage' ? null : panel;
  const [logData, setLogData] = useState<JobLogPayload | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const logRequestRef = useRef(0);

  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      const matchesSearch = 
        job.jobId.includes(searchTerm) || 
        job.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        job.user.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesStatus = statusFilter === 'ALL' || job.state === statusFilter;
      
      return matchesSearch && matchesStatus;
    });
  }, [jobs, searchTerm, statusFilter]);

  const sortedAndGrouped = useMemo(() => {
    let base = [...filteredJobs];

    base.sort((a, b) => {
      if (sortBy === 'jobId') return parseInt(b.jobId) - parseInt(a.jobId);
      if (sortBy === 'priority') return parseFloat(b.priority) - parseFloat(a.priority);
      if (sortBy === 'util') {
        const left = usage[a.jobId]?.efficiencyPct;
        const right = usage[b.jobId]?.efficiencyPct;
        const hasLeft = typeof left === 'number' && Number.isFinite(left);
        const hasRight = typeof right === 'number' && Number.isFinite(right);
        // 无用量数据（未运行或没有采集）的作业始终排在末尾
        if (!hasLeft && !hasRight) return parseInt(b.jobId) - parseInt(a.jobId);
        if (!hasLeft) return 1;
        if (!hasRight) return -1;
        return utilAsc ? left - right : right - left;
      }
      return 0;
    });

    if (groupBy === 'all') {
      return [{ id: 'global', title: 'Global Job Queue', jobs: base }];
    }

    const groups: Record<string, JobInfo[]> = {};
    base.forEach(job => {
      const key = groupBy === 'partition' ? job.partition : job.user;
      if (!groups[key]) groups[key] = [];
      groups[key].push(job);
    });

    return Object.keys(groups).sort().map(key => ({
      id: key,
      title: `${groupBy === 'partition' ? 'Partition' : 'User'}: ${key}`,
      jobs: groups[key]
    }));
  }, [filteredJobs, groupBy, sortBy, usage, utilAsc]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await slurmService.fetchJobUsageSummary();
        if (cancelled) return;
        setUsage(payload?.jobs || {});
        setUsageUpdatedAt(payload?.updatedAt ? new Date(payload.updatedAt) : new Date());
      } catch {
        if (!cancelled) setUsageUpdatedAt(null);
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!selectedJobId) {
      setJobScript('');
      setScriptError(null);
      setScriptLoading(false);
      return;
    }

    if (cachedScript !== undefined) {
      setJobScript(cachedScript);
      setScriptError(null);
      return;
    }

    setScriptLoading(true);
    setScriptError(null);
    slurmService.fetchJobScript(selectedJobId)
      .then((script) => {
        if (cancelled) return;
        setJobScript(script || '');
        setScriptCache((prev) => ({ ...prev, [selectedJobId]: script || '' }));
      })
      .catch((err: any) => {
        if (cancelled) return;
        setScriptError(err?.message || '无法获取作业脚本');
        setJobScript('');
      })
      .finally(() => {
        if (!cancelled) setScriptLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedJobId, cachedScript]);

  const loadJobLog = useCallback(async (jobId: string, stream: 'out' | 'err', silent = false) => {
    const requestId = ++logRequestRef.current;
    if (!silent) setLogLoading(true);
    try {
      const payload = await slurmService.fetchJobLog(jobId, stream);
      if (logRequestRef.current !== requestId) return;
      setLogData(payload);
      setLogError(null);
    } catch (err: any) {
      if (logRequestRef.current !== requestId) return;
      setLogError(err?.message || '读取日志失败');
    } finally {
      if (logRequestRef.current === requestId) setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    setPanel('usage');
    setLogData(null);
    setLogError(null);
    setLogLoading(false);
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedJobId || !logStream) return;
    loadJobLog(selectedJobId, logStream);
    if (!autoRefresh) return;
    const timer = setInterval(() => loadJobLog(selectedJobId, logStream, true), 5000);
    return () => clearInterval(timer);
  }, [selectedJobId, logStream, autoRefresh, loadJobLog]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logData]);

  const selectPanel = (next: 'usage' | 'out' | 'err') => {
    if (next !== panel && next !== 'usage') {
      setLogData(null);
      setLogError(null);
    }
    setPanel(next);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-24 relative">
      {/* Controls */}
      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
              <input 
                type="text" 
                placeholder="Job ID, Name, or User..."
                className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-base focus:ring-2 focus:ring-blue-500 outline-none w-64 transition-all font-medium"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
              {['ALL', 'RUNNING', 'PENDING'].map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-4 py-1.5 text-xs font-black rounded-lg transition-all ${
                    statusFilter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-600'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-black text-slate-600 uppercase tracking-widest">Group By</span>
              <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
                {(['all', 'partition', 'user'] as GroupBy[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGroupBy(g)}
                    className={`px-4 py-1.5 text-xs font-black rounded-lg transition-all capitalize ${
                      groupBy === g ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-600'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-black text-slate-600 uppercase tracking-widest">Sort By</span>
              <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
                {(['jobId', 'priority', 'util'] as SortBy[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      if (s !== 'util') { setSortBy(s); return; }
                      if (sortBy === 'util') setUtilAsc(!utilAsc);
                      else { setSortBy('util'); setUtilAsc(true); }
                    }}
                    className={`px-4 py-1.5 text-xs font-black rounded-lg transition-all ${
                      sortBy === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-600'
                    }`}
                    title={s === 'util' ? '按资源利用率排序，默认从低到高（低效作业在前）' : undefined}
                  >
                    {s === 'jobId' ? 'ID' : s === 'priority' ? 'PRI' : `利用率 ${sortBy === 'util' ? (utilAsc ? '↑' : '↓') : ''}`}
                  </button>
                ))}
              </div>
              {usageUpdatedAt && (
                <span className="text-[10px] font-bold text-slate-500">用量更新于 {usageUpdatedAt.toLocaleTimeString()}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Grouped Jobs Table */}
      <div className="space-y-6">
        {sortedAndGrouped.map((group) => (
          <div key={group.id} className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 bg-slate-50/50 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                   <div className="w-1.5 h-4 bg-blue-600 rounded-full"></div>
                   <h3 className="font-black text-sm text-slate-800 tracking-tight">{group.title}</h3>
                </div>
              <span className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-black text-slate-500 uppercase">
                {group.jobs.length} Total
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse table-fixed min-w-[1480px] text-sm">
                <thead>
                  <tr className="bg-slate-50/30">
                    <th className="w-24 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">JOBID</th>
                    <th className="px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">NAME</th>
                    <th className="w-32 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">PRIORITY</th>
                    <th className="w-40 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">USER</th>
                    <th className="w-40 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">PARTITION</th>
                    <th className="w-28 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">STATE</th>
                    <th className="w-20 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider text-right">CPUS</th>
                    <th className="w-20 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider text-right">GPUS</th>
                    <th className="w-52 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">
                      <button
                        onClick={() => {
                          if (sortBy === 'util') setUtilAsc(!utilAsc);
                          else { setSortBy('util'); setUtilAsc(true); }
                        }}
                        title="申请资源与实际使用的比值，点击切换排序方向（默认低效在前）"
                        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors ${sortBy === 'util' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
                      >
                        资源利用率
                        {sortBy === 'util' ? (utilAsc ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ArrowUpDown size={11} className="opacity-50" />}
                      </button>
                    </th>
                    <th className="w-44 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider">NODELIST</th>
                    <th className="w-20 px-6 py-4 text-xs font-black text-slate-500 uppercase tracking-wider text-center">ACTION</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {group.jobs.map((job) => (
                    <tr key={job.jobId} className="hover:bg-slate-50/80 transition-colors group">
                      <td className="px-6 py-4">
                        <span className="font-mono text-sm font-black text-slate-900">{job.jobId}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-bold text-sm text-slate-700 truncate block w-full" title={job.name}>{job.name}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-xs text-slate-500 font-bold font-mono tracking-tight">{job.priority.slice(0, 10)}</span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2 overflow-hidden">
                          <User size={12} className="text-slate-300 shrink-0" />
                          <span className="font-bold text-sm text-slate-600 truncate">{job.user}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-xs font-black text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200/50 truncate">
                          {job.partition}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-black border ${stateColor(job.state)}`}>
                          {job.state === 'RUNNING' ? <PlayCircle size={12} /> : job.state === 'PENDING' ? <Clock size={12} /> : <AlertCircle size={12} />}
                          {job.state}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="font-black text-sm text-slate-700">{job.cpus}</span>
                      </td>
                      <td className="px-6 py-4">
                        {(() => {
                          const isJupyter = (job.partition || '').toLowerCase() === 'jupyter';
                          const gpuVal = isJupyter ? (job.shards ?? job.gpus ?? 0) : (job.gpus ?? 0);
                          return (
                            <div className="flex items-center justify-end">
                              <span className="font-black text-sm text-slate-700">{gpuVal}</span>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4">
                        {(() => {
                          const entry = usage[job.jobId];
                          const pct = entry?.efficiencyPct;
                          if (!entry || pct === undefined || pct === null || !Number.isFinite(pct)) {
                            return (
                              <span
                                className="text-xs font-bold text-slate-300 cursor-help"
                                title={job.state === 'RUNNING' ? '暂无用量数据：作业可能刚启动，或所在节点未采集 cgroup 指标' : '排队中的作业没有实际用量'}
                              >
                                —
                              </span>
                            );
                          }
                          const isGpu = entry.efficiencyBasis === 'gpu';
                          const tone = pct < 20 ? 'text-rose-600' : pct < 50 ? 'text-amber-600' : 'text-emerald-600';
                          const bar = pct < 20 ? 'bg-rose-400' : pct < 50 ? 'bg-amber-400' : 'bg-emerald-400';
                          const detail = isGpu
                            ? `${entry.gpuCards} 卡${entry.gpuUtil !== null ? '' : ''}`
                            : `${entry.cpuCores !== null ? entry.cpuCores.toFixed(1) : '—'} / ${entry.requestedCpus ?? '—'} 核`;
                          const memory = entry.memoryBytes !== null
                            ? `内存 ${formatBytes(entry.memoryBytes)}${entry.requestedMemBytes ? ` / 申请 ${formatBytes(entry.requestedMemBytes)}` : ''}`
                            : '内存数据缺失';
                          return (
                            <div
                              className="min-w-0"
                              title={`${isGpu ? 'GPU 卡平均利用率' : 'CPU 核数利用率'} ${pct.toFixed(1)}%｜${detail}｜${memory}`}
                            >
                              <div className="flex items-center gap-2">
                                <span className={`text-sm font-black tabular-nums w-11 text-right ${tone}`}>
                                  {pct > 999 ? '>999' : pct.toFixed(0)}%
                                </span>
                                <div className="flex-1 min-w-[2.5rem] h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                                </div>
                              </div>
                              <div className="mt-0.5 pl-[3.25rem] text-[9px] font-bold text-slate-500 tabular-nums truncate">
                                {isGpu ? 'GPU' : 'CPU'} · {detail}
                              </div>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4">
                        {job.state === 'PENDING' ? (
                          <span className="text-xs font-bold text-amber-600 italic bg-amber-50 px-2 py-0.5 rounded">
                            ({job.reason || '等待资源'})
                          </span>
                        ) : (
                          <span className="font-mono text-sm text-slate-600 font-bold truncate">{job.nodelist}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button 
                          onClick={() => setSelectedJob(job)}
                          className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                          title="View Details"
                        >
                          <Eye size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* Detail Modal */}
      {selectedJob && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-[96rem] h-[92vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-300 border border-slate-200">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-2xl ${selectedJob.state === 'RUNNING' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}`}>
                   <Terminal size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-900 tracking-tight">Job Details | 作业详情</h2>
                  <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mt-0.5">JobID: {selectedJob.jobId}</p>
                </div>
              </div>
              <button 
                onClick={() => setSelectedJob(null)}
                className="p-2 hover:bg-slate-200 rounded-xl transition-all text-slate-500 hover:text-slate-900"
              >
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
              <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-8 flex flex-col gap-4 xl:max-w-[760px]">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6 shrink-0">
                  <DetailRow label="作业名" value={selectedJob.name} />
                  <DetailRow label="作业ID" value={selectedJob.jobId} />
                  <DetailRow label="用户名" value={selectedJob.user} />
                  <DetailRow label="作业状态" value={selectedJob.state} isStatus status={selectedJob.state} />
                  <DetailRow label="申请资源" value={selectedJob.reqTres || 'N/A'} isFullWidth />
                  <DetailRow label="运行节点" value={selectedJob.nodelist || 'Pending...'} />
                  <DetailRow label="提交时间" value={selectedJob.submitTime || 'N/A'} />
                  <DetailRow label="运行时间" value={selectedJob.time} />
                  <DetailRow label="退出时间" value={selectedJob.endTime || 'Unknown'} />
                  <DetailRow label="工作目录" value={selectedJob.workDir || 'N/A'} isFullWidth isCode />
                </div>
                <div className="space-y-2 flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between shrink-0">
                    <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest">作业脚本</span>
                    {scriptLoading && <span className="text-[11px] font-black text-blue-600">加载中...</span>}
                  </div>
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 flex-1 min-h-[10rem] overflow-y-auto">
                    {scriptError ? (
                      <span className="text-xs font-bold text-rose-600">获取失败：{scriptError}</span>
                    ) : (
                      <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-slate-700 leading-relaxed">{jobScript || '暂无脚本信息'}</pre>
                    )}
                  </div>
                </div>
              </div>

              {/* Log viewer */}
              <div className="flex flex-col flex-1 lg:flex-none min-h-0 w-full lg:w-[720px] xl:w-[820px] shrink-0 border-t lg:border-t-0 lg:border-l border-slate-200 bg-slate-50">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2 shrink-0 bg-white">
                  <FileText size={14} className="text-slate-500" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">作业监控</span>
                  <div className="ml-auto flex bg-slate-100 rounded-lg p-0.5">
                    <button
                      onClick={() => selectPanel('usage')}
                      className={`px-3 py-1 rounded-md text-[11px] font-black transition-all ${panel === 'usage' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'}`}
                    >
                      资源使用
                    </button>
                    <button
                      onClick={() => selectPanel('out')}
                      className={`px-3 py-1 rounded-md text-[11px] font-black transition-all ${panel === 'out' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800'}`}
                    >
                      输出 .out
                    </button>
                    <button
                      onClick={() => selectPanel('err')}
                      className={`px-3 py-1 rounded-md text-[11px] font-black transition-all ${panel === 'err' ? 'bg-rose-600 text-white' : 'text-slate-500 hover:text-slate-800'}`}
                    >
                      错误 .err
                    </button>
                  </div>
                </div>

                {panel === 'usage' && selectedJobId ? (
                  <JobUsagePanel jobId={selectedJobId} requestedGpus={selectedJob.gpus || 0} />
                ) : logStream ? (
                  <>
                    <div className="px-4 py-2 flex items-center gap-2 border-b border-slate-200 bg-white shrink-0">
                      <button
                        onClick={() => selectedJobId && loadJobLog(selectedJobId, logStream)}
                        disabled={logLoading}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-600 text-[11px] font-black hover:bg-slate-50 disabled:opacity-60"
                      >
                        <RefreshCw size={11} className={logLoading ? 'animate-spin' : ''} />
                        刷新
                      </button>
                      <button
                        onClick={() => setAutoRefresh((value) => !value)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-black transition-all border ${autoRefresh ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-slate-200 text-slate-500'}`}
                        title="每 5 秒自动刷新"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                        自动 5s
                      </button>
                      <span className="ml-auto text-[10px] font-mono text-slate-500">
                        {logData ? `${formatBytes(logData.size)}${logData.truncated ? ' · 尾部' : ''}` : ''}
                      </span>
                    </div>
                    <pre
                      ref={logRef}
                      className="flex-1 min-h-0 overflow-auto p-4 text-[11px] leading-relaxed font-mono text-slate-700 whitespace-pre-wrap break-words"
                    >
                      {logError
                        ? `读取失败：${logError}`
                        : logData
                          ? (logData.exists ? (logData.content || '（文件为空）') : '（日志文件尚未生成）')
                          : '加载中…'}
                    </pre>
                    <div className="px-4 py-2 border-t border-slate-200 bg-white text-[10px] font-mono text-slate-500 truncate shrink-0" title={logData?.path || ''}>
                      {logData?.path || '—'}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 px-6 text-center">
                    <Terminal size={28} className="text-slate-300" />
                    <p className="text-xs font-black text-slate-500">选择一个日志查看</p>
                    <p className="text-[10px] text-slate-500 leading-relaxed">输出日志 / 错误日志，打开后每 5 秒自动刷新，也可手动刷新。</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const DetailRow: React.FC<{ label: string; value: string; isFullWidth?: boolean; isStatus?: boolean; status?: JobState; isCode?: boolean }> = ({ label, value, isFullWidth, isStatus, status, isCode }) => (
  <div className={`${isFullWidth ? 'col-span-full' : ''} flex flex-col gap-1`}>
    <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest">{label}：</span>
    {isStatus && status ? (
      <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-black border w-fit ${stateColor(status)}`}>
        {value}
      </div>
    ) : isCode ? (
      <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 font-mono text-[11px] break-all leading-relaxed text-slate-600">
        {value}
      </div>
    ) : (
      <span className="text-sm font-bold text-slate-800 break-all">{value}</span>
    )}
  </div>
);

export default JobQueueView;
