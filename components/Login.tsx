import React, { useState } from 'react';

interface LoginProps {
  onSuccess: (data: { token: string; role: 'admin' | 'user'; menus: string[] | null; partitions: string[] | null; username: string }) => void;
}

const Login: React.FC<LoginProps> = ({ onSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Login failed');
      onSuccess({ ...data, username });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="bg-white max-w-md w-full rounded-3xl shadow-2xl p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-black text-slate-900">SlurmInsight 登录</h1>
          <p className="text-slate-500 text-sm">请输入账户与密码</p>
        </div>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="text-xs font-black text-slate-500 uppercase">用户名</label>
            <input
              className="mt-1 w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="text-xs font-black text-slate-500 uppercase">密码</label>
            <input
              type="password"
              className="mt-1 w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="text-rose-600 text-sm font-bold">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className={`w-full py-3 rounded-xl text-white font-black text-sm transition-all ${loading ? 'bg-slate-400' : 'bg-blue-600 hover:bg-blue-700 active:scale-95'}`}
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
