
import React from 'react';
import { NAVIGATION_ITEMS } from '../constants.tsx';
import { Server, Activity, Terminal } from 'lucide-react';
import { ControllerStatus } from '../types';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (id: string) => void;
  allowedMenus?: string[] | null;
  controllers?: ControllerStatus[];
}

const roleLabel = (role: string) => {
  if (role === 'primary') return 'Primary';
  if (role === 'backup') return 'Backup';
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Controller';
};

const stateStyles = (state: string) => {
  if (state === 'UP') return 'text-emerald-400 bg-emerald-400/10';
  if (state === 'DOWN') return 'text-rose-400 bg-rose-400/10';
  return 'text-amber-400 bg-amber-400/10';
};

const stateDot = (state: string) => {
  if (state === 'UP') return 'bg-emerald-400 animate-pulse';
  if (state === 'DOWN') return 'bg-rose-400';
  return 'bg-amber-400';
};

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, allowedMenus, controllers }) => {
  const items = allowedMenus ? NAVIGATION_ITEMS.filter(i => allowedMenus.includes(i.id)) : NAVIGATION_ITEMS;
  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-slate-900 text-white flex flex-col z-20 transition-all duration-300">
      <div className="p-6 flex items-center gap-3 border-b border-slate-800">
        <div className="bg-blue-600 p-2 rounded-lg">
          <Server size={24} className="text-white" />
        </div>
        <h1 className="text-lg font-bold tracking-tight">SlurmInsight</h1>
      </div>
      
      <nav className="flex-1 px-4 py-6 space-y-2">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
              activeTab === item.id 
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' 
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
            }`}
          >
            {item.icon}
            <span className="font-medium">{item.label}</span>
          </button>
        ))}
      </nav>
      
      <div className="p-5 bg-slate-800/40 m-4 rounded-2xl border border-slate-700/50 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Activity size={12} className="text-blue-400" />
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Cluster Info</p>
          </div>
          <div className="space-y-1.5">
            {!controllers || controllers.length === 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-400 font-medium">slurmctld</span>
                <span className="flex items-center gap-1.5 text-[10px] font-black text-slate-400 bg-slate-400/10 px-1.5 py-0.5 rounded">
                  <span className="w-1 h-1 rounded-full bg-slate-400"></span>
                  未知
                </span>
              </div>
            ) : (
              controllers.map((controller) => (
                <div key={`${controller.role}-${controller.host}`} className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-400 font-medium truncate" title={controller.host}>
                    {roleLabel(controller.role)} ({controller.host})
                  </span>
                  <span className={`flex items-center gap-1.5 text-[10px] font-black px-1.5 py-0.5 rounded shrink-0 ${stateStyles(controller.state)}`}>
                    <span className={`w-1 h-1 rounded-full ${stateDot(controller.state)}`}></span>
                    {controller.state}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        
        <div className="pt-3 border-t border-slate-700/50">
          <div className="flex items-center gap-2 mb-1">
            <Terminal size={12} className="text-slate-500" />
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Software Version</p>
          </div>
          <span className="text-xs font-black text-slate-200 font-mono tracking-tight">slurm 23.11.10</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
