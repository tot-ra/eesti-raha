# Project Plan: Interactive Estonian Government Budget Flow Diagram

## 1) Goal
Build a highly interactive, visual flow diagram for Estonia’s public budget where:
- income is on the left,
- expenses are on the right,
- users can drill down from top categories into deeper levels,
- colors encode category groups consistently,
- zoom/pan and branch-focus interactions are smooth.

## 2) Product concept
Primary visualization:
- Sankey-style flow for income -> budget nodes -> expenses.

Secondary detail view (on node click):
- Branch-focused mini-flow (same color family), and
- contextual panel/table with line items, trend, metadata, source links.

Interaction model:
- Global zoom + pan,
- Click node: expand one level deeper,
- Alt-click or breadcrumb: collapse back up,
- Hover: highlight connected flows and show amount + percent,
- Filter chips: year, sector (central/local/social funds), COFOG function.

## 3) Data source research (recommended stack of sources)

### Source A (Core): Statistics Estonia (andmed.stat.ee) API
Use for machine-readable, stable expenditure/revenue structures and historical time series.

Why:
- Official source, API-first, documented JSON/CSV/XLSX access.
- COFOG-based functions map naturally to hierarchical branches.

Relevant entries:
- API base: `https://andmed.stat.ee/api/v1/et`
- Example expenditure table page: `RR056` (general government expenditure by function/sector)

How to use:
- Pull table metadata via GET.
- Pull selected slices via POST (`response.format=json` or `csv`).
- Build hierarchy from function codes (e.g., `09` -> `09.1` -> deeper levels where available).

### Source B (Core): Ministry of Finance budget dashboard (`riigiraha.fin.ee`)
Use for budget-specific and citizen-facing budget exploration context.

Why:
- Official MoF public dashboard focused on budget visibility.
- Useful for mapping presentation logic and category naming used in public communication.

Note:
- Technical extraction may require export endpoints or controlled ingestion if dashboard is JS-heavy.

### Source C (Legal/Reference): State Budget Act (Riigi Teataja) + annual budget materials (fin.ee)
Use for authoritative annual totals, legal reconciliation, and validation of category amounts.

Why:
- Legal ground truth for annual budget allocations.
- Supports correctness checks and lineage documentation.

### Source D (Optional benchmark): Eurostat COFOG (gov_10a_exp)
Use for comparability and validation against harmonized ESA/COFOG outputs.

Why:
- Useful to validate classification consistency and cross-year coherence.
- Good for “methodology confidence” section.

### Source E (Drill-down enhancer): Education institution-level datasets (if available)
Use for school-level drill-down only if institution-level finance data is available in a machine-readable way.

Reality check:
- School-level budget lines are often not fully available in one central budget API.
- Likely approach is to combine multiple datasets (education registries/statistics + municipal/sector finance data).

## 4) Feasibility for “school-level” drill-down

Expected feasible drill-down path (high confidence):
- Government total -> sector -> COFOG function -> subfunction.

Potentially feasible with additional integration (medium confidence):
- Function (Education) -> program/institution groups.

Potentially difficult (lower confidence) without extra datasets:
- Education -> specific school budget flow.

Plan implication:
- Ship MVP with robust function/subfunction drill-down.
- Add institution/school layer as Phase 2 after confirming data coverage and joins.

## 5) Technical architecture

Frontend:
- React + TypeScript + Vite.
- Visualization: D3 (`d3-sankey`) with custom interactions.
- State/data: TanStack Query + Zustand (or Redux Toolkit).
- Styling: CSS variables for category palettes + animated transitions.

Backend (recommended):
- Node.js (Fastify/Express) data service.
- ETL jobs to normalize sources into one canonical graph schema.
- Postgres (or DuckDB for early-stage analytical prototyping).

Data model (canonical):
- `nodes(id, label, level, parent_id, type, source)`
- `flows(id, from_node_id, to_node_id, amount, year, unit, source)`
- `dimensions(year, sector, function_code, institution_code, ...)`
- `lineage(flow_id, origin_dataset, extract_time, transformation_hash)`

## 6) Delivery phases

Phase 0: Discovery (1-2 weeks)
- Validate exact tables/endpoints and export rights.
- Define canonical taxonomy and drill-down rules.
- Produce data dictionary + mapping table.

Phase 1: Data pipeline MVP (1-2 weeks)
- Build ingestion for Statistics Estonia API.
- Add legal annual reconciliation against budget act totals.
- Generate first canonical node-flow dataset.

Phase 2: Interactive diagram MVP (2-3 weeks)
- Build Sankey with zoom/pan, hover, click-expand.
- Add year and category filters.
- Add branch detail panel + breadcrumbs.

Phase 3: Deep drill-down + polish (2-4 weeks)
- Add second-level/third-level expansions where data supports it.
- Add accessibility and performance tuning.
- Add animation polish and responsive behavior.

Phase 4: Institution-level extension (optional, 2-6+ weeks)
- Integrate education/institution datasets.
- Add school-level branch if data quality and joins are sufficient.

## 7) Visual design direction
- Use a strong, non-generic palette with semantic color groups:
  - Income families (greens/teals),
  - Expense families (oranges/reds/ambers),
  - Neutral transfer/admin nodes (slate).
- Keep color stable across zoom levels (same family, varying lightness).
- Use animated flow morphing when expanding/collapsing branches.
- Add mini-map for orientation in large graphs.

## 8) Risks and mitigations
- Risk: Source mismatch across institutions.
  - Mitigation: canonical mapping + explicit reconciliation report per year.

- Risk: School-level data not directly linkable.
  - Mitigation: release with function-level depth first; add institution layer incrementally.

- Risk: Dense graphs become unreadable.
  - Mitigation: progressive disclosure, branch isolation mode, threshold filters.

## 9) Success criteria
- User can answer in <30 sec:
  - “Where does revenue come from?”
  - “Where does money go at category/subcategory level?”
  - “How did this category change by year?”
- Data lineage visible for every shown number.
- Smooth interaction with large graph (>2k links) on modern laptop.

## 10) Immediate next actions
1. Confirm initial scope as “central government + COFOG drill-down” for MVP.
2. Build source inventory spreadsheet (table code, granularity, update frequency, license).
3. Implement first ETL for Statistics Estonia API and produce one-year graph JSON.
4. Prototype Sankey interaction with that JSON before integrating additional sources.
