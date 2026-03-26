export type NodeSide = 'income' | 'expense' | 'hub';

export interface FlowNode {
  id: string;
  label: string;
  side: NodeSide;
  group: string;
  depth: number;
  parentId: string | null;
  source: string;
}

export interface FlowLink {
  source: string;
  target: string;
  value: number;
  kind: 'income' | 'expense';
  sourceRef: string;
}

export interface BudgetFlowData {
  meta: {
    generatedAt: string;
    datasetYear: string;
    sector: string;
    methodology?: 'stats-ee-cofog' | 'mof-budget-law';
    notes: string;
    sources: string[];
  };
  nodes: FlowNode[];
  links: FlowLink[];
}

export interface BudgetFlowBundle {
  meta: {
    generatedAt: string;
    sector: string;
    availableYears: string[];
    notes: string;
    sources: string[];
  };
  availableYears: string[];
  years: Record<string, BudgetFlowData>;
}
