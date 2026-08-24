import React, { useState, useEffect } from 'react';
import { MessageCircle, Users, Zap, Send, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';

const API_URL = '/api';

function AdminApp() {
  const [token, setToken] = useState(localStorage.getItem('admin_token') || null);

  if (!token) {
    return <AdminLogin setToken={setToken} />;
  }

  return <AdminDashboard token={token} setToken={setToken} />;
}

function AdminLogin({ setToken }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch(`${API_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      localStorage.setItem('admin_token', data.accessToken);
      setToken(data.accessToken);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, var(--brand-deep) 0%, var(--text) 100%)',
    }}>
      <div style={{
        background: 'white', borderRadius: 'var(--r-lg)', padding: '40px', width: '100%', maxWidth: '400px',
        boxShadow: '0 25px 50px rgba(0,0,0,0.4)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ display: 'inline-flex', background: 'var(--brand-deep)', padding: '14px', borderRadius: 'var(--r-lg)', marginBottom: '16px' }}>
            <ShieldAlert size={28} color="white" />
          </div>
          <h2 style={{ margin: 0, fontWeight: 700, fontSize: '22px', color: 'var(--brand-deep)' }}>Master Admin Panel</h2>
          <p style={{ color: 'var(--text-muted)', marginTop: '6px', fontSize: '14px' }}>Restricted access only</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {error && (
            <div style={{ padding: '12px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--r-md)', fontSize: '14px' }}>{error}</div>
          )}
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px', color: 'var(--text)' }}>Username</label>
            <input
              type="text" value={username} onChange={e => setUsername(e.target.value)} required
              style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', fontSize: '14px', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px', color: 'var(--text)' }}>Password</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', fontSize: '14px', boxSizing: 'border-box' }}
            />
          </div>
          <button type="submit" style={{
            padding: '12px', background: 'var(--brand-deep)', color: 'white', border: 'none',
            borderRadius: 'var(--r-md)', fontWeight: 600, fontSize: '15px', cursor: 'pointer', marginTop: '8px',
          }}>
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}

function AdminDashboard({ token, setToken }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = () => {
    setLoading(true);
    fetch(`${API_URL}/admin/dashboard`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
      .then(res => {
        if (res.status === 401 || res.status === 403) {
          localStorage.removeItem('admin_token');
          setToken(null);
          throw new Error('Unauthorized');
        }
        return res.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  };

  useEffect(() => { fetchData(); }, []);

  const handleLogout = () => {
    localStorage.removeItem('admin_token');
    setToken(null);
  };

  const statCardStyle = (color) => ({
    background: 'white', borderRadius: 'var(--r-lg)', padding: '24px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)', borderLeft: `4px solid ${color}`,
    flex: 1, minWidth: '160px',
  });

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-raised)', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{
        background: 'var(--brand-deep)', color: 'white', padding: '0 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: 700, fontSize: '18px' }}>
          <ShieldAlert size={22} />
          WA Reach — Master Admin
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button onClick={fetchData} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', padding: '8px 12px', borderRadius: 'var(--r-md)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={handleLogout} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', padding: '8px 12px', borderRadius: 'var(--r-md)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
            <LogOut size={14} /> Logout
          </button>
        </div>
      </div>

      <div style={{ padding: '32px', maxWidth: '1200px', margin: '0 auto' }}>
        {loading && <p style={{ color: 'var(--text-muted)' }}>Loading dashboard data...</p>}
        {error && <p style={{ color: 'var(--danger)' }}>Error: {error}</p>}

        {data && (
          <>
            {/* Global Stats */}
            <div style={{ display: 'flex', gap: '20px', marginBottom: '32px', flexWrap: 'wrap' }}>
              <div style={statCardStyle('var(--info)')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <Users size={20} color="var(--info)" />
                  <span style={{ color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>Total Users</span>
                </div>
                <div style={{ fontSize: '36px', fontWeight: 800, color: 'var(--brand-deep)' }}>{data.globalStats.totalUsers}</div>
              </div>
              <div style={statCardStyle('var(--success)')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <Zap size={20} color="var(--success)" />
                  <span style={{ color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>Total Automations</span>
                </div>
                <div style={{ fontSize: '36px', fontWeight: 800, color: 'var(--brand-deep)' }}>{data.globalStats.totalAutomations}</div>
              </div>
              <div style={statCardStyle('var(--warning)')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <Send size={20} color="var(--warning)" />
                  <span style={{ color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>Messages Sent</span>
                </div>
                <div style={{ fontSize: '36px', fontWeight: 800, color: 'var(--brand-deep)' }}>{data.globalStats.totalMessagesSent}</div>
              </div>
            </div>

            {/* Users Table */}
            <div style={{ background: 'white', borderRadius: 'var(--r-lg)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--surface-raised)' }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--brand-deep)' }}>All User Accounts</h3>
                <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: '13px' }}>Platform-wide user overview</p>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-sunken)' }}>
                      {['ID', 'Username', 'Email', 'WhatsApp Number', 'Automations', 'Messages Sent'].map(h => (
                        <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((user, i) => (
                      <tr key={user.id} style={{ borderBottom: '1px solid var(--surface-raised)', background: i % 2 === 0 ? 'white' : 'var(--bg)' }}>
                        <td style={{ padding: '14px 16px', color: 'var(--text-faint)', fontWeight: 600 }}>#{user.id}</td>
                        <td style={{ padding: '14px 16px', fontWeight: 700, color: 'var(--brand-deep)' }}>{user.username}</td>
                        <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>{user.email || <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                        <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>{user.personal_whatsapp_number || <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                        <td style={{ padding: '14px 16px' }}>
                          <span style={{ background: 'var(--info-bg)', color: 'var(--info)', padding: '3px 10px', borderRadius: 'var(--r-full)', fontWeight: 600, fontSize: '13px' }}>
                            {user.total_automations}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px' }}>
                          <span style={{ background: 'var(--success-bg)', color: 'var(--success)', padding: '3px 10px', borderRadius: 'var(--r-full)', fontWeight: 600, fontSize: '13px' }}>
                            {user.total_messages}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default AdminApp;
