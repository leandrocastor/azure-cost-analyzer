import {
  BusinessMetricInputSchema,
  BusinessOutcomeLedgerSchema,
} from '@/models';
import type { BusinessMetricInput, BusinessOutcomeLedger, BusinessOutcomeObservation } from '@/models';
import type { TaggedCostEntry } from '@/services/cost-analyzer';
import { latestSettledMonth } from '@/utils/billing-period';

const REQUIRED_HEADERS = ['period', 'tag_key', 'tag_value', 'unit', 'quantity'] as const;
const round = (value: number): number => Number(value.toFixed(4));
const monthBefore = (period: string): string => {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 2, 1)).toISOString().slice(0, 7);
};

type CsvRecord = { fields: string[]; line: number };

const parseCsvRecords = (content: string): CsvRecord[] => {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let recordLine = 1;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }

    if (closedQuote && character !== ',' && character !== '\r' && character !== '\n' && !/\s/.test(character)) {
      throw new Error(`CSV line ${line}: unexpected character after a quoted field.`);
    }
    if (character === '"' && field.length === 0 && !closedQuote) {
      quoted = true;
    } else if (character === ',' || character === '\r' || character === '\n') {
      fields.push(field.trim());
      field = '';
      closedQuote = false;
      if (character === ',' || character === '\r' && content[index + 1] !== '\n') {
        continue;
      }
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      if (fields.some((value) => value.length > 0)) records.push({ fields, line: recordLine });
      fields = [];
      line += 1;
      recordLine = line;
    } else {
      if (character === '"' && !closedQuote) {
        throw new Error(`CSV line ${line}: quote inside an unquoted field.`);
      }
      if (!closedQuote) field += character;
    }
  }

  if (quoted) throw new Error(`CSV line ${recordLine}: unterminated quoted field.`);
  fields.push(field.trim());
  if (fields.some((value) => value.length > 0)) records.push({ fields, line: recordLine });
  return records;
};

export class BusinessOutcomeLedgerService {
  public assertComparisonWindow(queryStartMonth: string, generatedAt: string): void {
    const latestSettled = latestSettledMonth(generatedAt);
    if (!latestSettled || queryStartMonth > monthBefore(latestSettled)) {
      throw new Error(
        '--business-metrics requires a cost query window that includes at least two conservatively closed consecutive months; increase --period.',
      );
    }
  }

  public parseCsv(content: string): BusinessMetricInput[] {
    const records = parseCsvRecords(content.replace(/^\uFEFF/, ''));
    const header = records.shift();
    if (!header) throw new Error('Business metrics CSV is empty.');
    if (records.length === 0) throw new Error('Business metrics CSV has a header but no data rows.');

    const columns = header.fields.map((value) => value.toLowerCase());
    if (
      columns.length !== REQUIRED_HEADERS.length ||
      REQUIRED_HEADERS.some((name) => !columns.includes(name))
    ) {
      throw new Error(`Business metrics CSV must have exactly these columns: ${REQUIRED_HEADERS.join(', ')}.`);
    }
    const index = Object.fromEntries(REQUIRED_HEADERS.map((name) => [name, columns.indexOf(name)])) as
      Record<(typeof REQUIRED_HEADERS)[number], number>;
    const seen = new Set<string>();

    return records.map(({ fields, line }) => {
      if (fields.length !== REQUIRED_HEADERS.length) {
        throw new Error(`CSV line ${line}: expected ${REQUIRED_HEADERS.length} columns, received ${fields.length}.`);
      }
      const rawQuantity = fields[index.quantity]!;
      const quantity = Number(rawQuantity);
      const parsed = BusinessMetricInputSchema.safeParse({
        period: fields[index.period],
        tagKey: fields[index.tag_key],
        tagValue: fields[index.tag_value],
        unit: fields[index.unit],
        quantity,
      });
      if (!parsed.success || rawQuantity.length === 0) {
        throw new Error(`CSV line ${line}: invalid month, tag, unit, or non-negative numeric quantity.`);
      }
      const metric = parsed.data;
      const key = [metric.period, metric.tagKey.toLowerCase(), metric.tagValue, metric.unit.toLowerCase()].join('\0');
      if (seen.has(key)) {
        throw new Error(`CSV line ${line}: duplicate period/tag/unit record.`);
      }
      seen.add(key);
      return metric;
    });
  }

  public build(
    metrics: BusinessMetricInput[],
    costsBySubscriptionAndTag: ReadonlyMap<string, ReadonlyMap<string, TaggedCostEntry[]>>,
    generatedAt: string,
  ): BusinessOutcomeLedger {
    const latestSettled = latestSettledMonth(generatedAt);
    const observations: BusinessOutcomeObservation[] = metrics.map((metric) => {
      if (!latestSettled || metric.period > latestSettled) {
        return {
          ...metric,
          status: 'awaiting_closed_month',
          interpretation: 'O mês ainda não passou pela janela conservadora de fechamento; custo e eficiência não são comparados.',
        };
      }

      const amountsByCurrency = new Map<string, number>();
      for (const tags of costsBySubscriptionAndTag.values()) {
        const entries = tags.get(metric.tagKey.toLowerCase()) ?? [];
        for (const entry of entries) {
          if (entry.period === metric.period && entry.tagValue === metric.tagValue) {
            amountsByCurrency.set(entry.currency, (amountsByCurrency.get(entry.currency) ?? 0) + entry.amount);
          }
        }
      }

      if (amountsByCurrency.size === 0) {
        return {
          ...metric,
          status: 'no_billed_cost',
          interpretation: 'Nenhum custo faturado foi retornado para esta tag neste mês; confirme cobertura, valor da tag e se houve cobrança.',
        };
      }
      if (amountsByCurrency.size > 1) {
        return {
          ...metric,
          status: 'multiple_currencies',
          observedCostByCurrency: Object.fromEntries(
            [...amountsByCurrency.entries()].map(([currency, amount]) => [currency, round(amount)]),
          ),
          interpretation: 'A mesma unidade de negócio tem custos em moedas diferentes; sem conversão cambial, não calculamos custo unitário.',
        };
      }

      const [currency, amount] = amountsByCurrency.entries().next().value!;
      if (amount < 0) {
        return {
          ...metric,
          status: 'negative_net_cost',
          currency,
          observedCost: round(amount),
          interpretation: 'Créditos superam cobranças nesta tag/mês; o custo líquido negativo não é uma base válida para custo unitário.',
        };
      }
      if (metric.quantity === 0) {
        return {
          ...metric,
          status: 'zero_business_volume',
          currency,
          observedCost: round(amount),
          interpretation: 'Houve custo faturado sem volume de negócio informado; não há denominador para custo unitário.',
        };
      }
      return {
        ...metric,
        status: 'measured',
        currency,
        observedCost: round(amount),
        costPerUnit: round(amount / metric.quantity),
        interpretation: 'Custo faturado atribuído historicamente à tag dividido pelo volume de negócio informado.',
      };
    });

    const bySeries = new Map<string, BusinessOutcomeObservation[]>();
    for (const observation of observations) {
      if (observation.status !== 'measured' || !observation.currency || observation.costPerUnit === undefined) continue;
      const key = [observation.tagKey.toLowerCase(), observation.tagValue, observation.unit.toLowerCase(), observation.currency].join('\0');
      const series = bySeries.get(key) ?? [];
      series.push(observation);
      bySeries.set(key, series);
    }

    for (const series of bySeries.values()) {
      series.sort((left, right) => left.period.localeCompare(right.period));
      for (let index = 1; index < series.length; index += 1) {
        const current = series[index]!;
        const previous = series[index - 1]!;
        if (
          monthBefore(current.period) !== previous.period ||
          previous.observedCost === undefined ||
          previous.costPerUnit === undefined ||
          previous.quantity === 0
        ) continue;
        current.spendChangePercent = previous.observedCost > 0
          ? round(((current.observedCost! - previous.observedCost) / previous.observedCost) * 100) : undefined;
        current.volumeChangePercent = round(((current.quantity - previous.quantity) / previous.quantity) * 100);
        if (previous.costPerUnit > 0) {
          current.costPerUnitChangePercent = round(((current.costPerUnit! - previous.costPerUnit) / previous.costPerUnit) * 100);
          current.efficiencyGap = round(Math.max(0, current.observedCost! - previous.costPerUnit * current.quantity));
        }
        current.interpretation = current.efficiencyGap !== undefined && current.efficiencyGap > 0
          ? `O custo por ${current.unit} aumentou ${current.costPerUnitChangePercent?.toFixed(1)}% ante o mês anterior; diferença de ${current.currency} ${current.efficiencyGap.toFixed(2)} frente ao custo unitário anterior no volume atual. É um sinal para investigar, não economia recuperável confirmada.`
          : `Custo e volume comparados ao mês anterior; variação do custo por ${current.unit}: ${current.costPerUnitChangePercent?.toFixed(1) ?? 'indisponível'}%.`;
      }
    }

    observations.sort((left, right) =>
      left.tagKey.localeCompare(right.tagKey) ||
      left.tagValue.localeCompare(right.tagValue) ||
      left.unit.localeCompare(right.unit) ||
      left.period.localeCompare(right.period),
    );

    return BusinessOutcomeLedgerSchema.parse({
      latestSettledMonth: latestSettled,
      observations,
      limitations: [
        'O volume de negócio é informado pelo cliente; o relatório não valida sua origem nem causalidade entre volume e custo.',
        'Custos vêm do Cost Management agrupados pela tag histórica. Tag sem cobrança, cobertura parcial ou dados de outro escopo ficam fora da comparação; o volume informado deve cobrir todas as assinaturas incluídas.',
        'O valor usa PreTaxCost (antes de impostos); não representa o total pago na fatura.',
        'Meses após a janela conservadora de fechamento são exibidos sem custo unitário; sete dias não garantem fatura finalizada.',
        'A diferença de eficiência compara o custo unitário ao mês anterior consecutivo; é um sinal investigativo, não previsão nem economia realizável.',
        'Não convertemos moedas nem somamos métricas diferentes; valores e unidades permanecem separados.',
      ],
    });
  }
}
