# Eesti Raha: Estonian Budget Flow MVP

Interactive Sankey visualization of Estonia's public budget flows, built with React + TypeScript + D3.

It shows:
- income categories on the left,
- a budget hub in the middle,
- expense hierarchy on the right,
- optional procurement/institution/program/contract drill-down from RHR open data.

All values are in **million EUR**.

## What this project contains

- Frontend app (Vite + React) that renders an interactive Sankey graph.
- Data fetch/transform script that builds a single JSON bundle used by the frontend.
- Generated dataset in `public/data/estonia-budget-flow.json`.

## Tech stack

- React 19
- TypeScript
- Vite
- D3 (`d3`, `d3-sankey`, `d3-selection`, `d3-zoom`)
- Node.js script for ETL (`scripts/fetch-estonia-budget.mjs`)

## Project structure

- `src/main.tsx`: app bootstrap.
- `src/App.tsx`: data loading, filters, branch focus logic, side panels.
- `src/components/BudgetSankey.tsx`: Sankey layout + SVG rendering + zoom/pan.
- `src/lib/types.ts`: shared graph types.
- `src/lib/data.ts`: JSON loader (`/data/estonia-budget-flow.json`).
- `scripts/fetch-estonia-budget.mjs`: ETL that fetches, normalizes, enriches, writes data file.
- `public/data/estonia-budget-flow.json`: multi-year output consumed by frontend.
- `PROJECT_PLAN.md`: product and scope planning notes.

## How data flows through the system

1. Run ETL script (`npm run data:refresh`).
2. Script fetches live metadata/data from Statistics Estonia tables:
   - `RR055.PX` for income side
   - `RR056.PX` for expense side
3. Script builds per-year graph with nodes/links.
4. Script enriches expense side with deep indicator/subsector layers and procurement chain (RHR open data).
5. Script writes bundle to `public/data/estonia-budget-flow.json`.
6. Frontend fetches this file at runtime and renders the selected year.

## Data model

Defined in `src/lib/types.ts`:

- `FlowNode`: `id`, `label`, `side`, `group`, `depth`, `parentId`, `source`
- `FlowLink`: `source`, `target`, `value`, `kind`, `sourceRef`
- `BudgetFlowData`: graph + metadata for one year
- `BudgetFlowBundle`: multi-year object (`availableYears`, `years` map)

Important fixed nodes used across years:
- `INC_TOTAL`
- `BUDGET`
- `EXP_TOTAL`

## ETL behavior (`scripts/fetch-estonia-budget.mjs`)

### 1) Year selection

- Reads available years from RR056 metadata.
- Keeps years `>= 2018`.
- Fetches up to 8 newest years.

### 2) Income construction

- Pulls RR055 income rows.
- Prefers a curated set of ESA codes (`D2`, `D5`, `D61`, `D7`, `D9`, `D4`, `P1O`) to avoid double counting from hierarchical totals.
- Adds links `income category -> INC_TOTAL -> BUDGET`.

### 3) Expense construction

- Pulls RR056 function rows (`Valitsemisfunktsioon`).
- Parses hierarchical COFOG-like codes (`01`, `01.1`, etc.) into parent-child tree.
- Adds links from `EXP_TOTAL` to top-level functions and between function levels.
- Adds `BUDGET -> EXP_TOTAL` link using top-level expense sum.

### 4) Deep detail enrichment from RR056

For leaf function nodes:
- Adds top indicator nodes (up to 4 per function) if values are meaningful.
- Adds subsector breakdown nodes/links from sector-split dataset (top 3 per indicator).

### 5) Procurement enrichment from RHR

- Tries to parse award XML for all months (12 -> 1) of each year.
- Maps contract CPV prefixes to function buckets.
- Caps procurement contribution to 20% of each top-level function budget.
- Builds chain:
  - `EXP_SECTOR_* -> Procurement Contracts -> Institution -> Program CPV XX -> Contract`
- Keeps top contracts per CPV group.

If procurement fetch/parse fails, script continues without procurement layer.

### 6) Fallback behavior

If live API fetching fails completely, script writes a minimal fallback sample (single year, 2024).

## Frontend behavior (`src/App.tsx`)

### Initial load

- Fetches bundle from `/data/estonia-budget-flow.json`.
- Selects first available year from bundle (typically newest year in file).

### Controls

- Year chips: switch year (left/right arrow keys also switch).
- Visible expense depth slider: limits expense nodes by `depth`.
- Minimum visible flow slider: removes small links unless pinned/focused/procurement.
- Category sorting:
  - default Sankey order
  - by node id
  - by node value (largest first)
- Reset focus button.

### Focus logic

Clicking an expense node toggles branch focus.
Focused view includes:
- ancestors of focused node,
- all descendants,
- connected expense graph neighbors,
- procurement links and key spine links retained.

Clicking non-expense nodes (or `EXP_TOTAL`) clears focus.

### Side panels

- Focus panel: outgoing children and values for focused node.
- Expense details table: deeper rows under focused branch, with parent and source.
- Procurement contracts panel: visible contract nodes (`source === 'RHR'`, deep levels).
- Sources panel: metadata/source URLs for selected year.

## Sankey rendering (`src/components/BudgetSankey.tsx`)

- Uses `d3-sankey` with fixed extent and zero node padding for compact value-driven bars.
- Uses `d3-zoom` for pan/zoom (`scaleExtent [0.65, 14]`).
- Colors by semantic `group` (income/expense categories).
- Link thickness comes from Sankey value/width.
- Label visibility is adaptive by zoom scale + node height to reduce clutter.
- Tiny nodes render as lines; larger nodes render as rounded rectangles.

## Running locally

### Prerequisites

- Node.js 20+ recommended
- npm

### Install

```bash
npm install
```

### Start dev server

```bash
npm run dev
```

### Refresh data bundle from live APIs

```bash
npm run data:refresh
```

### Build production bundle

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

## Data sources

- Statistics Estonia API:
  - `https://andmed.stat.ee/api/v1/et/stat/RR055.PX`
  - `https://andmed.stat.ee/api/v1/et/stat/RR056.PX`
- Estonian Public Procurement Register (RHR) open data:
  - `https://riigihanked.riik.ee/rhr/api/public/v1/opendata`

## Notes and caveats

- Dataset language is mostly Estonian labels from source tables.
- Procurement contract parsing is heuristic from XML and intentionally capped; it is an enrichment layer, not full accounting reconciliation.
- Flow filtering (`Minimum visible flow`) can hide small links unless they are pinned, procurement-derived, or part of focused branch context.
- Existing generated JSON can be large; loading/rendering depends on browser performance and selected filters.

## Quick command reference

- `npm run dev` - start development server
- `npm run data:refresh` - regenerate `public/data/estonia-budget-flow.json`
- `npm run build` - typecheck + production build
- `npm run preview` - preview production build
