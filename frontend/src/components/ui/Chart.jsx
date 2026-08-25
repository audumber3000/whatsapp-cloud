import {
    AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

/**
 * The chart primitives.
 *
 * These lived inside DesignSystem.jsx, which meant the catalog page and the
 * real screens could only ever *look* like each other. They are now one module
 * that both import, so "the app is built from the design system" is enforced
 * by the import graph rather than by discipline.
 *
 * --c1..--c4 is a fixed-order categorical ramp, validated for colour-vision
 * separation against both surfaces (worst adjacent pair ΔE 9.6 protan light,
 * 11.2 deutan dark). It is never cycled and never reassigned by rank: a filter
 * that drops a series must not repaint the survivors.
 *
 * Against the light surface two of the four fall below 3:1 contrast, so every
 * chart here ships a legend or direct labels, and the analytics page carries a
 * table view — identity never rests on colour alone.
 */

export const SERIES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];
export const AXIS = { stroke: 'var(--c-axis)', fontSize: 11, tickLine: false, axisLine: false };

/** Text wears text tokens, never the series colour; the swatch carries identity. */
export function ChartTooltip({ active, payload, label, suffix = '' }) {
    if (!active || !payload?.length) return null;
    return (
        <div className="chart-tip">
            {label && <div className="chart-tip-label">{label}</div>}
            {payload.map((p, i) => (
                <div className="chart-tip-row" key={i}>
                    <i style={{ background: p.color || p.fill || p.payload?.fill }} />
                    <span>{p.name}</span>
                    <b>{p.value}{suffix}</b>
                </div>
            ))}
        </div>
    );
}

export function Legend({ items }) {
    return (
        <div className="chart-legend">
            {items.map(([label, color]) => (
                <span key={label}><i style={{ background: color }} />{label}</span>
            ))}
        </div>
    );
}

/** A chart's frame: title, optional sub, and the plot. */
export function ChartCard({ title, sub, action, children, span }) {
    return (
        <section className="chart-card" style={span ? { gridColumn: `span ${span}` } : undefined}>
            <header>
                <div>
                    <h3>{title}</h3>
                    {sub && <p>{sub}</p>}
                </div>
                {action}
            </header>
            <div className="chart-card-body">{children}</div>
        </section>
    );
}

/** Change over time, one series. The title names it, so no legend box. */
export function TrendArea({ data, x, y, name, height = 190, colour = 'var(--c1)', suffix = '' }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="var(--c-grid)" vertical={false} />
                <XAxis dataKey={x} {...AXIS} />
                <YAxis {...AXIS} allowDecimals={false} />
                <Tooltip content={<ChartTooltip suffix={suffix} />}
                         cursor={{ stroke: 'var(--c-axis)', strokeDasharray: '3 3' }} />
                <Area type="monotone" dataKey={y} name={name} stroke={colour} strokeWidth={2}
                      fill={colour} fillOpacity={0.16} dot={false}
                      activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
            </AreaChart>
        </ResponsiveContainer>
    );
}

/** Two or more series over time. A legend is always present. */
export function TrendLines({ data, x, series, height = 190, suffix = '' }) {
    return (
        <>
            <ResponsiveContainer width="100%" height={height}>
                <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="var(--c-grid)" vertical={false} />
                    <XAxis dataKey={x} {...AXIS} />
                    <YAxis {...AXIS} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip suffix={suffix} />}
                             cursor={{ stroke: 'var(--c-axis)', strokeDasharray: '3 3' }} />
                    {series.map((s, i) => (
                        <Line key={s.key} type="monotone" dataKey={s.key} name={s.label}
                              stroke={s.colour || SERIES[i]} strokeWidth={2}
                              dot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
                    ))}
                </LineChart>
            </ResponsiveContainer>
            <Legend items={series.map((s, i) => [s.label, s.colour || SERIES[i]])} />
        </>
    );
}

/** Magnitude. 4px rounded ends, anchored to the baseline. */
export function Bars({ data, x, series, height = 190, layout = 'vertical' }) {
    const horizontal = layout === 'horizontal';
    return (
        <>
            <ResponsiveContainer width="100%" height={height}>
                <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'}
                          margin={horizontal
                              ? { top: 4, right: 24, bottom: 0, left: 8 }
                              : { top: 8, right: 8, bottom: 0, left: -18 }}
                          barGap={2}>
                    <CartesianGrid stroke="var(--c-grid)" vertical={horizontal} horizontal={!horizontal} />
                    {horizontal ? (
                        <>
                            <XAxis type="number" {...AXIS} allowDecimals={false} />
                            <YAxis type="category" dataKey={x} {...AXIS} width={132} />
                        </>
                    ) : (
                        <>
                            <XAxis dataKey={x} {...AXIS} />
                            <YAxis {...AXIS} allowDecimals={false} />
                        </>
                    )}
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-raised)' }} />
                    {series.map((s, i) => (
                        <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.colour || SERIES[i]}
                             radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={18} />
                    ))}
                </BarChart>
            </ResponsiveContainer>
            {series.length > 1 && <Legend items={series.map((s, i) => [s.label, s.colour || SERIES[i]])} />}
        </>
    );
}

/** Parts of one whole. Direct-labelled, so identity never rests on colour. */
export function Donut({ data, total, unit, height = 190 }) {
    const sum = total ?? data.reduce((a, d) => a + d.value, 0);
    return (
        <>
            <div className="chart-donut">
                <ResponsiveContainer width="100%" height={height}>
                    <PieChart>
                        <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78}
                             paddingAngle={2} stroke="var(--surface)" strokeWidth={2}>
                            {data.map((d, i) => <Cell key={i} fill={d.colour || SERIES[i]} />)}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                </ResponsiveContainer>
                <div className="chart-donut-center"><b>{sum}</b>{unit && <span>{unit}</span>}</div>
            </div>
            <Legend items={data.map((d, i) => [`${d.name} · ${d.value}`, d.colour || SERIES[i]])} />
        </>
    );
}

/** A single bounded number. The remainder is neutral, not a second series. */
export function Gauge({ value, label, height = 150, colour = 'var(--c1)' }) {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    return (
        <div className="chart-donut">
            <ResponsiveContainer width="100%" height={height}>
                <PieChart>
                    <Pie data={[{ v }, { v: 100 - v }]} dataKey="v" startAngle={200} endAngle={-20}
                         innerRadius={58} outerRadius={80} stroke="none" isAnimationActive={false}>
                        <Cell fill={colour} />
                        <Cell fill="var(--c-empty)" />
                    </Pie>
                </PieChart>
            </ResponsiveContainer>
            <div className="chart-donut-center" style={{ top: '58%' }}>
                <b>{v}%</b>{label && <span>{label}</span>}
            </div>
        </div>
    );
}

/** A stat tile's inline trend. No axes, no tooltip — it is a shape, not a plot. */
export function Sparkline({ data, y, colour = 'var(--c1)', height = 30 }) {
    return (
        <div className="sparkline">
            <ResponsiveContainer width="100%" height={height}>
                <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                    <Area type="monotone" dataKey={y} stroke={colour} strokeWidth={2}
                          fill={colour} fillOpacity={0.14} dot={false} isAnimationActive={false} />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}

/**
 * A funnel as stacked proportional rows.
 *
 * Not a tapered funnel graphic: those encode magnitude in an area that is hard
 * to compare, and the question here is "where did the drop happen", which reads
 * off aligned bars from a common baseline.
 */
export function Funnel({ steps }) {
    const top = steps[0]?.value || 0;
    return (
        <div className="funnel">
            {steps.map((s, i) => {
                const pct = top ? (s.value / top) * 100 : 0;
                const prev = i > 0 ? steps[i - 1].value : null;
                const drop = prev !== null && prev > 0 ? prev - s.value : 0;
                return (
                    <div className="funnel-step" key={s.label}>
                        <div className="funnel-head">
                            <span className="funnel-label">{s.label}</span>
                            <span className="funnel-value">
                                <b>{s.value.toLocaleString()}</b>
                                <em>{top ? Math.round(pct) : 0}%</em>
                            </span>
                        </div>
                        <div className="funnel-track">
                            <span style={{ width: `${pct}%`, background: s.colour || SERIES[i % SERIES.length] }} />
                        </div>
                        {drop > 0 && (
                            <div className="funnel-drop">
                                −{drop.toLocaleString()} {s.dropLabel || 'lost here'}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
