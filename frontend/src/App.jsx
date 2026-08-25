import React, { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  MessageCircle, LayoutDashboard, Zap, Activity,
  Settings, Moon, Sun, Menu, Inbox, Search, LogOut, Link2Off,
  CheckCircle2, XCircle, Clock, Plus, ArrowRight, ChevronLeft, ChevronRight, AlertTriangle, Trash2,
  Upload, Paperclip, Users, Pencil, Ban, ShieldCheck
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { WhatsAppGlyph, Logo } from './components/Brand';
import InboxView from './components/InboxView';
import ErrorBoundary from './components/ErrorBoundary';
import AppHeader from './components/AppHeader';
import ProfileView from './components/ProfileView';
import NotFound from './components/NotFound';
import { useConfirm } from './components/ui/ConfirmDialog';
import ResponseSummary from './components/ResponseSummary';
import ActivityFeed from './components/ActivityFeed';
import ApiKeyPanel from './components/ApiKeyPanel';

import { io } from 'socket.io-client';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea
} from 'recharts';

const API_URL = '/api';
const SOCKET_URL = window.location.origin;

// Helper to get local timezone and region info
const getTimezoneInfo = () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = new Date().getTimezoneOffset();
  const absOffset = Math.abs(offset);
  const sign = offset > 0 ? '-' : '+';
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const mins = String(absOffset % 60).padStart(2, '0');
  const gmt = `GMT${sign}${hours}:${mins}`;

  // Mapping for country name and flag based on common timezone cities
  let flag = '🌍';
  let country = '';
  
  if (tz.includes('Kolkata')) { flag = '🇮🇳'; country = 'India'; }
  else if (tz.includes('Dubai') || tz.includes('Abu_Dhabi')) { flag = '🇦🇪'; country = 'UAE'; }
  else if (tz.includes('London')) { flag = '🇬🇧'; country = 'UK'; }
  else if (tz.includes('New_York') || tz.includes('Chicago') || tz.includes('Los_Angeles')) { flag = '🇺🇸'; country = 'USA'; }
  else if (tz.includes('Singapore')) { flag = '🇸🇬'; country = 'Singapore'; }
  else if (tz.includes('Sydney')) { flag = '🇦🇺'; country = 'Australia'; }
  
  return { gmt, flag, country };
};

const TIMEZONES = [
  { label: 'GMT-12:00', offset: 720 },
  { label: 'GMT-11:00', offset: 660 },
  { label: 'GMT-10:00 (Hawaii)', offset: 600 },
  { label: 'GMT-09:00 (Alaska)', offset: 540 },
  { label: 'GMT-08:00 (Pacific Time)', offset: 480 },
  { label: 'GMT-07:00 (Mountain Time)', offset: 420 },
  { label: 'GMT-06:00 (Central Time)', offset: 360 },
  { label: 'GMT-05:00 (Eastern Time)', offset: 300 },
  { label: 'GMT-04:00 (Atlantic Time)', offset: 240 },
  { label: 'GMT-03:00 (Brasilia)', offset: 180 },
  { label: 'GMT-02:00 (Mid-Atlantic)', offset: 120 },
  { label: 'GMT-01:00 (Azores)', offset: 60 },
  { label: 'GMT+00:00 (London)', offset: 0 },
  { label: 'GMT+01:00 (Berlin, Paris)', offset: -60 },
  { label: 'GMT+02:00 (Cairo, Jerusalem)', offset: -120 },
  { label: 'GMT+03:00 (Moscow, Riyadh)', offset: -180 },
  { label: 'GMT+03:30 (Tehran)', offset: -210 },
  { label: 'GMT+04:00 (Dubai)', offset: -240 },
  { label: 'GMT+04:30 (Kabul)', offset: -270 },
  { label: 'GMT+05:00 (Karachi)', offset: -300 },
  { label: 'GMT+05:30 (India)', offset: -330 },
  { label: 'GMT+05:45 (Kathmandu)', offset: -345 },
  { label: 'GMT+06:00 (Dhaka)', offset: -360 },
  { label: 'GMT+06:30 (Yangon)', offset: -390 },
  { label: 'GMT+07:00 (Bangkok, Jakarta)', offset: -420 },
  { label: 'GMT+08:00 (Beijing, Singapore)', offset: -480 },
  { label: 'GMT+09:00 (Tokyo, Seoul)', offset: -540 },
  { label: 'GMT+09:30 (Adelaide)', offset: -570 },
  { label: 'GMT+10:00 (Sydney)', offset: -600 },
  { label: 'GMT+11:00 (Solomon Is.)', offset: -660 },
  { label: 'GMT+12:00 (Auckland)', offset: -720 },
];

// Top-level router: clinic SSO dashboard vs the normal app.
// Which URL maps to which screen. Navigation used to be a useState value, so
// the URL was always "/" — nothing could be linked or bookmarked, refresh
// always dumped you on the dashboard, and browser Back left the app entirely.
const TABS = ['dashboard', 'inbox', 'automations', 'contacts', 'logs', 'settings', 'profile'];
const pathToTab = (pathname) => {
  const seg = pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  if (!seg) return 'dashboard';
  return TABS.includes(seg) ? seg : null;   // null = unknown path
};
const tabToPath = (tab) => (tab === 'dashboard' ? '/' : `/${tab}`);

function App() {
  const location = useLocation();

  if (location.pathname.startsWith('/clinic')) {
    const ssoToken = new URLSearchParams(location.search).get('token');
    return <ClinicDashboard ssoToken={ssoToken} />;
  }
  return <MainApp />;
}

function MainApp() {
  const [token, setToken] = useState(localStorage.getItem('wa_token') || null);
  const location = useLocation();
  const navigate = useNavigate();
  const resolvedTab = pathToTab(location.pathname);
  const activeTab = resolvedTab || 'dashboard';
  const notFound = resolvedTab === null;
  const setActiveTab = useCallback((tab) => navigate(tabToPath(tab)), [navigate]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [socketRef, setSocketRef] = useState(null);
  const [me, setMe] = useState(null);
  const confirmDisconnect = useConfirm();

  // Who is signed in, which workspace, and which number is connected.
  const loadMe = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API_URL}/account/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setMe(await r.json());
      else if (r.status === 401) handleLogout();
    } catch { /* leave the shell usable */ }
  }, [token]);
  useEffect(() => { loadMe(); }, [loadMe]);
  const [unread, setUnread] = useState(0);

  // Colour theme. Default follows the OS; an explicit choice is remembered and
  // stamped on <html> so the CSS [data-theme] blocks win over the media query.
  // Storage can throw in private windows, so every access is guarded.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('wa_theme') || 'system'; } catch { return 'system'; }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem('wa_theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const prefersDark = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const effectiveTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  const toggleTheme = () => setTheme(effectiveTheme === 'dark' ? 'light' : 'dark');

  // WA Connection State
  const [isLinked, setIsLinked] = useState(false);
  const [qrCodeData, setQrCodeData] = useState('');
  const [userPhone, setUserPhone] = useState(null);

  // Notifications State
  const [notifications, setNotifications] = useState([]);

  // Toasts were built inline inside the socket handler; this is the same
  // behaviour as a callable so other code paths can raise one too.
  const addNotification = useCallback((type, message) => {
    const id = Date.now() + Math.random();
    setNotifications((prev) => [...prev, { type, message, id }]);
    setTimeout(() => setNotifications((prev) => prev.filter((n) => n.id !== id)), 5000);
  }, []);

  // Setup Socket.io connection for real-time updates
  useEffect(() => {
    if (token) {
      console.log('Connecting to Socket.io...');
      let socket;
      socket = io(SOCKET_URL, {
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

      setSocketRef(socket);

      // A patient replying should be visible immediately, wherever you are.
      socket.on('inbound_message', (msg) => {
        setUnread((n) => n + 1);
        const who = msg.name && msg.name !== 'Unknown' ? msg.name : `+${msg.from}`;
        const label = msg.intent === 'confirm' ? 'confirmed'
          : msg.intent === 'opt_out' ? 'opted out'
          : msg.intent === 'reschedule' ? 'asked to reschedule'
          : msg.intent === 'cancel' ? 'cancelled'
          : 'replied';
        addNotification(msg.intent === 'confirm' ? 'success' : msg.intent === 'opt_out' ? 'warning' : 'info',
          `${who} ${label}`);
      });

      socket.on('notification', (data) => {
        console.log('New notification received:', data);
        addNotification(data.type, data.message);
      });

      socket.on('connect_error', (err) => {
        console.error('Socket connection error:', err);
      });

      return () => {
        setSocketRef(null);
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
    const ok = await confirmDisconnect({
      title: 'Disconnect WhatsApp?',
      body: 'Messages stop sending until you scan a new QR code to reconnect.',
      confirmLabel: 'Disconnect', danger: true,
    });
    if (!ok) return;
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
        addNotification('error', 'Could not disconnect WhatsApp.');
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
      {/* Notifications Portal */}
      <div className="notifications-container">
        {notifications.map(n => (
          <div key={n.id} className={`notification-toast ${n.type}`}>
            <div className="notification-icon">
              {n.type === 'success' && <CheckCircle2 size={20} className="text-success" />}
              {n.type === 'error' && <XCircle size={20} className="text-danger" />}
              {n.type === 'warning' && <AlertTriangle size={20} className="text-warning" />}
            </div>
            <div className="notification-content">
              <div className="notification-title">{n.type.toUpperCase()}</div>
              <div className="notification-message">{n.message}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Sidebar */}
      <div className={`sidebar-backdrop${sidebarOpen ? ' show' : ''}`} onClick={() => setSidebarOpen(false)} />
      <div className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <Logo size={22} showText={false} />
          WA Reach
        </div>

        <nav className="nav-menu" aria-label="Main">
          <div className="nav-section">Overview</div>
          <button
            type="button"
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setSidebarOpen(false) || setActiveTab('dashboard')}
            aria-current={activeTab === 'dashboard' ? 'page' : undefined}
          >
            <LayoutDashboard size={19} />
            Dashboard
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === 'inbox' ? 'active' : ''}`}
            onClick={() => { setSidebarOpen(false); setUnread(0); setActiveTab('inbox'); }}
            aria-current={activeTab === 'inbox' ? 'page' : undefined}
          >
            <Inbox size={19} />
            Inbox
            {unread > 0 && <span className="inbox-unread" style={{ marginLeft: 'auto' }}>{unread}</span>}
          </button>

          <div className="nav-section">Messaging</div>
          <button
            type="button"
            className={`nav-item ${activeTab === 'automations' ? 'active' : ''}`}
            onClick={() => setSidebarOpen(false) || setActiveTab('automations')}
            aria-current={activeTab === 'automations' ? 'page' : undefined}
          >
            <Zap size={19} />
            Automations
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === 'contacts' ? 'active' : ''}`}
            onClick={() => setSidebarOpen(false) || setActiveTab('contacts')}
            aria-current={activeTab === 'contacts' ? 'page' : undefined}
          >
            <Users size={19} />
            Contacts
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setSidebarOpen(false) || setActiveTab('logs')}
            aria-current={activeTab === 'logs' ? 'page' : undefined}
          >
            <Activity size={19} />
            Activity Logs
          </button>

          <div className="nav-section">Settings &amp; Help</div>
          <button
             type="button"
             className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
             onClick={() => setSidebarOpen(false) || setActiveTab('settings')}
             aria-current={activeTab === 'settings' ? 'page' : undefined}
          >
            <Settings size={19} />
            Settings
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-title">Status: {isLinked ? 'Connected' : 'Disconnected'}</div>
          {isLinked && (
            <button onClick={handleWADisconnect} style={{ marginTop: '8px', width: '100%', padding: '6px', background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', borderRadius: 'var(--r-md)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '12px' }}>
              <Link2Off size={14} /> Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="main-wrapper">
        <AppHeader
          title={{
            dashboard: 'Dashboard', automations: 'Automations', contacts: 'Contacts',
            inbox: 'Inbox', logs: 'Message Logs', settings: 'Settings', profile: 'Your Profile',
          }[activeTab] || 'WA Reach'}
          me={me}
          isLinked={isLinked}
          userPhone={userPhone}
          effectiveTheme={effectiveTheme}
          onToggleTheme={toggleTheme}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onNavigate={(tab) => { setSidebarOpen(false); setActiveTab(tab); }}
          onLogout={handleLogout}
        />

        <div className="page-content">
        <ErrorBoundary>
          {notFound ? (
            <NotFound onHome={() => setActiveTab('dashboard')} />
          ) : !isLinked && !['settings', 'contacts', 'inbox', 'profile'].includes(activeTab) ? (
            <div className="connect-view">
              <div className="connect-card">
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  <WhatsAppGlyph size={64} />
                </div>
                <h2>Connect WhatsApp</h2>
                <p>Scan the QR code below using your WhatsApp mobile app to link WA Reach.</p>

                <div className="qr-box">
                  {qrCodeData ? (
                     <QRCodeSVG value={qrCodeData} size={200} level="L" />
                  ) : (
                    <div className="qr-placeholder-img">
                      <span style={{ color: 'var(--text-faint)', fontSize: '14px' }}>QR Code Loading...</span>
                    </div>
                  )}
                </div>

                <div className={`scan-status ${qrCodeData ? 'pending' : ''}`}>
                  {qrCodeData ? 'Waiting for scan...' : 'Generating code...'}
                </div>
              </div>
            </div>
          ) : (
            <>
              {activeTab === 'dashboard' && <DashboardView token={token} setActiveTab={setActiveTab} userPhone={userPhone} isLinked={isLinked} socket={socketRef} />}
              {activeTab === 'automations' && <AutomationsView token={token} onToast={addNotification} />}
              {activeTab === 'contacts' && <ContactsView token={token} onToast={addNotification} />}
              {activeTab === 'inbox' && (
                <InboxView
                  apiUrl={API_URL}
                  token={token}
                  socket={socketRef}
                  onToast={(type, msg) => addNotification(type, msg)}
                />
              )}
              {activeTab === 'logs' && <LogsView token={token} />}
              {activeTab === 'settings' && <SettingsView token={token} />}
              {activeTab === 'profile' && (
                <ProfileView
                  apiUrl={API_URL}
                  token={token}
                  onToast={addNotification}
                  onProfileSaved={loadMe}
                />
              )}
            </>
          )}
        </ErrorBoundary>
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
        // Previously only the token was kept, so the app never knew who was
        // signed in — the header literally rendered the string "User".
        if (data.refresh_token) localStorage.setItem('wa_refresh', data.refresh_token);
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
          <div className="auth-logo-text">
            <Logo size={24} showText={false} />
            WA Reach
          </div>
          <h2>{isLogin ? 'Welcome Back' : 'Get Started'}</h2>
          <p>{isLogin ? 'Enter your credentials to access your account.' : 'Create an account to start automating your WhatsApp.'}</p>
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
              placeholder="Enter username"
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

          <button type="submit" className="btn-primary auth-submit" style={{ padding: '14px', fontSize: '16px' }}>
            {isLogin ? 'Log In to WA Reach' : 'Create Account'}
          </button>
        </form>

        <div className="auth-footer">
          {isLogin ? "New to WA Reach? " : "Already have an account? "}
          <span onClick={() => setIsLogin(!isLogin)} className="text-primary auth-link">
            {isLogin ? 'Create Account' : 'Sign in instead'}
          </span>
        </div>
      </div>
    </div>
  );
}

// --- SUBVIEWS ---

function DashboardView({ token, setActiveTab, userPhone, isLinked, socket }) {
  const [stats, setStats] = useState({ sent: 0, failed: 0, activeAutomations: 0 });
  const [graphData, setGraphData] = useState([]);
  const [recentAutomations, setRecentAutomations] = useState([]);
  const [recentLogs, setRecentLogs] = useState([]);

  useEffect(() => {
    const fetchSafe = (url, setter) => {
      fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
        .then(res => {
          if (!res.ok) throw new Error('Network response was not ok');
          return res.json();
        })
        .then(data => setter(data))
        .catch(err => console.error(`Fetch error for ${url}:`, err));
    };

    fetchSafe(`${API_URL}/dashboard/stats`, data => setStats(prev => ({ ...prev, ...data })));
    fetchSafe(`${API_URL}/dashboard/graph-data`, setGraphData);
    fetchSafe(`${API_URL}/automations`, data => setRecentAutomations((data || []).slice(0, 3)));
    fetchSafe(`${API_URL}/logs?limit=4&status=delivered,read,sent,failed`, data => setRecentLogs(data ? (data.data || []) : []));
  }, [token]);

  // Custom tool tip for the wave graph
  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div style={{ background: 'var(--surface)', padding: '10px', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
          <p style={{ fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>{label}</p>
          <p style={{ color: 'var(--brand)' }}>Sent: {payload[0].value} messages</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="view-container">
      
      {/* Session Status Banner */}
      <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface)', padding: '16px 24px', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', marginBottom: '8px', justifyContent: 'space-between' }}>
         <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
             <MessageCircle size={28} color={isLinked ? 'var(--brand)' : 'var(--text-faint)'} />
             <div>
                <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '15px' }}>WhatsApp Session Status</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                   {userPhone ? `Connected as +${userPhone}` : 'No phone linked'}
                </div>
             </div>
         </div>
         <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: isLinked ? 'var(--brand)' : 'var(--danger)' }}></div>
            <span style={{ fontWeight: 600, color: isLinked ? 'var(--brand)' : 'var(--danger)' }}>
                {isLinked ? 'Active' : 'Disconnected / Blocked'}
            </span>
         </div>
      </div>

      <ResponseSummary apiUrl={API_URL} token={token} socket={socket} />

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

      {/* Wave Graph Implementation */}
      <div className="graph-container">
        <div className="graph-header">
           <div className="graph-title">Message Activity (Last 24h)</div>
           <div className="graph-legend">
              <div className="legend-item">
                 <div className="legend-color" style={{ background: 'rgba(37, 211, 102, 0.2)' }}></div>
                 <span>Activity</span>
              </div>
              <div className="legend-item">
                 <div className="legend-color" style={{ background: 'rgba(30, 41, 59, 0.05)' }}></div>
                 <span>Night Hours (8PM-6AM)</span>
              </div>
           </div>
        </div>
        <div style={{ width: '100%', height: 300 }}>
          <ResponsiveContainer>
            <AreaChart data={graphData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--brand)" stopOpacity={0.4}/>
                  <stop offset="95%" stopColor="var(--brand)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
              <XAxis 
                dataKey="time" 
                axisLine={false} 
                tickLine={false} 
                tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
                interval={3}
              />
              <YAxis 
                axisLine={false} 
                tickLine={false} 
                tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
              />
              <Tooltip content={<CustomTooltip />} />
              
              {/* Highlight Night Hours */}
              {graphData.map((d, index) => {
                if (d.isNight) {
                   return (
                     <ReferenceArea 
                       key={index}
                       x1={d.time} 
                       x2={graphData[index+1]?.time || d.time} 
                       fill="rgba(30, 41, 59, 0.04)"
                       strokeOpacity={0}
                     />
                   )
                }
                return null;
              })}

              <Area 
                type="monotone" 
                dataKey="count" 
                stroke="var(--brand)" 
                strokeWidth={3}
                fillOpacity={1} 
                fill="url(#colorCount)" 
                animationDuration={1500}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 18, marginBottom: 18 }} className="dashboard-grid">
        <ActivityFeed apiUrl={API_URL} token={token} socket={socket} limit={10} />
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <div className="card-header">
            <h3>Recent Automations</h3>
            <button className="btn-text" onClick={() => setActiveTab('automations')}>View All <ArrowRight size={16} /></button>
          </div>
          <div className="card-list">
            {recentAutomations.length === 0 ? <p style={{ color: 'var(--text-faint)', fontSize: 14 }}>No automations running.</p> : null}
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
            {recentLogs.length === 0 ? <p style={{ color: 'var(--text-faint)', fontSize: 14 }}>No recent activity.</p> : null}
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


function AutomationsView({ token, onToast }) {
  const confirm = useConfirm();
  const [automations, setAutomations] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', start_time: '09:00', end_time: '17:00', message_template: [], contacts: '', active_days: [1,2,3,4,5], timezone_offset: new Date().getTimezoneOffset(), ask_confirmation: false });
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
          active_days: data.active_days ? JSON.parse(data.active_days) : [1,2,3,4,5],
          ask_confirmation: !!data.ask_confirmation,
          timezone_offset: data.timezone_offset !== undefined ? data.timezone_offset : new Date().getTimezoneOffset()
        });
        setEditAutomationId(id);
        setShowModal(true);
      } else {
        onToast('error', 'Could not load that automation.');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Delete this automation?',
      body: 'Any messages still queued for it will be cancelled. This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API_URL}/automations/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        fetchAutomations();
      } else {
        onToast('error', 'Could not delete the automation.');
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
        onToast('error', 'Could not change the automation status.');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setEditAutomationId(null);
    setFormData({ name: '', start_time: '09:00', end_time: '17:00', message_template: [], contacts: '', active_days: [1,2,3,4,5], timezone_offset: new Date().getTimezoneOffset(), ask_confirmation: false });
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

  const handleAttachMedia = async (blockIndex, file) => {
     if (!file) return;
     if (file.size > 20 * 1024 * 1024) return onToast('error', 'Attachment must be under 20MB.');
     const body = new FormData();
     body.append('file', file);
     try {
        const res = await fetch(`${API_URL}/media`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body });
        const d = await res.json();
        if (!res.ok) return onToast('error', d.error || 'Upload failed.');
        const newBlocks = [...formData.message_template];
        newBlocks[blockIndex] = { ...newBlocks[blockIndex], media_id: d.id, media_name: d.original_name, media_mime: d.mimetype };
        setFormData({ ...formData, message_template: newBlocks });
     } catch (e) {
        onToast('error', 'Upload failed.');
     }
  };

  const handleRemoveMedia = (blockIndex) => {
     const newBlocks = [...formData.message_template];
     const b = { ...newBlocks[blockIndex] };
     delete b.media_id; delete b.media_name; delete b.media_mime;
     newBlocks[blockIndex] = b;
     setFormData({ ...formData, message_template: newBlocks });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const contactList = formData.contacts.split(',').map(s => s.trim()).filter(Boolean);
    if (contactList.length === 0) return onToast('warning', 'Add at least one contact number.');

    if (formData.message_template.length === 0) return onToast('warning', 'Add at least one message block.');
    for (const b of formData.message_template) {
       const hasText = (b.variations || []).filter(v => v.trim()).length > 0;
       if (!hasText && !b.media_id) {
           return onToast('warning', 'Every block needs a message or an attachment.');
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
        body: JSON.stringify({ ...formData, contacts: contactList, clientOffset: parseInt(formData.timezone_offset) })
      });
      if (res.ok) {
        closeModal();
        fetchAutomations();
      } else {
        const d = await res.json();
        onToast('error', d.error || 'Could not save the automation.');
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
          <button className="btn-primary" onClick={() => { setEditAutomationId(null); setFormData({ name: '', start_time: '09:00', end_time: '17:00', message_template: [{ variations: [''] }], contacts: '', active_days: [1,2,3,4,5], timezone_offset: new Date().getTimezoneOffset(), ask_confirmation: false }); setShowModal(true); }}>
            <Plus size={16} /> New Automation
          </button>
        </div>

        <div className="automation-grid">
          {automations.length === 0 ? <p style={{ color: 'var(--text-faint)', fontSize: 14 }}>No automations found. Create one to get started.</p> : null}
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
                {task.timezone_offset !== undefined && (
                  <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: '4px' }}>
                    <Clock size={10} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                    Timezone: GMT{task.timezone_offset <= 0 ? '+' : '-'}{Math.floor(Math.abs(task.timezone_offset)/60)}:{String(Math.abs(task.timezone_offset)%60).padStart(2, '0')}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                <button className="btn-outline" style={{ flex: 1, color: task.status === 'Active' ? 'var(--danger)' : 'var(--brand)', borderColor: task.status === 'Active' ? 'var(--danger)' : 'var(--brand)' }} onClick={() => handleToggle(task.id)}>
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
                <label>Timezone</label>
                <select 
                  value={formData.timezone_offset} 
                  onChange={e => setFormData({ ...formData, timezone_offset: parseInt(e.target.value) })}
                  style={{ width: '100%', padding: '10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', outline: 'none', background: 'var(--surface)' }}
                >
                  {TIMEZONES.map(tz => (
                    <option key={tz.offset} value={tz.offset}>{tz.label}</option>
                  ))}
                </select>
                {editAutomationId && (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Note: Adjusting timezone will reschedule upcoming messages.
                  </div>
                )}
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
                        backgroundColor: formData.active_days.includes(i) ? 'var(--success-bg)' : 'var(--surface-raised)',
                        color: formData.active_days.includes(i) ? 'var(--success)' : 'var(--text-faint)',
                        fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.2s'
                      }}
                    >
                      {dayChar}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label>Reply options</label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={!!formData.ask_confirmation}
                    onChange={(e) => setFormData({ ...formData, ask_confirmation: e.target.checked })}
                  />
                  <span>
                    <strong>Ask for confirmation</strong>
                    <em>Sends the last message with tappable Confirm / Reschedule / Cancel buttons. Replies show up in your Inbox and against the contact.</em>
                  </span>
                </label>
              </div>


              <div className="form-group" style={{ margin: 0 }}>
                <label>Contacts (Comma separated numeric strings)</label>
                <textarea
                  required
                  rows={3}
                  placeholder="e.g. 15551234567, 44207946, 91987654321"
                  value={formData.contacts}
                  onChange={e => setFormData({ ...formData, contacts: e.target.value })}
                  style={{ width: '100%', padding: '10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', resize: 'vertical' }}
                />
              </div>

              {/* Dynamic Multiple Messages + Variations Component */}
              <div className="form-group" style={{ margin: 0 }}>
                 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label style={{ margin: 0 }}>Message Sequence</label>
                    <button type="button" className="btn-text" onClick={handleAddBlock} style={{ color: 'var(--brand)', fontWeight: 600, fontSize: '13px' }}>
                       + Add Message Block
                    </button>
                 </div>
                 <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '12px' }}>
                    Multiple Blocks will be sent independently one after another as sequential messages. Adding variations to a block prevents account bans.
                 </div>

                 {formData.message_template.map((block, blockIndex) => (
                    <div key={blockIndex} style={{ border: '1px solid var(--border)', background: 'var(--surface-sunken)', padding: '16px', borderRadius: 'var(--r-md)', marginBottom: '12px' }}>
                       <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                          <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--text)' }}>Message Block {blockIndex + 1}</h4>
                          {formData.message_template.length > 1 && (
                             <button type="button" onClick={() => handleRemoveBlock(blockIndex)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0 }}>
                                Remove
                             </button>
                          )}
                       </div>

                       {block.variations.map((varText, varIndex) => (
                           <div key={varIndex} style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'flex-start' }}>
                              <textarea
                                rows={2}
                                placeholder={block.media_id ? `Caption variation ${varIndex + 1} (optional)...` : `Variation ${varIndex + 1} for block ${blockIndex + 1}...`}
                                value={varText}
                                onChange={(e) => handleVariationChange(blockIndex, varIndex, e.target.value)}
                                style={{ flex: 1, padding: '10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border-strong)', resize: 'vertical', fontSize: '13px' }}
                              />
                              {block.variations.length > 1 && (
                                <button type="button" onClick={() => handleRemoveVariation(blockIndex, varIndex)} style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', padding: '6px', borderRadius: 'var(--r-md)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                                   <XCircle size={16} />
                                </button>
                              )}
                           </div>
                       ))}
                       <button type="button" className="btn-text" onClick={() => handleAddVariation(blockIndex)} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          + Add Variation
                       </button>

                       {/* Attachment (image / PDF / video) — text variations become the caption */}
                       <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed var(--border)' }}>
                          {block.media_id ? (
                             <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--info-bg)', border: '1px solid var(--info-border)', borderRadius: 'var(--r-md)', padding: '8px 12px' }}>
                                <Paperclip size={15} color="var(--info)" />
                                <span style={{ flex: 1, fontSize: '13px', color: 'var(--info)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                   {block.media_name || 'Attachment'}
                                   <span style={{ color: 'var(--info)', marginLeft: '6px', fontSize: '11px' }}>({(block.media_mime || '').split('/')[1] || 'file'})</span>
                                </span>
                                <button type="button" onClick={() => handleRemoveMedia(blockIndex)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '12px' }}>Remove</button>
                             </div>
                          ) : (
                             <label className="btn-text" style={{ fontSize: '12px', color: 'var(--info)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                <Paperclip size={14} /> Attach image / PDF / video
                                <input type="file" accept="image/*,video/*,audio/*,application/pdf" style={{ display: 'none' }} onChange={(e) => handleAttachMedia(blockIndex, e.target.files?.[0])} />
                             </label>
                          )}
                       </div>
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
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1, limit: 15 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('delivered');
  const [loading, setLoading] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState([]);

  const toggleExpand = (id) => {
    setExpandedLogs(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/logs?page=${page}&limit=${pagination.limit}&status=${statusFilter}`, { 
      headers: { 'Authorization': `Bearer ${token}` } 
    })
      .then(res => {
        if (!res.ok) throw new Error('Network response was not ok');
        return res.json();
      })
      .then(data => {
        if (!data) return;
        if (page === 1) {
          setLogs(data.data || []);
        } else {
          setLogs(prev => [...prev, ...(data.data || [])]);
        }
        setPagination(data.pagination || { total: 0, totalPages: 1, limit: 15 });
        setLoading(false);
      })
      .catch((err) => {
        console.error('Logs fetch error:', err);
        setLoading(false);
      });
  }, [page, statusFilter, token]);

  const handleFilterChange = (status) => {
    setStatusFilter(status);
    setPage(1);
    setLogs([]);
  };

  const currentData = logs.filter(log => (log.contact || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="view-container">
      <div className="card full-width" style={{ display: 'flex', flexDirection: 'column', minHeight: '500px' }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: '16px' }}>
          <div className="card-title-group">
            <h3>Messaging Activity</h3>
            <p className="card-desc">Detailed logs of all inbound and outbound messages.</p>
          </div>
          
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <div className="filter-box">
               <select 
                 value={statusFilter} 
                 onChange={(e) => handleFilterChange(e.target.value)}
                 style={{ padding: '8px 12px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', outline: 'none', fontSize: '14px', background: 'var(--surface)' }}
               >
                 <option value="all">All Status</option>
                 <option value="delivered">Delivered</option>
                 <option value="failed">Failed</option>
                 <option value="pending">Pending</option>
               </select>
            </div>

            <div className="search-box" style={{ margin: 0 }}>
              <Search size={16} />
              <input type="text" placeholder="Search phone..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </div>

        <div style={{ flexGrow: 1, overflowX: 'auto' }}>
          <table className="logs-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}></th>
                <th>Contact</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Reply</th>
                <th>Target Time</th>
              </tr>
            </thead>
            <tbody>
              {currentData.length === 0 && !loading ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-faint)', padding: '40px' }}>No logs found.</td></tr>
              ) : null}
              {currentData.map((log, idx) => {
                const isExpanded = expandedLogs.includes(log.id);
                return (
                  <React.Fragment key={`${log.id}-${idx}`}>
                    <tr onClick={() => log.content && toggleExpand(log.id)} style={{ cursor: log.content ? 'pointer' : 'default' }}>
                      <td>
                        {log.content && (
                          <div style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            <ChevronRight size={16} />
                          </div>
                        )}
                      </td>
                      <td className="log-contact">{log.contact}</td>
                      <td className="log-flow">{log.workflow || 'Manual API'}</td>
                      <td>
                        <span className={`badge badge-${log.status}`}>
                          {log.status}
                        </span>
                        {log.error_reason && <span style={{ display: 'block', fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>{log.error_reason}</span>}
                      </td>
                      <td>
                        {log.response ? (
                          <span className={`badge badge-${log.response === 'confirm' ? 'delivered' : log.response === 'cancel' ? 'failed' : 'pending'}`}>
                            {log.response === 'confirm' ? 'Confirmed'
                              : log.response === 'reschedule' ? 'Reschedule'
                              : log.response === 'cancel' ? 'Cancelled' : log.response}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>—</span>
                        )}
                        {log.delivery_status && (
                          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3, textTransform: 'capitalize' }}>
                            {log.delivery_status}
                          </span>
                        )}
                      </td>
                      <td className="log-time">{new Date(log.sent_time).toLocaleString()}</td>
                    </tr>
                    {isExpanded && log.content && (
                      <tr className="expanded-row">
                        <td></td>
                        <td colSpan={5} style={{ padding: '0 16px 16px' }}>
                          <div style={{ background: 'var(--surface-raised)', padding: '12px', borderRadius: 'var(--r-md)', fontSize: '13px', color: 'var(--text)', borderLeft: '4px solid var(--brand)', whiteSpace: 'pre-wrap' }}>
                             {log.content}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Load More Control */}
        {page < pagination.totalPages && (
          <div style={{ padding: '24px', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button 
              className="btn-outline" 
              onClick={() => setPage(p => p + 1)} 
              disabled={loading}
              style={{ padding: '10px 32px' }}
            >
              {loading ? 'Loading...' : 'Load More Activity'}
            </button>
          </div>
        )}
        
        <div style={{ padding: '12px 24px', fontSize: '13px', color: 'var(--text-faint)', borderTop: '1px solid var(--border)', background: 'var(--surface-sunken)', borderRadius: '0 0 12px 12px' }}>
          Showing {currentData.length} of {pagination.total} total logs{search ? ' (filtered)' : ''}
        </div>
      </div>
    </div>
  );
}

function SettingsView({ token }) {
  const [activeTab, setActiveTab] = useState('account');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState({ text: '', type: '' });
  const [notifLogs, setNotifLogs] = useState([]);

  useEffect(() => {
     fetch(`${API_URL}/settings`, { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => {
           if(d.email) setEmail(d.email);
           if(d.personal_whatsapp_number) setPhone(d.personal_whatsapp_number);
        }).catch(console.error);

     fetch(`${API_URL}/notifications/logs`, { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => setNotifLogs(Array.isArray(d) ? d : []))
        .catch(console.error);
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
       <div className="card" style={{ maxWidth: '800px', width: '100%', margin: '0 auto' }}>
          <div className="card-header" style={{ display: 'block', paddingBottom: 0 }}>
             {/* Tabs Navigation */}
             <div style={{ display: 'flex', gap: '24px', borderBottom: '1px solid var(--border)' }}>
                <button 
                  onClick={() => setActiveTab('account')}
                  style={{ 
                    padding: '8px 4px 12px', 
                    border: 'none', 
                    background: 'none', 
                    color: activeTab === 'account' ? 'var(--brand)' : 'var(--text-muted)', 
                    borderBottom: activeTab === 'account' ? '2px solid var(--brand)' : '2px solid transparent',
                    fontWeight: activeTab === 'account' ? '600' : '500', 
                    cursor: 'pointer',
                    fontSize: '14px',
                    transition: 'all 0.2s'
                  }}
                >
                  Account Settings
                </button>
                <button
                  onClick={() => setActiveTab('logs')}
                  style={{ 
                    padding: '8px 4px 12px', 
                    border: 'none', 
                    background: 'none', 
                    color: activeTab === 'logs' ? 'var(--brand)' : 'var(--text-muted)', 
                    borderBottom: activeTab === 'logs' ? '2px solid var(--brand)' : '2px solid transparent',
                    fontWeight: activeTab === 'logs' ? '600' : '500', 
                    cursor: 'pointer',
                    fontSize: '14px',
                    transition: 'all 0.2s'
                  }}
                >
                  Notification Log
                </button>
                <button
                  onClick={() => setActiveTab('api')}
                  style={{
                    padding: '8px 4px 12px',
                    border: 'none',
                    background: 'none',
                    color: activeTab === 'api' ? 'var(--brand)' : 'var(--text-muted)',
                    borderBottom: activeTab === 'api' ? '2px solid var(--brand)' : '2px solid transparent',
                    fontWeight: activeTab === 'api' ? '600' : '500',
                    cursor: 'pointer',
                    fontSize: '14px',
                    transition: 'all 0.2s'
                  }}
                >
                  API
                </button>
             </div>
           </div>

           {activeTab === 'api' ? (
             <div style={{ padding: '24px' }}>
               <ApiKeyPanel apiUrl={API_URL} token={token} />
             </div>
           ) : activeTab === 'account' ? (
             <form style={{ padding: '24px' }} onSubmit={handleSave}>
               {msg.text && (
                  <div style={{ padding: '12px', background: msg.type==='success'?'var(--success-bg)':'var(--danger-bg)', color: msg.type==='success'?'var(--success)':'var(--danger)', borderRadius: 'var(--r-md)', marginBottom: '16px' }}>
                     {msg.text}
                  </div>
               )}

               <div style={{ background: 'var(--info-bg)', border: '1px solid var(--info-border)', borderRadius: 'var(--r-md)', padding: '12px 16px', marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                 <span style={{ fontSize: '18px', lineHeight: 1 }}>🔔</span>
                 <div style={{ fontSize: '13px', color: 'var(--info)' }}>
                   <strong>System Alerts</strong><br />
                   Configure where you receive daily startup alerts and campaign summaries.
                 </div>
               </div>

               <div className="form-group">
                  <label>Email Address</label>
                  <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="hello@company.com" style={{ width: '100%', padding: '10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)'}}/>
                  <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--text-faint)' }}>Used for system notifications and summaries.</p>
               </div>
               
               <div className="form-group" style={{ marginTop: '16px' }}>
                  <label>Personal WhatsApp Number</label>
                  <input type="text" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="e.g. 919876543210" style={{ width: '100%', padding: '10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)'}}/>
                  <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--text-faint)' }}>Include country code (e.g. 91xxxxxxxxxx).</p>
               </div>

               <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn-primary">Save Changes</button>
               </div>
             </form>
           ) : (
             <div style={{ padding: '24px', overflowX: 'auto' }}>
                <table className="logs-table">
                   <thead>
                      <tr>
                         <th>Type</th>
                         <th>Event</th>
                         <th>Recipient</th>
                         <th>Time</th>
                         <th>Status</th>
                      </tr>
                   </thead>
                   <tbody>
                      {notifLogs.length === 0 ? (
                         <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-faint)', padding: '40px' }}>No notification history yet.</td></tr>
                      ) : (
                         notifLogs.map(log => (
                            <tr key={log.id}>
                               <td style={{ textTransform: 'capitalize' }}>{log.type}</td>
                               <td style={{ fontSize: '13px' }}>
                                  {log.category === 'start_alert' ? '🚀 Startup Alert' : '🏁 Daily Summary'}
                               </td>
                               <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{log.recipient}</td>
                               <td style={{ fontSize: '12px' }}>{new Date(log.sent_at).toLocaleString()}</td>
                               <td>
                                  <span className={`badge badge-${log.status}`}>
                                     {log.status}
                                  </span>
                               </td>
                            </tr>
                         ))
                      )}
                   </tbody>
                </table>
             </div>
           )}
       </div>
    </div>
  );
}

// --- READ-ONLY CLINIC DASHBOARD (SSO from MolarPlus) ---
function ClinicDashboard({ ssoToken }) {
  const [status, setStatus] = useState(null);
  const [qr, setQr] = useState(null);
  const [stats, setStats] = useState({});
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const authHeaders = { 'Authorization': `Bearer ${ssoToken}` };

  const loadStatus = () => {
    fetch(`${API_URL}/clinic/status`, { headers: authHeaders })
      .then(r => { if (r.status === 401 || r.status === 403) throw new Error('expired'); return r.json(); })
      .then(d => { setStatus(d); if (!d || d.status !== 'connected') loadQr(); })
      .catch(e => setError(e.message === 'expired' ? 'This link has expired. Please reopen it from MolarPlus.' : 'Could not load status.'));
  };
  const loadQr = () => {
    fetch(`${API_URL}/clinic/qr`, { headers: authHeaders }).then(r => r.json()).then(d => setQr(d.qr)).catch(() => {});
  };
  const loadStats = () => {
    fetch(`${API_URL}/clinic/stats`, { headers: authHeaders }).then(r => r.json()).then(setStats).catch(() => {});
  };
  const loadMessages = () => {
    fetch(`${API_URL}/clinic/messages?limit=25`, { headers: authHeaders }).then(r => r.json())
      .then(d => setMessages(d.data || [])).catch(() => {});
  };

  useEffect(() => {
    if (!ssoToken) { setError('Missing access token.'); setLoading(false); return; }
    loadStatus(); loadStats(); loadMessages();
    setLoading(false);
    // poll status while pairing / for live updates
    const t = setInterval(() => { loadStatus(); }, 6000);
    const t2 = setInterval(() => { loadStats(); loadMessages(); }, 20000);
    return () => { clearInterval(t); clearInterval(t2); };
  }, [ssoToken]);

  const connected = status && status.status === 'connected';
  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '20px 24px' };

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 24 }}>
        <div style={{ ...card, maxWidth: 420, textAlign: 'center' }}>
          <AlertTriangle size={32} color="var(--danger)" />
          <h3 style={{ margin: '12px 0 6px' }}>Can’t open dashboard</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '24px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div style={{ background: 'var(--brand)', color: 'var(--surface)', display: 'flex', padding: 8, borderRadius: 'var(--r-lg)' }}>
            <MessageCircle size={24} fill="currentColor" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text)' }}>WhatsApp by WA Reach</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Read-only overview {status && status.phone_number ? `· +${status.phone_number}` : ''}</div>
          </div>
        </div>

        {/* Connection status */}
        <div style={{ ...card, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: connected ? 'var(--brand)' : 'var(--danger)' }} />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text)' }}>{connected ? 'Connected' : (status ? status.status : 'Loading…')}</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{connected ? `Linked as +${status.phone_number}` : 'Scan the QR to link your WhatsApp number'}</div>
            </div>
          </div>
        </div>

        {/* QR if not connected */}
        {!connected && qr && (
          <div style={{ ...card, marginBottom: 16, textAlign: 'center' }}>
            <h3 style={{ marginBottom: 8 }}>Link your WhatsApp</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>WhatsApp → Settings → Linked Devices → Link a Device, then scan:</p>
            <img src={qr} alt="QR" style={{ width: 240, height: 240, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)' }} />
          </div>
        )}

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
          {[
            { label: 'Total sent', value: stats.sent || 0, color: 'var(--brand)' },
            { label: 'Delivered', value: stats.delivered || 0, color: 'var(--info)' },
            { label: 'Read', value: stats.read || 0, color: 'var(--success)' },
            { label: 'Failed', value: stats.failed || 0, color: 'var(--danger)' },
            { label: 'Today', value: stats.today || 0, color: 'var(--text-muted)' },
          ].map(s => (
            <div key={s.label} style={{ ...card, padding: '16px 18px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.label}</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Message log */}
        <div style={{ ...card, padding: 0 }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', fontWeight: 600, color: 'var(--text)' }}>Recent messages</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="logs-table">
              <thead>
                <tr><th>To</th><th>Message</th><th>Status</th><th>Time</th></tr>
              </thead>
              <tbody>
                {messages.length === 0 ? (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-faint)', padding: 40 }}>No messages yet.</td></tr>
                ) : messages.map(m => (
                  <tr key={m.id}>
                    <td>+{m.to_number}</td>
                    <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.has_media ? '📎 ' : ''}{m.body || (m.has_media ? '[attachment]' : '')}
                    </td>
                    <td><span className={`badge badge-${m.status}`}>{m.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 13 }}>{new Date(m.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: 12, marginTop: 16 }}>
          Read-only view · powered by WA Reach
        </div>
      </div>
    </div>
  );
}

// --- CONTACTS VIEW ---
function ContactsView({ token, onToast }) {
  const confirm = useConfirm();
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState({ text: '', type: '' });
  const [modal, setModal] = useState(null); // { mode:'add'|'edit', id?, name, phone }
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [saving, setSaving] = useState(false);

  const authHeaders = { 'Authorization': `Bearer ${token}` };

  const [checking, setChecking] = useState(false);

  // Ask WhatsApp which of these numbers actually exist, rather than finding out
  // by burning sends on them — repeated failures are themselves a ban signal.
  const checkNumbers = async () => {
    setChecking(true);
    try {
      const r = await fetch(`${API_URL}/contacts/validate`, { method: 'POST', headers: authHeaders });
      const d = await r.json();
      if (!r.ok) {
        setBanner({ text: d.error || 'Could not check numbers', type: 'error' });
      } else {
        setBanner({
          text: d.invalid > 0
            ? `Checked ${d.checked} numbers — ${d.invalid} not on WhatsApp.`
            : `Checked ${d.checked} numbers — all valid.`,
          type: d.invalid > 0 ? 'error' : 'success',
        });
        fetchContacts();
      }
    } finally {
      setChecking(false);
      setTimeout(() => setBanner({ text: '', type: '' }), 5000);
    }
  };

  const toggleOptOut = async (c) => {
    const next = Number(c.opted_out) === 1 ? false : true;
    const r = await fetch(`${API_URL}/contacts/${c.id}/optout`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ opted_out: next }),
    });
    if (r.ok) {
      setBanner({ text: next ? 'Contact opted out — queued messages cancelled.' : 'Contact opted back in.', type: 'success' });
      fetchContacts();
      setTimeout(() => setBanner({ text: '', type: '' }), 4000);
    }
  };

  const fetchContacts = (q = '') => {
    setLoading(true);
    fetch(`${API_URL}/contacts${q ? `?search=${encodeURIComponent(q)}` : ''}`, { headers: authHeaders })
      .then(r => r.json())
      .then(d => { setContacts(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchContacts(); }, [token]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => fetchContacts(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const flash = (text, type = 'success') => { setBanner({ text, type }); setTimeout(() => setBanner({ text: '', type: '' }), 4000); };

  const saveContact = async (e) => {
    e.preventDefault();
    if (!modal.phone.trim()) return flash('Phone number is required', 'error');
    setSaving(true);
    const isEdit = modal.mode === 'edit';
    try {
      const res = await fetch(`${API_URL}/contacts${isEdit ? `/${modal.id}` : ''}`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modal.name, phone: modal.phone })
      });
      const d = await res.json();
      if (!res.ok) return flash(d.error || 'Failed to save', 'error');
      setModal(null);
      flash(isEdit ? 'Contact updated' : 'Contact added');
      fetchContacts(search.trim());
    } catch (err) { flash('Failed to save', 'error'); }
    finally { setSaving(false); }
  };

  const deleteContact = async (c) => {
    const ok = await confirm({
      title: `Delete ${c.name || c.phone}?`,
      body: 'Their message history stays, but they are removed from your contacts.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const res = await fetch(`${API_URL}/contacts/${c.id}`, { method: 'DELETE', headers: authHeaders });
    if (res.ok) { flash('Contact deleted'); fetchContacts(search.trim()); }
    else flash('Failed to delete', 'error');
  };

  // Parse pasted text: each line "name, phone" or "phone" (commas or tabs as separators)
  const runImport = async () => {
    const rows = importText.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const parts = line.split(/[,\t]/).map(s => s.trim());
      if (parts.length >= 2) return { name: parts[0], phone: parts[1] };
      return { name: '', phone: parts[0] };
    });
    if (rows.length === 0) return flash('Nothing to import', 'error');
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/contacts/bulk`, {
        method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: rows })
      });
      const d = await res.json();
      if (!res.ok) return flash(d.error || 'Import failed', 'error');
      setShowImport(false); setImportText('');
      flash(`Imported ${d.added} contact${d.added === 1 ? '' : 's'}${d.skipped ? `, skipped ${d.skipped}` : ''}`);
      fetchContacts(search.trim());
    } catch (e) { flash('Import failed', 'error'); }
    finally { setSaving(false); }
  };

  const inputStyle = { width: '100%', padding: '10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' };

  return (
    <div className="view-container">
      <div className="card full-width" style={{ display: 'flex', flexDirection: 'column', minHeight: '500px' }}>
        <div className="card-header" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div className="card-title-group">
            <h3>Contacts</h3>
            <p className="card-desc">{contacts.length} contact{contacts.length === 1 ? '' : 's'} — manage your patient list.</p>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="search-box" style={{ margin: 0 }}>
              <Search size={16} />
              <input type="text" placeholder="Search name or number…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <button
              className="btn-outline"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={checkNumbers}
              disabled={checking}
              title="Check which numbers are registered on WhatsApp"
            >
              <ShieldCheck size={16} /> {checking ? 'Checking…' : 'Check numbers'}
            </button>
            <button className="btn-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }} onClick={() => setShowImport(true)}>
              <Upload size={16} /> Import
            </button>
            <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }} onClick={() => setModal({ mode: 'add', name: '', phone: '' })}>
              <Plus size={16} /> Add Contact
            </button>
          </div>
        </div>

        {banner.text && (
          <div style={{ margin: '0 0 16px', padding: '12px', background: banner.type === 'success' ? 'var(--success-bg)' : 'var(--danger-bg)', color: banner.type === 'success' ? 'var(--success)' : 'var(--danger)', borderRadius: 'var(--r-md)' }}>
            {banner.text}
          </div>
        )}

        <div style={{ flexGrow: 1, overflowX: 'auto' }}>
          <table className="logs-table">
            <thead>
              <tr><th>Name</th><th>Phone</th><th style={{ width: 120, textAlign: 'right' }}>Actions</th></tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-faint)', padding: 40 }}>Loading…</td></tr>
              ) : contacts.length === 0 ? (
                <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-faint)', padding: 40 }}>
                  {search ? 'No contacts match your search.' : 'No contacts yet. Add one or import a list.'}
                </td></tr>
              ) : contacts.map(c => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500 }}>{c.name || <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                  <td>
                    +{c.phone}
                    <span style={{ display: 'inline-flex', gap: 6, marginLeft: 8, verticalAlign: 'middle' }}>
                      {Number(c.opted_out) === 1 && (
                        <span className="badge badge-failed" title="This contact asked to stop receiving messages">
                          <Ban size={11} /> Opted out
                        </span>
                      )}
                      {c.wa_valid === 0 && (
                        <span className="badge badge-pending" title="Not registered on WhatsApp — sends to this number will fail">
                          <AlertTriangle size={11} /> Not on WhatsApp
                        </span>
                      )}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button title="Edit" onClick={() => setModal({ mode: 'edit', id: c.id, name: c.name || '', phone: c.phone })}
                      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 6, cursor: 'pointer', marginRight: 6, color: 'var(--text-muted)' }}>
                      <Pencil size={15} />
                    </button>
                    <button
                      title={Number(c.opted_out) === 1 ? 'Allow messages again' : 'Stop messaging this contact'}
                      onClick={() => toggleOptOut(c)}
                      style={{
                        background: Number(c.opted_out) === 1 ? 'var(--success-bg)' : 'var(--surface-raised)',
                        border: `1px solid ${Number(c.opted_out) === 1 ? 'var(--success-border)' : 'var(--border)'}`,
                        borderRadius: 'var(--r-md)', padding: 6, cursor: 'pointer', marginRight: 6,
                        color: Number(c.opted_out) === 1 ? 'var(--success)' : 'var(--text-muted)',
                      }}
                    >
                      <Ban size={15} />
                    </button>
                    <button title="Delete" onClick={() => deleteContact(c)}
                      style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 'var(--r-md)', padding: 6, cursor: 'pointer', color: 'var(--danger)' }}>
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit modal */}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-content" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginBottom: 16 }}>{modal.mode === 'edit' ? 'Edit Contact' : 'Add Contact'}</h2>
            <form onSubmit={saveContact} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Name</label>
                <input style={inputStyle} value={modal.name} onChange={e => setModal({ ...modal, name: e.target.value })} placeholder="e.g. Priya Sharma" />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Phone (with country code)</label>
                <input style={inputStyle} value={modal.phone} onChange={e => setModal({ ...modal, phone: e.target.value })} placeholder="e.g. 919876543210" />
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                <button type="button" className="btn-outline" onClick={() => setModal(null)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import modal */}
      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)}>
          <div className="modal-content" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginBottom: 8 }}>Import Contacts</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
              Paste one contact per line as <strong>Name, Number</strong> (or just the number). Country code included, e.g. <code>Priya, 919876543210</code>. Duplicates are skipped.
            </p>
            <textarea rows={8} value={importText} onChange={e => setImportText(e.target.value)}
              placeholder={"Priya Sharma, 919876543210\nRahul, 919812345678\n918887776655"}
              style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="btn-outline" onClick={() => setShowImport(false)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={saving} onClick={runImport}>{saving ? 'Importing…' : 'Import'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
