import type { ReactNode } from 'react';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtNum, fmtShortDate } from '../lib/format';

/** Validated 2-slot categorical palette: brand orange (primary) + blue (secondary). */
export const CHART = { primary: '#E85D04', secondary: '#2563EB', grid: '#EEF0F3', axis: '#9CA3AF', muted: '#CBD5E1' };

const axisProps = { stroke: CHART.axis, fontSize: 11, tickLine: false, axisLine: false } as const;

function TooltipBox({ active, payload, label, fmt }: { active?: boolean; payload?: { name?: string; value?: number | string; color?: string; dataKey?: string }[]; label?: string | number; fmt?: (v: number, key: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-gray-900">{typeof label === 'string' && /^\d{4}-\d{2}-\d{2}/.test(label) ? fmtShortDate(label) : label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2 text-gray-600">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular text-gray-900">{typeof p.value === 'number' ? (fmt ? fmt(p.value, String(p.dataKey)) : fmtNum(p.value)) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartFrame({ height = 240, children }: { height?: number; children: ReactNode }) {
  return (
    <div style={{ width: '100%', height }} className="min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

/** Clicks (area, left axis) and impressions (line, right axis) over time. */
export function ClicksImpressionsChart({ data, height = 260 }: { data: { date: string; clicks: number; impressions: number }[]; height?: number }) {
  return (
    <ChartFrame height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey="date" tickFormatter={fmtShortDate} minTickGap={28} {...axisProps} />
        <YAxis yAxisId="l" tickFormatter={(v) => fmtNum(v)} width={48} {...axisProps} />
        <YAxis yAxisId="r" orientation="right" tickFormatter={(v) => fmtNum(v)} width={52} {...axisProps} />
        <Tooltip content={<TooltipBox />} cursor={{ stroke: CHART.axis, strokeDasharray: '3 3' }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />
        <Area yAxisId="l" type="monotone" dataKey="clicks" name="Clicks (left)" stroke={CHART.primary} strokeWidth={2} fill={CHART.primary} fillOpacity={0.1} isAnimationActive={false} dot={false} activeDot={{ r: 4 }} />
        <Line yAxisId="r" type="monotone" dataKey="impressions" name="Impressions (right)" stroke={CHART.secondary} strokeWidth={2} isAnimationActive={false} dot={false} activeDot={{ r: 4 }} />
      </ComposedChart>
    </ChartFrame>
  );
}

export function SingleLineChart({ data, dataKey, name, height = 200, reversed, format, domain }: { data: object[]; dataKey: string; name: string; height?: number; reversed?: boolean; format?: (v: number) => string; domain?: [number | string, number | string] }) {
  return (
    <ChartFrame height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey="date" tickFormatter={fmtShortDate} minTickGap={28} {...axisProps} />
        <YAxis reversed={reversed} tickFormatter={(v) => (format ? format(v) : fmtNum(v))} width={48} domain={domain ?? ['auto', 'auto']} {...axisProps} />
        <Tooltip content={<TooltipBox fmt={format ? (v) => format(v) : undefined} />} cursor={{ stroke: CHART.axis, strokeDasharray: '3 3' }} />
        <Line type="monotone" dataKey={dataKey} name={name} stroke={CHART.primary} strokeWidth={2} isAnimationActive={false} dot={false} activeDot={{ r: 4 }} />
      </LineChart>
    </ChartFrame>
  );
}

export function SimpleBarChart({ data, xKey, yKey, name, height = 220, color = CHART.primary, horizontal }: { data: object[]; xKey: string; yKey: string; name: string; height?: number; color?: string; horizontal?: boolean }) {
  if (horizontal) {
    return (
      <ChartFrame height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barCategoryGap={4}>
          <CartesianGrid stroke={CHART.grid} horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => fmtNum(v)} {...axisProps} />
          <YAxis type="category" dataKey={xKey} width={150} {...axisProps} tick={{ fontSize: 11, fill: '#4B5563' }} />
          <Tooltip content={<TooltipBox />} cursor={{ fill: '#F3F4F6' }} />
          <Bar dataKey={yKey} name={name} fill={color} radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false} />
        </BarChart>
      </ChartFrame>
    );
  }
  return (
    <ChartFrame height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis tickFormatter={(v) => fmtNum(v)} width={44} allowDecimals={false} {...axisProps} />
        <Tooltip content={<TooltipBox />} cursor={{ fill: '#F3F4F6' }} />
        <Bar dataKey={yKey} name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
      </BarChart>
    </ChartFrame>
  );
}
