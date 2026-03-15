import React, { useState, useEffect } from 'react';
import {
  MessageCircle, LayoutDashboard, Zap, Activity,
  Settings, Moon, Search, LogOut, Link2Off,
  CheckCircle2, XCircle, Clock, Plus, ArrowRight, ChevronLeft, ChevronRight, AlertTriangle, Trash2
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import { io } from 'socket.io-client';

const API_URL = '/api';
const SOCKET_URL = window.location.origin; // Base URL for socket connection

function App() {
  const [token, setToken] = useState(localStorage.getItem('wa_token') || null);
  const [activeTab, setActiveTab] = useState('dashboard');

  // WA Connection State
  const [isLinked, setIsLinked] = useState(false);
  const [qrCodeData, setQrCodeData] = useState('');
  const [userPhone, setUserPhone] = useState(null);

  // Setup Socket.io connection for real-time updates
  useEffect(() => {
    if (token) {
      console.log('Connecting to Socket.io...');
      const socket = io(SOCKET_URL, {
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        auth: { token }
      });

      socket.on('connect', () => {
        console.log('Socket connected');
      });

      socket.on('wa_status', (data) => {
        console.log('WA Status update received via socket:', data);
        setIsLinked(data.isConnected);
        setQrCodeData(data.currentQR);
        setUserPhone(data.phone);
      });

      socket.on('connect_error', (err) => {
        console.error('Socket connection error:', err);
      });

      return () => {
        socket.disconnect();
      };
    }
  }, [token]);

  const handleLogout = () => {
    localStorage.removeItem('wa_token');
    setToken(null);
    setIsLinked(false);
  };

  const handleWADisconnect = async () => {
    if (!window.confirm("Are you sure you want to disconnect WhatsApp? You will need to scan a new QR code to reconnect.")) return;
    try {
      const res = await fetch(`${API_URL}/wa/disconnect`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setIsLinked(false);
        setQrCodeData('');
        setUserPhone(null);
      } else {
        alert("Failed to disconnect.");
      }
    } catch (e) {
      console.error(e);
    }
  }

  if (!token) {
    return <AuthView setToken={setToken} />;
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <MessageCircle size={24} />
          </div>
          WA Reach
        </div>

        <div className="nav-menu">
          <div
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={20} />
            Dashboard
          </div>
          <div
            className={`nav-item ${activeTab === 'automations' ? 'active' : ''}`}
            onClick={() => setActiveTab('automations')}
          >
            <Zap size={20} />
            Automations
          </div>
          <div
            className={`nav-item ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            <Activity size={20} />
            Activity Logs
          </div>
          <div 
             className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
             onClick={() => setActiveTab('settings')}
          >
            <Settings size={20} />
            Settings
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-footer-title">Status: {isLinked ? 'Connected' : 'Disconnected'}</div>
          {isLinked && (
            <button onClick={handleWADisconnect} style={{ marginTop: '8px', width: '100%', padding: '6px', background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '12px' }}>
              <Link2Off size={14} /> Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="main-wrapper">
        <div className="header">
          <div className="header-title">
            {activeTab === 'dashboard' && 'Dashboard Overview'}
            {activeTab === 'automations' && 'Manage Automations'}
            {activeTab === 'logs' && 'Message Logs'}
            {activeTab === 'settings' && 'User Settings'}
          </div>

          <div className="header-actions">
            <button className="icon-btn">
              <Moon size={20} />
            </button>
            <div className="user-profile">
              <div className="user-info">
                <span className="user-name">User</span>
              </div>
              <button className="icon-btn" onClick={handleLogout} title="Logout" style={{ marginLeft: 8 }}>
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="page-content">
          {!isLinked && activeTab !== 'settings' ? (
            <div className="connect-view">
              <div className="connect-card">
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  <div style={{ background: '#dcf8c6', padding: '16px', borderRadius: '50%', color: '#075e54' }}>
                    <MessageCircle size={40} />
                  </div>
                </div>
                <h2>Connect WhatsApp</h2>
                <p>Scan the QR code below using your WhatsApp mobile app to link WA Reach.</p>

                <div className="qr-box">
                  {qrCodeData ? (
                     <QRCodeSVG value={qrCodeData} size={200} level="L" />
                  ) : (
                    <div className="qr-placeholder-img">
                      <span style={{ color: '#94a3b8', fontSize: '14px' }}>QR Code Loading...</span>
                    </div>
                  )}
                </div>

                <div className="scan-status pending">Waiting for scan...</div>
              </div>
            </div>
          ) : (
            <>
              {activeTab === 'dashboard' && <DashboardView token={token} setActiveTab={setActiveTab} userPhone={userPhone} isLinked={isLinked} />}
              {activeTab === 'automations' && <AutomationsView token={token} />}
              {activeTab === 'logs' && <LogsView token={token} />}
              {activeTab === 'settings' && <SettingsView token={token} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- AUTH VIEW ---
function AuthView({ setToken }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const endpoint = isLogin ? '/login' : '/signup';

    try {
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed');

      if (isLogin) {
        localStorage.setItem('wa_token', data.accessToken);
        setToken(data.accessToken);
      } else {
        setIsLogin(true);
        setError('Signup successful! Please login.');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="sidebar-logo-icon" style={{ background: 'var(--primary)', color: 'white', display: 'inline-flex', padding: 8, borderRadius: 12, marginBottom: 16 }}>
            <MessageCircle size={24} />
          </div>
          <h2>{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
          <p>Sign in to manage your WA Reach automations.</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {error && <div className={`auth-msg ${error.includes('successful') ? 'success' : 'error'}`}>{error}</div>}

          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="admin"
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
            />
          </div>

          <button type="submit" className="btn-primary auth-submit">
            {isLogin ? 'Log In' : 'Sign Up'}
          </button>
        </form>

        <div className="auth-footer">
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <span onClick={() => setIsLogin(!isLogin)} className="text-primary auth-link">
            {isLogin ? 'Sign up' : 'Log in'}
          </span>
        </div>
      </div>
    </div>
  );
}

// --- SUBVIEWS ---

function DashboardView({ token, setActiveTab, userPhone, isLinked }) {
  const [stats, setStats] = useState({ sent: 0, failed: 0, activeAutomations: 0 });
  const [recentAutomations, setRecentAutomations] = useState([]);
  const [recentLogs, setRecentLogs] = useState([]);

  useEffect(() => {
    fetch(`${API_URL}/dashboard/stats`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(res => res.json()).then(data => setStats(prev => ({ ...prev, ...data }))).catch();

    fetch(`${API_URL}/automations`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(res => res.json()).then(data => setRecentAutomations(data.slice(0, 3))).catch();

    fetch(`${API_URL}/logs?limit=4`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(res => res.json()).then(data => setRecentLogs(data.data)).catch();
  }, [token]);

  return (
    <div className="view-container">
      
      {/* Session Status Banner */}
      <div style={{ display: 'flex', alignItems: 'center', background: '#fff', padding: '16px 24px', borderRadius: '12px', border: '1px solid var(--border-color)', marginBottom: '24px', justifyContent: 'space-between' }}>
         <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
             <MessageCircle size={28} color={isLinked ? 'var(--primary)' : '#94a3b8'} />
             <div>
                <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>WhatsApp Session Status</div>
                <div style={{ color: '#64748b', fontSize: '13px' }}>
                   {userPhone ? `Connected as +${userPhone}` : 'No phone linked'}
                </div>
             </div>
         </div>
         <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: isLinked ? 'var(--primary)' : 'var(--danger)' }}></div>
            <span style={{ fontWeight: 600, color: isLinked ? 'var(--primary)' : 'var(--danger)' }}>
                {isLinked ? 'Active' : 'Disconnected / Blocked'}
            </span>
         </div>
      </div>

      <div className="stats-row">
        <div className="stat-box">
          <span className="stat-title">Messages Sent</span>
          <span className="stat-value text-primary">{stats.sent}</span>
        </div>
        <div className="stat-box">
          <span className="stat-title">Failed Delivery</span>
          <span className="stat-value text-danger">{stats.failed}</span>
        </div>
        <div className="stat-box">
          <span className="stat-title">Active Automations</span>
          <span className="stat-value text-main">{stats.activeAutomations}</span>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <div className="card-header">
            <h3>Recent Automations</h3>
            <button className="btn-text" onClick={() => setActiveTab('automations')}>View All <ArrowRight size={16} /></button>
          </div>
          <div className="card-list">
            {recentAutomations.length === 0 ? <p style={{ color: '#94a3b8', fontSize: 14 }}>No automations running.</p> : null}
            {recentAutomations.map(task => (
              <div className="list-item" key={task.id}>
                <div>
                  <div className="item-title">{task.name}</div>
                  <div className="item-sub">Window: {task.start_time} - {task.end_time}</div>
                </div>
                <div className={`status-badge ${task.status === 'Active' ? 'active' : 'paused'}`}>
                  {task.status}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Recent Logs</h3>
            <button className="btn-text" onClick={() => setActiveTab('logs')}>View All <ArrowRight size={16} /></button>
          </div>
          <div className="card-list">
            {recentLogs.length === 0 ? <p style={{ color: '#94a3b8', fontSize: 14 }}>No recent activity.</p> : null}
            {recentLogs.map(log => (
              <div className="list-item" key={log.id}>
                <div>
                  <div className="item-title">{log.contact}</div>
                  <div className="item-sub">{log.workflow || 'Manual'}</div>
                </div>
                <div className={`log-status ${log.status}`}>
                  {log.status === 'delivered' && <CheckCircle2 size={16} />}
                  {log.status === 'read' && <CheckCircle2 size={16} className="text-blue" />}
                  {log.status === 'failed' && <XCircle size={16} />}
                  {log.status === 'pending' && <Clock size={16} />}
                  <span style={{ textTransform: 'capitalize', marginLeft: '4px' }}>{log.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AutomationsView({ token }) {
  const [automations, setAutomations] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', start_time: '09:00', end_time: '17:00', message_template: [], contacts: '', active_days: [1,2,3,4,5] });
  const [editAutomationId, setEditAutomationId] = useState(null);

  const fetchAutomations = () => {
    fetch(`${API_URL}/automations`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(res => res.json()).then(data => setAutomations(data)).catch();
  };

  useEffect(() => {
    fetchAutomations();
  }, [token]);

  const handleEditClick = async (id) => {
    try {
      const res = await fetch(`${API_URL}/automations/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) {
        let data = await res.json();
        
        // ensure backwards compatibility if database had string
        let blocks = data.message_template;
        if (typeof blocks === 'string') {
           blocks = [{ variations: [blocks] }];
        }

        setFormData({
          name: data.name,
          start_time: data.start_time,
          end_time: data.end_time,
          message_template: Array.isArray(blocks) ? blocks : [{ variations: [''] }],
          contacts: data.contacts ? data.contacts.join(', ') : '',
          active_days: data.active_days ? JSON.parse(data.active_days) : [1,2,3,4,5]
        });
        setEditAutomationId(id);
        setShowModal(true);
      } else {
        alert("Failed to fetch automation details.");
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this automation completely?")) return;
    try {
      const res = await fetch(`${API_URL}/automations/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        fetchAutomations();
      } else {
        alert("Failed to delete automation.");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggle = async (id) => {
    try {
      const res = await fetch(`${API_URL}/automations/${id}/toggle`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        fetchAutomations();
      } else {
        alert("Failed to toggle automation.");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setEditAutomationId(null);
    setFormData({ name: '', start_time: '09:00', end_time: '17:00', message_template: [], contacts: '', active_days: [1,2,3,4,5] });
  };

  const handleAddBlock = () => {
     setFormData({ ...formData, message_template: [...formData.message_template, { variations: [''] }] });
  };

  const handleRemoveBlock = (index) => {
     const newBlocks = [...formData.message_template];
     newBlocks.splice(index, 1);
     setFormData({ ...formData, message_template: newBlocks });
  };

  const handleAddVariation = (blockIndex) => {
     const newBlocks = [...formData.message_template];
     newBlocks[blockIndex].variations.push('');
     setFormData({ ...formData, message_template: newBlocks });
  };

  const handleRemoveVariation = (blockIndex, varIndex) => {
     const newBlocks = [...formData.message_template];
     newBlocks[blockIndex].variations.splice(varIndex, 1);
     setFormData({ ...formData, message_template: newBlocks });
  };

  const handleVariationChange = (blockIndex, varIndex, value) => {
     const newBlocks = [...formData.message_template];
     newBlocks[blockIndex].variations[varIndex] = value;
     setFormData({ ...formData, message_template: newBlocks });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const contactList = formData.contacts.split(',').map(s => s.trim()).filter(Boolean);
    if (contactList.length === 0) return alert("Please enter at least one contact phone number.");

    if (formData.message_template.length === 0) return alert("Please add at least one message block.");
    for (const b of formData.message_template) {
       if (b.variations.filter(v => v.trim()).length === 0) {
           return alert("Every message block must have at least one non-empty variation.");
       }
    }

    const endpoint = editAutomationId ? `${API_URL}/automations/${editAutomationId}` : `${API_URL}/automations`;
    const method = editAutomationId ? 'PUT' : 'POST';

    try {
      const res = await fetch(endpoint, {
        method: method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...formData, contacts: contactList, clientOffset: new Date().getTimezoneOffset() })
      });
      if (res.ok) {
        closeModal();
        fetchAutomations();
      } else {
        const d = await res.json();
        alert(d.error || 'Failed to save automation');
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="view-container">
      <div className="card full-width">
        <div className="card-header" style={{ alignItems: 'center' }}>
          <div className="card-title-group">
            <h3>All Workflows</h3>
            <p className="card-desc">Manage your intelligent message flows and triggers.</p>
          </div>
          <button className="btn-primary" onClick={() => { setEditAutomationId(null); setFormData(f => ({...f, message_template: [{ variations: [''] }]})); setShowModal(true); }}>
            <Plus size={16} /> New Automation
          </button>
        </div>

        <div className="automation-grid">
          {automations.length === 0 ? <p style={{ color: '#94a3b8', fontSize: 14 }}>No automations found. Create one to get started.</p> : null}
          {automations.map(task => (
            <div className="automation-card" key={task.id}>
              <div className="auto-card-top">
                <div className="auto-icon">
                  <MessageCircle size={20} />
                </div>
                <div className={`status-label ${task.status.toLowerCase()}`}>{task.status}</div>
              </div>
              <h4>{task.name}</h4>
              <div className="auto-card-stats">
                <div>
                  <span className="lbl">Window:</span> {task.start_time} - {task.end_time}
                </div>
                <div>
                  <span className="lbl">Queue size:</span> {task.count}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                <button className="btn-outline" style={{ flex: 1, color: task.status === 'Active' ? 'var(--danger)' : 'var(--primary)', borderColor: task.status === 'Active' ? 'var(--danger)' : 'var(--primary)' }} onClick={() => handleToggle(task.id)}>
                   {task.status === 'Active' ? 'Stop' : 'Start'}
                </button>
                <button className="btn-outline" style={{ flex: 1 }} onClick={() => handleEditClick(task.id)}>Edit</button>
                <button className="btn-outline" style={{ color: 'var(--danger)', borderColor: 'var(--danger)', padding: '0 12px' }} onClick={() => handleDelete(task.id)}>
                   <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '650px', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ marginBottom: '16px' }}>{editAutomationId ? 'Edit Automation Rule' : 'Create Automation Rule'}</h2>

            <div className="alert-box warning">
              <AlertTriangle size={18} />
              <div>
                <strong>Safe Sending Guidelines</strong>
                <p>To avoid WhatsApp banning your number from automated systems:</p>
                <ul style={{ marginLeft: '20px', marginTop: '4px' }}>
                  <li>We send your grouped messages concurrently but randomize intervals inside your overall window.</li>
                  <li>Use Variations! Our system will pick a random variation from a block to make chats look organic.</li>
                </ul>
              </div>
            </div>

            <form onSubmit={handleSubmit} style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Automation Name</label>
                <input type="text" required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Daily Promo Broadcast" />
              </div>

              <div style={{ display: 'flex', gap: '16px' }}>
                <div className="form-group" style={{ flex: 1, margin: 0 }}>
                  <label>Start Time</label>
                  <input type="time" required value={formData.start_time} onChange={e => setFormData({ ...formData, start_time: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1, margin: 0 }}>
                  <label>End Time</label>
                  <input type="time" required value={formData.end_time} onChange={e => setFormData({ ...formData, end_time: e.target.value })} />
                </div>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Days to Run</label>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((dayChar, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        const newDays = formData.active_days.includes(i) 
                          ? formData.active_days.filter(d => d !== i) 
                          : [...formData.active_days, i].sort();
                        setFormData({ ...formData, active_days: newDays });
                      }}
                      style={{
                        width: '32px', height: '32px', borderRadius: '50%', border: 'none',
                        backgroundColor: formData.active_days.includes(i) ? '#dcfce7' : '#f1f5f9',
                        color: formData.active_days.includes(i) ? '#15803d' : '#94a3b8',
                        fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.2s'
                      }}
                    >
                      {dayChar}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Contacts (Comma separated numeric strings)</label>
                <textarea
                  required
                  rows={3}
                  placeholder="e.g. 15551234567, 44207946, 91987654321"
                  value={formData.contacts}
                  onChange={e => setFormData({ ...formData, contacts: e.target.value })}
                  style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', resize: 'vertical' }}
                />
              </div>

              {/* Dynamic Multiple Messages + Variations Component */}
              <div className="form-group" style={{ margin: 0 }}>
                 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label style={{ margin: 0 }}>Message Sequence</label>
                    <button type="button" className="btn-text" onClick={handleAddBlock} style={{ color: 'var(--primary)', fontWeight: 600, fontSize: '13px' }}>
                       + Add Message Block
                    </button>
                 </div>
                 <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '12px' }}>
                    Multiple Blocks will be sent independently one after another as sequential messages. Adding variations to a block prevents account bans.
                 </div>

                 {formData.message_template.map((block, blockIndex) => (
                    <div key={blockIndex} style={{ border: '1px solid var(--border-color)', background: '#f8fafc', padding: '16px', borderRadius: '8px', marginBottom: '12px' }}>
                       <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                          <h4 style={{ margin: 0, fontSize: '14px', color: '#334155' }}>Message Block {blockIndex + 1}</h4>
                          {formData.message_template.length > 1 && (
                             <button type="button" onClick={() => handleRemoveBlock(blockIndex)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0 }}>
                                Remove
                             </button>
                          )}
                       </div>

                       {block.variations.map((varText, varIndex) => (
                           <div key={varIndex} style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'flex-start' }}>
                              <textarea
                                required
                                rows={2}
                                placeholder={`Variation ${varIndex + 1} for block ${blockIndex + 1}...`}
                                value={varText}
                                onChange={(e) => handleVariationChange(blockIndex, varIndex, e.target.value)}
                                style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', resize: 'vertical', fontSize: '13px' }}
                              />
                              {block.variations.length > 1 && (
                                <button type="button" onClick={() => handleRemoveVariation(blockIndex, varIndex)} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '6px', borderRadius: '6px', color: '#64748b', cursor: 'pointer' }}>
                                   <XCircle size={16} />
                                </button>
                              )}
                           </div>
                       ))}
                       <button type="button" className="btn-text" onClick={() => handleAddVariation(blockIndex)} style={{ fontSize: '12px', color: '#475569' }}>
                          + Add Variation
                       </button>
                    </div>
                 ))}
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button type="button" className="btn-outline" onClick={closeModal}>Cancel</button>
                <button type="submit" className="btn-primary">{editAutomationId ? 'Save Changes' : 'Activate Automation'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function LogsView({ token }) {
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1, limit: 10 });
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/logs?page=${page}&limit=10`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        setLogs(data.data);
        setPagination(data.pagination);
      })
      .catch();
  }, [page, token]);

  const currentData = logs.filter(log => (log.contact || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="view-container">
      <div className="card full-width" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="card-header">
          <div className="card-title-group">
            <h3>Messaging Activity</h3>
            <p className="card-desc">Detailed logs of all inbound and outbound messages.</p>
          </div>
          <div className="search-box">
            <Search size={16} />
            <input type="text" placeholder="Search phone number..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <div style={{ flexGrow: 1 }}>
          <table className="logs-table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Target Time</th>
              </tr>
            </thead>
            <tbody>
              {currentData.length === 0 ? <tr><td colSpan={4} style={{ textAlign: 'center', color: '#94a3b8' }}>No logs found.</td></tr> : null}
              {currentData.map(log => (
                <tr key={log.id}>
                  <td className="log-contact">{log.contact}</td>
                  <td className="log-flow">{log.workflow || 'Manual API'}</td>
                  <td>
                    <span className={`badge badge-${log.status}`}>
                      {log.status}
                    </span>
                    {log.error_reason && <span style={{ display: 'block', fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>{log.error_reason}</span>}
                  </td>
                  <td className="log-time">{new Date(log.sent_time).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        <div className="pagination">
          <span className="page-info">Showing {logs.length} entries (Page {page} of {pagination.totalPages || 1})</span>
          <div className="page-actions">
            <button
              className="btn-outline btn-sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft size={16} /> Previous
            </button>
            <span className="page-number">{page} / {pagination.totalPages || 1}</span>
            <button
              className="btn-outline btn-sm"
              onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
              disabled={page >= pagination.totalPages}
            >
              Next <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsView({ token }) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState({ text: '', type: '' });

  useEffect(() => {
     fetch(`${API_URL}/settings`, { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => {
           if(d.email) setEmail(d.email);
           if(d.personal_whatsapp_number) setPhone(d.personal_whatsapp_number);
        }).catch(console.error);
  }, [token]);

  const handleSave = async (e) => {
     e.preventDefault();
     setMsg({ text: '', type: '' });
     try {
       const res = await fetch(`${API_URL}/settings`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email, personal_whatsapp_number: phone })
       });
       if(res.ok) {
          setMsg({ text: 'Settings saved successfully!', type: 'success' });
       } else {
          setMsg({ text: 'Failed to save settings.', type: 'error' });
       }
     } catch(e) {
       setMsg({ text: e.message, type: 'error' });
     }
  };

  return (
    <div className="view-container">
       <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
          <div className="card-header">
             <div className="card-title-group">
                <h3>Account Settings</h3>
                <p className="card-desc">Update your personal preferences and contact details.</p>
             </div>
           </div>
           <form style={{ padding: '24px' }} onSubmit={handleSave}>
             {msg.text && (
                <div style={{ padding: '12px', background: msg.type==='success'?'#dcfce7':'#fee2e2', color: msg.type==='success'?'#15803d':'#b91c1c', borderRadius: '8px', marginBottom: '16px' }}>
                   {msg.text}
                </div>
             )}

             {/* Notification info banner */}
             <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
               <span style={{ fontSize: '18px', lineHeight: 1 }}>🔔</span>
               <div style={{ fontSize: '13px', color: '#0369a1' }}>
                 <strong>Notification Settings</strong><br />
                 The details below are used to send you <strong>daily campaign summary reports</strong> via WhatsApp — including total messages sent, failed deliveries, and campaign timings — once each automation finishes for the day.
               </div>
             </div>

             <div className="form-group">
                <label>Email Address</label>
                <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="hello@company.com" style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)'}}/>
                <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#94a3b8' }}>Reserved for future email notifications. Optional.</p>
             </div>
             
             <div className="form-group" style={{ marginTop: '16px' }}>
                <label>Personal WhatsApp Number</label>
                <input type="text" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="e.g. 15551234567" style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)'}}/>
                <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#94a3b8' }}>Enter your number with country code but <strong>without</strong> the +. E.g. for +91 98765 43210 enter <code>919876543210</code>. Daily campaign summaries will be sent here once all messages are dispatched.</p>
             </div>

             <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end' }}>
                <button type="submit" className="btn-primary">Save Settings</button>
             </div>
          </form>
       </div>
    </div>
  );
}

export default App;
