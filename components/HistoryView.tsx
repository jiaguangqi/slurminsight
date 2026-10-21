
import React, { useState, useMemo, useEffect } from 'react';
import { HistoryRecord, FilterRange, ResourceType } from '../types';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, AreaChart, Area } from 'recharts';
import { Calendar, Search, Maximize2, X, Clock, Check } from 'lucide-react';
import { slurmService } from '../services/slurmService.ts';

interface HistoryViewProps {
  history: HistoryRecord[];
}

const HistoryView: React.FC<HistoryViewProps> = ({ history }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [resourceFilter, setResourceFilter] = useState<'ALL' | 'CPU' | 'GPU'>('ALL');
  const [selectedPartition, setSelectedPartition] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<number | null>(1); // Default to 1 day (24h)
  const [records, setRecords] = useState<HistoryRecord[]>(history);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  const [dateRange, setDateRange] = useState<FilterRange>(() => {
    const end = new Date();
    const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return { start, end };
  });

  const startMs = dateRange.start.getTime();
  const endMs = dateRange.end.getTime();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    slurmService.fetchHistoryRecords(startMs, endMs)
      .then((rows) => {
        if (!cancelled) setRecords(rows);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setRecords([]);
          setLoadError(err?.message || '加载历史数据失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [startMs, endMs]);

  const setPreset = (days: number) => {
    const end = new Date();
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    setDateRange({ start, end });
    setActivePreset(days);
  };

  const handleCustomDateChange = (type: 'start' | 'end', value: string) => {
    const newDate = new Date(value);
    setDateRange(prev => ({ ...prev, [type]: newDate }));
    setActivePreset(null); // Clear preset if manual selection is made
  };

  const partitionNames = useMemo(() => {
    if (records.length === 0) return [];
    // Use the most recent record to get available partition names
    return records[0].partitions
      .filter(p => resourceFilter === 'ALL' || p.type === resourceFilter)
      .filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .map(p => ({ name: p.name, type: p.type }));
  }, [records, searchTerm, resourceFilter]);

  const getChartDataForPartition = (name: string) => {
    const startMs = dateRange.start.getTime();
    const endMs = dateRange.end.getTime();
    const rangeDurationMs = endMs - startMs;
    const isLongRange = rangeDurationMs > 2 * 24 * 60 * 60 * 1000; // More than 2 days

    return records
      .filter(h => h.timestamp >= startMs && h.timestamp <= endMs)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(record => {
        const p = record.partitions.find(part => part.name === name);
        const dateObj = new Date(record.timestamp);
        
        // Dynamic label based on range
        const label = isLongRange 
          ? `${dateObj.getMonth() + 1}-${dateObj.getDate()}`
          : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return {
          time: label,
          fullTime: dateObj.toLocaleString(),
          allocated: p ? p.allocated : 0,
          total: p ? p.total : 0,
          pending: p ? p.pending : 0,
          utilization: p ? parseFloat(p.utilization.toFixed(1)) : 0
        };
      });
  };

  const selectedPartitionData = useMemo(() => {
    if (!selectedPartition) return null;
    const type = records.find(h => h.partitions.some(p => p.name === selectedPartition))
      ?.partitions.find(p => p.name === selectedPartition)?.type || ResourceType.CPU;
    
    return {
      name: selectedPartition,
      type,
      data: getChartDataForPartition(selectedPartition)
    };
  }, [selectedPartition, records, dateRange]);

  const formatDateForInput = (date: Date) => {
    const pad = (num: number) => num.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  return (
    <div className="space-y-6 pb-20 animate-in fade-in duration-500">
      {/* Header & Advanced Time Controls */}
      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight">Historical Trends</h2>
            <p className="text-slate-500 font-medium">Analyzing resource allocation patterns over time.</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                placeholder="Search partitions..."
                className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none w-48 transition-all"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <div className="flex bg-slate-50 p-1 rounded-xl border border-slate-200">
              {['ALL', 'CPU', 'GPU'].map((f) => (
                <button
                  key={f}
                  onClick={() => setResourceFilter(f as any)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                    resourceFilter === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col xl:flex-row gap-6 pt-6 border-t border-slate-50">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mr-2">Quick Range:</span>
            {[
              { label: '24H', days: 1 },
              { label: 'WEEK', days: 7 },
              { label: 'MONTH', days: 30 },
              { label: '60D', days: 60 },
              { label: '90D', days: 90 }
            ].map(preset => (
              <button
                key={preset.label}
                onClick={() => setPreset(preset.days)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[10px] font-black transition-all ${
                  activePreset === preset.days 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' 
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {activePreset === preset.days && <Check size={10} />}
                LAST {preset.label}
              </button>
            ))}
          </div>

          <div className="flex-1 flex flex-wrap items-center gap-3 xl:justify-end">
            <div className="flex items-center gap-2 bg-slate-50 px-4 py-2 rounded-xl border border-slate-200">
              <Clock size={14} className="text-slate-400" />
              <div className="flex flex-col">
                <label className="text-[8px] font-black text-slate-400 uppercase leading-none mb-1">Start Time</label>
                <input 
                  type="datetime-local" 
                  className="bg-transparent border-none outline-none text-[11px] font-bold text-slate-700 p-0"
                  value={formatDateForInput(dateRange.start)}
                  onChange={(e) => handleCustomDateChange('start', e.target.value)}
                />
              </div>
              <div className="h-4 w-px bg-slate-200 mx-2"></div>
              <div className="flex flex-col">
                <label className="text-[8px] font-black text-slate-400 uppercase leading-none mb-1">End Time</label>
                <input 
                  type="datetime-local" 
                  className="bg-transparent border-none outline-none text-[11px] font-bold text-slate-700 p-0"
                  value={formatDateForInput(dateRange.end)}
                  onChange={(e) => handleCustomDateChange('end', e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Grid of Trends */}
      {loadError && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-sm font-bold text-rose-700">
          加载历史数据失败：{loadError}
        </div>
      )}
      {loading && (
        <div className="p-4 bg-slate-100 border border-slate-200 rounded-2xl text-sm font-bold text-slate-500">
          正在加载所选时间段的数据…
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
        {partitionNames.map((pInfo) => {
          const data = getChartDataForPartition(pInfo.name);
          const isGpu = pInfo.type === ResourceType.GPU;
          const mainColor = isGpu ? '#8b5cf6' : '#3b82f6';

          return (
            <div key={pInfo.name} className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:border-blue-200 transition-all group flex flex-col">
              <div className="flex justify-between items-start mb-2">
                <div className="min-w-0">
                  <h3 className="font-black text-slate-800 text-sm truncate group-hover:text-blue-600 transition-colors" title={pInfo.name}>
                    {pInfo.name}
                  </h3>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{pInfo.type}</p>
                </div>
                <button 
                  onClick={() => setSelectedPartition(pInfo.name)}
                  className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors ml-2 shrink-0 opacity-0 group-hover:opacity-100"
                  title="Detailed View"
                >
                  <Maximize2 size={14} />
                </button>
              </div>

              <div className="h-[200px] w-full mt-auto">
                {data.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="time" hide={true} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 9 }} width={44} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#fff', borderRadius: '12px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontSize: '10px' }}
                        labelStyle={{ fontWeight: 'bold', marginBottom: '4px' }}
                      />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: '9px', paddingTop: '10px' }} />
                      <Line name="Total" type="stepAfter" dataKey="total" stroke="#94a3b8" strokeWidth={1} strokeDasharray="5 5" dot={false} activeDot={false} isAnimationActive={false} />
                      <Line name="Used" type="monotone" dataKey="allocated" stroke={mainColor} strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                      <Line name="Queued" type="monotone" dataKey="pending" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-[10px] text-slate-400 italic">
                    Data not available
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {partitionNames.length === 0 && (
          <div className="col-span-full py-20 text-center bg-white rounded-3xl border border-dashed border-slate-300">
            <p className="text-slate-400 font-medium">No partitions matching your search criteria.</p>
          </div>
        )}
      </div>

      {/* Modal Detailed View */}
      {selectedPartition && selectedPartitionData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 md:p-8 animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-6xl h-full max-h-[90vh] rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-300">
            <div className="p-8 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-5">
                <div className={`p-4 rounded-3xl ${selectedPartitionData.type === ResourceType.GPU ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
                   <Clock size={28} />
                </div>
                <div>
                  <h2 className="text-3xl font-black text-slate-900 tracking-tight">{selectedPartitionData.name}</h2>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">{selectedPartitionData.type} Resource</span>
                    <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                    <span className="text-xs font-bold text-slate-400">Detailed Time Series Analysis</span>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setSelectedPartition(null)}
                className="p-3 hover:bg-slate-200 rounded-2xl transition-all text-slate-400 hover:text-slate-900"
              >
                <X size={28} />
              </button>
            </div>

            <div className="flex-1 p-10 min-h-0">
              <div className="h-full w-full">
                {selectedPartitionData.data.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={selectedPartitionData.data} margin={{ top: 10, right: 30, left: 20, bottom: 20 }}>
                      <defs>
                        <linearGradient id="colorUsed" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={selectedPartitionData.type === ResourceType.GPU ? '#8b5cf6' : '#3b82f6'} stopOpacity={0.2}/>
                          <stop offset="95%" stopColor={selectedPartitionData.type === ResourceType.GPU ? '#8b5cf6' : '#3b82f6'} stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="colorQueued" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis 
                        dataKey="time" 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 'bold' }} 
                        dy={15}
                        minTickGap={60}
                      />
                      <YAxis 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 'bold' }} 
                        label={{ value: selectedPartitionData.type === ResourceType.GPU ? 'Cards' : 'Cores', angle: -90, position: 'insideLeft', offset: 0, fill: '#cbd5e1', fontSize: 11, fontWeight: 'black' }}
                      />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#fff', borderRadius: '20px', border: 'none', boxShadow: '0 20px 50px rgba(0,0,0,0.1)', padding: '20px' }}
                        labelStyle={{ fontWeight: 'black', marginBottom: '10px', color: '#1e293b', fontSize: '14px' }}
                      />
                      <Legend verticalAlign="top" height={50} iconType="circle" wrapperStyle={{ fontWeight: 'bold', fontSize: '12px' }} />
                      <Area 
                        name="Resource Used" 
                        type="monotone" 
                        dataKey="allocated" 
                        stroke={selectedPartitionData.type === ResourceType.GPU ? '#8b5cf6' : '#3b82f6'} 
                        strokeWidth={4} 
                        fillOpacity={1} 
                        fill="url(#colorUsed)" 
                      />
                      <Area 
                        name="Pending Request" 
                        type="monotone" 
                        dataKey="pending" 
                        stroke="#f59e0b" 
                        strokeWidth={4} 
                        fillOpacity={1} 
                        fill="url(#colorQueued)" 
                      />
                      <Line 
                        name="Total Limit" 
                        type="stepAfter" 
                        dataKey="total" 
                        stroke="#cbd5e1" 
                        strokeWidth={2} 
                        strokeDasharray="10 10" 
                        dot={false} 
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center gap-4 text-slate-400">
                    <div className="bg-slate-100 p-6 rounded-full">
                      <Calendar size={48} className="text-slate-200" />
                    </div>
                    <p className="font-bold">No telemetry data found for this period.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Modal Summary Footer */}
            <div className="px-10 py-8 bg-slate-50 flex justify-between items-center">
              <div className="flex gap-10">
                 {selectedPartitionData.data.length > 0 && (
                   <>
                     <div className="flex flex-col">
                       <span className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-1">Max Utilization</span>
                       <span className={`text-2xl font-black ${Math.max(...selectedPartitionData.data.map(d => d.utilization)) > 90 ? 'text-rose-500' : 'text-slate-900'}`}>
                         {Math.max(...selectedPartitionData.data.map(d => d.utilization)).toFixed(1)}%
                       </span>
                     </div>
                     <div className="flex flex-col border-l border-slate-200 pl-10">
                       <span className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-1">Average Load</span>
                       <span className="text-2xl font-black text-slate-900">
                         {(selectedPartitionData.data.reduce((acc, d) => acc + d.allocated, 0) / (selectedPartitionData.data.length || 1)).toFixed(1)} <span className="text-sm text-slate-400 font-medium">{selectedPartitionData.type === ResourceType.GPU ? 'Cards' : 'Cores'}</span>
                       </span>
                     </div>
                   </>
                 )}
              </div>
              <div className="text-right">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Current Filter View</p>
                <p className="text-slate-600 font-bold text-sm">{dateRange.start.toLocaleString()} — {dateRange.end.toLocaleString()}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryView;
