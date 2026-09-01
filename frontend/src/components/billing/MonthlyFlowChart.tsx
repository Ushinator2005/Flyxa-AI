import { useMemo, useState } from 'react';
import type { MonthlyFlowPoint } from '../../utils/billingMonthlyFlow.js';

/**
 * Money in vs money out, per month.
 *
 * The job is polarity — which side of break-even each month landed on — so the
 * form is a diverging column chart on a zero baseline: payouts above, fees
 * below. Position carries the meaning on its own, which leaves color as
 * reinforcement rather than the only channel.
 *
 * Colors are the validated pair in `--chart-flow-in` / `--chart-flow-out`
 * (see tokens.css), not the page's --green/--red.
 */

interface MonthlyFlowChartProps {
  months: MonthlyFlowPoint[];
}

const BAR_WIDTH = 13;      // ≤ 24px cap; the band's leftover is air
const CAP_RADIUS = 4;      // rounded at the data end, square at the baseline
const PLOT_HEIGHT = 34;    // per arm
const BASELINE_GAP = 3;    // keeps the two arms off the axis line
const VALUE_BAND = 12;     // reserved row for the one direct value label
const MONTH_BAND = 13;     // month names, always below the value row

function formatMoney(value: number): string {
  const rounded = Math.round(Math.abs(value));
  const compact = rounded >= 10_000
    ? `${(rounded / 1000).toFixed(rounded % 1000 === 0 ? 0 : 1)}k`
    : rounded.toLocaleString('en-US');
  return `$${compact}`;
}

function formatSigned(value: number): string {
  if (Math.round(value) === 0) return '$0';
  return `${value > 0 ? '+' : '−'}${formatMoney(value)}`;
}

/**
 * A column with a rounded data end and a square baseline end. Drawn as a path
 * rather than a rect so only the two outer corners round — a fully rounded rect
 * lifts the mark off its baseline and reads as floating.
 */
function columnPath(x: number, width: number, baselineY: number, length: number, up: boolean): string {
  const radius = Math.min(CAP_RADIUS, length, width / 2);
  const tipY = up ? baselineY - length : baselineY + length;
  const dir = up ? 1 : -1;
  return [
    `M ${x} ${baselineY}`,
    `L ${x} ${tipY + radius * dir}`,
    `Q ${x} ${tipY} ${x + radius} ${tipY}`,
    `L ${x + width - radius} ${tipY}`,
    `Q ${x + width} ${tipY} ${x + width} ${tipY + radius * dir}`,
    `L ${x + width} ${baselineY}`,
    'Z',
  ].join(' ');
}

export default function MonthlyFlowChart({ months }: MonthlyFlowChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const totals = useMemo(() => ({
    spent: months.reduce((sum, m) => sum + m.spent, 0),
    payouts: months.reduce((sum, m) => sum + m.payouts, 0),
  }), [months]);

  // One scale for both arms, so a dollar is the same height whichever way it
  // points — two scales would make a small payout look like a big one.
  const scaleMax = useMemo(
    () => Math.max(1, ...months.map(m => Math.max(m.spent, m.payouts))),
    [months],
  );

  // Label the extreme month only. A number on every column is unreadable, and
  // the rest are one hover away.
  const extremeIndex = useMemo(() => {
    let index = -1;
    let worst = 0;
    months.forEach((month, i) => {
      if (Math.abs(month.net) > worst) { worst = Math.abs(month.net); index = i; }
    });
    return index;
  }, [months]);

  if (months.length === 0) {
    return (
      <div style={{ minWidth: 220 }}>
        <p className="billing-stat-label">Monthly Flow</p>
        <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--txt-3)' }}>
          No fees or payouts logged yet.
        </p>
      </div>
    );
  }

  const bandWidth = 30;
  const width = months.length * bandWidth;
  const baselineY = VALUE_BAND + PLOT_HEIGHT;
  const height = baselineY + PLOT_HEIGHT + VALUE_BAND + MONTH_BAND;
  const active = hovered !== null ? months[hovered] : null;

  return (
    <div style={{ minWidth: 220 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
        <p className="billing-stat-label" style={{ margin: 0 }}>Monthly Flow</p>
        <button
          type="button"
          onClick={() => setShowTable(value => !value)}
          style={{
            appearance: 'none', border: 'none', background: 'none', padding: 0,
            font: 'inherit', fontSize: 10, color: 'var(--txt-3)', cursor: 'pointer',
            textDecoration: 'underline', textUnderlineOffset: 2,
          }}
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {/* Legend — two series always get one; identity is never color alone. */}
      <div style={{ display: 'flex', gap: 12, margin: '4px 0 2px' }}>
        {[
          { label: 'Payouts', color: 'var(--chart-flow-in)', total: totals.payouts },
          { label: 'Fees', color: 'var(--chart-flow-out)', total: totals.spent },
        ].map(series => (
          <span key={series.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: series.color, flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>{series.label}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt-2)', fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(series.total)}
            </span>
          </span>
        ))}
      </div>

      {showTable ? (
        <table style={{ borderCollapse: 'collapse', fontSize: 10, marginTop: 4 }}>
          <thead>
            <tr style={{ color: 'var(--txt-3)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '2px 10px 2px 0' }}>Month</th>
              <th style={{ fontWeight: 500, padding: '2px 0 2px 10px' }}>Fees</th>
              <th style={{ fontWeight: 500, padding: '2px 0 2px 10px' }}>Payouts</th>
              <th style={{ fontWeight: 500, padding: '2px 0 2px 10px' }}>Net</th>
            </tr>
          </thead>
          <tbody style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--txt-2)' }}>
            {months.map(month => (
              <tr key={month.key}>
                <td style={{ padding: '2px 10px 2px 0', color: 'var(--txt-3)' }}>{month.label} {String(month.year).slice(2)}</td>
                <td style={{ textAlign: 'right', padding: '2px 0 2px 10px' }}>{formatMoney(month.spent)}</td>
                <td style={{ textAlign: 'right', padding: '2px 0 2px 10px' }}>{formatMoney(month.payouts)}</td>
                <td style={{ textAlign: 'right', padding: '2px 0 2px 10px', color: 'var(--txt)' }}>{formatSigned(month.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ position: 'relative' }}>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Fees and payouts by month. ${months.map(m => (
              `${m.label} ${m.year}: ${formatMoney(m.spent)} in fees, ${formatMoney(m.payouts)} in payouts, net ${formatSigned(m.net)}`
            )).join('. ')}`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            <line
              x1={0} y1={baselineY} x2={width} y2={baselineY}
              stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges"
            />

            {months.map((month, index) => {
              const bandX = index * bandWidth;
              const barX = bandX + (bandWidth - BAR_WIDTH) / 2;
              const payoutLength = (month.payouts / scaleMax) * (PLOT_HEIGHT - BASELINE_GAP);
              const spentLength = (month.spent / scaleMax) * (PLOT_HEIGHT - BASELINE_GAP);
              const isHovered = hovered === index;
              const dim = hovered !== null && !isHovered ? 0.45 : 1;

              return (
                <g
                  key={month.key}
                  opacity={dim}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(current => (current === index ? null : current))}
                >
                  {/* Hit target spans the whole band, not just the marks. */}
                  <rect x={bandX} y={0} width={bandWidth} height={height} fill="transparent" />

                  {month.payouts > 0 && (
                    <path
                      d={columnPath(barX, BAR_WIDTH, baselineY - BASELINE_GAP, payoutLength, true)}
                      fill="var(--chart-flow-in)"
                    />
                  )}
                  {month.spent > 0 && (
                    <path
                      d={columnPath(barX, BAR_WIDTH, baselineY + BASELINE_GAP, spentLength, false)}
                      fill="var(--chart-flow-out)"
                    />
                  )}
                  {month.payouts === 0 && month.spent === 0 && (
                    <circle cx={bandX + bandWidth / 2} cy={baselineY} r={1.5} fill="var(--txt-3)" opacity={0.5} />
                  )}

                  <text
                    x={bandX + bandWidth / 2}
                    y={height - 3}
                    textAnchor="middle"
                    style={{ fontSize: 9, fill: isHovered ? 'var(--txt-2)' : 'var(--txt-3)' }}
                  >
                    {month.label}
                  </text>

                  {index === extremeIndex && hovered === null && (
                    <text
                      x={bandX + bandWidth / 2}
                      // Clamped into the reserved value row: a long bar must never
                      // push its own label down into the month names.
                      y={month.net >= 0
                        ? Math.max(9, baselineY - BASELINE_GAP - payoutLength - 4)
                        : Math.min(baselineY + PLOT_HEIGHT + 9, baselineY + BASELINE_GAP + spentLength + 10)}
                      textAnchor="middle"
                      style={{ fontSize: 9, fill: 'var(--txt-2)', fontFamily: 'var(--font-mono)' }}
                    >
                      {formatSigned(month.net)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {active && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(Math.max(0, (hovered as number) * bandWidth + bandWidth / 2 - 62), Math.max(0, width - 124)),
                top: -4,
                width: 124,
                pointerEvents: 'none',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '6px 8px',
                zIndex: 5,
                boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
              }}
            >
              <p style={{ margin: '0 0 4px', fontSize: 10, color: 'var(--txt-2)' }}>
                {active.label} {active.year}
              </p>
              {[
                { label: 'Payouts', value: formatMoney(active.payouts), color: 'var(--chart-flow-in)' },
                { label: 'Fees', value: formatMoney(active.spent), color: 'var(--chart-flow-out)' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 2, background: row.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: 'var(--txt-3)', flex: 1 }}>{row.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt-2)', fontVariantNumeric: 'tabular-nums' }}>
                    {row.value}
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 5, borderTop: '1px solid var(--border)', paddingTop: 3, marginTop: 3 }}>
                <span style={{ fontSize: 10, color: 'var(--txt-3)', flex: 1 }}>Net</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatSigned(active.net)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
