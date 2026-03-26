import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = 'https://andmed.stat.ee/api/v1/et/stat';
const OUTPUT_PATH = new URL('../public/data/estonia-budget-flow.json', import.meta.url);

/**
 * @typedef {{id:string,label:string,side:'income'|'expense'|'hub',group:string,depth:number,parentId:string|null,source:string}} FlowNode
 * @typedef {{source:string,target:string,value:number,kind:'income'|'expense',sourceRef:string}} FlowLink
 * @typedef {{meta:{generatedAt:string,datasetYear:string,sector:string,notes:string,sources:string[]},nodes:FlowNode[],links:FlowLink[]}} YearGraph
 */

const FALLBACK_YEAR = {
  meta: {
    generatedAt: new Date().toISOString(),
    datasetYear: '2024',
    sector: 'S.13 Valitsemissektor',
    notes: 'Fallback sample used because live API was unavailable.',
    sources: ['https://andmed.stat.ee/api/v1/et/stat/RR055.PX', 'https://andmed.stat.ee/api/v1/et/stat/RR056.PX']
  },
  nodes: [
    { id: 'INC_TOTAL', label: 'Income Total', side: 'income', group: 'income-total', depth: 0, parentId: null, source: 'fallback' },
    { id: 'inc_taxes', label: 'Taxes', side: 'income', group: 'tax', depth: 1, parentId: 'INC_TOTAL', source: 'fallback' },
    { id: 'inc_social', label: 'Social Contributions', side: 'income', group: 'social', depth: 1, parentId: 'INC_TOTAL', source: 'fallback' },
    { id: 'inc_other', label: 'Other Income', side: 'income', group: 'other-income', depth: 1, parentId: 'INC_TOTAL', source: 'fallback' },
    { id: 'BUDGET', label: 'State Budget (2024)', side: 'hub', group: 'hub', depth: 0, parentId: null, source: 'fallback' },
    { id: 'EXP_TOTAL', label: 'Expenses Total', side: 'expense', group: 'expense-total', depth: 0, parentId: null, source: 'fallback' },
    { id: 'exp_09', label: '09 Education', side: 'expense', group: 'education', depth: 1, parentId: 'EXP_TOTAL', source: 'fallback' },
    { id: 'exp_10', label: '10 Social Protection', side: 'expense', group: 'social-protection', depth: 1, parentId: 'EXP_TOTAL', source: 'fallback' }
  ],
  links: [
    { source: 'inc_taxes', target: 'INC_TOTAL', value: 9500, kind: 'income', sourceRef: 'fallback' },
    { source: 'inc_social', target: 'INC_TOTAL', value: 4300, kind: 'income', sourceRef: 'fallback' },
    { source: 'inc_other', target: 'INC_TOTAL', value: 3027, kind: 'income', sourceRef: 'fallback' },
    { source: 'INC_TOTAL', target: 'BUDGET', value: 16827, kind: 'income', sourceRef: 'fallback' },
    { source: 'BUDGET', target: 'EXP_TOTAL', value: 8100, kind: 'expense', sourceRef: 'fallback' },
    { source: 'EXP_TOTAL', target: 'exp_09', value: 2900, kind: 'expense', sourceRef: 'fallback' },
    { source: 'EXP_TOTAL', target: 'exp_10', value: 5200, kind: 'expense', sourceRef: 'fallback' }
  ]
};

function parseFunctionLabel(valueText) {
  if (valueText === 'Kokku') return { code: 'TOTAL', name: 'Kokku', depth: 0 };
  const firstSpace = valueText.indexOf(' ');
  if (firstSpace < 0) return { code: valueText, name: valueText, depth: 1 };
  const code = valueText.slice(0, firstSpace).trim();
  const name = valueText.slice(firstSpace + 1).trim();
  const depth = code.includes('.') ? code.split('.').length : 1;
  return { code, name, depth };
}

function parentForFunction(code) {
  if (!code.includes('.')) return 'EXP_TOTAL';
  const parentCode = code.split('.').slice(0, -1).join('.');
  return `EXP_${parentCode.replaceAll('.', '_')}`;
}

function inferIncomeGroup(label) {
  const lower = label.toLowerCase();
  if (lower.includes('maks')) return 'tax';
  if (lower.includes('sotsiaal')) return 'social';
  if (lower.includes('omanditulu')) return 'property';
  if (lower.includes('siirded')) return 'transfers';
  return 'other-income';
}

function inferExpenseGroup(code, name) {
  if (code.startsWith('01')) return 'public-services';
  if (code.startsWith('02')) return 'defence';
  if (code.startsWith('03')) return 'safety';
  if (code.startsWith('04')) return 'economy';
  if (code.startsWith('05')) return 'environment';
  if (code.startsWith('06')) return 'housing';
  if (code.startsWith('07')) return 'health';
  if (code.startsWith('08')) return 'culture';
  if (code.startsWith('09')) return 'education';
  if (code.startsWith('10')) return 'social-protection';
  return name.toLowerCase().includes('haridus') ? 'education' : 'other-expense';
}

function decodeDimension(dataset, key) {
  const dimension = dataset.dimension[key];
  const category = dimension.category;
  const indexToCode = Object.keys(category.index).sort((a, b) => category.index[a] - category.index[b]);
  const labels = category.label;
  return indexToCode.map((code) => ({ code, label: labels[code] ?? code }));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Failed request ${url}: HTTP ${res.status}`);
  return res.json();
}

function toMillions(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value <= 0) return null;
  return Number(value.toFixed(1));
}

/** @returns {Promise<YearGraph>} */
async function fetchYearGraph(year, sectorCode, sectorLabel, expenseTotalCode) {
  const rr055Request = {
    query: [
      { code: 'Aasta', selection: { filter: 'item', values: [year] } },
      { code: 'Näitaja', selection: { filter: 'all', values: ['*'] } },
      { code: 'Tulud ja kulud', selection: { filter: 'item', values: ['1'] } },
      { code: 'Sektor', selection: { filter: 'item', values: [sectorCode] } }
    ],
    response: { format: 'json-stat2' }
  };

  const rr056Request = {
    query: [
      { code: 'Aasta', selection: { filter: 'item', values: [year] } },
      { code: 'Sektor', selection: { filter: 'item', values: [sectorCode] } },
      { code: 'Valitsemisfunktsioon', selection: { filter: 'all', values: ['*'] } },
      { code: 'Näitaja', selection: { filter: 'item', values: [expenseTotalCode] } }
    ],
    response: { format: 'json-stat2' }
  };

  const rr056DetailRequest = {
    query: [
      { code: 'Aasta', selection: { filter: 'item', values: [year] } },
      { code: 'Sektor', selection: { filter: 'item', values: [sectorCode] } },
      { code: 'Valitsemisfunktsioon', selection: { filter: 'all', values: ['*'] } },
      { code: 'Näitaja', selection: { filter: 'all', values: ['*'] } }
    ],
    response: { format: 'json-stat2' }
  };

  const rr056SectorBreakdownRequest = {
    query: [
      { code: 'Aasta', selection: { filter: 'item', values: [year] } },
      { code: 'Sektor', selection: { filter: 'all', values: ['*'] } },
      { code: 'Valitsemisfunktsioon', selection: { filter: 'all', values: ['*'] } },
      { code: 'Näitaja', selection: { filter: 'all', values: ['*'] } }
    ],
    response: { format: 'json-stat2' }
  };

  const [incomeData, expenseData, expenseDetailData, expenseSectorData] = await Promise.all([
    fetchJson(`${API_BASE}/RR055.PX`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rr055Request) }),
    fetchJson(`${API_BASE}/RR056.PX`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rr056Request) }),
    fetchJson(`${API_BASE}/RR056.PX`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rr056DetailRequest) }),
    fetchJson(`${API_BASE}/RR056.PX`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rr056SectorBreakdownRequest) })
  ]);

  /** @type {FlowNode[]} */
  const nodes = [
    { id: 'INC_TOTAL', label: 'Income Total', side: 'income', group: 'income-total', depth: 0, parentId: null, source: 'RR055' },
    { id: 'BUDGET', label: `Estonia Government Budget (${year})`, side: 'hub', group: 'hub', depth: 0, parentId: null, source: 'RR055+RR056' },
    { id: 'EXP_TOTAL', label: 'Expenses Total', side: 'expense', group: 'expense-total', depth: 0, parentId: null, source: 'RR056' }
  ];
  /** @type {FlowLink[]} */
  const links = [];

  const incomeDims = decodeDimension(incomeData, 'Näitaja');
  const incomeRows = incomeDims
    .map((dim, index) => ({ code: dim.code, label: dim.label, value: toMillions(incomeData.value[index]) }))
    .filter((row) => row.value && row.label !== 'Kokku')
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const incomeTotal = Number(incomeRows.reduce((sum, row) => sum + row.value, 0).toFixed(1));
  for (const row of incomeRows) {
    const nodeId = `INC_${row.code}`;
    nodes.push({ id: nodeId, label: row.label, side: 'income', group: inferIncomeGroup(row.label), depth: 1, parentId: 'INC_TOTAL', source: 'RR055' });
    links.push({ source: nodeId, target: 'INC_TOTAL', value: row.value, kind: 'income', sourceRef: 'RR055.PX' });
  }
  links.push({ source: 'INC_TOTAL', target: 'BUDGET', value: incomeTotal, kind: 'income', sourceRef: 'RR055.PX' });

  const expenseDims = decodeDimension(expenseData, 'Valitsemisfunktsioon');
  const createdExpenseNodes = new Set(['EXP_TOTAL']);
  const expenseNodeMeta = new Map();
  const expenseChildrenCount = new Map();
  let expenseTopLevelTotal = 0;

  for (let i = 0; i < expenseDims.length; i += 1) {
    const value = toMillions(expenseData.value[i]);
    if (!value) continue;
    const parsed = parseFunctionLabel(expenseDims[i].label);
    if (parsed.code === 'TOTAL') continue;

    const nodeId = `EXP_${parsed.code.replaceAll('.', '_')}`;
    const parentId = parentForFunction(parsed.code);
    if (!createdExpenseNodes.has(nodeId)) {
      const group = inferExpenseGroup(parsed.code, parsed.name);
      nodes.push({ id: nodeId, label: `${parsed.code} ${parsed.name}`, side: 'expense', group, depth: parsed.depth, parentId, source: 'RR056' });
      createdExpenseNodes.add(nodeId);
      expenseNodeMeta.set(nodeId, { code: parsed.code, depth: parsed.depth, group });
    }

    expenseChildrenCount.set(parentId, (expenseChildrenCount.get(parentId) ?? 0) + 1);

    if (parentId === 'EXP_TOTAL') {
      expenseTopLevelTotal += value;
      links.push({ source: 'EXP_TOTAL', target: nodeId, value, kind: 'expense', sourceRef: 'RR056.PX' });
    } else if (createdExpenseNodes.has(parentId)) {
      links.push({ source: parentId, target: nodeId, value, kind: 'expense', sourceRef: 'RR056.PX' });
    }
  }

  links.push({ source: 'BUDGET', target: 'EXP_TOTAL', value: Number(expenseTopLevelTotal.toFixed(1)), kind: 'expense', sourceRef: 'RR056.PX' });

  const functionDimsDetailed = decodeDimension(expenseDetailData, 'Valitsemisfunktsioon');
  const indicatorDimsDetailed = decodeDimension(expenseDetailData, 'Näitaja');
  const sectorDimsDetailed = decodeDimension(expenseSectorData, 'Sektor');
  const indicatorCount = indicatorDimsDetailed.length;
  const indicatorTotalCode = String(expenseTotalCode);
  const indicatorRowsByFunction = new Map();
  const sectorBreakdownByFunctionIndicator = new Map();

  for (let functionIndex = 0; functionIndex < functionDimsDetailed.length; functionIndex += 1) {
    const parsed = parseFunctionLabel(functionDimsDetailed[functionIndex].label);
    if (parsed.code === 'TOTAL') continue;
    const functionNodeId = `EXP_${parsed.code.replaceAll('.', '_')}`;
    const hasChildren = (expenseChildrenCount.get(functionNodeId) ?? 0) > 0;
    if (!createdExpenseNodes.has(functionNodeId) || hasChildren) continue;

    for (let indicatorIndex = 0; indicatorIndex < indicatorCount; indicatorIndex += 1) {
      const indicator = indicatorDimsDetailed[indicatorIndex];
      if (indicator.code === indicatorTotalCode) continue;

      const flatIndex = functionIndex * indicatorCount + indicatorIndex;
      const value = toMillions(expenseDetailData.value[flatIndex]);
      if (!value || value < 10) continue;

      const rows = indicatorRowsByFunction.get(functionNodeId) ?? [];
      rows.push({ indicatorCode: indicator.code, indicatorLabel: indicator.label, value });
      indicatorRowsByFunction.set(functionNodeId, rows);

      const sectorRows = [];
      for (let sectorIndex = 0; sectorIndex < sectorDimsDetailed.length; sectorIndex += 1) {
        const sector = sectorDimsDetailed[sectorIndex];
        if (sector.code === '1') continue;
        const idx = sectorIndex * functionDimsDetailed.length * indicatorCount + functionIndex * indicatorCount + indicatorIndex;
        const sectorValue = toMillions(expenseSectorData.value[idx]);
        if (!sectorValue || sectorValue <= 0) continue;
        sectorRows.push({ sectorCode: sector.code, sectorLabel: sector.label, value: sectorValue });
      }

      if (sectorRows.length) {
        sectorBreakdownByFunctionIndicator.set(`${functionNodeId}|${indicator.code}`, sectorRows);
      }
    }
  }

  for (const [functionNodeId, rows] of indicatorRowsByFunction.entries()) {
    const parentMeta = expenseNodeMeta.get(functionNodeId);
    if (!parentMeta) continue;
    const topRows = rows.sort((a, b) => b.value - a.value).slice(0, 4);

    for (const row of topRows) {
      const indicatorNodeId = `${functionNodeId}__I_${row.indicatorCode.replaceAll('.', '_').replaceAll('+', '_')}`;
      if (!createdExpenseNodes.has(indicatorNodeId)) {
        nodes.push({
          id: indicatorNodeId,
          label: row.indicatorLabel,
          side: 'expense',
          group: parentMeta.group,
          depth: parentMeta.depth + 1,
          parentId: functionNodeId,
          source: 'RR056'
        });
        createdExpenseNodes.add(indicatorNodeId);
      }

      links.push({ source: functionNodeId, target: indicatorNodeId, value: row.value, kind: 'expense', sourceRef: 'RR056.PX' });

      const sectorRows = (sectorBreakdownByFunctionIndicator.get(`${functionNodeId}|${row.indicatorCode}`) ?? [])
        .sort((a, b) => b.value - a.value)
        .slice(0, 3);

      for (const sectorRow of sectorRows) {
        const sectorNodeId = `EXP_SECTOR_${sectorRow.sectorCode}`;
        if (!createdExpenseNodes.has(sectorNodeId)) {
          nodes.push({
            id: sectorNodeId,
            label: sectorRow.sectorLabel,
            side: 'expense',
            group: parentMeta.group,
            depth: 4,
            parentId: 'EXP_TOTAL',
            source: 'RR056'
          });
          createdExpenseNodes.add(sectorNodeId);
        }

        links.push({ source: indicatorNodeId, target: sectorNodeId, value: sectorRow.value, kind: 'expense', sourceRef: 'RR056.PX' });
      }
    }
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      datasetYear: year,
      sector: sectorLabel,
      notes: 'Live data from Statistics Estonia API with deep function/indicator/subsector breakdown. Values in million EUR.',
      sources: ['https://andmed.stat.ee/api/v1/et/stat/RR055.PX', 'https://andmed.stat.ee/api/v1/et/stat/RR056.PX']
    },
    nodes,
    links
  };
}

async function fetchLiveDataBundle() {
  const rr056Meta = await fetchJson(`${API_BASE}/RR056.PX`);
  const yearVar = rr056Meta.variables.find((v) => v.code === 'Aasta');
  const sectorVar = rr056Meta.variables.find((v) => v.code === 'Sektor');
  const indicatorVar = rr056Meta.variables.find((v) => v.code === 'Näitaja');

  if (!yearVar || !sectorVar || !indicatorVar) throw new Error('RR056 metadata missing expected variables');

  const sectorCode = '1';
  const sectorLabel = sectorVar.valueTexts[sectorVar.values.indexOf(sectorCode)] ?? 'S.13 Valitsemissektor';
  const expenseTotalCode = indicatorVar.values[indicatorVar.valueTexts.indexOf('Kulud kokku')];
  if (!expenseTotalCode) throw new Error('RR056 indicator "Kulud kokku" not found.');

  const years = [...yearVar.values].map(String).filter((y) => Number(y) >= 2018).sort((a, b) => Number(b) - Number(a));
  const availableYears = years.slice(0, 8);

  const yearsMap = {};
  for (const year of availableYears) {
    yearsMap[year] = await fetchYearGraph(year, sectorCode, sectorLabel, expenseTotalCode);
    console.log(`Fetched ${year}`);
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sector: sectorLabel,
      availableYears,
      notes: 'Multi-year budget flow bundle from Statistics Estonia API.',
      sources: ['https://andmed.stat.ee/api/v1/et/stat/RR055.PX', 'https://andmed.stat.ee/api/v1/et/stat/RR056.PX']
    },
    availableYears,
    years: yearsMap
  };
}

async function main() {
  await mkdir(new URL('../public/data', import.meta.url), { recursive: true });

  let output;
  try {
    output = await fetchLiveDataBundle();
    console.log(`Fetched ${output.availableYears.length} years.`);
  } catch (error) {
    console.warn(`Live fetch failed; writing fallback sample instead.\n${error}`);
    output = {
      meta: {
        generatedAt: new Date().toISOString(),
        sector: 'S.13 Valitsemissektor',
        availableYears: ['2024'],
        notes: 'Fallback sample used because live API was unavailable.',
        sources: ['https://andmed.stat.ee/api/v1/et/stat/RR055.PX', 'https://andmed.stat.ee/api/v1/et/stat/RR056.PX']
      },
      availableYears: ['2024'],
      years: { '2024': FALLBACK_YEAR }
    };
  }

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
