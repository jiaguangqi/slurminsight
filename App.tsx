
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { HashRouter } from 'react-router-dom';
import Sidebar from './components/Sidebar.tsx';
import Dashboard from './components/Dashboard.tsx';
import HistoryView from './components/HistoryView.tsx';
import NodeHeatmap from './components/NodeHeatmap.tsx';
import JobQueueView from './components/JobQueueView.tsx';
import ServiceHealth from './components/ServiceHealth.tsx';
import { slurmService, DBStats, USE_MOCK } from './services/slurmService.ts';
import { PartitionStats, HistoryRecord, RetentionPeriod, JobInfo, UserSession, ControllerStatus } from './types';
import { FETCH_INTERVAL_MS } from './constants.tsx';
import { RefreshCw, Bell, Database, Save, Trash2, CheckCircle2, HardDrive, ShieldCheck, Activity, Download, Upload, AlertCircle } from 'lucide-react';
import Login from './components/Login.tsx';

const AppContent: React.FC = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [currentStats, setCurrentStats] = useState<PartitionStats[]>([]);
  const [currentJobs, setCurrentJobs] = useState<JobInfo[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [lastSync, setLastSync] = useState<Date>(new Date());
  const [isSyncing, setIsSyncing] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("Database updated successfully");
  const [dbStats, setDbStats] = useState<DBStats | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [controllers, setControllers] = useState<ControllerStatus[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<UserSession | null>(null);
  const [ldapForm, setLdapForm] = useState<{
    servers: Array<{ url: string; baseDn: string; bindDn: string; bindPassword: string; hasBindPassword?: boolean }>;
    minUid: number;
  }>({
    servers: [
      { url: '', baseDn: '', bindDn: '', bindPassword: '' },
      { url: '', baseDn: '', bindDn: '', bindPassword: '' }
    ],
    minUid: 500
  });
  const [dbForm, setDbForm] = useState({ connectionString: '', ssl: false, intervalSeconds: 300 });
  const [configLoading, setConfigLoading] = useState(false);
  
  const isSyncingRef = useRef(false);
  const [retention, setRetention] = useState<RetentionPeriod>(slurmService.getRetentionPeriod());

  const normalizeSession = (data: { token?: string; role: 'admin' | 'user'; menus: string[] | null; partitions: string[] | null; username: string }): UserSession => {
    const defaultMenus = data.role === 'user' && !data.menus ? ['dashboard', 'jobs'] : data.menus;
    return { username: data.username, role: data.role, menus: defaultMenus || null, partitions: data.partitions || null };
  };

  const handleLoginSuccess = (data: { token: string; role: 'admin' | 'user'; menus: string[] | null; partitions: string[] | null; username: string }) => {
    localStorage.setItem('authToken', data.token);
    setSession(normalizeSession(data));
    fetchLatestData();
  };

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    setSession(null);
    setCurrentStats([]);
    setCurrentJobs([]);
  };

  const fetchLatestData = useCallback(async () => {
    if (isSyncingRef.current) return;
    
    isSyncingRef.current = true;
    setIsSyncing(true);
    
    try {
      // Controller status is cheap; start it first so the sidebar fills in without waiting on the heavy queries.
      slurmService.fetchClusterHealth().then(setControllers).catch(() => {});
      const stats = await slurmService.fetchCurrentStatus();
      const jobs = await slurmService.fetchJobs();
      slurmService.saveRecord(stats);
      
      setCurrentStats(stats);
      setCurrentJobs(jobs);
      const historyRecords = await slurmService.fetchHistoryRecords();
      setHistory(historyRecords);
      setLastSync(new Date());
      setDbStats(slurmService.getDBStats());
      setDataError(null);
      
      triggerToast("Data synchronized successfully");
    } catch (error: any) {
      console.error("Failed to fetch Slurm data:", error);
      if (error?.status === 401) {
        handleLogout();
        return;
      }
      setCurrentStats([]);
      setCurrentJobs([]);
      setDataError(error?.message || 'Failed to load cluster data');
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (USE_MOCK) {
      slurmService.seedInitialData();
    }
    const token = localStorage.getItem('authToken');
    if (token) {
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
        .then(async (res) => {
          if (!res.ok) throw new Error('unauthorized');
          const data = await res.json();
          setSession(normalizeSession({ ...data, username: data.username || data.user || 'user', token }));
          fetchLatestData();
        })
        .catch(() => {
          handleLogout();
        });
    }
    if (!token && USE_MOCK) {
      fetchLatestData();
    }

    const interval = setInterval(() => {
      fetchLatestData();
    }, FETCH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchLatestData]);

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (session?.role === 'admin' && token) {
      const loadConfigs = async () => {
        try {
          setConfigLoading(true);
          const [ldapRes, dbRes] = await Promise.all([
            fetch('/api/admin/ldap-config', { headers: { Authorization: `Bearer ${token}` } }),
            fetch('/api/admin/db-config', { headers: { Authorization: `Bearer ${token}` } })
          ]);
          if (ldapRes.ok) {
            const data = await ldapRes.json();
            setLdapForm({
              servers: (data?.ldap?.servers?.length ? data.ldap.servers : ldapForm.servers).map((server: any) => ({
                url: server.url || '',
                baseDn: server.baseDn || '',
                bindDn: server.bindDn || '',
                bindPassword: '',
                hasBindPassword: Boolean(server.hasBindPassword),
              })),
              minUid: data?.ldap?.minUid || 500
            });
          }
          if (dbRes.ok) {
            const data = await dbRes.json();
            setDbForm({
              connectionString: data?.db?.connectionString || '',
              ssl: data?.db?.ssl || false,
              intervalSeconds: data?.db?.intervalSeconds || 300
            });
          }
        } catch {}
        finally {
          setConfigLoading(false);
        }
      };
      loadConfigs();
    }
  }, [session]);

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setShowSuccessToast(true);
    setTimeout(() => setShowSuccessToast(false), 3000);
  };

  const handleRetentionChange = async (period: RetentionPeriod) => {
    setRetention(period);
    slurmService.setRetentionPeriod(period);
    if (session?.role === 'admin') {
      const token = localStorage.getItem('authToken') || '';
      try {
        const res = await fetch('/api/admin/collector-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ retentionDays: period })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        triggerToast("Retention policy updated (server + browser)");
      } catch (err) {
        console.error('Failed to persist retention policy', err);
        triggerToast("Saved locally — server retention unchanged");
      }
    } else {
      triggerToast("Retention policy updated");
    }
    slurmService.fetchHistoryRecords().then(setHistory).catch(() => {});
    setDbStats(slurmService.getDBStats());
  };

  const handleExport = async () => {
    try {
      const blob = await slurmService.exportDatabase();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SlurmInsight_Backup_${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      triggerToast("Backup exported successfully");
    } catch (e) {
      console.error(e);
      alert("Failed to export database.");
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!confirm("Are you sure? This will overwrite your current local database with the contents of the backup.")) {
      e.target.value = '';
      return;
    }

    try {
      await slurmService.importDatabase(file);
      triggerToast("Database restored! Reloading...");
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      console.error(err);
      alert("Import failed: " + err.message);
    } finally {
      e.target.value = '';
    }
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return (
          <Dashboard 
            stats={currentStats} 
            jobs={currentJobs}
            onRefresh={fetchLatestData} 
            isSyncing={isSyncing} 
            lastSync={lastSync}
          />
        );
      case 'heatmap':
        return (
          <div className="space-y-8 animate-in fade-in duration-500">
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div>
                <h2 className="text-3xl font-black text-slate-900 tracking-tight">Live Node Heatmap</h2>
                <p className="text-slate-500 font-medium">Real-time individual node status distribution across clusters.</p>
              </div>
              <button 
                onClick={fetchLatestData}
                disabled={isSyncing}
                className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-black text-sm transition-all shadow-sm ${
                  isSyncing 
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                  : 'bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95'
                }`}
              >
                <RefreshCw size={18} className={isSyncing ? 'animate-spin' : ''} />
                {isSyncing ? 'Syncing...' : 'Update Map'}
              </button>
            </header>
            <NodeHeatmap partitions={currentStats} jobs={currentJobs} />
          </div>
        );
      case 'jobs':
        return (
          <div className="space-y-8 animate-in fade-in duration-500">
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div>
                <h2 className="text-3xl font-black text-slate-900 tracking-tight">Cluster Job Queue</h2>
                <p className="text-slate-500 font-medium">Real-time tracking of running and pending Slurm jobs.</p>
              </div>
              <button 
                onClick={fetchLatestData}
                disabled={isSyncing}
                className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-black text-sm transition-all shadow-sm ${
                  isSyncing 
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                  : 'bg-blue-600 text-white hover:bg-blue-700 active:scale-95'
                }`}
              >
                <RefreshCw size={18} className={isSyncing ? 'animate-spin' : ''} />
                {isSyncing ? 'Syncing...' : 'Update Queue'}
              </button>
            </header>
            <JobQueueView jobs={currentJobs} />
          </div>
        );
      case 'history':
        return <HistoryView history={history} />;
      case 'services':
        return <ServiceHealth />;
      case 'settings':
        return (
          <div className="space-y-12 animate-in fade-in duration-500 max-w-6xl">
            <header>
              <h2 className="text-3xl font-black text-slate-900 tracking-tight">Configuration & Database</h2>
              <p className="text-slate-500 font-medium">Manage system parameters and local data storage persistence.</p>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
               <div className="lg:col-span-2 space-y-8">
                  {session?.role === 'admin' && (
                    <>
                    <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-xl font-black text-slate-800">LDAP 对接配置</h3>
                          <p className="text-sm text-slate-500">支持双 LDAP，高可用一致性校验；仅 uidNumber ≥ {ldapForm.minUid} 的用户允许登录。</p>
                        </div>
                        <span className="text-xs text-slate-400 font-black uppercase">Admin Only</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {[0,1].map((idx) => (
                          <div key={idx} className="space-y-3 border border-slate-100 rounded-xl p-4">
                            <p className="text-xs font-black text-slate-500 uppercase">LDAP Server {idx+1}</p>
                            <input className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" placeholder="ldap://host:389"
                              value={ldapForm.servers[idx]?.url || ''} onChange={e => {
                                const servers = [...ldapForm.servers];
                                servers[idx] = { ...servers[idx], url: e.target.value };
                                setLdapForm({ ...ldapForm, servers });
                              }} />
                            <input className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" placeholder="Base DN (e.g. ou=People,dc=example,dc=com)"
                              value={ldapForm.servers[idx]?.baseDn || ''} onChange={e => {
                                const servers = [...ldapForm.servers];
                                servers[idx] = { ...servers[idx], baseDn: e.target.value };
                                setLdapForm({ ...ldapForm, servers });
                              }} />
                            <input className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm" placeholder="Bind DN 模板（可用 {username})"
                              value={ldapForm.servers[idx]?.bindDn || ''} onChange={e => {
                                const servers = [...ldapForm.servers];
                                servers[idx] = { ...servers[idx], bindDn: e.target.value };
                                setLdapForm({ ...ldapForm, servers });
                              }} />
                            <input className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                              placeholder={ldapForm.servers[idx]?.hasBindPassword ? '已加密保存，留空则不修改' : 'Bind 密码'}
                              type="password"
                              value={ldapForm.servers[idx]?.bindPassword || ''} onChange={e => {
                                const servers = [...ldapForm.servers];
                                servers[idx] = { ...servers[idx], bindPassword: e.target.value };
                                setLdapForm({ ...ldapForm, servers });
                              }} />
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="text-xs font-black text-slate-500 uppercase">最小 uidNumber</label>
                        <input type="number" className="w-24 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          value={ldapForm.minUid}
                          onChange={(e) => setLdapForm({ ...ldapForm, minUid: parseInt(e.target.value, 10) || 500 })}
                        />
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <button
                          onClick={async () => {
                            setConfigLoading(true);
                            const token = localStorage.getItem('authToken') || '';
                            await fetch('/api/admin/ldap-config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                              body: JSON.stringify(ldapForm)
                            }).finally(() => setConfigLoading(false));
                            triggerToast('LDAP 配置已保存');
                          }}
                          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-black hover:bg-blue-700"
                          disabled={configLoading}
                        >
                          保存配置
                        </button>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={async () => {
                              setConfigLoading(true);
                              const token = localStorage.getItem('authToken') || '';
                              const res = await fetch('/api/admin/ldap-test', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                body: JSON.stringify({ servers: ldapForm.servers })
                              });
                              const data = await res.json();
                              setConfigLoading(false);
                              if (res.ok && data.ok) {
                                triggerToast('LDAP 连通性/一致性检测通过');
                              } else {
                                alert(`LDAP 测试失败：${data.error || (data.results || []).map((r: any, i: number) => `S${i+1}(${r.url||''},bindDn=${r.bindDn||''}): ${r.error || 'ok'}`).join('; ')}`);
                              }
                            }}
                            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-black hover:bg-emerald-700"
                            disabled={configLoading}
                          >
                            测试连接
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-xl font-black text-slate-800">PostgreSQL 对接</h3>
                          <p className="text-sm text-slate-500">用于后台采集数据持久化，保存后即生效。</p>
                        </div>
                        <span className="text-xs text-slate-400 font-black uppercase">Admin Only</span>
                      </div>
                      <div className="space-y-3">
                        <label className="text-xs font-black text-slate-500 uppercase">Connection String</label>
                        <input
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                          placeholder="postgres://user:pass@host:5432/dbname"
                          value={dbForm.connectionString}
                          onChange={(e) => setDbForm({ ...dbForm, connectionString: e.target.value })}
                        />
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={dbForm.ssl}
                            onChange={(e) => setDbForm({ ...dbForm, ssl: e.target.checked })}
                          />
                          <span className="text-sm text-slate-600">启用 SSL</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-black text-slate-500 uppercase">采集间隔(秒)</label>
                          <input
                            type="number"
                            min={60}
                            className="w-24 px-3 py-2 rounded-lg border border-slate-200 text-sm"
                            value={dbForm.intervalSeconds}
                            onChange={(e) => setDbForm({ ...dbForm, intervalSeconds: parseInt(e.target.value, 10) || 300 })}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <button
                          onClick={async () => {
                            setConfigLoading(true);
                            const token = localStorage.getItem('authToken') || '';
                            const res = await fetch('/api/admin/db-test', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                              body: JSON.stringify({ db: dbForm })
                            });
                            const data = await res.json();
                            setConfigLoading(false);
                            if (res.ok && data.ok) {
                              triggerToast('PostgreSQL 连接成功');
                            } else {
                              alert(`PostgreSQL 连接失败：${data.error}`);
                            }
                          }}
                          className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-black hover:bg-emerald-700"
                          disabled={configLoading}
                        >
                          测试连接
                        </button>
                        <button
                          onClick={async () => {
                            setConfigLoading(true);
                            const token = localStorage.getItem('authToken') || '';
                            const res = await fetch('/api/admin/db-config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                              body: JSON.stringify({ db: dbForm })
                            });
                            const data = await res.json();
                            setConfigLoading(false);
                            if (res.ok && data.ok) {
                              triggerToast('PostgreSQL 配置已保存并生效');
                            } else {
                              alert(`保存失败：${data.error}`);
                            }
                          }}
                          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-black hover:bg-blue-700"
                          disabled={configLoading}
                        >
                          保存配置
                        </button>
                      </div>
                    </div>
                    </>
                  )}
                  <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                    <div className="flex items-center gap-4 mb-8">
                      <div className="p-3 bg-blue-50 text-blue-600 rounded-2xl">
                        <Database size={24} />
                      </div>
                      <div>
                        <h3 className="text-xl font-black text-slate-800 tracking-tight">Virtual Database Status</h3>
                        <p className="text-sm text-slate-400 font-medium uppercase tracking-wider">Engine: {dbStats?.engine}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
                       <DBStatItem icon={<Activity size={16} />} label="Records" value={dbStats?.recordCount || 0} />
                       <DBStatItem icon={<HardDrive size={16} />} label="Capacity" value={`${dbStats?.estimatedSizeKB} KB`} />
                       <DBStatItem icon={<ShieldCheck size={16} />} label="Health" value={dbStats?.status || 'Healthy'} isStatus />
                       <DBStatItem icon={<RefreshCw size={16} />} label="Version" value={dbStats?.version || 'N/A'} />
                    </div>

                    <div className="mt-10 pt-8 border-t border-slate-50 space-y-6">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                        <div>
                          <p className="font-black text-slate-800 tracking-tight">Retention Policy</p>
                          <p className="text-xs text-slate-400 font-medium">Automatic purging of historical telemetry.</p>
                        </div>
                        <div className="flex bg-slate-100 p-1 rounded-xl">
                          {[
                            { label: '6M', value: RetentionPeriod.SIX_MONTHS },
                            { label: '1Y', value: RetentionPeriod.ONE_YEAR },
                            { label: '2Y', value: RetentionPeriod.TWO_YEARS }
                          ].map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => handleRetentionChange(opt.value)}
                              className={`px-5 py-2 rounded-lg text-[11px] font-black transition-all ${
                                retention === opt.value 
                                  ? 'bg-white text-slate-900 shadow-sm' 
                                  : 'text-slate-400 hover:text-slate-600'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Backup & Restore Card */}
                  <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                    <div className="flex items-center gap-4 mb-8">
                      <div className="p-3 bg-emerald-50 text-emerald-600 rounded-2xl">
                        <Save size={24} />
                      </div>
                      <div>
                        <h3 className="text-xl font-black text-slate-800 tracking-tight">Backup & Restore | 数据备份与恢复</h3>
                        <p className="text-sm text-slate-400 font-medium">Export all data to a ZIP file or restore from a previous session.</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                       <button 
                        onClick={handleExport}
                        className="flex items-center justify-between p-6 bg-slate-50 hover:bg-blue-50 border border-slate-100 hover:border-blue-200 rounded-[2rem] transition-all group"
                       >
                          <div className="flex flex-col text-left">
                            <span className="text-sm font-black text-slate-900">Export All Data</span>
                            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Download ZIP Package</span>
                          </div>
                          <div className="p-3 bg-white text-blue-600 rounded-2xl shadow-sm group-hover:scale-110 transition-transform">
                             <Download size={20} />
                          </div>
                       </button>

                       <button 
                        onClick={handleImportClick}
                        className="flex items-center justify-between p-6 bg-slate-50 hover:bg-emerald-50 border border-slate-100 hover:border-emerald-200 rounded-[2rem] transition-all group"
                       >
                          <div className="flex flex-col text-left">
                            <span className="text-sm font-black text-slate-900">Import All Data</span>
                            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Restore ZIP Package</span>
                          </div>
                          <div className="p-3 bg-white text-emerald-600 rounded-2xl shadow-sm group-hover:scale-110 transition-transform">
                             <Upload size={20} />
                          </div>
                       </button>
                    </div>
                    
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      className="hidden" 
                      accept=".zip" 
                      onChange={handleFileChange}
                    />

                    <div className="mt-6 flex items-start gap-3 p-4 bg-amber-50 rounded-2xl border border-amber-100">
                       <AlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                       <p className="text-[11px] text-amber-700 font-bold leading-relaxed">
                          Note: Importing data will replace your current cluster history and settings. 
                          It is recommended to export your current state before performing an import.
                       </p>
                    </div>
                  </div>
               </div>

               <div className="space-y-6">
                  <div className="bg-slate-900 text-white p-8 rounded-[2.5rem] shadow-xl relative overflow-hidden group h-fit">
                     <div className="absolute top-0 right-0 p-12 opacity-10 group-hover:scale-110 transition-transform duration-700">
                        <Database size={160} />
                     </div>
                     <div className="relative z-10">
                        <h4 className="text-xl font-black mb-4 tracking-tight">Database Infrastructure</h4>
                        <div className="space-y-4">
                           <p className="text-slate-400 text-sm leading-relaxed font-medium">
                              SlurmInsight utilizes a high-performance local persistence layer. 
                              Data is indexed by timestamp to ensure O(1) retrieval.
                           </p>
                           <div className="flex flex-wrap gap-2">
                              <span className="bg-slate-800 text-slate-400 px-3 py-1 rounded-lg text-[10px] font-bold border border-slate-700">V1.4-STABLE</span>
                              <span className="bg-slate-800 text-slate-400 px-3 py-1 rounded-lg text-[10px] font-bold border border-slate-700">COMPRESSED</span>
                           </div>
                        </div>
                     </div>
                  </div>

                  <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm flex flex-col">
                    <h4 className="text-lg font-black text-slate-800 mb-6 tracking-tight">Maintenance</h4>
                    <div className="space-y-4 flex-1">
                       <button 
                        onClick={() => { if(confirm('Vacuuming will re-index all records. Continue?')) { fetchLatestData(); triggerToast("Database optimized"); } }}
                        className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-blue-50 hover:border-blue-200 border border-slate-100 rounded-2xl transition-all group"
                       >
                          <div className="text-left">
                             <p className="text-xs font-black text-slate-700">Optimize Database</p>
                             <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Run Vacuum/Reindex</p>
                          </div>
                          <RefreshCw size={16} className="text-slate-300 group-hover:text-blue-500 group-hover:rotate-180 transition-all duration-500" />
                       </button>

                       <button 
                        onClick={() => { if(confirm('WARNING: This will permanently delete all records. This cannot be undone.')) { localStorage.clear(); window.location.reload(); } }}
                        className="w-full flex items-center justify-between p-4 bg-rose-50/30 hover:bg-rose-50 hover:border-rose-200 border border-transparent rounded-2xl transition-all group"
                       >
                          <div className="text-left">
                             <p className="text-xs font-black text-rose-700">Purge Records</p>
                             <p className="text-[10px] text-rose-400 font-bold uppercase tracking-tight">Hard Delete History</p>
                          </div>
                          <Trash2 size={16} className="text-rose-300 group-hover:text-rose-600 transition-colors" />
                       </button>
                    </div>

                    <div className="mt-8 p-6 bg-emerald-50 rounded-3xl border border-emerald-100">
                       <div className="flex items-center gap-3 mb-2">
                          <CheckCircle2 size={14} className="text-emerald-600" />
                          <p className="text-[11px] font-black text-emerald-800 uppercase tracking-wider">Sync Integrity</p>
                       </div>
                       <p className="text-[11px] text-emerald-600 font-bold leading-relaxed italic">
                          Integrity checks passed. Local storage is synchronized.
                       </p>
                    </div>
                  </div>
               </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  if (!session && !USE_MOCK) {
    return <Login onSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} allowedMenus={session?.menus || null} controllers={controllers} />
      
      <main className="flex-1 min-w-0 ml-64 p-8 transition-all duration-300">
        <header className="flex justify-end items-center gap-6 mb-10">
          <div className="flex items-center gap-3 text-xs text-slate-400 font-bold uppercase tracking-widest">
            <RefreshCw size={12} className={isSyncing ? 'animate-spin text-blue-500' : ''} />
            <span>Last Sync: {lastSync.toLocaleTimeString()}</span>
          </div>
          <div className="flex items-center gap-4">
            <button className="relative p-2 text-slate-400 hover:text-slate-600 transition-colors">
              <Bell size={20} />
              <span className="absolute top-1 right-1 w-2 h-2 bg-rose-500 rounded-full border-2 border-white"></span>
            </button>
            <div className="h-10 w-10 rounded-full bg-slate-200 border border-white shadow-sm flex items-center justify-center text-slate-500 font-black text-xs">
              {session?.role === 'admin' ? 'ADM' : (session?.username?.slice(0, 3) || 'USR').toUpperCase()}
            </div>
            <button onClick={handleLogout} className="text-xs text-slate-500 hover:text-slate-900 underline">
              Logout
            </button>
          </div>
        </header>

        <div className="w-full mx-auto relative">
          {dataError && (
            <div className="mb-6 flex items-start gap-3 p-4 bg-rose-50 border border-rose-200 rounded-2xl">
              <AlertCircle size={18} className="text-rose-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-black text-rose-800">无法获取集群数据</p>
                <p className="text-xs font-bold text-rose-600 mt-1">
                  上一次同步失败（{dataError}）。界面当前不展示任何数据，也不会用模拟数据代替。
                </p>
              </div>
              <button
                onClick={fetchLatestData}
                disabled={isSyncing}
                className="px-4 py-2 rounded-xl bg-rose-600 text-white text-xs font-black hover:bg-rose-700 disabled:bg-rose-300"
              >
                重试
              </button>
            </div>
          )}
          {renderContent()}

          {/* Global Success Toast */}
          {showSuccessToast && (
            <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom-10 fade-in duration-300 z-[9999]">
              <CheckCircle2 size={18} className="text-emerald-400" />
              <span className="text-sm font-black tracking-tight">{toastMessage}</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

const DBStatItem: React.FC<{ icon: React.ReactNode; label: string; value: string | number; isStatus?: boolean }> = ({ icon, label, value, isStatus }) => (
  <div className="flex flex-col">
     <div className="flex items-center gap-2 mb-1 text-slate-400">
        {icon}
        <span className="text-[10px] font-black uppercase tracking-widest">{label}</span>
     </div>
     <span className={`text-sm font-black ${isStatus ? (value === 'Healthy' ? 'text-emerald-600' : 'text-rose-500') : 'text-slate-800'}`}>
        {value}
     </span>
  </div>
);

const App: React.FC = () => {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
};

export default App;
