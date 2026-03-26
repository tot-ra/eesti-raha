import { mkdir, writeFile } from 'node:fs/promises';

const API_BASE = 'https://andmed.stat.ee/api/v1/et/stat';
const RHR_BASE = 'https://riigihanked.riik.ee/rhr/api/public/v1/opendata';
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

function decodeXmlEntities(input) {
  return input
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function safeId(input) {
  return input.replaceAll(/[^A-Za-z0-9]+/g, '_').replaceAll(/^_+|_+$/g, '').slice(0, 64) || 'x';
}

function pickIncomeRows(rows) {
  // RR055 uses hierarchical ESA codes (for example D2 includes D21),
  // so summing top-N rows can double-count.
  const preferredCodes = ['D2', 'D5', 'D61', 'D7', 'D9', 'D4', 'P1O'];
  const preferredRows = preferredCodes.map((code) => rows.find((row) => row.code === code)).filter((row) => Boolean(row && row.value));
  if (preferredRows.length > 0) {
    return preferredRows;
  }

  // Fallback: use leaf rows only.
  const leaves = rows.filter((row) => {
    if (!row.value) return false;
    return !rows.some((other) => other.code !== row.code && other.value && other.code.startsWith(row.code));
  });
  return leaves.sort((a, b) => b.value - a.value).slice(0, 10);
}

function mapCpvToFunction(cpvCode) {
  const group = Number(String(cpvCode).slice(0, 2));
  if (!Number.isFinite(group)) return '04';
  if (group === 35) return '02';
  if (group === 33 || group === 85) return '07';
  if (group === 80) return '09';
  if (group === 92) return '08';
  if (group === 98) return '10';
  if (group === 75) return '01';
  if (group === 45) return '06';
  return '04';
}

function pickInstitutionName(names) {
  const publicKeywords = ['ministeerium', 'vallavalitsus', 'linnavalitsus', 'amet', 'keskus', 'haigla', 'sihtasutus', 'ülikool', 'politsei', 'päästeamet', 'riigi'];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (publicKeywords.some((word) => lower.includes(word))) {
      return name;
    }
  }
  return names[0] ?? 'Unknown institution';
}

function pickContractTitle(names, institutionName) {
  for (const name of names) {
    if (name === institutionName) continue;
    if (name.length < 12) continue;
    const lower = name.toLowerCase();
    if (lower.includes('riigihangete register') || lower.includes('vaidlustuskomisjon')) continue;
    return name;
  }
  return `Contract for ${institutionName}`;
}

function buildContractRecord({ amountEur, cpv, institutionName, title }) {
  const amountM = toMillions(amountEur / 1_000_000);
  if (!amountM || amountM < 0.2) return null;
  const functionCode = mapCpvToFunction(cpv);
  return {
    functionCode,
    sectorCode: '2',
    institutionName,
    cpv2: cpv.slice(0, 2),
    cpv,
    title,
    amountM
  };
}

function parseContractsFromUblAwardXml(xml) {
  const parsed = [];
  const notices = [...xml.matchAll(/<ContractAwardNotice\b[\s\S]*?<\/ContractAwardNotice>/g)].map((m) => m[0]);
  for (const notice of notices) {
    const amountMatches = [...notice.matchAll(/<(?:cbc|efbc):(?:PayableAmount|TotalAmount|MaximumValueAmount|OverallMaximumFrameworkContractsAmount)[^>]*>([0-9.]+)</g)];
    const amounts = amountMatches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n > 0);
    if (!amounts.length) continue;
    const amountEur = Math.max(...amounts);

    const cpvMatch = notice.match(/listName=\"cpv\">([0-9]{8})</);
    const cpv = cpvMatch ? cpvMatch[1] : '00000000';

    const names = [...notice.matchAll(/<cbc:Name[^>]*>([^<]+)<\/cbc:Name>/g)]
      .map((m) => decodeXmlEntities(m[1]).trim())
      .filter((v) => v && v.length > 2);
    if (!names.length) continue;

    const institutionName = pickInstitutionName(names);
    const title = pickContractTitle(names, institutionName);
    const contract = buildContractRecord({ amountEur, cpv, institutionName, title });
    if (contract) parsed.push(contract);
  }
  return parsed;
}

function parseContractsFromLegacyAwardXml(xml) {
  const parsed = [];
  const forms = [...xml.matchAll(/<FORM_SECTION>[\s\S]*?<\/FORM_SECTION>/g)].map((m) => m[0]);
  for (const form of forms) {
    const amountMatches = [...form.matchAll(/<VAL_TOTAL\b[^>]*>([0-9.]+)</g)];
    const amounts = amountMatches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n > 0);
    if (!amounts.length) continue;
    const amountEur = Math.max(...amounts);

    const cpvMatch = form.match(/<CPV_CODE\b[^>]*CODE=\"([0-9]{8})\"/);
    const cpv = cpvMatch ? cpvMatch[1] : '00000000';

    const institutionMatch = form.match(/<ADDRESS_CONTRACTING_BODY>[\s\S]*?<OFFICIALNAME>([^<]+)</);
    const institutionName = decodeXmlEntities((institutionMatch?.[1] ?? 'Unknown institution').trim());

    const titleMatch =
      form.match(/<OBJECT_CONTRACT>[\s\S]*?<TITLE>\s*<P>([^<]+)<\/P>/) ??
      form.match(/<TITLE>\s*<P>([^<]+)<\/P>/);
    const title = decodeXmlEntities((titleMatch?.[1] ?? `Contract for ${institutionName}`).trim());

    const contract = buildContractRecord({ amountEur, cpv, institutionName, title });
    if (contract) parsed.push(contract);
  }
  return parsed;
}

async function fetchProcurementContracts(year) {
  const contracts = [];
  const sourceUrls = [];
  const months = Array.from({ length: 12 }, (_, index) => 12 - index);

  for (const month of months) {
    try {
      const url = `${RHR_BASE}/notice_award/${year}/month/${month}/xml`;
      const res = await fetch(url);
      if (!res.ok) continue;
      sourceUrls.push(url);
      const xml = await res.text();
      const parsedContracts = xml.includes('<ContractAwardNotice')
        ? parseContractsFromUblAwardXml(xml)
        : parseContractsFromLegacyAwardXml(xml);
      contracts.push(...parsedContracts);
    } catch {
      // Try next month fallback.
    }
  }

  return {
    contracts: contracts.sort((a, b) => b.amountM - a.amountM).slice(0, 180),
    sources: sourceUrls
  };
}

/** @returns {Promise<YearGraph>} */
async function fetchYearGraph(year, rr055Config, rr056Config) {
  const rr055Query = [
    { code: rr055Config.yearVarCode, selection: { filter: 'item', values: [year] } },
    { code: rr055Config.lineVarCode, selection: { filter: 'all', values: ['*'] } },
    { code: rr055Config.revenueExpenseVarCode, selection: { filter: 'item', values: [rr055Config.revenueCode] } },
    { code: rr055Config.sectorVarCode, selection: { filter: 'item', values: [rr055Config.sectorCode] } }
  ];
  if (rr055Config.measureVarCode && rr055Config.measureCode) {
    rr055Query.splice(1, 0, { code: rr055Config.measureVarCode, selection: { filter: 'item', values: [rr055Config.measureCode] } });
  }
  const rr055Request = { query: rr055Query, response: { format: 'json-stat2' } };

  const rr056Request = {
    query: [
      { code: 'Aasta', selection: { filter: 'item', values: [year] } },
      { code: 'Sektor', selection: { filter: 'item', values: [rr056Config.sectorCode] } },
      { code: 'Valitsemisfunktsioon', selection: { filter: 'all', values: ['*'] } },
      { code: 'Näitaja', selection: { filter: 'item', values: [rr056Config.expenseTotalCode] } }
    ],
    response: { format: 'json-stat2' }
  };

  const rr056DetailRequest = {
    query: [
      { code: 'Aasta', selection: { filter: 'item', values: [year] } },
      { code: 'Sektor', selection: { filter: 'item', values: [rr056Config.sectorCode] } },
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

  const incomeDims = decodeDimension(incomeData, rr055Config.lineVarCode);
  const incomeRowsRaw = incomeDims
    .map((dim, index) => ({ code: dim.code, label: dim.label, value: toMillions(incomeData.value[index]) }))
    .filter((row) => row.value);
  const incomeRows = pickIncomeRows(incomeRowsRaw);
  const incomeTotalRow = incomeRowsRaw.find((row) => row.code === 'TR_TE');
  const derivedIncomeTotal = Number(incomeRows.reduce((sum, row) => sum + row.value, 0).toFixed(1));
  const incomeTotal = incomeTotalRow?.value ?? derivedIncomeTotal;

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
  const indicatorTotalCode = String(rr056Config.expenseTotalCode);
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

  // Procurement enrichment (RHR open-data contracts): Sector -> Institution -> Program(CPV) -> Contract.
  // Values are capped per top-level function to keep this as a drill-down sample layer.
  const procurementSources = [];
  try {
    const procurementData = await fetchProcurementContracts(year);
    const procurementContracts = procurementData.contracts;
    procurementSources.push(...procurementData.sources);
    const topFunctionBudgets = new Map();
    for (const link of links) {
      if (link.source === 'EXP_TOTAL' && /^EXP_[0-9]{2}$/.test(link.target)) {
        topFunctionBudgets.set(link.target, link.value);
      }
    }

    const remainingByFunction = new Map();
    for (const [functionNodeId, budgetValue] of topFunctionBudgets.entries()) {
      remainingByFunction.set(functionNodeId, budgetValue * 0.2);
    }

    const accepted = [];
    for (const contract of procurementContracts) {
      const functionNodeId = `EXP_${contract.functionCode}`;
      const remaining = remainingByFunction.get(functionNodeId) ?? 0;
      if (remaining <= 0) continue;
      const usedValue = Math.min(contract.amountM, remaining);
      if (usedValue < 0.2) continue;
      remainingByFunction.set(functionNodeId, remaining - usedValue);
      accepted.push({ ...contract, usedValue, functionNodeId });
    }

    const sectorTotals = new Map();
    const hubTotals = new Map();
    const institutionTotals = new Map();
    const cpvTotals = new Map();
    for (const row of accepted) {
      const sectorNodeId = `EXP_SECTOR_${row.sectorCode}`;
      const hubId = `${sectorNodeId}__PROC`;
      const instId = `${hubId}__INST_${safeId(row.institutionName)}`;
      const cpvId = `${instId}__CPV_${row.cpv2}`;
      sectorTotals.set(sectorNodeId, (sectorTotals.get(sectorNodeId) ?? 0) + row.usedValue);
      hubTotals.set(hubId, (hubTotals.get(hubId) ?? 0) + row.usedValue);
      institutionTotals.set(instId, (institutionTotals.get(instId) ?? 0) + row.usedValue);
      cpvTotals.set(cpvId, (cpvTotals.get(cpvId) ?? 0) + row.usedValue);
    }

    const groupedBySector = new Map();
    for (const row of accepted) {
      const sectorNodeId = `EXP_SECTOR_${row.sectorCode}`;
      const arr = groupedBySector.get(sectorNodeId) ?? [];
      arr.push(row);
      groupedBySector.set(sectorNodeId, arr);
    }

    for (const [sectorNodeId, rows] of groupedBySector.entries()) {
      const sectorNode = nodes.find((n) => n.id === sectorNodeId);
      if (!sectorNode) continue;
      const hubId = `${sectorNodeId}__PROC`;
      if (!createdExpenseNodes.has(hubId)) {
        nodes.push({
          id: hubId,
          label: 'Procurement Contracts',
          side: 'expense',
          group: sectorNode.group,
          depth: Math.max(5, sectorNode.depth + 1),
          parentId: sectorNodeId,
          source: 'RHR'
        });
        createdExpenseNodes.add(hubId);
      }

      links.push({
        source: sectorNodeId,
        target: hubId,
        value: Number((hubTotals.get(hubId) ?? 0).toFixed(1)),
        kind: 'expense',
        sourceRef: 'RHR open data'
      });

      const byInst = new Map();
      for (const row of rows) {
        const key = row.institutionName;
        const arr = byInst.get(key) ?? [];
        arr.push(row);
        byInst.set(key, arr);
      }

      for (const [institutionName, instRows] of byInst.entries()) {
        const instId = `${hubId}__INST_${safeId(institutionName)}`;
        if (!createdExpenseNodes.has(instId)) {
          nodes.push({
            id: instId,
            label: institutionName,
            side: 'expense',
            group: sectorNode.group,
            depth: Math.max(6, sectorNode.depth + 2),
            parentId: hubId,
            source: 'RHR'
          });
          createdExpenseNodes.add(instId);
        }

        links.push({
          source: hubId,
          target: instId,
          value: Number((institutionTotals.get(instId) ?? 0).toFixed(1)),
          kind: 'expense',
          sourceRef: 'RHR open data'
        });

        const byCpv2 = new Map();
        for (const row of instRows) {
          const arr = byCpv2.get(row.cpv2) ?? [];
          arr.push(row);
          byCpv2.set(row.cpv2, arr);
        }

        for (const [cpv2, cpvRows] of byCpv2.entries()) {
          const cpvId = `${instId}__CPV_${cpv2}`;
          if (!createdExpenseNodes.has(cpvId)) {
            nodes.push({
              id: cpvId,
              label: `Program CPV ${cpv2}`,
              side: 'expense',
              group: sectorNode.group,
              depth: Math.max(7, sectorNode.depth + 3),
              parentId: instId,
              source: 'RHR'
            });
            createdExpenseNodes.add(cpvId);
          }

          links.push({
            source: instId,
            target: cpvId,
            value: Number((cpvTotals.get(cpvId) ?? 0).toFixed(1)),
            kind: 'expense',
            sourceRef: 'RHR open data'
          });

          const topContracts = cpvRows.sort((a, b) => b.usedValue - a.usedValue).slice(0, 4);
          for (const contract of topContracts) {
            const contractId = `${cpvId}__C_${safeId(contract.title)}_${safeId(contract.cpv)}`;
            if (!createdExpenseNodes.has(contractId)) {
              nodes.push({
                id: contractId,
                label: contract.title,
                side: 'expense',
                group: sectorNode.group,
                depth: Math.max(8, sectorNode.depth + 4),
                parentId: cpvId,
                source: 'RHR'
              });
              createdExpenseNodes.add(contractId);
            }

            links.push({
              source: cpvId,
              target: contractId,
              value: contract.usedValue,
              kind: 'expense',
              sourceRef: 'RHR open data'
            });
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Procurement enrichment skipped for ${year}: ${error}`);
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      datasetYear: year,
      sector: rr056Config.sectorLabel,
      notes: 'Live data from Statistics Estonia API with deep function/indicator/subsector breakdown plus procurement and institution/program enrichment from RHR open-data. Values in million EUR.',
      sources: [
        'https://andmed.stat.ee/api/v1/et/stat/RR055.PX',
        'https://andmed.stat.ee/api/v1/et/stat/RR056.PX',
        ...(procurementSources.length
          ? procurementSources
          : [`https://riigihanked.riik.ee/rhr/api/public/v1/opendata/notice_award/${year}/month/12/xml`])
      ]
    },
    nodes,
    links
  };
}

async function fetchLiveDataBundle() {
  const [rr055Meta, rr056Meta] = await Promise.all([
    fetchJson(`${API_BASE}/RR055.PX`),
    fetchJson(`${API_BASE}/RR056.PX`)
  ]);

  const rr055YearVar = rr055Meta.variables.find((v) => v.code === 'Aasta' || v.code === 'Vaatlusperiood');
  const rr055LineVar =
    rr055Meta.variables.find((v) => v.code === 'Tulu/kulu liik') ??
    rr055Meta.variables.find((v) => v.code === 'Näitaja');
  const rr055MeasureVar = rr055Meta.variables.find((v) => v.code === 'Näitaja' && (v.values?.length ?? 0) <= 5 && (v.valueTexts?.[0] ?? '').includes('Valitsemissektori'));
  const rr055RevenueExpenseVar = rr055Meta.variables.find((v) => v.code === 'Tulud ja kulud');
  const rr055SectorVar = rr055Meta.variables.find((v) => v.code === 'Sektor');

  if (!rr055YearVar || !rr055LineVar || !rr055RevenueExpenseVar || !rr055SectorVar) {
    throw new Error('RR055 metadata missing expected variables');
  }

  const rr055SectorCodeIndex = rr055SectorVar.valueTexts.findIndex((t) => t.includes('S.13 Valitsemissektor'));
  const rr055SectorCode = rr055SectorVar.values[rr055SectorCodeIndex >= 0 ? rr055SectorCodeIndex : 0];
  const rr055RevenueCodeIndex = rr055RevenueExpenseVar.valueTexts.findIndex((t) => t.toLowerCase().includes('tulud'));
  const rr055RevenueCode = rr055RevenueExpenseVar.values[rr055RevenueCodeIndex >= 0 ? rr055RevenueCodeIndex : 0];
  const rr055MeasureCode = rr055MeasureVar?.values?.[0] ?? null;

  const yearVar = rr056Meta.variables.find((v) => v.code === 'Aasta');
  const sectorVar = rr056Meta.variables.find((v) => v.code === 'Sektor');
  const indicatorVar = rr056Meta.variables.find((v) => v.code === 'Näitaja');

  if (!yearVar || !sectorVar || !indicatorVar) throw new Error('RR056 metadata missing expected variables');

  const sectorCode = '1';
  const sectorLabel = sectorVar.valueTexts[sectorVar.values.indexOf(sectorCode)] ?? 'S.13 Valitsemissektor';
  const expenseTotalCode = indicatorVar.values[indicatorVar.valueTexts.indexOf('Kulud kokku')];
  if (!expenseTotalCode) throw new Error('RR056 indicator "Kulud kokku" not found.');

  const rr055Config = {
    yearVarCode: rr055YearVar.code,
    measureVarCode: rr055MeasureVar?.code ?? null,
    measureCode: rr055MeasureCode,
    lineVarCode: rr055LineVar.code,
    revenueExpenseVarCode: rr055RevenueExpenseVar.code,
    revenueCode: rr055RevenueCode,
    sectorVarCode: rr055SectorVar.code,
    sectorCode: rr055SectorCode
  };
  const rr056Config = { sectorCode, sectorLabel, expenseTotalCode };

  const years = [...yearVar.values].map(String).filter((y) => Number(y) >= 2018).sort((a, b) => Number(b) - Number(a));
  const availableYears = years.slice(0, 8);

  const yearsMap = {};
  for (const year of availableYears) {
    yearsMap[year] = await fetchYearGraph(year, rr055Config, rr056Config);
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
