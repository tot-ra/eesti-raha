import type { BudgetFlowBundle } from './types';

export async function loadBudgetFlowData(): Promise<BudgetFlowBundle> {
  const response = await fetch('/data/estonia-budget-flow.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load budget graph: HTTP ${response.status}`);
  }

  return response.json() as Promise<BudgetFlowBundle>;
}
