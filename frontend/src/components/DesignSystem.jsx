import { useState } from 'react';
import {
    AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { ChartTooltip, Legend, AXIS, SERIES, Funnel } from './ui/Chart';
import {
    CheckCircle2, XCircle, Clock, Send, Plus, Search, Trash2, Pencil,
    AlertTriangle, Inbox, MessageSquare, TrendingUp, TrendingDown,
} from 'lucide-react';

/**
 * The design system, rendered.
 *
 * Every component in WA Reach should be assembled from what's on this page. If
 * a screen needs something that isn't here, it gets added here first — that is
 * the whole point of having it.
 *
 * Chart colours come from --c1..--c4, a fixed-order categorical ramp validated
 * for colour-vision separation against both surfaces. They are never cycled and
 * never reassigned by rank.
 */

/* ── demo data ─────────────────────────────────────────────────────────────── */
const week = [
    { d: 'Mon', sent: 42, failed: 3, replies: 18 },
    { d: 'Tue', sent: 55, failed: 2, replies: 27 },
    { d: 'Wed', sent: 38, failed: 7, replies: 15 },
    { d: 'Thu', sent: 61, failed: 1, replies: 34 },
    { d: 'Fri', sent: 49, failed: 4, replies: 22 },
    { d: 'Sat', sent: 30, failed: 2, replies: 11 },
    { d: 'Sun', sent: 12, failed: 0, replies: 4 },
];
const donut = [
    { name: 'Confirmed', value: 48 },
    { name: 'Reschedule', value: 12 },
    { name: 'Cancelled', value: 6 },
    { name: 'No reply', value: 24 },
];

/* ── shared chart pieces ───────────────────────────────────────────────────── */
/* ChartTooltip, Legend, AXIS and SERIES now live in ui/Chart.jsx and are
   imported above. They were defined here, which meant this catalog and the
   real screens could only ever *look* alike; now the import graph enforces it. */

function Panel({ title, sub, children, wide }) {
    return (
        <section className="ds-panel" style={wide ? { gridColumn: '1 / -1' } : undefined}>
            <div className="ds-panel-head">
                <h3>{title}</h3>
                {sub && <p>{sub}</p>}
            </div>
            <div className="ds-panel-body">{children}</div>
        </section>
    );
}

/* ── the page ──────────────────────────────────────────────────────────────── */
export default function DesignSystem() {
    const [tab, setTab] = useState('one');
    const [checked, setChecked] = useState(true);

    return (
        <div className="ds-root">
            <header className="ds-header">
                <h1>WA Reach design system</h1>
                <p>
                    Every screen is built from these. Add here first, then use it — that is what
                    keeps the app consistent. Toggle the theme in the app header to check both.
                </p>
            </header>

            <div className="ds-grid">

                {/* ---------- foundations ---------- */}
                <Panel title="Colour" sub="Semantic tokens. Nothing in the app should carry a raw hex.">
                    <div className="ds-swatches">
                        {[
                            ['--brand', 'Brand'], ['--brand-teal', 'Brand deep'],
                            ['--success', 'Success'], ['--warning', 'Warning'],
                            ['--danger', 'Danger'], ['--info', 'Info'],
                        ].map(([v, n]) => (
                            <div className="ds-sw" key={v}>
                                <span style={{ background: `var(${v})` }} />
                                <b>{n}</b><code>{v}</code>
                            </div>
                        ))}
                    </div>
                    <div className="ds-swatches" style={{ marginTop: 14 }}>
                        {[['--c1', 'Series 1'], ['--c2', 'Series 2'], ['--c3', 'Series 3'], ['--c4', 'Series 4']].map(([v, n]) => (
                            <div className="ds-sw" key={v}>
                                <span style={{ background: `var(${v})` }} />
                                <b>{n}</b><code>{v}</code>
                            </div>
                        ))}
                    </div>
                    <p className="ds-note">
                        Series colours are assigned in fixed order and never cycled. A fifth series
                        folds into “Other” rather than inventing a hue.
                    </p>
                </Panel>

                <Panel title="Surfaces &amp; radius" sub="Flat, squared, separated by 1px lines rather than shadow.">
                    <div className="ds-surfaces">
                        <div style={{ background: 'var(--bg)' }}><b>--bg</b></div>
                        <div style={{ background: 'var(--surface)' }}><b>--surface</b></div>
                        <div style={{ background: 'var(--surface-raised)' }}><b>--raised</b></div>
                        <div style={{ background: 'var(--surface-sunken)' }}><b>--sunken</b></div>
                    </div>
                    <div className="ds-radii">
                        {[['--r-sm', '3'], ['--r-md', '6'], ['--r-lg', '8'], ['--r-xl', '10']].map(([v, px]) => (
                            <div key={v}><span style={{ borderRadius: `var(${v})` }} /><code>{v}</code><em>{px}px</em></div>
                        ))}
                    </div>
                </Panel>

                <Panel title="Typography">
                    <div className="ds-type">
                        <p style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.03em' }}>Stat value · 30/800</p>
                        <p style={{ fontSize: 18, fontWeight: 700 }}>Page title · 18/700</p>
                        <p style={{ fontSize: 15, fontWeight: 700 }}>Card heading · 15/700</p>
                        <p style={{ fontSize: 14 }}>Body copy · 14/400 — the default for everything.</p>
                        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Secondary · 13, muted</p>
                        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Overline · 11/700</p>
                    </div>
                </Panel>

                {/* ---------- controls ---------- */}
                <Panel title="Buttons">
                    <div className="ds-row">
                        <button className="btn-primary">Primary</button>
                        <button className="btn-outline">Secondary</button>
                        <button className="btn-text">Text</button>
                        <button className="btn-primary" disabled>Disabled</button>
                    </div>
                    <div className="ds-row">
                        <button className="btn-primary btn-sm"><Plus size={14} /> With icon</button>
                        <button className="btn-outline btn-sm"><Trash2 size={14} /> Small</button>
                        <button className="icon-btn"><Pencil size={16} /></button>
                        <button className="icon-btn"><Search size={16} /></button>
                    </div>
                </Panel>

                <Panel title="Form controls">
                    <div className="form-group"><label>Text field</label><input type="text" placeholder="Priya Sharma" /></div>
                    <div className="form-group"><label>Select</label><select><option>Daily</option><option>Weekly</option></select></div>
                    <div className="form-group"><label>Textarea</label><textarea rows={2} placeholder="Your appointment is tomorrow at 4pm." /></div>
                    <label className="toggle-row">
                        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                        <span><strong>Ask for confirmation</strong><em>Sends tappable reply options.</em></span>
                    </label>
                    <div className="ds-tabs" style={{ marginTop: 14 }}>
                        {['one', 'two', 'three'].map((t) => (
                            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                                Tab {t}
                            </button>
                        ))}
                    </div>
                </Panel>

                <Panel title="Status &amp; badges" sub="Status colour always ships with an icon and a word, never colour alone.">
                    <div className="ds-row">
                        <span className="badge badge-delivered"><CheckCircle2 size={12} /> Delivered</span>
                        <span className="badge badge-pending"><Clock size={12} /> Pending</span>
                        <span className="badge badge-failed"><XCircle size={12} /> Failed</span>
                        <span className="status-label active">Active</span>
                        <span className="status-label paused">Paused</span>
                    </div>
                    <div className="ds-row" style={{ marginTop: 12 }}>
                        <div className="alert-box success"><CheckCircle2 size={15} /><span>Saved.</span></div>
                    </div>
                    <div className="ds-row"><div className="alert-box warning"><AlertTriangle size={15} /><span>Sending fast can get a number banned.</span></div></div>
                    <div className="ds-row"><div className="alert-box danger"><XCircle size={15} /><span>WhatsApp is not connected.</span></div></div>
                </Panel>

                {/* ---------- data display ---------- */}
                <Panel title="Stat tiles" sub="Not every number needs a chart.">
                    <div className="ds-stats">
                        <div className="stat-box"><span className="stat-title">Delivered</span><span className="stat-value">1,245</span>
                            <span className="stat-delta up"><TrendingUp size={13} /> 15%</span></div>
                        <div className="stat-box"><span className="stat-title">Failed</span><span className="stat-value" style={{ color: 'var(--danger)' }}>18</span>
                            <span className="stat-delta down"><TrendingDown size={13} /> 4%</span></div>
                        <div className="stat-box"><span className="stat-title">Reply rate</span><span className="stat-value">62%</span>
                            <div className="sparkline">
                                <ResponsiveContainer width="100%" height={30}>
                                    <AreaChart data={week} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                                        <Area type="monotone" dataKey="replies" stroke="var(--c1)" strokeWidth={2} fill="var(--c1)" fillOpacity={0.14} dot={false} />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </div>
                </Panel>

                <Panel title="Area chart" sub="Change over time, one series — the title names it, so no legend box.">
                    <ResponsiveContainer width="100%" height={190}>
                        <AreaChart data={week} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                            <CartesianGrid stroke="var(--c-grid)" vertical={false} />
                            <XAxis dataKey="d" {...AXIS} />
                            <YAxis {...AXIS} />
                            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--c-axis)', strokeDasharray: '3 3' }} />
                            <Area type="monotone" dataKey="sent" name="Sent" stroke="var(--c1)" strokeWidth={2}
                                  fill="var(--c1)" fillOpacity={0.16} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
                        </AreaChart>
                    </ResponsiveContainer>
                </Panel>

                <Panel title="Line chart" sub="Two series — legend present, markers ≥8px.">
                    <ResponsiveContainer width="100%" height={190}>
                        <LineChart data={week} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                            <CartesianGrid stroke="var(--c-grid)" vertical={false} />
                            <XAxis dataKey="d" {...AXIS} />
                            <YAxis {...AXIS} />
                            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--c-axis)', strokeDasharray: '3 3' }} />
                            <Line type="monotone" dataKey="sent" name="Sent" stroke="var(--c1)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
                            <Line type="monotone" dataKey="replies" name="Replies" stroke="var(--c3)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
                        </LineChart>
                    </ResponsiveContainer>
                    <Legend items={[['Sent', 'var(--c1)'], ['Replies', 'var(--c3)']]} />
                </Panel>

                <Panel title="Bar chart" sub="Magnitude. 4px rounded ends, anchored to the baseline.">
                    <ResponsiveContainer width="100%" height={190}>
                        <BarChart data={week} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barGap={2}>
                            <CartesianGrid stroke="var(--c-grid)" vertical={false} />
                            <XAxis dataKey="d" {...AXIS} />
                            <YAxis {...AXIS} />
                            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-raised)' }} />
                            <Bar dataKey="sent" name="Sent" fill="var(--c1)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                            <Bar dataKey="failed" name="Failed" fill="var(--c4)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                        </BarChart>
                    </ResponsiveContainer>
                    <Legend items={[['Sent', 'var(--c1)'], ['Failed', 'var(--c4)']]} />
                </Panel>

                <Panel title="Donut" sub="Parts of one whole. Direct-labelled, so identity never rests on colour.">
                    <div className="ds-donut">
                        <ResponsiveContainer width="100%" height={190}>
                            <PieChart>
                                <Pie data={donut} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78}
                                     paddingAngle={2} stroke="var(--surface)" strokeWidth={2}>
                                    {donut.map((_, i) => <Cell key={i} fill={SERIES[i]} />)}
                                </Pie>
                                <Tooltip content={<ChartTooltip />} />
                            </PieChart>
                        </ResponsiveContainer>
                        <div className="ds-donut-center"><b>90</b><span>reminders</span></div>
                    </div>
                    <Legend items={donut.map((d, i) => [`${d.name} · ${d.value}`, SERIES[i]])} />
                </Panel>

                <Panel title="Funnel" sub="Aligned bars from a common baseline — the question is where it dropped, which areas answer badly.">
                    <Funnel steps={[
                        { label: 'Queued', value: 240, dropLabel: 'never attempted' },
                        { label: 'Sent', value: 228, dropLabel: 'failed to send' },
                        { label: 'Delivered', value: 214, dropLabel: 'not delivered' },
                        { label: 'Read', value: 176, dropLabel: 'unread' },
                        { label: 'Replied', value: 90, dropLabel: 'no reply' },
                    ]} />
                </Panel>

                <Panel title="Gauge" sub="A single bounded number. The remainder is neutral, not a second series.">
                    <div className="ds-donut">
                        <ResponsiveContainer width="100%" height={150}>
                            <PieChart>
                                <Pie data={[{ v: 62 }, { v: 38 }]} dataKey="v" startAngle={200} endAngle={-20}
                                     innerRadius={58} outerRadius={80} stroke="none">
                                    <Cell fill="var(--c1)" />
                                    <Cell fill="var(--c-empty)" />
                                </Pie>
                            </PieChart>
                        </ResponsiveContainer>
                        <div className="ds-donut-center" style={{ top: '58%' }}><b>62%</b><span>reply rate</span></div>
                    </div>
                </Panel>

                <Panel title="Table" wide>
                    <div className="tablewrap">
                        <table className="logs-table">
                            <thead><tr><th>Contact</th><th>Workflow</th><th>Status</th><th>Reply</th><th>Time</th></tr></thead>
                            <tbody>
                                <tr><td className="log-contact">Priya Sharma</td><td className="log-flow">Appointment reminder</td>
                                    <td><span className="badge badge-delivered"><CheckCircle2 size={12} /> Delivered</span></td>
                                    <td><span className="badge badge-delivered">Confirmed</span></td><td className="log-time">09:12</td></tr>
                                <tr><td className="log-contact">Rahul Desai</td><td className="log-flow">Appointment reminder</td>
                                    <td><span className="badge badge-failed"><XCircle size={12} /> Failed</span></td>
                                    <td>—</td><td className="log-time">09:14</td></tr>
                                <tr><td className="log-contact">Anjali Rao</td><td className="log-flow">Recall due</td>
                                    <td><span className="badge badge-pending"><Clock size={12} /> Pending</span></td>
                                    <td>—</td><td className="log-time">09:20</td></tr>
                            </tbody>
                        </table>
                    </div>
                </Panel>

                <Panel title="Empty state">
                    <div className="empty-state">
                        <div className="empty-art"><Inbox size={28} strokeWidth={1.5} /></div>
                        <h4>No replies yet</h4>
                        <p>When a patient answers a reminder, the conversation shows up here.</p>
                        <button className="btn-primary btn-sm"><Send size={14} /> Create an automation</button>
                    </div>
                </Panel>

                <Panel title="Chat bubbles" sub="Used by the inbox.">
                    <div style={{ background: 'var(--surface-sunken)', padding: 14, borderRadius: 'var(--r-md)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div className="bubble in"><div className="bubble-body">Can I come at 5 instead?</div><div className="bubble-meta"><span>09:31</span></div></div>
                        <div className="bubble out"><div className="bubble-body">Yes, 5pm works. See you then.</div><div className="bubble-meta"><span>09:33</span></div></div>
                    </div>
                </Panel>

                <Panel title="Toast">
                    <div className="notification-toast success" style={{ position: 'static' }}>
                        <MessageSquare size={16} className="notification-icon" style={{ color: 'var(--success)' }} />
                        <div className="notification-content">
                            <div className="notification-title">Priya Sharma confirmed</div>
                            <div className="notification-message">Appointment reminder · just now</div>
                        </div>
                    </div>
                </Panel>

            </div>
        </div>
    );
}
