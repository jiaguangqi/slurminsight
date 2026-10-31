
import React from 'react';
import { PartitionStats, ResourceType } from '../types';
import { Users, Cpu, Zap, Server } from 'lucide-react';

interface StatCardProps {
  stats: PartitionStats;
  onPendingClick?: (partition: string) => void;
  onNodesClick?: (stats: PartitionStats) => void;
}

const StatCard: React.FC<StatCardProps> = ({ stats, onPendingClick, onNodesClick }) => {
  const isHigh = stats.utilization > 90;
  const isZero = stats.utilization === 0;
  
  const getBorderColor = () => {
    if (isHigh) return 'border-rose-200 hover:border-rose-300 shadow-rose-500/5';
    if (isZero) return 'border-slate-100 opacity-80';
    return 'border-slate-200 hover:border-blue-200 shadow-blue-500/5';
  };

  const getProgressColor = () => {
    if (isHigh) return 'bg-rose-500';
    if (stats.utilization > 60) return 'bg-blue-500';
    return 'bg-emerald-500';
  };

  const resourceLabel = stats.type === ResourceType.CPU ? 'Core' : 'GPU';

  return (
    <div className={`bg-white rounded-2xl p-4 border transition-all duration-300 hover:shadow-xl ${getBorderColor()}`}>
      <div className="flex justify-between items-start mb-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest truncate">{stats.type}</p>
          <h3 className="text-sm font-black text-slate-800 truncate" title={stats.name}>{stats.name}</h3>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onNodesClick?.(stats)}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-all"
            title={`查看 ${stats.name} 的节点`}
          >
            <Server size={14} />
          </button>
          <div className={`p-1.5 rounded-lg ${stats.type === ResourceType.CPU ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'}`}>
            {stats.type === ResourceType.CPU ? <Cpu size={14} /> : <Zap size={14} />}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex justify-between items-end">
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-500">USED / TOTAL</span>
            <span className="text-xs font-black text-slate-700">{stats.allocated} / {stats.total}</span>
          </div>
          <div className="text-right">
            <span className={`text-lg font-black tracking-tighter ${isHigh ? 'text-rose-600' : 'text-slate-900'}`}>
              {stats.utilization.toFixed(1)}%
            </span>
          </div>
        </div>

        <div className="w-full h-1.5 bg-slate-50 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-1000 ease-out ${getProgressColor()}`}
            style={{ width: `${stats.utilization}%` }}
          ></div>
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-slate-50 mt-2">
          <div className="flex items-center gap-1">
             <div className={`w-1.5 h-1.5 rounded-full ${isHigh ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`}></div>
             <span className="text-[10px] font-bold text-slate-500 uppercase">{isHigh ? 'High Load' : 'Available'}</span>
          </div>
          {stats.pending > 0 && (
            <button
              onClick={() => onPendingClick?.(stats.name)}
              className="flex items-center gap-1 text-amber-600 font-bold text-[10px] hover:text-amber-700 underline-offset-2 hover:underline"
            >
              <Users size={10} />
              <span>{stats.pending} {stats.type === ResourceType.GPU ? 'GPU 等待' : '作业等待'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatCard;
