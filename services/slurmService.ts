
import { ResourceType, PartitionStats, HistoryRecord, RetentionPeriod, NodeInfo, NodeState, JobInfo } from '../types';
import { STORAGE_KEY, MOCK_PARTITIONS } from '../constants.tsx';
import JSZip from 'jszip';

const CONFIG_KEY = 'slurm_monitor_config';
const API_BASE = (import.meta.env?.VITE_API_BASE as string) || '/api';
export const USE_MOCK = import.meta.env?.VITE_USE_MOCK === 'true';

export interface DBStats {
  engine: string;
  version: string;
  recordCount: number;
  estimatedSizeKB: number;
  lastVacuum: string;
  status: 'Healthy' | 'Warning' | 'Full';
}

class SlurmService {
  private static instance: SlurmService;
  
  private constructor() {}

  private async fetchJSON<T>(path: string): Promise<T> {
    const token = localStorage.getItem('authToken');
    const res = await fetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) {
      const err = new Error(`Request failed: ${res.status} ${res.statusText}`);
      (err as any).status = res.status;
      throw err;
    }
    return res.json();
  }

  public static getInstance(): SlurmService {
    if (!SlurmService.instance) {
      SlurmService.instance = new SlurmService();
    }
    return SlurmService.instance;
  }

  public getRetentionPeriod(): RetentionPeriod {
    const config = localStorage.getItem(CONFIG_KEY);
    if (!config) return RetentionPeriod.ONE_YEAR;
    try {
      return JSON.parse(config).retention || RetentionPeriod.ONE_YEAR;
    } catch {
      return RetentionPeriod.ONE_YEAR;
    }
  }

  public setRetentionPeriod(period: RetentionPeriod): void {
    const config = { retention: period };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    this.pruneHistory();
  }

  private pruneHistory(): void {
    const history = this.getHistory();
    const retentionDays = this.getRetentionPeriod();
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    
    const prunedHistory = history.filter(record => record.timestamp > cutoff);
    if (prunedHistory.length !== history.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prunedHistory));
    }
  }

  public getDBStats(): DBStats {
    const history = this.getHistory();
    const rawData = localStorage.getItem(STORAGE_KEY) || '';
    const sizeKB = (rawData.length * 2) / 1024; // Approximation for UTF-16
    
    return {
      engine: 'LocalStorage Virtual DB',
      version: 'v1.4.2-stable',
      recordCount: history.length,
      estimatedSizeKB: Math.round(sizeKB * 100) / 100,
      lastVacuum: new Date().toLocaleDateString(),
      status: sizeKB > 4000 ? 'Warning' : 'Healthy'
    };
  }

  public async exportDatabase(): Promise<Blob> {
    const zip = new JSZip();
    const data = {
      history: localStorage.getItem(STORAGE_KEY),
      config: localStorage.getItem(CONFIG_KEY),
      exportDate: new Date().toISOString(),
      app: "SlurmInsight"
    };
    
    zip.file("db_backup.json", JSON.stringify(data));
    return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  public async importDatabase(file: File): Promise<void> {
    const zip = await JSZip.loadAsync(file);
    const jsonFile = zip.file("db_backup.json");
    
    if (!jsonFile) {
      throw new Error("Invalid backup file: db_backup.json missing.");
    }
    
    const content = await jsonFile.async("string");
    const data = JSON.parse(content);
    
    if (data.app !== "SlurmInsight") {
      throw new Error("Invalid backup file: App mismatch.");
    }
    
    if (data.history) {
      localStorage.setItem(STORAGE_KEY, data.history);
    }
    if (data.config) {
      localStorage.setItem(CONFIG_KEY, data.config);
    }
  }

  private generateNodesForPartition(partitionName: string, totalCores: number): NodeInfo[] {
    const nodes: NodeInfo[] = [];
    const name = partitionName.toLowerCase();

    const generateRange = (prefix: string, start: number, count: number, padding: number = 2) => {
      const result: string[] = [];
      for (let i = 0; i < count; i++) {
        result.push(`${prefix}${String(start + i).padStart(padding, '0')}`);
      }
      return result;
    };

    let nodeNames: string[] = [];
    if (name === 'gold01') nodeNames = generateRange('c06n', 1, 10);
    else if (name === '6126-24c-192g') nodeNames = [...generateRange('c06n', 11, 3), ...generateRange('c07n', 1, 16).filter(n => n !== 'c07n03')];
    else if (name === 'normal_test') nodeNames = ['fat01'];
    else if (name === '2680v4-28c-256g') nodeNames = ['fat02', 'fat04'];
    else if (name === '6126-24c-768g') nodeNames = ['fat05', 'fat06'];
    else if (name === 'yuj-7542') nodeNames = ['fat07', 'fat10'];
    else if (name === '7542-64c-512g') nodeNames = ['fat08', 'fat09'];
    else if (name === 'jupyter') nodeNames = ['gpu05', 'gpu06', 'gpu14'];
    else if (name === 'gpu_v100') nodeNames = ['gpu07', 'gpu08', 'gpu10', 'gpu11', 'gpu12', 'gpu13', 'gpu18', 'gpu19', 'gpu20', 'gpu23'];
    else if (name === 'luc') nodeNames = ['gpu09'];
    else if (name === 'niqj') nodeNames = ['gpu21'];
    else if (name === 'fengl') nodeNames = ['gpu22'];
    else if (name === 'deepseek') nodeNames = ['h001', 'h006'];
    else if (name === 'gpub') nodeNames = ['h002', 'h003', 'h004', 'h005', 'h008', 'h010'];
    else if (name === 'lvjq') nodeNames = ['h007'];
    else if (name === 'qigl') nodeNames = ['h009'];
    else if (name === 'fengl2') nodeNames = ['h011'];
    else if (name === 'dishimin') nodeNames = ['h012'];
    else if (name === 'dongs') nodeNames = generateRange('phy', 1, 8);
    else if (name === '9462-64c-512g') nodeNames = [...generateRange('phy', 9, 5), ...generateRange('phy', 18, 19)];
    else if (name === 'lingcy') nodeNames = ['phy14', 'phy15', 'phy16', 'phy17', 'phy37', 'phy38', 'phy39', 'phy40', 'phy69', 'phy70'];
    else if (name === '9462-64c-1024g') nodeNames = generateRange('phy', 41, 10);
    else if (name === 'mal') nodeNames = [...generateRange('phy', 51, 10), 'phy67', 'phy68'];
    else if (name === 'zhouqh') nodeNames = generateRange('phy', 61, 4);
    else if (name === 'chenq') nodeNames = ['phy65', 'phy66'];
    else if (name === 'liq') nodeNames = ['phy67', 'phy68'];
    else if (name === '7495-128c-384g') nodeNames = [...generateRange('phy', 100, 41), ...generateRange('phy', 161, 4), ...generateRange('phy', 181, 8)];
    else if (name === 'jlwang') nodeNames = generateRange('phy', 165, 12);
    else if (name === 'lingcy-7495') nodeNames = generateRange('phy', 177, 4);
    else if (name === 'mal-7495') nodeNames = generateRange('phy', 189, 10);
    else if (name === 'wuyp') nodeNames = ['sd01n01', 'sd01n02'];
    else if (name === '6240-36c-192g') nodeNames = [...generateRange('sd', 1, 7).flatMap(s => generateRange(`${s}n`, 1, 4))].map(n => `sd${n}`).filter(n => n !== 'sd01n01' && n !== 'sd01n02');
    else nodeNames = generateRange('node', 1, Math.ceil(totalCores / 24));

    nodeNames.forEach(nodeName => {
      let state: NodeState = 'idle';
      let load = 0;
      let cpus = "0/24/0/24";
      let gres = "(null)";
      let reason = "none";

      if (nodeName.startsWith('c06n')) {
        cpus = "24/0/0/24";
        state = "allocated";
        load = 25;
      } else if (nodeName === 'c06n11') {
        cpus = "20/4/0/24";
        state = "mixed";
        load = 19.77;
      } else if (nodeName.startsWith('c07n')) {
        if (['c07n08', 'c07n09', 'c07n11', 'c07n14'].includes(nodeName)) {
           cpus = "0/24/0/24";
           state = "idle";
           load = 0.05;
        } else {
           cpus = "24/0/0/24";
           state = "allocated";
           load = 25;
        }
      } else if (nodeName.startsWith('fat')) {
        if (nodeName === 'fat01') { cpus = "0/28/0/28"; state = "idle"; gres = "gpu:1"; }
        else if (nodeName === 'fat04') { cpus = "28/0/0/28"; state = "allocated"; load = 28.13; }
        else if (nodeName.startsWith('fat08') || nodeName.startsWith('fat09') || nodeName.startsWith('fat10')) { cpus = "64/0/0/64"; state = "allocated"; load = 60; }
        else { cpus = "0/64/0/64"; state = "idle"; }
      } else if (nodeName.startsWith('gpu')) {
        gres = nodeName === 'gpu05' ? "gpu:3(S:0-1),shard:6(S:0-1)" : "gpu:8";
        state = "mixed";
        load = nodeName === 'gpu05' ? 1.31 : (5 + Math.random() * 20);
        cpus = nodeName === 'gpu05' ? "7/17/0/24" : "12/12/0/24";
        if (nodeName === 'gpu13') { state = "drained"; cpus = "0/0/24/24"; reason = "测试 : Not responding"; }
      } else if (nodeName.startsWith('h')) {
        gres = "gpu:8";
        cpus = "96/0/0/96";
        state = "allocated";
        load = 15;
      } else if (nodeName.startsWith('phy')) {
        const id = parseInt(nodeName.replace('phy', ''));
        if (id >= 100) { cpus = "128/0/0/128"; state = "allocated"; load = 128; }
        else { cpus = "64/0/0/64"; state = "allocated"; load = 64; }
        if ([9, 10, 11, 12, 13, 16, 24, 25, 26, 27, 28, 33, 35, 36, 47, 48, 49, 61, 62, 63, 64, 65, 66].includes(id)) {
           cpus = nodeName.startsWith('phy10') || nodeName.startsWith('phy1') || nodeName.startsWith('phy4') || nodeName.startsWith('phy5') ? "0/128/0/128" : "0/64/0/64";
           state = "idle";
           load = 0.1;
        }
      } else if (nodeName.startsWith('sd')) {
        if (nodeName === 'sd01n03') { state = "drained"; cpus = "0/0/36/36"; reason = "内存异常"; }
        else if (['sd01n01', 'sd01n02'].includes(nodeName)) { cpus = "0/36/0/36"; state = "idle"; load = 0.1; }
        else { cpus = "36/0/0/36"; state = "allocated"; load = 36; }
      }

      nodes.push({ name: nodeName, state, load, cpus, gres, reason });
    });

    return nodes;
  }

  public scrapeCurrentStatusMock(): PartitionStats[] {
    const timestamp = Date.now();
    return MOCK_PARTITIONS.map(p => {
      const nodes = this.generateNodesForPartition(p.name, p.total);
      
      const allocatedCores = nodes.reduce((sum, n) => {
        if (n.state === 'allocated') return sum + (p.total / nodes.length);
        if (n.state === 'mixed') {
           const parts = (n.cpus || "0/0/0/1").split('/');
           const alloc = parseInt(parts[0]);
           const total = parseInt(parts[3]);
           return sum + (alloc / (total || 1)) * (p.total / nodes.length);
        }
        return sum;
      }, 0);

      const utilization = (allocatedCores / p.total) * 100;
      const pending = utilization > 90 ? Math.floor(Math.random() * p.total * 0.4) : 0;

      return {
        id: `${p.name}-${timestamp}`,
        name: p.name,
        type: p.type as ResourceType,
        allocated: Math.floor(allocatedCores),
        total: p.total,
        pending,
        utilization,
        timestamp,
        nodes
      };
    });
  }

  public getJobsMock(): JobInfo[] {
    const baseJobs = [
      { 
        jobId: '597889', name: 'TS1_five_to_fou', partition: '2680v4-28C-256G', user: '230238862', state: 'RUNNING', time: '10:17:09', timeLimit: 'UNLIMITED', nodes: 1, cpus: 28, nodelist: 'fat04', priority: '0.00000023073517', memory: '0',
        reqTres: 'cpu=28,mem=256G,node=1', submitTime: '2026-01-09T08:15:00', endTime: 'Unknown', workDir: '/home/230238862/TS1_simulation'
      },
      { 
        jobId: '598521', name: 'vasp', partition: '7495-128C-384G', user: '220222207', state: 'RUNNING', time: '00:32:32', timeLimit: 'UNLIMITED', nodes: 1, cpus: 128, nodelist: 'phy128', priority: '0.00000064633787', memory: '364800M',
        reqTres: 'billing=128,cpu=128,mem=364800M,node=1', submitTime: '2026-01-10T19:52:05', endTime: 'Unknown', workDir: '/seu_share/home/220222207/workspace/wk3-NJU-ZZJ/surface-structure/Mo2CS2-onsurface-new-anal/condi-with-M-step-monolayer/nanoriboon-monolayer'
      },
      { 
        jobId: '598500', name: 'CASTEP', partition: '6126-24C-192G', user: '230248056', state: 'RUNNING', time: '16:57', timeLimit: 'UNLIMITED', nodes: 1, cpus: 10, nodelist: 'c06n11', priority: '0.00000064633787', memory: '7900M',
        reqTres: 'cpu=10,mem=7900M,node=1', submitTime: '2026-01-10T02:30:12', endTime: 'Unknown', workDir: '/home/230248056/materials/calc_01'
      },
      { 
        jobId: '598389', name: '25Ti', partition: '6126-24C-192G', user: '230258075', state: 'RUNNING', time: '1:40:28', timeLimit: 'UNLIMITED', nodes: 1, cpus: 24, nodelist: 'c06n12', priority: '0.00000042794272', memory: '7900M',
        reqTres: 'cpu=24,mem=7900M,node=1', submitTime: '2026-01-10T17:20:00', endTime: 'Unknown', workDir: '/home/230258075/titanium_project'
      },
      { 
        jobId: '562479', name: 'vasp', partition: '6126-24C-768G', user: 'yunfeichen', state: 'PENDING', time: '0:00', timeLimit: 'UNLIMITED', nodes: 1, cpus: 24, nodelist: '', priority: '0.00000232900493', reason: '等待资源', memory: '0',
        reqTres: 'cpu=24,mem=768G,node=1', submitTime: '2026-01-05T12:00:00', endTime: 'Unknown', workDir: '/home/yunfeichen/job_queue'
      },
      // gpu05 multi-job simulation
      { 
        jobId: '598321', name: 'vscode', partition: 'jupyter', user: '230249453', state: 'RUNNING', time: '4:34:03', timeLimit: '6:00:00', nodes: 1, cpus: 1, nodelist: 'gpu05', priority: '0.00000064168125', memory: '0',
        reqTres: 'gres/shard:1', submitTime: '2026-01-10T15:20:00', endTime: 'Unknown', workDir: '/home/230249453/vscode'
      },
      { 
        jobId: '598277', name: 'vscode', partition: 'jupyter', user: '230248634', state: 'RUNNING', time: '5:20:55', timeLimit: '6:00:00', nodes: 1, cpus: 1, nodelist: 'gpu05', priority: '0.00000058719888', memory: '0',
        reqTres: 'gres/shard:1', submitTime: '2026-01-10T14:30:00', endTime: 'Unknown', workDir: '/home/230248634/vscode'
      },
      { 
        jobId: '598626', name: 'pycharm', partition: 'jupyter', user: 'xiangwenguo', state: 'RUNNING', time: '13:49', timeLimit: '6:00:00', nodes: 1, cpus: 1, nodelist: 'gpu05', priority: '0.00000053853728', memory: '0',
        reqTres: 'gres/shard:1', submitTime: '2026-01-10T19:40:00', endTime: 'Unknown', workDir: '/home/xiangwenguo/projects'
      },
      { 
        jobId: '598300', name: 'vscode', partition: 'jupyter', user: '220245592', state: 'RUNNING', time: '5:01:34', timeLimit: '6:00:00', nodes: 1, cpus: 1, nodelist: 'gpu05', priority: '0.00000032479875', memory: '0',
        reqTres: 'gres/shard:1', submitTime: '2026-01-10T14:50:00', endTime: 'Unknown', workDir: '/home/220245592/vscode'
      },
      { 
        jobId: '598318', name: 'pycharm', partition: 'jupyter', user: '220245021', state: 'RUNNING', time: '4:37:22', timeLimit: '6:00:00', nodes: 1, cpus: 1, nodelist: 'gpu05', priority: '0.00000024260953', memory: '0',
        reqTres: 'gres/shard:1', submitTime: '2026-01-10T15:15:00', endTime: 'Unknown', workDir: '/home/220245021/pycharm'
      },
    ] as JobInfo[];
    return baseJobs;
  }

  public async fetchCurrentStatus(): Promise<PartitionStats[]> {
    if (USE_MOCK) return this.scrapeCurrentStatusMock();
    try {
      return await this.fetchJSON<PartitionStats[]>('/partitions');
    } catch (err) {
      console.error('Failed to fetch partitions from API, falling back to mock data', err);
      return this.scrapeCurrentStatusMock();
    }
  }

  public async fetchJobs(): Promise<JobInfo[]> {
    if (USE_MOCK) return this.getJobsMock();
    try {
      return await this.fetchJSON<JobInfo[]>('/jobs');
    } catch (err) {
      console.error('Failed to fetch jobs from API, falling back to mock data', err);
      return this.getJobsMock();
    }
  }

  public saveRecord(stats: PartitionStats[]): void {
    const history = this.getHistory();
    const recordToSave: HistoryRecord = {
      timestamp: Date.now(),
      partitions: stats.map(({ nodes, ...rest }) => rest) as PartitionStats[]
    };
    
    const retentionDays = this.getRetentionPeriod();
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const updatedHistory = [recordToSave, ...history].filter(record => record.timestamp > cutoff);
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedHistory.slice(0, 5000)));
    } catch (e) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedHistory.slice(0, 500)));
    }
  }

  public getHistory(): HistoryRecord[] {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    try {
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }

  public seedInitialData(): void {
    if (!USE_MOCK) return;
    if (this.getHistory().length > 0) return;
    const history: HistoryRecord[] = [];
    const now = Date.now();
    for (let i = 0; i < 48; i++) {
      const timestamp = now - (i * 30 * 60 * 1000);
      const partitions = MOCK_PARTITIONS.map(p => {
        const utilization = 0.6 + Math.random() * 0.35;
        const allocated = Math.floor(p.total * utilization);
        return {
          id: `${p.name}-${timestamp}`,
          name: p.name,
          type: p.type as ResourceType,
          allocated,
          total: p.total,
          pending: utilization > 0.9 ? Math.floor(p.total * 0.1) : 0,
          utilization: (allocated / p.total) * 100 || 0,
          timestamp,
        };
      });
      history.push({ timestamp, partitions });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.reverse()));
  }
}

export const slurmService = SlurmService.getInstance();
