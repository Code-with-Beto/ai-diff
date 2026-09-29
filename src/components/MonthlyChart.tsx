import { useState } from 'react';
import type { MonthTotal } from '../../shared/types';
import { formatNumber } from '../lib/analysis';
export default function MonthlyChart({ months, cutoff }: { months: MonthTotal[]; cutoff: string }) {
  const [hover, setHover] = useState<MonthTotal | null>(null);
  const width = 900, height = 180, max = Math.max(1, ...months.map(m => m.before + m.after));
  const gap = Math.min(4, width / Math.max(months.length, 1) * .25), bar = width / Math.max(months.length, 1);
  const years = months.map((m, i) => ({ month: m.month, i })).filter((m, i) => i === 0 || m.month.endsWith('-01'));
  return <div className="chart-block">
    <div className="chart-heading"><div><h3>Every commit tells a story.</h3><p>Lines added, month by month</p></div><span className="chart-readout">{hover ? `${new Date(hover.month + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })} · ${formatNumber(hover.before + hover.after)}` : `${formatNumber(max)} peak`}</span></div>
    <svg className="activity-chart" viewBox={`0 0 ${width} ${height + 34}`} role="img" aria-label={`Monthly lines added. ${months.length} months. Before ${cutoff} shown in gray; on and after shown in green.`} onMouseLeave={() => setHover(null)}>
      {[0, 1, 2, 3].map(i => <line key={i} x1="0" x2={width} y1={i * height / 3} y2={i * height / 3} className="chart-grid" />)}
      {months.map((m, i) => { const before = m.before / max * (height - 12), after = m.after / max * (height - 12); return <g key={m.month} onMouseEnter={() => setHover(m)}><title>{m.month}: {formatNumber(m.before + m.after)} lines added</title><rect x={i * bar} y={0} width={bar} height={height} fill="transparent" /><rect x={i * bar} y={height - before} width={Math.max(1, bar - gap)} height={before || (m.after ? 0 : 2)} rx="1" fill="#58635a" /><rect x={i * bar} y={height - before - after} width={Math.max(1, bar - gap)} height={after} rx="1" fill="#c6f582" /></g>; })}
      {years.filter((_, i) => i % Math.max(1, Math.ceil(years.length / 8)) === 0).map(({ month, i }) => <text key={month} x={i * bar} y={height + 27} fill="#8d968e" fontSize="13">{month.slice(0, 4)}</text>)}
    </svg>
    <details className="chart-table"><summary>View monthly values</summary><div className="table-scroll"><table><caption>Lines added by month</caption><thead><tr><th>Month</th><th>Before</th><th>After</th></tr></thead><tbody>{months.map(m => <tr key={m.month}><td>{m.month}</td><td>{formatNumber(m.before)}</td><td>{formatNumber(m.after)}</td></tr>)}</tbody></table></div></details>
  </div>;
}
