
import React, { useState, useMemo, useEffect } from 'react';
import { PartitionStats, NodeState, NodeInfo, ResourceType, JobInfo } from '../types';
import { LayoutGrid, Layers, Box, Info, Monitor, AlertTriangle, Hash, Cpu, Zap, User, MemoryStick, HardDrive } from 'lucide-react';
import NodeDetailModal from './NodeDetailModal.tsx';
import { slurmService } from '../services/slurmService.ts';
import type { NodeMonitoringEntry } from '../services/slurmService.ts';

interface NodeHeatmapProps {
  partitions: PartitionStats[];
  jobs: JobInfo[];
}

type GroupByMode = 'partition' | 'type' | 'all' | 'cpu' | 'mem' | 'disk';

const STATE_COLORS: Record<NodeState, string> = {
  idle: 'text-emerald-400 opacity-60',
  allocated: 'text-orange-600', 
  mixed: 'text-orange-400',
  drained: 'text-slate-400',
  down: 'text-red-700',
  maint: 'text-blue-500'
};

const CONTAINER_STYLES: Record<NodeState, string> = {
  idle: 'bg-emerald-50/20 border-emerald-100/30',
  allocated: 'bg-orange-50 border-orange-200 shadow-sm',
  mixed: 'bg-orange-50/50 border-orange-100',
  drained: 'bg-slate-50 border-slate-200',
  down: 'bg-red-50 border-red-200 shadow-inner',
  maint: 'bg-blue-50 border-blue-100'
};

// 利用率热度：低 → 高的五档配色，无采集数据单独一档
const HEAT_BANDS = [
  { min: 90, tile: 'bg-rose-500/25 border-rose-300', icon: 'text-rose-700', label: '≥90%' },
  { min: 70, tile: 'bg-orange-500/20 border-orange-300', icon: 'text-orange-600', label: '70-90%' },
  { min: 40, tile: 'bg-amber-400/20 border-amber-300', icon: 'text-amber-600', label: '40-70%' },
  { min: 10, tile: 'bg-emerald-400/15 border-emerald-200', icon: 'text-emerald-600', label: '10-40%' },
  { min: -1, tile: 'bg-emerald-50 border-emerald-100', icon: 'text-emerald-500', label: '<10%' },
];

// 磁盘热度：写满才会出事（根分区满会拖垮登录与新作业），分档比 CPU/内存更靠上，
// 让「已经填得比较满」的节点也有独立一档，而不是全图一片浅绿。
const DISK_BANDS = [
  { min: 90, tile: 'bg-rose-500/25 border-rose-300', icon: 'text-rose-700', label: '≥90%' },
  { min: 70, tile: 'bg-orange-500/20 border-orange-300', icon: 'text-orange-600', label: '70-90%' },
  { min: 50, tile: 'bg-amber-400/20 border-amber-300', icon: 'text-amber-600', label: '50-70%' },
  { min: 20, tile: 'bg-emerald-400/15 border-emerald-200', icon: 'text-emerald-600', label: '20-50%' },
  { min: -1, tile: 'bg-emerald-50 border-emerald-100', icon: 'text-emerald-500', label: '<20%' },
];

const NO_DATA_STYLE = { tile: 'bg-slate-50 border-dashed border-slate-200', icon: 'text-slate-300' };

const formatDiskSize = (bytes?: number | null) => {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Math.abs(bytes);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index <= 1 ? 0 : 1)} ${units[index]}`;
};

const heatBand = (pct: number | null, bands = HEAT_BANDS) => {
  if (pct === undefined || pct === null || !Number.isFinite(pct)) return null;
  return bands.find((band) => pct >= band.min) || bands[bands.length - 1];
};

const NodeHeatmap: React.FC<NodeHeatmapProps> = ({ partitions, jobs }) => {
  const [groupBy, setGroupBy] = useState<GroupByMode>('all');
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<Record<string, NodeMonitoringEntry>>({});
  const [coverageError, setCoverageError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await slurmService.fetchNodeMonitoring();
        if (!cancelled) {
          setCoverage(payload?.nodes || {});
          setCoverageError(false);
        }
      } catch {
        if (!cancelled) setCoverageError(true);
      }
    };
    load();
    const timer = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const collectorIssues = useMemo(() => {
    const states = (entry: NodeMonitoringEntry) => [entry.metrics, entry.jobs, entry.gpu].filter((state) => state !== 'ok' && state !== 'n/a');
    const entries = Object.values(coverage) as NodeMonitoringEntry[];
    return entries.filter((entry) => states(entry).length > 0).length;
  }, [coverage]);

  const isHeatView = groupBy === 'cpu' || groupBy === 'mem' || groupBy === 'disk';
  const heatBands = groupBy === 'disk' ? DISK_BANDS : HEAT_BANDS;

  const heatValue = (name: string): number | null => {
    const entry = coverage[name];
    if (!entry) return null;
    const value = groupBy === 'cpu' ? entry.cpuPct : groupBy === 'mem' ? entry.memPct : entry.diskPct;
    return value === undefined || value === null || !Number.isFinite(value) ? null : value;
  };

  const groups = useMemo(() => {
    const allNodesMap = new Map<string, NodeInfo & { partitionNames: string[]; type: ResourceType }>();
    
    partitions.forEach(p => {
      p.nodes?.forEach(node => {
        if (!allNodesMap.has(node.name)) {
          allNodesMap.set(node.name, { 
            ...node, 
            partitionNames: [p.name], 
            type: p.type 
          });
        } else {
          const existing = allNodesMap.get(node.name)!;
          if (!existing.partitionNames.includes(p.name)) {
            existing.partitionNames.push(p.name);
          }
          if (p.type === ResourceType.GPU) {
            existing.type = ResourceType.GPU;
          }
        }
      });
    });

    const allNodes = Array.from(allNodesMap.values()).sort((a, b) => {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    if (groupBy === 'all' || groupBy === 'cpu' || groupBy === 'mem' || groupBy === 'disk') {
      const abnormalNodes = allNodes.filter(n => n.state === 'down' || n.state === 'drained');
      const normalNodes = allNodes.filter(n => n.state !== 'down' && n.state !== 'drained');
      const titles: Record<string, { alert: string; total: string; type: string }> = {
        all: { alert: 'Abnormal Nodes | 异常节点', total: 'Cluster Status | 节点状态', type: 'TOTAL' },
        cpu: { alert: 'Abnormal Nodes | 异常节点', total: 'CPU Utilization Heat | CPU 使用率热度', type: 'HEAT' },
        mem: { alert: 'Abnormal Nodes | 异常节点', total: 'Memory Utilization Heat | 内存使用率热度', type: 'HEAT' },
        disk: { alert: 'Abnormal Nodes | 异常节点', total: 'Root Filesystem Usage Heat | 根目录空间使用热度', type: 'HEAT' },
      };
      const naming = titles[groupBy];

      const result = [];
      if (abnormalNodes.length > 0) {
        result.push({
          id: `${groupBy}-abnormal`,
          title: naming.alert,
          type: 'ALERT',
          nodes: abnormalNodes
        });
      }
      result.push({
        id: `${groupBy}-all`,
        title: naming.total,
        type: naming.type,
        nodes: normalNodes
      });
      return result;
    }

    if (groupBy === 'type') {
      return [
        { 
          id: 'gpu-nodes', 
          title: 'GPU Computing Resources', 
          type: ResourceType.GPU, 
          nodes: allNodes.filter(n => n.type === ResourceType.GPU) 
        },
        { 
          id: 'cpu-nodes', 
          title: 'CPU Computing Resources', 
          type: ResourceType.CPU, 
          nodes: allNodes.filter(n => n.type === ResourceType.CPU) 
        }
      ];
    }

    return partitions.map(p => ({
      id: p.name,
      title: p.name,
      type: p.type,
      nodes: (p.nodes || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    })).filter(g => g.nodes.length > 0);
  }, [partitions, groupBy]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-24">
      {/* View Switchers */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex bg-slate-200/50 p-1 rounded-xl border border-slate-200 w-fit shrink-0">
          <button 
            onClick={() => setGroupBy('all')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-black transition-all ${groupBy === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <LayoutGrid size={14} />
            Status
          </button>
          <button 
            onClick={() => setGroupBy('partition')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-black transition-all ${groupBy === 'partition' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <Layers size={14} />
            Partitions
          </button>
          <button 
            onClick={() => setGroupBy('type')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-black transition-all ${groupBy === 'type' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <Box size={14} />
            Resource
          </button>
          <button 
            onClick={() => setGroupBy('cpu')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-black transition-all ${groupBy === 'cpu' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <Cpu size={14} />
            CPU 热度
          </button>
          <button 
            onClick={() => setGroupBy('mem')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-black transition-all ${groupBy === 'mem' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <MemoryStick size={14} />
            内存热度
          </button>
          <button 
            onClick={() => setGroupBy('disk')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-black transition-all ${groupBy === 'disk' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <HardDrive size={14} />
            磁盘热度
          </button>
        </div>

        {/* Legend */}
        <div className="bg-white/80 backdrop-blur px-4 py-2 rounded-xl border border-slate-200 shadow-sm flex flex-wrap items-center gap-x-5 gap-y-2">
          {isHeatView ? (
            <>
              <div className="flex items-center gap-1.5 mr-1">
                <Info size={12} className="text-slate-400" />
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                  {groupBy === 'cpu' ? 'CPU 使用率' : groupBy === 'mem' ? '内存使用率' : '根目录 (/) 占用'}
                </span>
              </div>
              {heatBands.map((band) => (
                <div key={band.label} className="flex items-center gap-1.5">
                  <span className={`w-3.5 h-3.5 rounded border ${band.tile}`} />
                  <span className="text-[10px] font-bold text-slate-500 tracking-tight">{band.label}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <span className={`w-3.5 h-3.5 rounded border ${NO_DATA_STYLE.tile}`} />
                <span className="text-[10px] font-bold text-slate-500 tracking-tight">无数据</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mr-1">
                <Info size={12} className="text-slate-400" />
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">States</span>
              </div>
              {(Object.keys(STATE_COLORS) as NodeState[]).map(state => (
                <div key={state} className="flex items-center gap-1.5">
                  <Monitor size={12} className={STATE_COLORS[state]} />
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tight">
                    {state === 'allocated' ? 'alloc' : state === 'mixed' ? 'mix' : state}
                  </span>
                </div>
              ))}
            </>
          )}
          <div className="flex items-center gap-1.5 pl-4 border-l border-slate-200">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tight">采集异常</span>
            {collectorIssues > 0 && <span className="text-[10px] font-black text-rose-500 tabular-nums">{collectorIssues}</span>}
          </div>
          {coverageError && (
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={11} className="text-amber-500" />
              <span className="text-[10px] font-bold text-amber-600 uppercase tracking-tight">采集状态暂不可用</span>
            </div>
          )}
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 gap-6">
        {groups.map((group) => {
          const isAlert = group.type === 'ALERT';
          const activeCount = group.nodes.filter(n => n.state === 'allocated' || n.state === 'mixed').length;
          const zIndex = activeGroupId === group.id ? 100 : (isAlert ? 10 : 1);
          const heatValues = isHeatView ? group.nodes.map((node) => heatValue(node.name)).filter((value): value is number => value !== null) : [];
          const heatAverage = heatValues.length ? heatValues.reduce((sum, value) => sum + value, 0) / heatValues.length : null;
          const heatMissing = isHeatView ? group.nodes.length - heatValues.length : 0;

          return (
            <div 
              key={group.id} 
              onMouseEnter={() => setActiveGroupId(group.id)}
              onMouseLeave={() => setActiveGroupId(null)}
              className={`bg-white p-6 rounded-[2rem] border shadow-sm transition-all duration-300 ${isAlert ? 'border-rose-200 bg-rose-50/20' : 'border-slate-200'} relative`}
              style={{ zIndex }}
            >
              <div className={`flex items-center justify-between mb-6 border-b pb-4 ${isAlert ? 'border-rose-100' : 'border-slate-50'}`}>
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-6 rounded-full ${
                    isAlert ? 'bg-rose-600 animate-pulse' : 
                    group.type === 'GPU' ? 'bg-purple-500' : 
                    group.type === 'CPU' ? 'bg-blue-500' : 'bg-slate-900'
                  }`}></div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className={`font-black text-lg tracking-tight leading-none ${isAlert ? 'text-rose-700' : 'text-slate-800'}`}>
                        {group.title}
                      </h4>
                      {isAlert && <AlertTriangle size={16} className="text-rose-600" />}
                    </div>
                    <p className={`text-[10px] font-bold uppercase tracking-widest mt-1 ${isAlert ? 'text-rose-400' : 'text-slate-400'}`}>
                      {isAlert
                        ? `${group.nodes.length} Nodes Reported Issues`
                        : isHeatView
                          ? `平均 ${heatAverage === null ? '—' : `${heatAverage.toFixed(1)}%`} · ${heatValues.length}/${group.nodes.length} 有数据${heatMissing > 0 ? ` · ${heatMissing} 无采集` : ''}`
                          : `${activeCount} / ${group.nodes.length} Nodes Active`}
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,120px))] justify-start gap-3 sm:gap-4">
                {group.nodes.map((node, idx) => {
                  const nodeJobs = jobs.filter(j => {
                    const expanded = j.nodesExpanded && j.nodesExpanded.length > 0 ? j.nodesExpanded : (j.nodelist ? [j.nodelist] : []);
                    return expanded.some(n => n === node.name);
                  });

                  const entry = coverage[node.name];
                  const missingMetrics = !!entry && entry.metrics !== 'ok';
                  const otherIssues = !!entry && (entry.jobs !== 'ok' && entry.jobs !== 'n/a' || entry.gpu !== 'ok' && entry.gpu !== 'n/a');
                  const hasIssue = missingMetrics || otherIssues;
                  const issueTitle = entry
                    ? [
                        entry.metrics !== 'ok' ? 'node_exporter 数据缺失' : null,
                        entry.jobs !== 'ok' && entry.jobs !== 'n/a' ? '作业资源数据缺失' : null,
                        entry.gpu !== 'ok' && entry.gpu !== 'n/a' ? 'GPU 指标缺失' : null,
                      ].filter(Boolean).join('；')
                    : '';

                  const utilValue = isHeatView ? heatValue(node.name) : null;
                  const band = isHeatView ? heatBand(utilValue, heatBands) : null;
                  const tileStyle = isHeatView
                    ? (band ? band.tile : NO_DATA_STYLE.tile)
                    : CONTAINER_STYLES[node.state];
                  const iconStyle = isHeatView
                    ? (band ? band.icon : NO_DATA_STYLE.icon)
                    : STATE_COLORS[node.state];

                  return (
                    <div
                      key={`${group.id}-${node.name}-${idx}`}
                      className="group relative flex flex-col items-center"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedNode(node.name)}
                        title={hasIssue ? `点击查看详情 · ${issueTitle}` : '点击查看节点详情'}
                        className={`w-[42px] h-[38px] rounded-lg border transition-all duration-200 hover:scale-125 hover:shadow-xl cursor-pointer relative z-10 flex items-center justify-center ${tileStyle}`}
                      >
                        {isHeatView ? (
                          <span className={`text-[11px] font-black tabular-nums leading-none ${iconStyle}`}>
                            {utilValue === null ? '—' : `${Math.round(utilValue)}%`}
                          </span>
                        ) : (
                          <Monitor 
                            size={18} 
                            className={`${iconStyle} transition-transform ${node.state === 'down' ? 'animate-pulse' : ''}`} 
                            strokeWidth={2.5}
                          />
                        )}

                        {/* ULTRA COMPACT TOOLTIP */}
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 w-60 bg-slate-900 text-white p-3 rounded-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-all z-[9999] shadow-2xl scale-90 group-hover:scale-100 origin-bottom border border-slate-700 translate-y-2 group-hover:translate-y-0">
                          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-slate-900 rotate-45 border-r border-b border-slate-700"></div>
                          
                          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
                             <span className="font-black text-[11px] tracking-tight text-white uppercase flex items-center gap-1">
                               <Monitor size={10} className="text-slate-500" /> {node.name}
                             </span>
                             <span className={`px-1 py-0.5 rounded-[3px] text-[7px] font-black uppercase tracking-widest ${node.state === 'down' ? 'bg-rose-500/20 text-rose-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                {node.state}
                             </span>
                          </div>

                          <div className="space-y-1.5 relative">
                            <div className="flex justify-between items-center text-[9px]">
                              <span className="text-slate-500 font-bold uppercase text-[7.5px] tracking-widest">CPU 用量</span>
                              <span className="font-mono font-black text-slate-100">{node.cpus || "0/0/0/0"}</span>
                            </div>

                            <div className="flex justify-between items-center text-[9px]">
                              <span className="text-slate-500 font-bold uppercase text-[7.5px] tracking-widest">实时 CPU / 内存</span>
                              <span className="font-mono font-black text-slate-100 tabular-nums">
                                {entry?.cpuPct === undefined || entry?.cpuPct === null ? '—' : `${entry.cpuPct.toFixed(1)}%`}
                                {' / '}
                                {entry?.memPct === undefined || entry?.memPct === null ? '—' : `${entry.memPct.toFixed(1)}%`}
                              </span>
                            </div>

                            <div className="flex justify-between items-center text-[9px]">
                              <span className="text-slate-500 font-bold uppercase text-[7.5px] tracking-widest">根目录 (/)</span>
                              <span className="font-mono font-black text-slate-100 tabular-nums">
                                {entry?.diskPct === undefined || entry?.diskPct === null ? '—' : `${entry.diskPct.toFixed(1)}%`}
                                {entry?.diskFreeBytes !== undefined && entry?.diskFreeBytes !== null ? ` · 剩 ${formatDiskSize(entry.diskFreeBytes)}` : ''}
                              </span>
                            </div>

                            <div className="flex justify-between items-start text-[9px]">
                              <span className="text-slate-500 font-bold uppercase text-[7.5px] tracking-widest pt-0.5">GPU 数量</span>
                              <div className="flex flex-col items-end gap-0.5 max-w-[130px]">
                                {(node.gres || "(null)").split(',').map((part, pIdx) => (
                                  <span key={pIdx} className="font-mono font-black text-slate-100 text-right leading-tight whitespace-nowrap">
                                    {part.trim()}
                                  </span>
                                ))}
                              </div>
                            </div>

                            <div className="pt-1.5 border-t border-slate-800">
                               <div className="flex items-center justify-between mb-1">
                                 <span className="text-slate-500 font-bold uppercase text-[7.5px] tracking-widest">Running Jobs</span>
                                 <span className="text-[7.5px] font-black text-slate-400 bg-slate-800 px-1 py-0.5 rounded leading-none">{nodeJobs.length}</span>
                               </div>
                               
                               <div className="space-y-0.5">
                                 {nodeJobs.length > 0 ? (
                                   nodeJobs.map(j => (
                                     <div key={j.jobId} className="flex items-center justify-between bg-white/5 rounded px-1.5 py-0.5">
                                        <span className="font-mono text-[9px] font-black text-blue-400">#{j.jobId}</span>
                                        <div className="flex items-center gap-1">
                                          <User size={7} className="text-slate-500" />
                                          <span className="text-[9px] font-bold text-slate-400">{j.user}</span>
                                        </div>
                                     </div>
                                   ))
                                 ) : (
                                   <div className="text-slate-600 font-bold italic text-[8px] py-0.5 text-center">No active jobs</div>
                                 )}
                               </div>
                            </div>
                            
                            {node.reason && node.reason !== 'none' && (
                              <div className="mt-1.5 p-1.5 bg-rose-500/10 border border-rose-500/20 rounded-md">
                                <p className="text-rose-100 font-bold leading-tight text-[9px]">Reason: {node.reason}</p>
                              </div>
                            )}

                            {'partitionNames' in node && (
                               <div className="mt-1.5 pt-1.5 border-t border-slate-800 flex items-center gap-1 overflow-hidden">
                                 <span className="text-slate-600 font-bold uppercase text-[7px] tracking-widest shrink-0">Queues:</span>
                                 <div className="flex gap-1 overflow-hidden">
                                   {(node as any).partitionNames.map((p: string) => (
                                     <span key={p} className="text-slate-500 text-[7px] font-bold whitespace-nowrap">{p}</span>
                                   ))}
                                 </div>
                               </div>
                            )}
                          </div>
                        </div>
                      </button>
                      
                      <span className={`mt-1 text-[9px] font-bold truncate w-full text-center group-hover:text-slate-900 group-hover:font-black transition-all ${node.state === 'down' ? 'text-rose-600' : 'text-slate-400'}`}>
                        {node.name}
                      </span>
                      {hasIssue && (
                        <span
                          className="mt-1 flex items-center justify-center"
                          title={issueTitle}
                        >
                          <i className={`block w-1.5 h-1.5 rounded-full ${missingMetrics ? 'bg-rose-500' : 'bg-amber-500'}`} />
                        </span>
                      )}
                      {!hasIssue && <span className="mt-1 block h-1.5" aria-hidden="true" />}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selectedNode && (
        <NodeDetailModal
          nodeName={selectedNode}
          fallback={(() => {
            const found = groups.flatMap((group) => group.nodes).find((node) => node.name === selectedNode);
            if (!found) return undefined;
            return {
              state: found.state,
              cpus: found.cpus,
              gres: found.gres,
              gpusTotal: found.gpusTotal,
              gpusAllocated: found.gpusAllocated,
              memoryTotalMb: found.memoryTotalMb,
              reason: found.reason,
            };
          })()}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
};

export default NodeHeatmap;
