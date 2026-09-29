import { useId, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { MonthTotal } from '../../shared/types';
import { formatDate, formatNumber } from '../lib/analysis';
import './MonthlyChart.css';

const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const axisFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const monthLabel = (month: string) => monthFormatter.format(new Date(`${month}-01T00:00:00Z`));

export default function MonthlyChart({ months, cutoff }: { months: MonthTotal[]; cutoff: string }) {
  const id = useId();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const peakIndex = months.reduce((peak, month, index) => month.before + month.after > months[peak].before + months[peak].after ? index : peak, 0);
  const selectedIndex = months.findIndex(month => month.month === selectedMonth);
  const activeIndex = selectedIndex < 0 ? peakIndex : selectedIndex;
  const activeMonth = months[activeIndex];
  const peak = months[peakIndex] ? months[peakIndex].before + months[peakIndex].after : 0;
  const scale = Math.max(1, peak);
  const width = 960, height = 192;
  const slotWidth = width / Math.max(months.length, 1);
  const barWidth = slotWidth * .72;
  const timeline = [...new Set([0, Math.round((months.length - 1) / 2), months.length - 1])].filter(index => index >= 0);
  const years = months.map((month, index) => ({ month: month.month, index })).filter(({ month, index }) => index === 0 || month.endsWith('-01'));
  const yearStride = Math.max(1, Math.ceil(years.length / 8));
  const cutoffDate = new Date(`${cutoff}T00:00:00Z`);
  const cutoffMonth = months.findIndex(month => month.month === cutoff.slice(0, 7));
  const daysInMonth = new Date(Date.UTC(cutoffDate.getUTCFullYear(), cutoffDate.getUTCMonth() + 1, 0)).getUTCDate();
  const cutoffPosition = cutoffMonth < 0 ? null : (cutoffMonth + (cutoffDate.getUTCDate() - 1) / daysInMonth) / months.length;

  function exploreWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const nextIndex = {
      ArrowLeft: activeIndex - 1, ArrowDown: activeIndex - 1,
      ArrowRight: activeIndex + 1, ArrowUp: activeIndex + 1,
      Home: 0, End: months.length - 1,
      PageUp: activeIndex + 12, PageDown: activeIndex - 12,
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    setSelectedMonth(months[Math.max(0, Math.min(months.length - 1, nextIndex))].month);
  }

  function exploreWithPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - bounds.left) / bounds.width * months.length);
    setSelectedMonth(months[Math.max(0, Math.min(months.length - 1, index))].month);
  }

  return <section className="monthly-chart" aria-labelledby={`${id}-heading`}>
    <div className="monthly-chart__header">
      <h3 id={`${id}-heading`}>Lines added per month</h3>
      {activeMonth && <div className="monthly-chart__readout" aria-hidden="true">
        <span className="monthly-chart__month">{monthLabel(activeMonth.month)}</span>
        <strong>{formatNumber(activeMonth.before + activeMonth.after)}</strong>
      </div>}
    </div>

    {activeMonth ? <>
      <div className="monthly-chart__legend" aria-label="Chart legend">
        <span><i className="monthly-chart__swatch monthly-chart__swatch--before" aria-hidden="true" />Before</span>
        <span><i className="monthly-chart__swatch monthly-chart__swatch--after" aria-hidden="true" />After</span>
        {cutoffPosition !== null && <span className="monthly-chart__cutoff-key"><i aria-hidden="true" />{formatDate(cutoff)}</span>}
      </div>
      <div className="monthly-chart__graph">
        <div className="monthly-chart__axis" aria-hidden="true"><span>{peak ? axisFormatter.format(peak) : ''}</span><span>{peak ? axisFormatter.format(peak / 2) : ''}</span><span>0</span></div>
        <div
          className="monthly-chart__plot"
          role="slider"
          tabIndex={0}
          aria-label="Explore monthly lines added"
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={months.length}
          aria-valuenow={activeIndex + 1}
          aria-valuetext={`${monthLabel(activeMonth.month)}: ${formatNumber(activeMonth.before + activeMonth.after)} lines added, ${formatNumber(activeMonth.before)} before and ${formatNumber(activeMonth.after)} after the comparison date`}
          aria-describedby={`${id}-instructions ${id}-cutoff`}
          onKeyDown={exploreWithKeyboard}
          onPointerMove={exploreWithPointer}
          onPointerDown={exploreWithPointer}
        >
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
            <defs><pattern id={`${id}-before`} width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" className="monthly-chart__bar--before" /><path d="M-2 2 2-2 M0 8 8 0 M6 10 10 6" className="monthly-chart__pattern" /></pattern></defs>
            {[0, .5, 1].map(fraction => <line key={fraction} x1={0} x2={width} y1={fraction * height} y2={fraction * height} className="monthly-chart__grid" vectorEffect="non-scaling-stroke" />)}
            <rect x={activeIndex * slotWidth} y={0} width={slotWidth} height={height} className="monthly-chart__highlight" />
            {months.map((month, index) => {
              const before = month.before / scale * height, after = month.after / scale * height;
              const x = index * slotWidth + (slotWidth - barWidth) / 2;
              return <g key={month.month}>
                <rect x={x} y={height - before} width={barWidth} height={before} fill={`url(#${id}-before)`} />
                <rect x={x} y={height - before - after} width={barWidth} height={after} className="monthly-chart__bar--after" />
              </g>;
            })}
            {cutoffPosition !== null && <line x1={cutoffPosition * width} x2={cutoffPosition * width} y1={0} y2={height} className="monthly-chart__cutoff" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <div className="monthly-chart__timeline monthly-chart__timeline--years" aria-hidden="true">
          {years.filter((_, index) => index % yearStride === 0).map(({ month, index }) => <span key={month} style={{ left: `${(index + .5) / months.length * 100}%` }}>{month.slice(0, 4)}</span>)}
        </div>
        <div className="monthly-chart__timeline monthly-chart__timeline--months" aria-hidden="true">
          {timeline.map(index => <span key={months[index].month} style={{ left: `${months.length > 1 ? index / (months.length - 1) * 100 : 0}%` }}>{monthLabel(months[index].month)}</span>)}
        </div>
      </div>
      <span className="monthly-chart__sr-only" id={`${id}-instructions`}>Hover or tap a month to explore. Use arrow keys when focused. Use Home or End for the first or last month, and Page Up or Page Down to move twelve months.</span>
      <span className="monthly-chart__sr-only" id={`${id}-cutoff`}>Before means before {formatDate(cutoff)}. After includes that date. The comparison starts at midnight UTC.</span>
      <details className="monthly-chart__details">
        <summary>Monthly values</summary>
        <div className="monthly-chart__table-scroll" tabIndex={0} role="region" aria-label="Monthly values table">
          <table>
            <caption>Lines added before and after {formatDate(cutoff)} (UTC)</caption>
            <thead><tr><th scope="col">Month</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
            <tbody>{months.map(month => <tr key={month.month}><th scope="row">{monthLabel(month.month)}</th><td>{formatNumber(month.before)}</td><td>{formatNumber(month.after)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </> : <p className="monthly-chart__empty">No monthly activity to show.</p>}
  </section>;
}
