
export enum ResourceType {
  CPU = 'CPU',
  GPU = 'GPU'
}

export enum RetentionPeriod {
  SIX_MONTHS = 180,
  ONE_YEAR = 365,
  TWO_YEARS = 730
}

export type NodeState = 'idle' | 'allocated' | 'mixed' | 'drained' | 'down' | 'maint';

export interface NodeInfo {
  name: string;
  state: NodeState;
  load: number; // percentage
  reason?: string;
  cpus?: string; // Format: A/I/O/T
  gres?: string; // Format: gpu:X
}

export type JobState = 'RUNNING' | 'PENDING' | 'COMPLETING' | 'CONFIGURING' | 'SUSPENDED';

export interface JobInfo {
  jobId: string;
  name: string;
  partition: string;
  user: string;
  state: JobState;
  time: string;
  timeLimit: string;
  nodes: number;
  cpus: number;
  nodelist: string;
  priority: string;
  reason?: string;
  memory?: string;
  // Detailed fields for sacct-like view
  reqTres?: string;
  submitTime?: string;
  endTime?: string;
  workDir?: string;
  nodesExpanded?: string[];
}

export interface PartitionStats {
  id: string;
  name: string;
  type: ResourceType;
  allocated: number;
  total: number;
  pending: number;
  utilization: number; // percentage
  timestamp: number;
  nodes?: NodeInfo[];
}

export interface HistoryRecord {
  timestamp: number;
  partitions: PartitionStats[];
}

export interface FilterRange {
  start: Date;
  end: Date;
}

export interface UserSession {
  username: string;
  role: 'admin' | 'user';
  menus: string[] | null;
  partitions: string[] | null;
}
