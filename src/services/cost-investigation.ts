import { createHash } from 'node:crypto';

const SCALE = 10n ** 18n;
export const MAX_INVESTIGATION_BYTES = 50 * 1024 * 1024;
const REQUIRED_COLUMNS = [
  'BillingPeriodStart',
  'BillingPeriodEnd',
  'BillingCurrency',
  'BilledCost',
  'ServiceName',
  'ChargeCategory',
] as const;

export type InvestigationInput = { name: string; content: string };
export type InvestigationEvidence = {
  id: string;
  sourceId: string;
  record: number;
  startLine: number;
  endLine: number;
  period: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  currency: string;
  billedCost: string;
  providerName: string;
  billingAccountId: string;
  subAccountId: string;
  resourceId: string;
  resourceName: string;
  serviceName: string;
  chargeCategory: string;
  chargeClass: string;
  skuId: string;
  meterId: string;
  regionId: string;
  pricingCategory: string;
  commitmentDiscountId: string;
  pricingQuantity: string;
  pricingUnit: string;
};
export type UsageExplanation = {
  dimensions: Record<string, string>;
  baselineCost: string;
  currentCost: string;
  delta: string;
  evidence: InvestigationDriver['evidence'];
  status: 'decomposed' | 'insufficient-evidence';
  reason: string;
  baselineQuantity?: string;
  currentQuantity?: string;
  quantityEffect?: string;
  observedUnitCostEffect?: string;
};
export type InvestigationDriver = {
  dimensions: Record<string, string>;
  baselineCost: string;
  currentCost: string;
  delta: string;
  presence: 'both' | 'baseline-only' | 'current-only';
  evidence: { baseline: string[]; current: string[] };
};
export type CostInvestigation = {
  schemaVersion: 1;
  costBasis: 'BilledCost';
  periodBasis: 'BillingPeriodStart';
  baseline: string;
  current: string;
  sources: {
    id: string;
    name: string;
    sha256: string;
    rowCount: number;
    selectedRowCount: number;
  }[];
  currencies: {
    currency: string;
    baselineCost: string;
    currentCost: string;
    delta: string;
    hasBothPeriods: boolean;
    billingBridge: {
      chargeCategory: string;
      chargeClass: string;
      baselineCost: string;
      currentCost: string;
      delta: string;
      interpretation: string;
      evidence: InvestigationDriver['evidence'];
    }[];
    usageExplanations: UsageExplanation[];
    breakdowns: Record<'service' | 'resource' | 'chargeCategory', InvestigationDriver[]>;
  }[];
  evidence: InvestigationEvidence[];
  warnings: string[];
  limitations: string[];
};

type CsvRecord = { fields: string[]; record: number; startLine: number; endLine: number };

function* csvRecords(content: string): Generator<CsvRecord> {
  const text = content.replace(/^\uFEFF/, '');
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let startLine = 1;
  let record = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        field += '\n';
        line += 1;
      } else {
        field += character;
      }
    } else if (character === ',') {
      fields.push(field);
      field = '';
      closedQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      fields.push(field);
      if (fields.length !== 1 || fields[0]!.trim() !== '') {
        yield { fields, record: ++record, startLine, endLine: line };
      }
      fields = [];
      field = '';
      closedQuote = false;
      line += 1;
      startLine = line;
    } else if (character === '"' && field === '' && !closedQuote) {
      quoted = true;
    } else if (character === '"' || closedQuote) {
      throw new Error(`Malformed CSV quoting at line ${line}.`);
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error(`Unterminated CSV quote starting at line ${startLine}.`);
  if (fields.length > 0 || field.trim() !== '' || closedQuote) {
    fields.push(field);
    yield { fields, record: ++record, startLine, endLine: line };
  }
}

// Fixed-point arithmetic keeps refunds and sub-cent charges exactly reconcilable.
const parseAmount = (value: string): bigint => {
  const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d{1,2}))?$/.exec(value);
  if (!match || value.length > 80) throw new Error('BilledCost must be a decimal number.');
  const [whole = '', fractional = ''] = match[2]!.split('.');
  let digits = whole + fractional;
  let decimals = fractional.length - Number(match[3] ?? 0);
  while (decimals > 18 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    decimals -= 1;
  }
  if (decimals > 18 || digits.length - decimals > 30) {
    throw new Error('BilledCost supports at most 18 fractional and 30 integer digits.');
  }
  const amount = BigInt(digits || '0') * 10n ** BigInt(18 - decimals);
  return match[1] === '-' ? -amount : amount;
};

const amountText = (value: bigint): string => {
  const magnitude = value < 0n ? -value : value;
  const fractional = (magnitude % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${magnitude / SCALE}.${fractional.padEnd(2, '0')}`;
};

const parseDate = (value: string, field: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?Z)?$/.test(value)) {
    throw new Error(`${field} must be an ISO UTC date.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`${field} is not a valid date.`);
  }
  return date.toISOString();
};

type Dimension = 'service' | 'resource' | 'chargeCategory';
const dimensionsFor = (
  row: InvestigationEvidence,
  dimension: Dimension,
): Record<string, string> => {
  const common = { providerName: row.providerName, billingAccountId: row.billingAccountId };
  if (dimension === 'service') return { ...common, serviceName: row.serviceName };
  if (dimension === 'chargeCategory') return { ...common, chargeCategory: row.chargeCategory };
  const resourceId = /^\/subscriptions\//i.test(row.resourceId)
    ? row.resourceId.toLowerCase()
    : row.resourceId;
  // Charges without a resource are retained, not assigned to a fictional resource.
  return resourceId
    ? { ...common, subAccountId: row.subAccountId, resourceId }
    : {
        ...common,
        subAccountId: row.subAccountId,
        resourceId: '',
        serviceName: row.serviceName,
        chargeCategory: row.chargeCategory,
      };
};

const buildDrivers = (
  rows: InvestigationEvidence[],
  dimension: Dimension,
  baseline: string,
): InvestigationDriver[] => {
  const groups = new Map<
    string,
    {
      dimensions: Record<string, string>;
      before: bigint;
      after: bigint;
      evidence: InvestigationDriver['evidence'];
    }
  >();
  for (const row of rows) {
    const dimensions = dimensionsFor(row, dimension);
    const key = JSON.stringify(dimensions);
    let group = groups.get(key);
    if (!group) {
      group = { dimensions, before: 0n, after: 0n, evidence: { baseline: [], current: [] } };
      groups.set(key, group);
    }
    if (row.period === baseline) {
      group.before += parseAmount(row.billedCost);
      group.evidence.baseline.push(row.id);
    } else {
      group.after += parseAmount(row.billedCost);
      group.evidence.current.push(row.id);
    }
  }
  return [...groups.values()]
    .sort((left, right) => {
      const a = left.after - left.before;
      const b = right.after - right.before;
      const absoluteA = a < 0n ? -a : a;
      const absoluteB = b < 0n ? -b : b;
      return absoluteA === absoluteB ? 0 : absoluteA > absoluteB ? -1 : 1;
    })
    .map((group): InvestigationDriver => ({
      dimensions: group.dimensions,
      baselineCost: amountText(group.before),
      currentCost: amountText(group.after),
      delta: amountText(group.after - group.before),
      presence:
        group.evidence.baseline.length === 0
          ? 'current-only'
          : group.evidence.current.length === 0
            ? 'baseline-only'
            : 'both',
      evidence: group.evidence,
    }));
};

const bridgeInterpretation = (category: string, chargeClass: string): string => {
  if (chargeClass === 'Correction')
    return 'Correção de cobrança: valide a competência original; não representa necessariamente consumo novo.';
  switch (category) {
    case 'Credit':
      return 'Variação de créditos. Um crédito menor pode aumentar o saldo sem aumento de consumo.';
    case 'Purchase':
      return 'Variação de compras. Confira frequência e contrato; não interprete automaticamente como crescimento de consumo.';
    case 'Tax':
      return 'Variação de impostos; confirme base e incidência na fatura.';
    case 'Adjustment':
      return 'Variação de ajustes financeiros; confira a descrição na fonte.';
    case 'Usage':
      return 'Variação de cobranças de uso. Quantidade, custo unitário observado e composição podem influenciar o saldo.';
    default:
      return 'Categoria preservada como informada: valide o significado na fonte antes de atribuir uma causa.';
  }
};

const billingBridge = (
  rows: InvestigationEvidence[],
  baseline: string,
): CostInvestigation['currencies'][number]['billingBridge'] => {
  const groups = new Map<string, InvestigationEvidence[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.chargeCategory, row.chargeClass]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const sum = (period: 'baseline' | 'current'): bigint =>
      group
        .filter((row) => (row.period === baseline) === (period === 'baseline'))
        .reduce((total, row) => total + parseAmount(row.billedCost), 0n);
    const before = sum('baseline');
    const after = sum('current');
    return {
      chargeCategory: group[0]!.chargeCategory,
      chargeClass: group[0]!.chargeClass,
      baselineCost: amountText(before),
      currentCost: amountText(after),
      delta: amountText(after - before),
      interpretation: bridgeInterpretation(group[0]!.chargeCategory, group[0]!.chargeClass),
      evidence: {
        baseline: group.filter((row) => row.period === baseline).map((row) => row.id),
        current: group.filter((row) => row.period !== baseline).map((row) => row.id),
      },
    };
  });
};

const explainUsage = (rows: InvestigationEvidence[], baseline: string): UsageExplanation[] => {
  const groups = new Map<
    string,
    { dimensions: Record<string, string>; rows: InvestigationEvidence[] }
  >();
  for (const row of rows.filter((entry) => entry.chargeCategory === 'Usage')) {
    const dimensions = {
      ...dimensionsFor(row, 'resource'),
      serviceName: row.serviceName,
      skuId: row.skuId,
      meterId: row.meterId,
      regionId: row.regionId,
      pricingUnit: row.pricingUnit,
      pricingCategory: row.pricingCategory,
      commitmentDiscountId: row.commitmentDiscountId,
      chargeClass: row.chargeClass,
    };
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) ?? { dimensions, rows: [] as InvestigationEvidence[] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ dimensions, rows: group }): UsageExplanation => {
    const before = group.filter((row) => row.period === baseline);
    const after = group.filter((row) => row.period !== baseline);
    const cost = (items: InvestigationEvidence[]): bigint =>
      items.reduce((total, row) => total + parseAmount(row.billedCost), 0n);
    const c0 = cost(before);
    const c1 = cost(after);
    const result: UsageExplanation = {
      dimensions,
      baselineCost: amountText(c0),
      currentCost: amountText(c1),
      delta: amountText(c1 - c0),
      evidence: { baseline: before.map((row) => row.id), current: after.map((row) => row.id) },
      status: 'insufficient-evidence',
      reason: '',
    };
    if (!before.length || !after.length) {
      return {
        ...result,
        reason:
          'Grupo presente em apenas um período; não presume criação, exclusão ou quantidade zero.',
      };
    }
    if (
      !dimensions.providerName ||
      !dimensions.billingAccountId ||
      !dimensions.subAccountId ||
      !dimensions.resourceId ||
      !dimensions.skuId ||
      !dimensions.meterId ||
      !dimensions.pricingUnit ||
      !dimensions.pricingCategory
    ) {
      return {
        ...result,
        reason:
          'Faltam identificadores de escopo, recurso, SKU, medidor, unidade ou modelo de preço para comparar quantidades homogêneas.',
      };
    }
    if (dimensions.chargeClass) {
      return {
        ...result,
        reason:
          'Cobrança com ChargeClass informado, como correção: efeitos de quantidade e custo unitário não são inferidos.',
      };
    }
    let quantities: bigint[];
    try {
      quantities = group.map((row) => parseAmount(row.pricingQuantity));
    } catch {
      return {
        ...result,
        reason:
          'PricingQuantity ausente ou inválida em uma ou mais linhas; a cobrança permanece no total.',
      };
    }
    if (
      quantities.some((quantity) => quantity <= 0n) ||
      group.some((row) => parseAmount(row.billedCost) < 0n)
    ) {
      return {
        ...result,
        reason:
          'Quantidades não positivas ou cobranças de uso negativas impedem uma decomposição confiável.',
      };
    }
    const quantity = (items: InvestigationEvidence[]): bigint =>
      items.reduce((total, row) => total + parseAmount(row.pricingQuantity), 0n);
    const q0 = quantity(before);
    const q1 = quantity(after);
    // Sequential bridge: hold the baseline blended cost per unit for the quantity
    // effect. Assign the remaining delta to observed unit cost, never to list price.
    const quantityEffect = (c0 * (q1 - q0)) / q0;
    return {
      ...result,
      status: 'decomposed',
      baselineQuantity: amountText(q0),
      currentQuantity: amountText(q1),
      quantityEffect: amountText(quantityEffect),
      observedUnitCostEffect: amountText(c1 - c0 - quantityEffect),
      reason:
        'Ponte aritmética, não causal: quantidade ao custo unitário médio da base; restante atribuído ao custo unitário observado, que pode refletir descontos, câmbio ou composição. Não comprova mudança de tarifa. Arredondamento abaixo de 10^-18 fica no restante.',
    };
  });
};

export class CostInvestigationService {
  public analyze(
    inputs: InvestigationInput[],
    baseline: string,
    current: string,
  ): CostInvestigation {
    const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
    if (!monthPattern.test(baseline) || !monthPattern.test(current) || baseline >= current) {
      throw new Error('Use YYYY-MM periods with --baseline earlier than --current.');
    }
    if (inputs.length === 0) throw new Error('Provide at least one FOCUS CSV input.');
    if (
      inputs.reduce((total, input) => total + Buffer.byteLength(input.content), 0) >
      MAX_INVESTIGATION_BYTES
    ) {
      throw new Error('FOCUS inputs exceed the combined 50 MiB offline limit.');
    }
    const evidence: InvestigationEvidence[] = [];
    const warnings: string[] = [];
    const hashes = new Set<string>();
    let duplicateRows = 0;
    const seenRows = new Set<string>();
    const sources = inputs.map((input, index) => {
      const id = `source-${index + 1}`;
      const sha256 = createHash('sha256').update(input.content).digest('hex');
      if (hashes.has(sha256)) throw new Error(`Duplicate input file: ${input.name}.`);
      hashes.add(sha256);
      let rowCount = 0;
      let selectedRowCount = 0;
      try {
        const records = csvRecords(input.content);
        const header = records.next().value as CsvRecord | undefined;
        if (!header) throw new Error('CSV is empty.');
        const columns = header.fields.map((field) => field.trim());
        if (new Set(columns).size !== columns.length)
          throw new Error('Duplicate CSV column names.');
        const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
        if (missing.length > 0) {
          throw new Error(
            `Missing FOCUS columns: ${missing.join(', ')}. Use a comma-separated CSV.`,
          );
        }
        for (const record of records) {
          try {
            if (record.fields.length !== columns.length) {
              throw new Error(
                `Expected ${columns.length} columns, received ${record.fields.length}.`,
              );
            }
            const values = new Map(columns.map((column, i) => [column, record.fields[i]!.trim()]));
            const get = (column: string): string => values.get(column) ?? '';
            const billingPeriodStart = parseDate(get('BillingPeriodStart'), 'BillingPeriodStart');
            const billingPeriodEnd = parseDate(get('BillingPeriodEnd'), 'BillingPeriodEnd');
            if (billingPeriodEnd <= billingPeriodStart) {
              throw new Error('BillingPeriodEnd must be after BillingPeriodStart.');
            }
            const currency = get('BillingCurrency');
            if (!/^[A-Z]{3}$/.test(currency))
              throw new Error('BillingCurrency must be a 3-letter uppercase code.');
            const billedCost = amountText(parseAmount(get('BilledCost')));
            if (!get('ServiceName') || !get('ChargeCategory')) {
              throw new Error('ServiceName and ChargeCategory must not be empty.');
            }
            rowCount += 1;
            const period = billingPeriodStart.slice(0, 7);
            if (period !== baseline && period !== current) continue;
            const fingerprint = createHash('sha256')
              .update(
                JSON.stringify([...values].sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))),
              )
              .digest('hex');
            if (seenRows.has(fingerprint)) duplicateRows += 1;
            seenRows.add(fingerprint);
            selectedRowCount += 1;
            evidence.push({
              id: `${id}-record-${record.record}`,
              sourceId: id,
              record: record.record,
              startLine: record.startLine,
              endLine: record.endLine,
              period,
              billingPeriodStart,
              billingPeriodEnd,
              currency,
              billedCost,
              providerName: get('ProviderName'),
              billingAccountId: get('BillingAccountId'),
              subAccountId: get('SubAccountId'),
              resourceId: get('ResourceId'),
              resourceName: get('ResourceName'),
              serviceName: get('ServiceName'),
              chargeCategory: get('ChargeCategory'),
              chargeClass: get('ChargeClass'),
              skuId: get('SkuId'),
              meterId: get('x_SkuMeterId'),
              regionId: get('RegionId'),
              pricingCategory: get('PricingCategory'),
              commitmentDiscountId: get('CommitmentDiscountId'),
              pricingQuantity: get('PricingQuantity'),
              pricingUnit: get('PricingUnit'),
            });
          } catch (error: unknown) {
            throw new Error(
              `Lines ${record.startLine}-${record.endLine}: ${error instanceof Error ? error.message : 'Invalid row'}`,
            );
          }
        }
      } catch (error: unknown) {
        throw new Error(`${input.name}: ${error instanceof Error ? error.message : 'Invalid CSV'}`);
      }
      return { id, name: input.name, sha256, rowCount, selectedRowCount };
    });
    for (const period of [baseline, current]) {
      if (!evidence.some((row) => row.period === period)) {
        throw new Error(`No rows for billing period ${period}; provide exports for both periods.`);
      }
    }
    if (duplicateRows > 0) {
      warnings.push(
        `${duplicateRows} linha(s) com conteúdo repetido: mantidas no total, pois podem ser cobranças legítimas. Verifique sobreposição dos arquivos.`,
      );
    }
    const excluded = sources.reduce(
      (sum, source) => sum + source.rowCount - source.selectedRowCount,
      0,
    );
    if (excluded > 0)
      warnings.push(
        `${excluded} linha(s) fora dos dois períodos selecionados foram excluídas do comparativo.`,
      );
    if (evidence.some((row) => !row.resourceId)) {
      warnings.push(
        'Há cobranças sem ResourceId: permanecem nos totais e nos grupos sem recurso identificado.',
      );
    }
    if (evidence.some((row) => !row.providerName || !row.billingAccountId || !row.subAccountId)) {
      warnings.push(
        'Há linhas sem provedor, conta ou assinatura identificados. Grupos com escopo não informado podem reunir cobranças distintas; confira as fontes antes de comparar.',
      );
    }
    const currencies = [...new Set(evidence.map((row) => row.currency))].sort().map((currency) => {
      const rows = evidence.filter((row) => row.currency === currency);
      const before = rows.filter((row) => row.period === baseline);
      const after = rows.filter((row) => row.period === current);
      const sum = (items: InvestigationEvidence[]): bigint =>
        items.reduce((total, row) => total + parseAmount(row.billedCost), 0n);
      const hasBothPeriods = before.length > 0 && after.length > 0;
      if (!hasBothPeriods) {
        warnings.push(
          `${currency}: há linhas em apenas um período. Zero representa ausência no arquivo, não custo comprovadamente zerado.`,
        );
      }
      return {
        currency,
        baselineCost: amountText(sum(before)),
        currentCost: amountText(sum(after)),
        delta: amountText(sum(after) - sum(before)),
        hasBothPeriods,
        billingBridge: billingBridge(rows, baseline),
        usageExplanations: explainUsage(rows, baseline),
        breakdowns: {
          service: buildDrivers(rows, 'service', baseline),
          resource: buildDrivers(rows, 'resource', baseline),
          chargeCategory: buildDrivers(rows, 'chargeCategory', baseline),
        },
      };
    });
    return {
      schemaVersion: 1,
      costBasis: 'BilledCost',
      periodBasis: 'BillingPeriodStart',
      baseline,
      current,
      sources,
      currencies,
      evidence,
      warnings,
      limitations: [
        'Compara BilledCost, não EffectiveCost: inclui descontos e créditos informados, sem amortizar compras antecipadas.',
        'Competências são o mês de início de BillingPeriodStart, não o mês de consumo de ChargePeriodStart. Não há rateio nem normalização por duração.',
        'Somente os arquivos fornecidos são conciliados. Não se comprova completude, fechamento da fatura ou igualdade de escopo entre períodos.',
        'Presença em apenas um período não comprova criação ou exclusão de recurso. Queda de custo não comprova economia causada por uma ação.',
        'Serviço, recurso e categoria são visões alternativas do mesmo total: não devem ser somadas entre si. Moedas nunca são convertidas ou somadas.',
        'Atribui a variação às cobranças observadas; não infere causa técnica, mudança de tarifa, câmbio ou compromissos sem evidência adicional. A ponte quantidade/custo unitário é aritmética, não prova causalidade.',
      ],
    };
  }
}
