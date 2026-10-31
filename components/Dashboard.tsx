
import React, { useMemo, useState } from 'react';
import { PartitionStats, ResourceType, JobInfo } from '../types';
import StatCard from './StatCard.tsx';
import PartitionNodesModal from './PartitionNodesModal.tsx';
import { AlertCircle, Cpu, Zap, RefreshCw, Clock, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

interface DashboardProps {
  stats: PartitionStats[];
  jobs: JobInfo[];
  onRefresh: () => void;
  isSyncing: boolean;
  lastSync: Date;
}

const Dashboard: React.FC<DashboardProps> = ({ stats, jobs, onRefresh, isSyncing, lastSync }) => {
  const cpuPartitions = stats.filter(s => s.type === ResourceType.CPU);
  const gpuPartitions = stats.filter(s => s.type === ResourceType.GPU);

  const totalCpus = cpuPartitions.reduce((acc, curr) => acc + curr.total, 0);
  const usedCpus = cpuPartitions.reduce((acc, curr) => acc + curr.allocated, 0);
  const pendingCpus = cpuPartitions.reduce((acc, curr) => acc + curr.pending, 0);

  const totalGpus = gpuPartitions.reduce((acc, curr) => acc + curr.total, 0);
  const usedGpus = gpuPartitions.reduce((acc, curr) => acc + curr.allocated, 0);
  const pendingGpus = gpuPartitions.reduce((acc, curr) => acc + curr.pending, 0);

  const cpuUtil = totalCpus > 0 ? (usedCpus / totalCpus) * 100 : 0;
  const gpuUtil = totalGpus > 0 ? (usedGpus / totalGpus) * 100 : 0;

  const [pendingPartition, setPendingPartition] = useState<string | null>(null);
  const [nodesPartition, setNodesPartition] = useState<PartitionStats | null>(null);
  const [prioritySort, setPrioritySort] = useState<'queue' | 'desc' | 'asc'>('queue');

  const pendingJobsForPartition = useMemo(() => {
    if (!pendingPartition) return [];
    const list = jobs.filter(j => j.partition === pendingPartition && j.state === 'PENDING');
    if (prioritySort === 'queue') return list;
    const dir = prioritySort === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const diff = (Number(a.priority) || 0) - (Number(b.priority) || 0);
      if (diff !== 0) return diff * dir;
      return (Number(a.jobId) || 0) - (Number(b.jobId) || 0);
    });
  }, [jobs, pendingPartition, prioritySort]);

  const openPending = (partition: string) => {
    setPrioritySort('queue');
    setPendingPartition(partition);
  };

  const priorityText = (raw?: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return raw || '-';
    return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
  };

  const cyclePrioritySort = () => {
    setPrioritySort(prev => (prev === 'queue' ? 'desc' : prev === 'desc' ? 'asc' : 'queue'));
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight">Cluster Monitor</h2>
          <div className="flex items-center gap-2 text-slate-500 font-medium">
             <Clock size={14} />
             <span>Refreshed at {lastSync.toLocaleTimeString()}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <button 
            onClick={onRefresh}
            disabled={isSyncing}
            className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-black text-sm transition-all shadow-sm ${
              isSyncing 
              ? 'bg-slate-100 text-slate-500 cursor-not-allowed' 
              : 'bg-blue-600 text-white hover:bg-blue-700 active:scale-95 shadow-lg shadow-blue-200'
            }`}
          >
            <RefreshCw size={18} className={isSyncing ? 'animate-spin' : ''} />
            {isSyncing ? 'Syncing...' : 'Refresh Now'}
          </button>
        </div>
      </header>

      {/* Global Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm relative overflow-hidden group">
          <div className="relative z-10 flex flex-col h-full justify-between">
            <div className="flex justify-between items-start mb-8">
              <div className="p-3 bg-blue-50 text-blue-600 rounded-2xl">
                <Cpu size={28} />
              </div>
              <div className="text-right">
                <p className="text-xs font-bold text-slate-600 uppercase tracking-widest">CPU Pool Utilization</p>
                <p className="text-4xl font-black text-slate-900">{cpuUtil.toFixed(1)}%</p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between text-sm font-bold">
                <span className="text-slate-500">Resource Load</span>
                <span className="text-blue-600">{usedCpus.toLocaleString()} / {totalCpus.toLocaleString()} Cores</span>
              </div>
              <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 transition-all duration-1000" style={{ width: `${cpuUtil}%` }}></div>
              </div>
              <div className="flex items-center gap-2 text-amber-600 text-xs font-bold pt-1">
                <AlertCircle size={14} />
                <span>{pendingCpus.toLocaleString()} cores requested in pending queue</span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm relative overflow-hidden group">
          <div className="relative z-10 flex flex-col h-full justify-between">
            <div className="flex justify-between items-start mb-8">
              <div className="p-3 bg-purple-50 text-purple-600 rounded-2xl">
                <Zap size={28} />
              </div>
              <div className="text-right">
                <p className="text-xs font-bold text-slate-600 uppercase tracking-widest">GPU Pool Utilization</p>
                <p className="text-4xl font-black text-slate-900">{gpuUtil.toFixed(1)}%</p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between text-sm font-bold">
                <span className="text-slate-500">Resource Load</span>
                <span className="text-purple-600">{usedGpus} / {totalGpus} Cards</span>
              </div>
              <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-purple-600 transition-all duration-1000" style={{ width: `${gpuUtil}%` }}></div>
              </div>
              <div className="flex items-center gap-2 text-amber-600 text-xs font-bold pt-1">
                <AlertCircle size={14} />
                <span>{pendingGpus} GPUs requested in pending queue</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-10">
        <section>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-1.5 h-6 bg-blue-600 rounded-full"></div>
              <h3 className="text-lg font-black text-slate-800 tracking-tight">CPU Partitions <span className="text-slate-500 font-medium ml-2">({cpuPartitions.length})</span></h3>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
            {cpuPartitions.map(p => (
              <StatCard key={p.name} stats={p} onPendingClick={openPending} onNodesClick={setNodesPartition} />
            ))}
          </div>
        </section>

        <section className="pb-10">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-1.5 h-6 bg-purple-600 rounded-full"></div>
              <h3 className="text-lg font-black text-slate-800 tracking-tight">GPU Partitions <span className="text-slate-500 font-medium ml-2">({gpuPartitions.length})</span></h3>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
            {gpuPartitions.map(p => (
              <StatCard key={p.name} stats={p} onPendingClick={openPending} onNodesClick={setNodesPartition} />
            ))}
          </div>
        </section>
      </div>

      {pendingPartition && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
              <div>
                <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Pending Jobs</p>
                <h3 className="text-xl font-black text-slate-900">{pendingPartition}</h3>
              </div>
              <button
                onClick={() => setPendingPartition(null)}
                className="text-slate-500 hover:text-slate-700 rounded-lg p-2 hover:bg-slate-100 transition-colors"
              >
                Close
              </button>
            </div>

            <div className="max-h-[70vh] overflow-auto">
              {pendingJobsForPartition.length === 0 ? (
                <div className="p-6 text-slate-500 text-sm">No pending jobs for this partition.</div>
              ) : (
                <table className="w-full border-collapse">
                  <thead className="bg-slate-50 text-[11px] text-slate-500 font-black uppercase tracking-widest">
                    <tr>
                      <th className="text-left px-4 py-3">JobID</th>
                      <th className="text-left px-4 py-3">Name</th>
                      <th className="text-left px-4 py-3">User</th>
                      <th className="text-right px-4 py-3">
                        <button
                          onClick={cyclePrioritySort}
                          title="按优先级排序：高 → 低 → 恢复队列顺序"
                          className={`inline-flex items-center gap-1 uppercase tracking-widest font-black transition-colors ${
                            prioritySort === 'queue' ? 'text-slate-500 hover:text-slate-800' : 'text-blue-600'
                          }`}
                        >
                          Priority
                          {prioritySort === 'desc' ? <ArrowDown size={11} /> : prioritySort === 'asc' ? <ArrowUp size={11} /> : <ArrowUpDown size={11} className="opacity-50" />}
                        </button>
                      </th>
                      <th className="text-left px-4 py-3">CPUs</th>
                      <th className="text-left px-4 py-3">GPUs</th>
                      <th className="text-left px-4 py-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm text-slate-700">
                    {pendingJobsForPartition.map(job => (
                      <tr key={job.jobId} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2 font-mono font-bold text-slate-900">{job.jobId}</td>
                        <td className="px-4 py-2 font-bold">{job.name}</td>
                        <td className="px-4 py-2">{job.user}</td>
                        <td className="px-4 py-2 text-right font-mono font-bold tabular-nums text-slate-700">
                          {priorityText(job.priority)}
                        </td>
                        <td className="px-4 py-2">{job.cpus ?? '-'}</td>
                        <td className="px-4 py-2">{job.gpus ?? 0}</td>
                        <td className="px-4 py-2 text-slate-500">{job.reason || '等待资源'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
      {nodesPartition && (
        <PartitionNodesModal partition={nodesPartition} onClose={() => setNodesPartition(null)} />
      )}
    </div>
  );
};

export default Dashboard;
