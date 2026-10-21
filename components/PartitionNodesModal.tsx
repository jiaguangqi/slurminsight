import React, { useMemo, useState } from 'react';
import { X, Server, Search, AlertTriangle } from 'lucide-react';
import { NodeInfo, NodeState, PartitionStats, ResourceType } from '../types';

interface PartitionNodesModalProps {
  partition: PartitionStats;
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

const STATE_ORDER: Record<NodeState, number> = {
  down: 0,
  drained: 1,
  maint: 2,
  allocated: 3,
  mixed: 4,
  idle: 5,
};

const parseCpus = (value?: string) => {
  const [alloc = 0, idle = 0, other = 0, total = 0] = (value || '0/0/0/0').split('/').map((n) => parseInt(n, 10) || 0);
  return { alloc, idle, other, total };
};

const PartitionNodesModal: React.FC<PartitionNodesModalProps> = ({ partition, onClose }) => {
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<{ node: string; index: number; jobId?: string; name?: string; user?: string } | null>(null);
  const nodes = partition.nodes || [];

  const summary = useMemo(() => {
    const counts: Record<string, number> = { idle: 0, allocated: 0, mixed: 0, drained: 0, down: 0, maint: 0 };
    nodes.forEach((n) => { counts[n.state] = (counts[n.state] || 0) + 1; });
    let gpus = 0;
    let gpusAllocated = 0;
    nodes.forEach((n) => {
      const match = (n.gres || '').match(/gpu[:=]([0-9]+)/i);
      gpus += n.gpusTotal ?? (match ? parseInt(match[1], 10) || 0 : 0);
      gpusAllocated += n.gpusAllocated ?? 0;
    });
    return { counts, gpus, gpusAllocated };
  }, [nodes]);

  const visible = useMemo(() => {
    const keyword = term.trim().toLowerCase();
    return nodes
      .filter((n) => !keyword || n.name.toLowerCase().includes(keyword))
      .slice()
      .sort((a, b) => {
        const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        if (byState !== 0) return byState;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
  }, [nodes, term]);

  const isGpu = partition.type === ResourceType.GPU;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-4xl max-h-[82vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 border border-slate-200">
        <div className="px-7 py-5 border-b border-slate-100 flex items-start justify-between gap-4 bg-slate-50/60">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className={`p-2.5 rounded-2xl shrink-0 ${isGpu ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
              <Server size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-900 tracking-tight truncate">{partition.name}</h2>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-0.5">
                {partition.type} 分区 · {nodes.length} 个节点
                {isGpu && summary.gpus > 0 ? ` · GPU 已分配 ${summary.gpusAllocated} / ${summary.gpus} 张` : ''}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-xl transition-all text-slate-400 hover:text-slate-900 shrink-0"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-7 py-4 border-b border-slate-100 flex flex-wrap items-center gap-2">
          {(['allocated', 'mixed', 'idle', 'drained', 'down', 'maint'] as NodeState[])
            .filter((state) => summary.counts[state] > 0)
            .map((state) => (
              <span key={state} className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold ${STATE_STYLE[state]}`}>
                {STATE_LABEL[state]} {summary.counts[state]}
              </span>
            ))}
          {isGpu && (
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 ml-1">
              <i className="inline-block w-3 h-3 rounded border bg-emerald-50 border-emerald-100" />空闲
              <i className="inline-block w-3 h-3 rounded border bg-rose-500/15 border-rose-200 ml-2" />已分配
            </span>
          )}
          <div className="ml-auto relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="节点名"
              className="pl-8 pr-3 py-1.5 w-40 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-7 py-4">
          {visible.length === 0 ? (
            <p className="py-10 text-center text-xs font-bold text-slate-400">
              {nodes.length === 0 ? '该分区暂无节点数据' : '没有匹配的节点'}
            </p>
          ) : (
            <div className="space-y-1.5">
              {visible.map((node: NodeInfo) => {
                const { alloc, total } = parseCpus(node.cpus);
                const gres = node.gres && node.gres !== '(null)' ? node.gres : '';
                const gresTotal = gres.match(/gpu[:=]([0-9]+)/i);
                const gpuTotal = node.gpusTotal ?? (gresTotal ? parseInt(gresTotal[1], 10) || 0 : 0);
                const gpuAllocated = node.gpusAllocated ?? 0;
                const showGpu = isGpu && gpuTotal > 0;
                const mainAlloc = showGpu ? gpuAllocated : alloc;
                const mainTotal = showGpu ? gpuTotal : total;
                const pct = mainTotal ? Math.round((mainAlloc / mainTotal) * 100) : 0;
                const cardMap = new Map((node.gpuCards || []).map((card) => [card.index, card]));
                const busyCards = new Set(cardMap.keys());
                if (gpuAllocated > busyCards.size) {
                  for (let i = 0; i < gpuTotal && busyCards.size < gpuAllocated; i += 1) busyCards.add(i);
                }
                return (
                  <div key={node.name} className="flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2 hover:bg-slate-50/70">
                    <span className="w-28 shrink-0 font-mono text-xs font-bold text-slate-800 truncate" title={node.name}>{node.name}</span>
                    <span className={`w-16 shrink-0 text-center px-1.5 py-0.5 rounded-md border text-[10px] font-black ${STATE_STYLE[node.state]}`}>
                      {STATE_LABEL[node.state]}
                    </span>
                    {showGpu ? (
                      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
                        {Array.from({ length: gpuTotal }).map((_, index) => {
                          const card = cardMap.get(index);
                          const busy = busyCards.has(index);
                          const tip = card
                            ? `GPU ${index} · 作业 ${card.jobId}${card.name ? ` ${card.name}` : ''}${card.user ? ` · ${card.user}` : ''}`
                            : `GPU ${index} · ${busy ? '已分配' : '空闲'}`;
                          const isSelected = selected?.node === node.name && selected?.index === index;
                          return (
                            <button
                              key={index}
                              type="button"
                              title={tip}
                              onClick={() => setSelected({ node: node.name, index, jobId: card?.jobId, name: card?.name, user: card?.user })}
                              className={`w-8 h-8 rounded-lg border flex items-center justify-center text-[11px] font-black tabular-nums transition-all ${
                                busy
                                  ? 'bg-rose-500/15 border-rose-200 text-rose-700 hover:bg-rose-500/25'
                                  : 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-100'
                              } ${isSelected ? 'ring-2 ring-offset-1 ring-slate-900' : ''}`}
                            >
                              {index}
                            </button>
                          );
                        })}
                        <span className="ml-1 text-[11px] font-bold text-slate-500 tabular-nums whitespace-nowrap">
                          {gpuAllocated}/{gpuTotal} 卡
                        </span>
                      </div>
                    ) : (
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${pct >= 90 ? 'bg-rose-400' : pct > 0 ? 'bg-blue-400' : 'bg-slate-200'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[11px] font-bold text-slate-500 tabular-nums w-20 text-right">
                          {mainAlloc}/{mainTotal || '—'} 核
                        </span>
                      </div>
                    )}
                    <span className="w-24 shrink-0 text-right text-[10px] font-bold text-slate-400 truncate" title={showGpu ? `CPU ${alloc}/${total}` : gres}>
                      {showGpu ? `CPU ${alloc}/${total}` : (gres ? gres.replace(/\(S:[^)]*\)/g, '') : '—')}
                    </span>
                    {node.reason && (node.state === 'drained' || node.state === 'down') && (
                      <span className="max-w-[9rem] shrink-0 flex items-center gap-1 text-[10px] font-bold text-rose-500 truncate" title={node.reason}>
                        <AlertTriangle size={10} /> {node.reason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selected && (
          <div className="px-7 py-3 border-t border-slate-100 bg-slate-50/70 flex items-center gap-2 text-xs shrink-0">
            <span className="font-black text-slate-800">{selected.node}</span>
            <span className="text-slate-300">/</span>
            <span className="font-bold text-slate-500">GPU {selected.index}</span>
            <span className="text-slate-300">/</span>
            {selected.jobId ? (
              <>
                <span className="font-black text-violet-700">{selected.jobId}</span>
                <span className="font-bold text-slate-700 truncate max-w-[16rem]" title={selected.name}>{selected.name}</span>
                <span className="text-slate-400">用户 {selected.user}</span>
              </>
            ) : (
              <span className="font-bold text-emerald-600">空闲</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PartitionNodesModal;
