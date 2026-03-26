import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'd3-format';
import { sankey, sankeyLinkHorizontal, type SankeyGraph, type SankeyLink, type SankeyNode } from 'd3-sankey';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomTransform } from 'd3-zoom';
import type { FlowLink, FlowNode } from '../lib/types';

interface BudgetSankeyProps {
  nodes: FlowNode[];
  links: FlowLink[];
  onNodeClick?: (node: FlowNode) => void;
  focusedNodeId: string | null;
}

interface SankeyNodeDatum extends SankeyNode<any, any> {
  id: string;
  label: string;
  group: string;
  side: FlowNode['side'];
  source: string;
}

interface SankeyLinkDatum extends SankeyLink<any, any> {
  source: string | SankeyNodeDatum;
  target: string | SankeyNodeDatum;
  value: number;
  kind: FlowLink['kind'];
  sourceRef: string;
}

const formatMillions = format(',.1f');

const groupColors: Record<string, string> = {
  'income-total': '#2f855a',
  tax: '#2b9348',
  social: '#55a630',
  property: '#1b7f5d',
  transfers: '#52b788',
  'other-income': '#40916c',
  hub: '#0f172a',
  'expense-total': '#7f1d1d',
  'public-services': '#264653',
  defence: '#b56576',
  safety: '#6d597a',
  economy: '#bc6c25',
  environment: '#2a9d8f',
  housing: '#8ab17d',
  health: '#e76f51',
  culture: '#ffb703',
  education: '#3a86ff',
  'social-protection': '#d62828',
  'other-expense': '#6b7280'
};

function colorFor(group: string): string {
  return groupColors[group] ?? '#64748b';
}

export function BudgetSankey({ nodes, links, onNodeClick, focusedNodeId }: BudgetSankeyProps) {
  const width = 1280;
  const height = 760;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity.translate(40, 15));

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = select(svgRef.current);
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.65, 14])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => setTransform(event.transform));

    svg.call(behavior as never);
    svg.call(behavior.transform as never, zoomIdentity.translate(40, 15).scale(0.92));

    return () => {
      svg.on('.zoom', null);
    };
  }, []);

  const graph = useMemo<SankeyGraph<SankeyNodeDatum, SankeyLinkDatum> | null>(() => {
    if (!nodes.length || !links.length) return null;

    const graphNodes = nodes.map((node) => ({
      id: node.id,
      label: node.label,
      group: node.group,
      side: node.side,
      source: node.source,
    })) satisfies SankeyNodeDatum[];

    const graphLinks = links.map((link) => ({
      source: link.source,
      target: link.target,
      value: link.value,
      kind: link.kind,
      sourceRef: link.sourceRef,
    })) satisfies SankeyLinkDatum[];

    const sankeyGenerator = sankey<SankeyNodeDatum, SankeyLinkDatum>()
      .nodeId((d) => d.id)
      .nodeWidth(20)
      .nodePadding(2)
      .extent([
        [16, 16],
        [width - 16, height - 16],
      ]);

    try {
      return sankeyGenerator({ nodes: graphNodes, links: graphLinks });
    } catch {
      return null;
    }
  }, [height, links, nodes, width]);

  if (!graph) {
    return <div className="chart-empty">No graph data available for current filter.</div>;
  }

  const path = sankeyLinkHorizontal<SankeyNodeDatum, SankeyLinkDatum>();
  const maxLinkValue = Math.max(...graph.links.map((link) => link.value), 1);

  return (
    <div className="chart-shell">
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="Estonian budget flow diagram">
        <defs>
          <filter id="soft-shadow">
            <feDropShadow dx="0" dy="1.8" stdDeviation="2" floodOpacity="0.25" />
          </filter>
        </defs>

        <g transform={transform.toString()}>
          {graph.links.map((link, index) => {
            const sourceNode = link.source as SankeyNodeDatum;
            const normalized = link.value / maxLinkValue;
            const strokeOpacity = 0.2 + normalized * 0.75;
            const linkColor =
              sourceNode.side === 'income'
                ? `rgba(46, 125, 50, ${strokeOpacity.toFixed(3)})`
                : `rgba(185, 28, 28, ${strokeOpacity.toFixed(3)})`;
            const strokeWidth = Math.max(0.2, link.width ?? 0);

            return (
              <g key={`${sourceNode.id}-${(link.target as SankeyNodeDatum).id}-${index}`}>
                <path d={path(link) ?? undefined} fill="none" stroke={linkColor} strokeWidth={strokeWidth} strokeLinecap="butt" />
                <title>
                  {`${sourceNode.label} -> ${(link.target as SankeyNodeDatum).label}\n${formatMillions(link.value)} M EUR`}
                </title>
              </g>
            );
          })}

          {graph.nodes.map((node) => {
            const widthPx = Math.max(1, (node.x1 ?? 0) - (node.x0 ?? 0));
            const heightPx = Math.max(0.6, (node.y1 ?? 0) - (node.y0 ?? 0));
            const isFocused = focusedNodeId === node.id;
            const fill = colorFor(node.group);

            return (
              <g key={node.id} className="node-group" onClick={() => onNodeClick?.(node as unknown as FlowNode)}>
                <rect
                  x={node.x0}
                  y={node.y0}
                  width={widthPx}
                  height={heightPx}
                  fill={fill}
                  stroke={isFocused ? '#0f172a' : '#ffffff'}
                  strokeWidth={isFocused ? 2.5 : 1}
                  rx={4}
                  filter="url(#soft-shadow)"
                  className="node-rect"
                />
                <text
                  x={(node.x0 ?? 0) + ((node.x0 ?? 0) < width / 2 ? widthPx + 6 : -6)}
                  y={((node.y0 ?? 0) + (node.y1 ?? 0)) / 2}
                  textAnchor={(node.x0 ?? 0) < width / 2 ? 'start' : 'end'}
                  dominantBaseline="middle"
                  className="node-label"
                >
                  {heightPx * transform.k >= 10 ? node.label : ''}
                </text>
                <title>{`${node.label}\n${formatMillions(node.value ?? 0)} M EUR`}</title>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="chart-help">
        <span>Flow thickness is proportional to amount (M EUR)</span>
        <span>Deeper labels appear as you zoom in</span>
        <span>Zoom: mouse wheel or trackpad</span>
        <span>Pan: drag on canvas</span>
        <span>Click a node to focus/reset a branch</span>
      </div>
    </div>
  );
}
