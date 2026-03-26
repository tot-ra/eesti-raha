import { useCallback, useEffect, useMemo, useState } from 'react';
import { BudgetSankey } from './components/BudgetSankey';
import { loadBudgetFlowData } from './lib/data';
import type { BudgetFlowBundle, BudgetFlowData, FlowLink, FlowNode } from './lib/types';

function collectDescendants(startId: string, childrenMap: Map<string, string[]>): Set<string> {
  const result = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length) {
    const current = queue.shift()!;
    const children = childrenMap.get(current) ?? [];
    for (const child of children) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }

  return result;
}

function collectAncestors(startId: string, parentMap: Map<string, string | null>): Set<string> {
  const result = new Set<string>();
  let current: string | null = startId;

  while (current) {
    result.add(current);
    current = parentMap.get(current) ?? null;
  }

  return result;
}

function collectConnectedExpenseGraph(startId: string, links: FlowLink[], byId: Map<string, FlowNode>): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const link of links) {
    if (!adjacency.has(link.source)) adjacency.set(link.source, new Set());
    if (!adjacency.has(link.target)) adjacency.set(link.target, new Set());
    adjacency.get(link.source)!.add(link.target);
    adjacency.get(link.target)!.add(link.source);
  }

  const visited = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current) ?? new Set<string>();
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      const node = byId.get(neighbor);
      if (!node) continue;
      if (node.side === 'income' && node.id !== 'INC_TOTAL' && node.id !== 'BUDGET') continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  return visited;
}

function isExpenseNode(node: FlowNode | undefined): node is FlowNode {
  return Boolean(node && node.side === 'expense');
}

export default function App() {
  const [data, setData] = useState<BudgetFlowBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [extraDepth, setExtraDepth] = useState(5);
  const [minFlowValue, setMinFlowValue] = useState(50);
  const [sortMode, setSortMode] = useState<'default' | 'id' | 'value'>('default');
  const [selectedYear, setSelectedYear] = useState<string>('');
  const yearOptions = useMemo(() => (data ? [...data.availableYears].reverse() : []), [data]);

  const selectYearByOffset = useCallback(
    (offset: number) => {
      if (!selectedYear || yearOptions.length === 0) return;
      const currentIndex = yearOptions.indexOf(selectedYear);
      if (currentIndex < 0) return;
      const nextIndex = currentIndex + offset;
      if (nextIndex < 0 || nextIndex >= yearOptions.length) return;
      setSelectedYear(yearOptions[nextIndex]);
      setFocusNodeId(null);
    },
    [selectedYear, yearOptions]
  );

  useEffect(() => {
    setLoading(true);
    loadBudgetFlowData()
      .then((result) => {
        setData(result);
        const firstYear = result.availableYears[0] ?? '';
        setSelectedYear(firstYear);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  const activeData: BudgetFlowData | null = useMemo(() => {
    if (!data || !selectedYear) return null;
    return data.years[selectedYear] ?? null;
  }, [data, selectedYear]);

  const maxExpenseDepth = useMemo(() => {
    if (!activeData) return 4;
    const depths = activeData.nodes.filter((node) => node.side === 'expense').map((node) => node.depth);
    return Math.max(1, ...depths);
  }, [activeData]);

  useEffect(() => {
    setExtraDepth((current) => Math.min(current, maxExpenseDepth));
  }, [maxExpenseDepth]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName.toLowerCase();
      const isTypingTarget =
        tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable;
      if (isTypingTarget) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectYearByOffset(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectYearByOffset(1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectYearByOffset]);

  const filteredGraph = useMemo(() => {
    if (!activeData) return { nodes: [] as FlowNode[], links: [] as FlowLink[], focusedIds: new Set<string>() };

    const byId = new Map<string, FlowNode>(activeData.nodes.map((node) => [node.id, node]));
    const childrenMap = new Map<string, string[]>();
    const parentMap = new Map<string, string | null>();

    for (const node of activeData.nodes) {
      parentMap.set(node.id, node.parentId);
      if (node.parentId) {
        const existing = childrenMap.get(node.parentId) ?? [];
        existing.push(node.id);
        childrenMap.set(node.parentId, existing);
      }
    }

    const visible = new Set<string>();
    visible.add('INC_TOTAL');
    visible.add('BUDGET');
    visible.add('EXP_TOTAL');

    for (const node of activeData.nodes) {
      if (node.side === 'income' && node.depth <= 1) {
        visible.add(node.id);
      }
    }

    const focusedNode = focusNodeId ? byId.get(focusNodeId) : undefined;
    const focusedIds = new Set<string>();

    if (!isExpenseNode(focusedNode)) {
      for (const node of activeData.nodes) {
        if (node.side === 'expense' && node.depth > 0 && (node.depth <= extraDepth || node.source === 'RHR')) {
          visible.add(node.id);
        }
      }
    } else {
      const treeDescendants = collectDescendants(focusedNode.id, childrenMap);
      const treeAncestors = collectAncestors(focusedNode.id, parentMap);
      const graphConnected = collectConnectedExpenseGraph(focusedNode.id, activeData.links, byId);

      for (const id of treeAncestors) {
        visible.add(id);
        focusedIds.add(id);
      }

      for (const id of treeDescendants) {
        const node = byId.get(id);
        if (!node || node.side !== 'expense') continue;
        visible.add(id);
        focusedIds.add(id);
      }

      for (const id of graphConnected) {
        const node = byId.get(id);
        if (!node) continue;
        visible.add(id);
        focusedIds.add(id);
      }
    }

    const nodes = activeData.nodes.filter((node) => visible.has(node.id));
    const initialLinks = activeData.links.filter((link) => visible.has(link.source) && visible.has(link.target));
    const pinnedLinks = new Set(['INC_TOTAL->BUDGET', 'BUDGET->EXP_TOTAL']);
    const links = initialLinks.filter((link) => {
      const key = `${link.source}->${link.target}`;
      const isProcurementLink = link.sourceRef === 'RHR open data';
      if (pinnedLinks.has(key)) return true;
      if (focusNodeId && focusedIds.has(link.source) && focusedIds.has(link.target)) return true;
      if (isProcurementLink) return true;
      if (focusedIds.has(link.source) || focusedIds.has(link.target)) return true;
      return link.value >= minFlowValue;
    });
    const usedNodeIds = new Set(['INC_TOTAL', 'BUDGET', 'EXP_TOTAL']);
    for (const link of links) {
      usedNodeIds.add(link.source);
      usedNodeIds.add(link.target);
    }
    const cleanedNodes = nodes.filter((node) => usedNodeIds.has(node.id));

    return { nodes: cleanedNodes, links, focusedIds };
  }, [activeData, extraDepth, focusNodeId, minFlowValue]);

  const onNodeClick = (node: FlowNode) => {
    if (node.side !== 'expense' || node.id === 'EXP_TOTAL') {
      setFocusNodeId(null);
      return;
    }

    setFocusNodeId((current) => (current === node.id ? null : node.id));
  };

  const focused = focusNodeId && activeData ? activeData.nodes.find((node) => node.id === focusNodeId) ?? null : null;
  const expenseTableRows = useMemo(() => {
    if (!activeData || !focused || focused.side !== 'expense') return [];

    const byId = new Map<string, FlowNode>(activeData.nodes.map((node) => [node.id, node]));
    const childrenMap = new Map<string, string[]>();
    for (const node of activeData.nodes) {
      if (!node.parentId) continue;
      const existing = childrenMap.get(node.parentId) ?? [];
      existing.push(node.id);
      childrenMap.set(node.parentId, existing);
    }

    const subtree = collectDescendants(focused.id, childrenMap);
    const rows = [];
    for (const nodeId of subtree) {
      if (nodeId === focused.id) continue;
      const node = byId.get(nodeId);
      if (!node || node.side !== 'expense') continue;

      const parentId = node.parentId ?? '';
      const parent = byId.get(parentId);
      const directLink =
        activeData.links.find((link) => link.source === parentId && link.target === nodeId) ??
        activeData.links.find((link) => link.target === nodeId);

      rows.push({
        id: node.id,
        depth: node.depth,
        category: node.label,
        parent: parent?.label ?? '-',
        amount: directLink?.value ?? 0,
        source: directLink?.sourceRef ?? node.source,
      });
    }

    return rows.sort((a, b) => a.depth - b.depth || b.amount - a.amount);
  }, [activeData, focused]);

  if (loading) {
    return <main className="app app-loading">Loading budget graph...</main>;
  }

  if (error || !data || !activeData) {
    return <main className="app app-loading">Failed to load data: {error ?? 'unknown error'}</main>;
  }

  const focusedChildren = focused
    ? filteredGraph.links
        .filter((link) => link.source === focused.id)
        .map((link) => ({
          ...link,
          targetLabel: activeData.nodes.find((node) => node.id === link.target)?.label ?? link.target,
        }))
        .sort((a, b) => b.value - a.value)
    : [];
  const sourceList = Array.from(new Set(activeData.meta.sources));

  return (
    <main className="app">
      <header className="hero">
        <h1>Estonian Budget Flow MVP</h1>
        <p>
          Interactive income-to-expense flow using official Estonian public finance data. Income on the left, expense branches on the
          right, with click-to-focus expansion.
        </p>
      </header>

      <section className="controls">
        <div className="control-card">
          <div className="label">Year</div>
          <div className="year-strip" role="tablist" aria-label="Select year">
            {yearOptions.map((year) => (
              <button
                key={year}
                type="button"
                role="tab"
                aria-selected={selectedYear === year}
                className={`year-chip${selectedYear === year ? ' is-active' : ''}`}
                onClick={() => {
                  setSelectedYear(year);
                  setFocusNodeId(null);
                }}
              >
                {year}
              </button>
            ))}
          </div>
          <div className="hint">Switches full flow graph data. Keyboard: left/right arrows.</div>
        </div>

        <div className="control-card">
          <label htmlFor="depth">Visible expense depth</label>
          <input
            id="depth"
            type="range"
            min={1}
            max={maxExpenseDepth}
            value={extraDepth}
            onChange={(event) => setExtraDepth(Number(event.target.value))}
          />
          <div className="hint">
            {extraDepth} level(s), max {maxExpenseDepth}
          </div>
        </div>

        <div className="control-card">
          <label htmlFor="minFlow">Minimum visible flow (M EUR)</label>
          <input
            id="minFlow"
            type="range"
            min={0}
            max={1000}
            step={25}
            value={minFlowValue}
            onChange={(event) => setMinFlowValue(Number(event.target.value))}
          />
          <div className="hint">{minFlowValue} M EUR</div>
        </div>

        <div className="control-card">
          <label htmlFor="sortMode">Category sorting</label>
          <select id="sortMode" value={sortMode} onChange={(event) => setSortMode(event.target.value as 'default' | 'id' | 'value')}>
            <option value="default">Default layout</option>
            <option value="id">Category ID</option>
            <option value="value">Value (largest first)</option>
          </select>
          <div className="hint">Sorts vertical order of nodes in each column.</div>
        </div>

        <div className="control-card">
          <div className="label">Branch focus</div>
          <div className="hint">{focused ? focused.label : 'No focused branch'}</div>
          <button className="reset-btn" type="button" onClick={() => setFocusNodeId(null)}>
            Reset focus
          </button>
        </div>

        <div className="control-card meta-card">
          <div>
            <strong>Year:</strong> {activeData.meta.datasetYear}
          </div>
          <div>
            <strong>Sector:</strong> {activeData.meta.sector}
          </div>
          <div>
            <strong>Method:</strong> {activeData.meta.methodology === 'mof-budget-law' ? 'MoF budget law (fallback)' : 'Statistics Estonia (RR055/RR056)'}
          </div>
          <div>
            <strong>Generated:</strong> {new Date(data.meta.generatedAt).toLocaleString()}
          </div>
        </div>
      </section>

      <BudgetSankey
        nodes={filteredGraph.nodes}
        links={filteredGraph.links}
        onNodeClick={onNodeClick}
        focusedNodeId={focusNodeId}
        sortMode={sortMode}
      />

      {focused && (
        <section className="focus-panel">
          <h2>{focused.label}</h2>
          <p>Visible outgoing layers from this node (including small flows).</p>
          <ul>
            {focusedChildren.length === 0 && <li>No visible deeper children at current depth.</li>}
            {focusedChildren.map((item) => (
              <li key={`${item.source}-${item.target}`}>
                {item.targetLabel}: {item.value.toFixed(1)} M EUR
              </li>
            ))}
          </ul>
        </section>
      )}

      {focused && (
        <section className="expense-table-panel">
          <h2>Expense Details: {focused.label}</h2>
          <p>Deeper categories and amounts for the selected branch.</p>
          <div className="expense-table-wrap">
            <table className="expense-table">
              <thead>
                <tr>
                  <th>Depth</th>
                  <th>Category</th>
                  <th>Parent</th>
                  <th>Amount (M EUR)</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {expenseTableRows.length === 0 && (
                  <tr>
                    <td colSpan={5}>No deeper expense rows found for this selection.</td>
                  </tr>
                )}
                {expenseTableRows.slice(0, 250).map((row) => (
                  <tr key={row.id}>
                    <td>{row.depth}</td>
                    <td>{row.category}</td>
                    <td>{row.parent}</td>
                    <td>{row.amount.toFixed(2)}</td>
                    <td>{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="sources">
        <h2>Sources ({activeData.meta.datasetYear})</h2>
        <p>{activeData.meta.notes}</p>
        <p>
          Showing sources used for selected year <strong>{activeData.meta.datasetYear}</strong>.
        </p>
        <ul>
          {sourceList.map((source) => (
            <li key={source}>
              <a href={source} target="_blank" rel="noreferrer">
                {source}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
