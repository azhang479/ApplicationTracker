import { useEffect, useMemo, useRef, useState } from 'react';
import { sankey, sankeyLinkHorizontal, type SankeyNode } from 'd3-sankey';
import {
  buildFlow,
  filterApplied,
  type AppliedWindow,
  type FlowNode,
  type FlowStage,
} from './flow';
import type { Application } from './types';

type LayoutNode = SankeyNode<FlowNode, { value: number }>;

const stageColors: Record<FlowStage, string> = {
  Applications: 'var(--accent)',
  'Online Assessment': '#f59e0b',
  'OA Completed': '#06b6d4',
  Interview: '#3b82f6',
  Offer: '#22c55e',
  Rejected: '#f43f5e',
  Withdrawn: '#64748b',
  Ghosted: '#cbd5e1',
  'No response yet': '#e2e8f0',
};
const stageOrder: FlowStage[] = [
  'Offer',
  'Interview',
  'OA Completed',
  'Online Assessment',
  'Rejected',
  'Withdrawn',
  'Ghosted',
  'No response yet',
  'Applications',
];
const stageRank = (node: LayoutNode) => stageOrder.indexOf(node.id);

function labelLines(label: string) {
  const words = label.split(' ');
  const lines = [''];
  for (const word of words) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + word.length + 1 > 15) lines.push(word);
    else lines[last] += (lines[last] ? ' ' : '') + word;
  }
  return lines;
}

function FlowChart({ flow }: { flow: ReturnType<typeof buildFlow> }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const height = 480;
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.max(640, Math.floor(entries[0].contentRect.width)));
    });
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, []);
  const graph = useMemo(
    () =>
      sankey<FlowNode, { value: number }>()
        .nodeId((node) => node.id)
        .nodeWidth(12)
        .nodePadding(42)
        .nodeSort((a, b) => stageRank(a) - stageRank(b))
        .linkSort((a, b) =>
          a.source === b.source
            ? stageRank(a.target as LayoutNode) - stageRank(b.target as LayoutNode)
            : stageRank(a.source as LayoutNode) - stageRank(b.source as LayoutNode),
        )
        .extent([
          [16, 24],
          [width - 16, height - 24],
        ])({
        nodes: flow.nodes.map((node) => ({ ...node })),
        links: flow.links.map((link) => ({ ...link })),
      }),
    [flow, width],
  );
  const linkPath = sankeyLinkHorizontal<FlowNode, { value: number }>();
  return (
    <div
      ref={container}
      className="flow-scroll"
      tabIndex={0}
      role="region"
      aria-label="Application flow chart; scroll horizontally on small screens"
    >
      <svg
        className="flow-chart"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby="flow-title flow-description"
      >
        <title id="flow-title">Application stages and outcomes</title>
        <desc id="flow-description">
          {flow.nodes.map((node) => `${node.id}: ${node.count}`).join('. ')}. Link widths show
          application counts. Stages appear once per application, in pipeline order.
        </desc>
        <g fill="none">
          {graph.links.map((link) => {
            const source = link.source as LayoutNode;
            const target = link.target as LayoutNode;
            return (
              <path
                key={`${source.id}-${target.id}`}
                className="flow-link"
                d={linkPath(link)!}
                stroke={stageColors[target.id]}
                strokeWidth={link.width}
              >
                <title>
                  {source.id} → {target.id}: {link.value}
                </title>
              </path>
            );
          })}
        </g>
        {graph.nodes.map((node) => {
          const x = node.x0!;
          const y = node.y0!;
          const nodeHeight = node.y1! - y;
          const right = x < width / 2;
          const lines = labelLines(`${node.id}: ${node.count}`);
          const labelWidth = Math.max(...lines.map((line) => line.length)) * 6.5 + 12;
          const labelHeight = lines.length * 14 + 8;
          const labelX = right ? 20 : -8 - labelWidth;
          return (
            <g key={node.id} transform={`translate(${x}, ${y})`}>
              <rect fill={stageColors[node.id]} width={12} height={nodeHeight} rx={2}>
                <title>
                  {node.id}: {node.count}
                </title>
              </rect>
              <g
                transform={`translate(${labelX}, ${(nodeHeight - labelHeight) / 2})`}
                className="flow-label"
              >
                <rect width={labelWidth} height={labelHeight} rx={4} />
                <text x={right ? 6 : labelWidth - 6} textAnchor={right ? 'start' : 'end'}>
                  {lines.map((line, i) => (
                    <tspan key={i} x={right ? 6 : labelWidth - 6} y={15 + i * 14}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function Insights({ apps }: { apps: Application[] }) {
  const [days, setDays] = useState<AppliedWindow>(0);
  const flow = useMemo(() => buildFlow(filterApplied(apps, days)), [apps, days]);
  return (
    <section aria-label="Application insights">
      <div
        className="application-filters flex items-center flex-wrap gap-2 mb-5"
        role="group"
        aria-label="Applied in"
      >
        <span className="text-xs font-medium text-slate-500 mr-1">Applied in:</span>
        {([0, 30, 90] as const).map((value) => (
          <button
            key={value}
            className={`chip ${days === value ? 'chip-active' : ''}`}
            aria-pressed={days === value}
            onClick={() => setDays(value)}
          >
            {value ? `Last ${value} days` : 'All time'}
          </button>
        ))}
      </div>
      <div className="workspace-stats grid grid-cols-3 gap-3">
        {[
          {
            label: 'Response rate',
            count: flow.responded,
            hint: 'Any recorded status beyond Applied, including Ghosted and Withdrawn.',
          },
          {
            label: 'Interview rate',
            count: flow.interviews,
            hint: 'Applications with a recorded Interview stage.',
          },
          {
            label: 'Offer rate',
            count: flow.offers,
            hint: 'Applications with a recorded Offer stage.',
          },
        ].map(({ label, count, hint }) => (
          <div className="card insights-stat" key={label} title={hint}>
            <p className="text-sm text-slate-500">{label}</p>
            <p className="text-3xl font-semibold tracking-tight">
              {flow.total ? Math.round((count / flow.total) * 100) : 0}%
            </p>
            <p className="insights-stat-detail">
              {count} of {flow.total}
            </p>
          </div>
        ))}
      </div>
      <div className="card p-4 sm:p-5">
        <h2 className="font-semibold text-sm">Your application journey</h2>
        <p className="text-xs text-slate-500 mt-1 mb-4">
          {flow.total} applications · Recorded stages, with repeated OA rounds counted once.
        </p>
        {flow.total ? (
          <FlowChart flow={flow} />
        ) : (
          <div className="py-16 text-center">
            <h3 className="font-medium text-sm">
              {apps.length ? 'No applications in this period' : 'No applications yet'}
            </h3>
            <p className="text-xs text-slate-500 mt-2">
              {apps.length
                ? 'Choose a wider date range to see your application journey.'
                : 'Track a job to start building your application journey.'}
            </p>
          </div>
        )}
        {flow.total > 0 && (
          <p className="text-xs text-slate-500 mt-4">
            Flow widths show application counts. In-progress paths end at the last recorded stage.
            Rates use all recorded statuses; response means any status beyond Applied.
          </p>
        )}
      </div>
    </section>
  );
}
