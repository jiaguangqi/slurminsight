
import React from 'react';
import { LayoutDashboard, History, Settings, Grid3X3, ListTodo, ShieldCheck } from 'lucide-react';

export const FETCH_INTERVAL_MS = 300000; // 5 minutes
export const STORAGE_KEY = 'slurm_monitor_history_v1';

export const NAVIGATION_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={20} /> },
  { id: 'heatmap', label: 'Node Heatmap', icon: <Grid3X3 size={20} /> },
  { id: 'jobs', label: 'Job Queue', icon: <ListTodo size={20} /> },
  { id: 'history', label: 'History Trends', icon: <History size={20} /> },
  { id: 'services', label: 'Service Health', icon: <ShieldCheck size={20} /> },
  { id: 'settings', label: 'Configuration', icon: <Settings size={20} /> },
];

export const MOCK_PARTITIONS = [
  // CPU Partitions
  { name: '2680v4-28C-256G', type: 'CPU', total: 56 },
  { name: '6126-24C-192G', type: 'CPU', total: 432 },
  { name: '6126-24C-768G', type: 'CPU', total: 48 },
  { name: '6240-36C-192G', type: 'CPU', total: 936 },
  { name: '7495-128C-384G', type: 'CPU', total: 6784 },
  { name: '7542-64C-512G', type: 'CPU', total: 128 },
  { name: '9462-64C-1024G', type: 'CPU', total: 640 },
  { name: '9462-64C-512G', type: 'CPU', total: 1536 },
  { name: 'chenq', type: 'CPU', total: 128 },
  { name: 'dongs', type: 'CPU', total: 512 },
  { name: 'gold01', type: 'CPU', total: 240 },
  { name: 'jlwang', type: 'CPU', total: 1536 },
  { name: 'lingcy', type: 'CPU', total: 640 },
  { name: 'lingcy-7495', type: 'CPU', total: 512 },
  { name: 'liq', type: 'CPU', total: 128 },
  { name: 'mal-7495', type: 'CPU', total: 1280 },
  { name: 'mal', type: 'CPU', total: 768 },
  { name: 'wuyp', type: 'CPU', total: 72 },
  { name: 'yuj-7542', type: 'CPU', total: 128 },
  { name: 'zhouqh', type: 'CPU', total: 256 },
  
  // GPU Partitions (Ensuring jupyter and others are included)
  { name: 'jupyter', type: 'GPU', total: 3 },
  { name: 'gpu_v100', type: 'GPU', total: 78 },
  { name: 'deepseek', type: 'GPU', total: 16 },
  { name: 'gpub', type: 'GPU', total: 48 },
  { name: 'dishimin', type: 'GPU', total: 8 },
  { name: 'fengl', type: 'GPU', total: 8 },
  { name: 'fengl2', type: 'GPU', total: 8 },
  { name: 'luc', type: 'GPU', total: 8 },
  { name: 'lvjq', type: 'GPU', total: 8 },
  { name: 'niqj', type: 'GPU', total: 8 },
  { name: 'normal_test', type: 'GPU', total: 1 },
  { name: 'qigl', type: 'GPU', total: 8 },
];
