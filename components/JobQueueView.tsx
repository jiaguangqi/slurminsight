
import React, { useState, useMemo } from 'react';
import { JobInfo, JobState } from '../types';
import { Search, Hash, User, Layers, PlayCircle, Clock, AlertCircle, Eye, X, Terminal, MapPin, Box, Calendar } from 'lucide-react';

interface JobQueueViewProps {
  jobs: JobInfo[];
}

type SortBy = 'jobId' | 'priority' | 'time';
type GroupBy = 'all' | 'partition' | 'user';

const STATE_COLORS: Record<JobState, string> = {
  RUNNING: 'text-emerald-600 bg-emerald-50 border-emerald-100',
  PENDING: 'text-amber-600 bg-amber-50 border-amber-100',
  COMPLETING: 'text-blue-600 bg-blue-50 border-blue-100',
  CONFIGURING: 'text-slate-400 bg-slate-50 border-slate-100',
  SUSPENDED: 'text-rose-600 bg-rose-50 border-rose-100'
};

const JobQueueView: React.FC<JobQueueViewProps> = ({ jobs }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [groupBy, setGroupBy] = useState<GroupBy>('all');
  const [sortBy, setSortBy] = useState<SortBy>('jobId');
  const [selectedJob, setSelectedJob] = useState<JobInfo | null>(null);

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
  }, [filteredJobs, groupBy, sortBy]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-24 relative">
      {/* Controls */}
      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
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
                    statusFilter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Group By</span>
              <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
                {(['all', 'partition', 'user'] as GroupBy[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGroupBy(g)}
                    className={`px-4 py-1.5 text-xs font-black rounded-lg transition-all capitalize ${
                      groupBy === g ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Sort By</span>
              <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
                {(['jobId', 'priority'] as SortBy[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSortBy(s)}
                    className={`px-4 py-1.5 text-xs font-black rounded-lg transition-all ${
                      sortBy === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {s === 'jobId' ? 'ID' : 'PRI'}
                  </button>
                ))}
              </div>
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
              <table className="w-full text-left border-collapse table-fixed min-w-[1200px] text-sm">
                <thead>
                  <tr className="bg-slate-50/30">
                    <th className="w-24 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider">JOBID</th>
                    <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider">NAME</th>
                    <th className="w-32 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider">PRIORITY</th>
                    <th className="w-40 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider">USER</th>
                    <th className="w-40 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider">PARTITION</th>
                    <th className="w-28 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider">STATE</th>
                    <th className="w-20 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider text-right">CPUS</th>
                    <th className="w-20 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider text-right">GPUS</th>
                    <th className="w-56 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider">NODELIST</th>
                    <th className="w-20 px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-wider text-center">ACTION</th>
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
                        <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-black border ${STATE_COLORS[job.state]}`}>
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
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
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
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-300 border border-slate-200">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-2xl ${selectedJob.state === 'RUNNING' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}`}>
                   <Terminal size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-900 tracking-tight">Job Details | 作业详情</h2>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">JobID: {selectedJob.jobId}</p>
                </div>
              </div>
              <button 
                onClick={() => setSelectedJob(null)}
                className="p-2 hover:bg-slate-200 rounded-xl transition-all text-slate-400 hover:text-slate-900"
              >
                <X size={24} />
              </button>
            </div>

            <div className="p-8 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
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
            </div>

            <div className="px-8 py-5 bg-slate-900 flex justify-end">
              <button 
                onClick={() => setSelectedJob(null)}
                className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-xs font-black transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const DetailRow: React.FC<{ label: string; value: string; isFullWidth?: boolean; isStatus?: boolean; status?: JobState; isCode?: boolean }> = ({ label, value, isFullWidth, isStatus, status, isCode }) => (
  <div className={`${isFullWidth ? 'col-span-full' : ''} flex flex-col gap-1`}>
    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}：</span>
    {isStatus && status ? (
      <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-black border w-fit ${STATE_COLORS[status]}`}>
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
