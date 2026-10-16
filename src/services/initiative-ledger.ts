import {
  FinOpsInitiativeInputSchema,
  FinOpsInitiativeLedgerSchema,
} from '@/models';
import type {
  BusinessOutcomeLedger,
  FinOpsInitiativeEvidenceIntegrity,
  FinOpsInitiativeInput,
  FinOpsInitiativeLedger,
  FinOpsInitiativeLedgerItem,
} from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { latestSettledMonth } from '@/utils/billing-period';

const round = (value: number): number => Number(value.toFixed(2));
const roundUnit = (value: number): number => Number(value.toFixed(6));
const RESOURCE_SUBSCRIPTION_PATTERN = /^\/subscriptions\/([^/]+)\//i;

const subscriptionIdFromResourceId = (resourceId: string): string | undefined =>
  RESOURCE_SUBSCRIPTION_PATTERN.exec(resourceId)?.[1]?.toLowerCase();

const formatInitiativeErrors = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues.map((issue) => `${issue.path.join('.') || 'initiative'}: ${issue.message}`).join('; ');

export class InitiativeLedgerService {
  public parseJson(content: string): FinOpsInitiativeInput[] {
    let decoded: unknown;
    try {
      decoded = JSON.parse(content);
    } catch (error: unknown) {
      throw new Error(`Initiatives JSON is invalid: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }

    const entries = Array.isArray(decoded)
      ? decoded
      : typeof decoded === 'object' && decoded !== null && 'initiatives' in decoded
        ? (decoded as { initiatives?: unknown }).initiatives
        : undefined;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('Initiatives JSON must contain a non-empty "initiatives" array.');
    }

    const initiatives = entries.map((entry, index) => {
      const parsed = FinOpsInitiativeInputSchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`Initiative ${index + 1} is invalid: ${formatInitiativeErrors(parsed.error.issues)}`);
      }
      const ids = [...parsed.data.sourceResourceIds, ...parsed.data.destinationResourceIds];
      if (ids.some((id) => !subscriptionIdFromResourceId(id))) {
        throw new Error(`Initiative ${index + 1} contains a resource ID without a subscription scope.`);
      }
      return parsed.data;
    });

    const seen = new Set<string>();
    for (const initiative of initiatives) {
      const key = initiative.id.toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate initiative id "${initiative.id}".`);
      seen.add(key);
    }
    return initiatives;
  }

  public build(
    initiatives: FinOpsInitiativeInput[],
    businessOutcome: BusinessOutcomeLedger,
    ledgersBySubscription: ReadonlyMap<string, ResourceCostLedger>,
    generatedAt: string,
  ): FinOpsInitiativeLedger {
    const latestSettled = latestSettledMonth(generatedAt);
    const items = initiatives.map((initiative) =>
      this.measure(initiative, businessOutcome, ledgersBySubscription, latestSettled),
    );
    const businessMetricChecks = initiatives.flatMap((initiative) => {
      const metrics = this.matchingMetrics(initiative, businessOutcome);
      const before = metrics.filter((item) => item.period < initiative.appliedMonth);
      const after = metrics.filter((item) =>
        item.period > initiative.appliedMonth &&
        (!latestSettled || item.period <= latestSettled),
      );
      const baseline = before.filter((item) => item.status === 'measured').at(-1) ?? before.at(-1);
      const post = after.at(-1);
      return [
        {
          initiativeId: initiative.id,
          side: 'baseline' as const,
          ...(baseline ? { period: baseline.period, status: baseline.status } : { status: 'missing_record' as const }),
        },
        {
          initiativeId: initiative.id,
          side: 'post' as const,
          ...(post ? { period: post.period, status: post.status } : { status: 'missing_record' as const }),
        },
      ];
    });
    const billingCoverageChecks = initiatives.flatMap((initiative) => {
      const metrics = this.matchingMetrics(initiative, businessOutcome);
      const before = metrics.filter((item) => item.period < initiative.appliedMonth);
      const after = metrics.filter((item) =>
        item.period > initiative.appliedMonth &&
        (!latestSettled || item.period <= latestSettled),
      );
      const baseline = before.filter((item) => item.status === 'measured').at(-1) ?? before.at(-1);
      const post = after.at(-1);
      const scopes = new Set(
        [...initiative.sourceResourceIds, ...initiative.destinationResourceIds]
          .map((id) => subscriptionIdFromResourceId(id))
          .filter((id): id is string => Boolean(id)),
      );
      return [
        ...(baseline ? scopesForMonth(initiative.id, baseline.period, 'baseline', scopes, ledgersBySubscription) : []),
        ...(post ? scopesForMonth(initiative.id, post.period, 'post', scopes, ledgersBySubscription) : []),
      ];
    });
    const comparableCount = items.filter((item) =>
      item.status === 'improved' || item.status === 'regressed' || item.status === 'unchanged',
    ).length;
    return FinOpsInitiativeLedgerSchema.parse({
      latestSettledMonth: latestSettled,
      items,
      evidenceIntegrity: {
        initiativeCount: initiatives.length,
        comparableCount,
        inconclusiveCount: initiatives.length - comparableCount,
        businessMetricChecks,
        billingCoverageChecks,
      },
      limitations: [
        'Cada iniciativa precisa informar todos os IDs de cobrança da origem e do destino; itens omitidos não entram no custo medido.',
        'O volume de negócio e a tag são fornecidos pelo cliente; a comparação não prova que a iniciativa causou a variação.',
        'Comparamos o último mês fechado antes da aplicação com o mês fechado mais recente posterior; sazonalidade e outras mudanças podem influenciar o resultado.',
        'Custos usam PreTaxCost e moedas não são convertidas; créditos ou ajustes negativos tornam o resultado não conclusivo.',
        'O ledger mede custo das unidades declaradas por unidade de negócio; custos indiretos não incluídos nesses IDs ficam fora do escopo.',
      ],
    });
  }

  private measure(
    initiative: FinOpsInitiativeInput,
    businessOutcome: BusinessOutcomeLedger,
    ledgersBySubscription: ReadonlyMap<string, ResourceCostLedger>,
    latestSettled: string | undefined,
  ): FinOpsInitiativeLedgerItem {
    const metricMatches = this.matchingMetrics(initiative, businessOutcome);
    const baseline = metricMatches.filter((item) =>
      item.period < initiative.appliedMonth && item.status === 'measured',
    ).at(-1);
    const postPeriods = metricMatches.filter((item) =>
      item.period > initiative.appliedMonth &&
      (!latestSettled || item.period <= latestSettled),
    );
    const observed = postPeriods.filter((item) => item.status === 'measured').at(-1);

    if (!baseline) {
      return {
        initiative,
        status: 'baseline_unavailable',
        explanation: 'Não há mês fechado com custo e volume medidos antes da iniciativa.',
      };
    }

    if (!observed) {
      const baselineCost = this.measureCosts(initiative, baseline.period, ledgersBySubscription);
      if (baselineCost.kind === 'unavailable') {
        return {
          initiative,
          status: 'billing_unavailable',
          baselineMonth: baseline.period,
          explanation: 'A cobertura mensal do Cost Management não inclui todas as unidades declaradas para a linha de base.',
        };
      }

      if (baselineCost.kind === 'multiple_currencies') {
        return {
          initiative,
          status: 'currency_mismatch',
          baselineMonth: baseline.period,
          explanation: 'As unidades de origem usam moedas diferentes; a linha de base não pode ser consolidada.',
        };
      }
      const baselineUnitCost = baseline.quantity > 0 && baselineCost.totalSpend > 0
        ? roundUnit(baselineCost.totalSpend / baseline.quantity)
        : undefined;
      const status = baselineCost.hasAdjustment
        ? 'billing_adjustment'
        : baselineCost.totalSpend <= 0
          ? 'no_baseline_spend'
          : baseline.quantity <= 0 || postPeriods.length > 0
            ? 'business_metrics_unavailable'
            : 'awaiting_post_period';
      return {
        initiative,
        status,
        baselineMonth: baseline.period,
        currency: baselineCost.currency,
        baselineSourceSpend: round(baselineCost.sourceSpend),
        baselineDestinationSpend: round(baselineCost.destinationSpend),
        baselineTotalSpend: round(baselineCost.totalSpend),
        baselineVolume: baseline.quantity,
        ...(baselineUnitCost !== undefined ? { baselineCostPerUnit: baselineUnitCost } : {}),
        explanation: status === 'awaiting_post_period'
          ? 'A linha de base está registrada; aguarde um mês fechado posterior ao mês de aplicação para medir o resultado.'
          : status === 'billing_adjustment'
            ? 'A linha de base contém créditos ou ajustes negativos; a comparação não poderá atribuir a variação à iniciativa.'
            : status === 'no_baseline_spend'
              ? 'Não havia custo faturado nas unidades declaradas antes da iniciativa.'
              : 'Há dados posteriores, mas custo/volume não permitem uma comparação válida.',
      };
    }

    const baselineCost = this.measureCosts(
      initiative,
      baseline.period,
      ledgersBySubscription,
    );
    const observedCost = this.measureCosts(
      initiative,
      observed.period,
      ledgersBySubscription,
    );
    if (baselineCost.kind === 'unavailable' || observedCost.kind === 'unavailable') {
      return {
        initiative,
        status: 'billing_unavailable',
        baselineMonth: baseline.period,
        observedMonth: observed.period,
        explanation: 'A cobertura mensal do Cost Management não inclui todas as assinaturas/unidades declaradas.',
      };
    }
    if (baselineCost.kind === 'multiple_currencies' || observedCost.kind === 'multiple_currencies' ||
      baselineCost.currency !== observedCost.currency) {
      return {
        initiative,
        status: 'currency_mismatch',
        baselineMonth: baseline.period,
        observedMonth: observed.period,
        explanation: 'As unidades de cobrança usam moedas diferentes; não é seguro consolidar nem dividir pelo volume.',
      };
    }

    const currency = baselineCost.currency;
    const base = {
      initiative,
      baselineMonth: baseline.period,
      observedMonth: observed.period,
      currency,
      baselineSourceSpend: round(baselineCost.sourceSpend),
      observedSourceSpend: round(observedCost.sourceSpend),
      baselineDestinationSpend: round(baselineCost.destinationSpend),
      observedDestinationSpend: round(observedCost.destinationSpend),
      baselineTotalSpend: round(baselineCost.totalSpend),
      observedTotalSpend: round(observedCost.totalSpend),
      baselineVolume: baseline.quantity,
      observedVolume: observed.quantity,
      sourceSpendReduction: round(baselineCost.sourceSpend - observedCost.sourceSpend),
      destinationSpendChange: round(observedCost.destinationSpend - baselineCost.destinationSpend),
      netSpendReduction: round(baselineCost.totalSpend - observedCost.totalSpend),
    };

    if (baselineCost.hasAdjustment || observedCost.hasAdjustment) {
      return {
        ...base,
        status: 'billing_adjustment',
        explanation: 'Créditos ou ajustes negativos nas unidades declaradas impedem atribuir a variação à iniciativa.',
      };
    }
    if (baseline.quantity <= 0 || observed.quantity <= 0 || baselineCost.totalSpend < 0 || observedCost.totalSpend < 0) {
      return {
        ...base,
        status: 'business_metrics_unavailable',
        explanation: 'Volume zero ou custo líquido negativo impede comparar custo por unidade.',
      };
    }
    if (baselineCost.totalSpend === 0) {
      return {
        ...base,
        status: 'no_baseline_spend',
        explanation: 'Não havia custo faturado nas unidades declaradas antes da iniciativa.',
      };
    }

    const baselineUnitRaw = baselineCost.totalSpend / baseline.quantity;
    const observedUnitRaw = observedCost.totalSpend / observed.quantity;
    const baselineCostPerUnit = roundUnit(baselineUnitRaw);
    const observedCostPerUnit = roundUnit(observedUnitRaw);
    const costPerUnitChangePercent = baselineUnitRaw > 0
      ? round(((observedUnitRaw - baselineUnitRaw) / baselineUnitRaw) * 100)
      : 0;
    const status = observedUnitRaw < baselineUnitRaw
      ? 'improved'
      : observedUnitRaw > baselineUnitRaw
        ? 'regressed'
        : 'unchanged';
    const destinationOffset = observedCost.destinationSpend > baselineCost.destinationSpend
      ? ` O destino passou a custar ${currency} ${round(observedCost.destinationSpend - baselineCost.destinationSpend).toFixed(2)} a mais, incluído no custo total para expor possível migração da cobrança.`
      : '';

    return {
      ...base,
      status,
      baselineCostPerUnit,
      observedCostPerUnit,
      costPerUnitChangePercent,
      explanation:
        `Custo por ${initiative.unit} ${status === 'improved' ? 'diminuiu' : status === 'regressed' ? 'aumentou' : 'permaneceu estável'} ${Math.abs(costPerUnitChangePercent).toFixed(2)}% no escopo declarado. A variação é observada após a iniciativa, não atribuída causalmente a ela.${destinationOffset}`,
    };
  }

  private matchingMetrics(
    initiative: FinOpsInitiativeInput,
    businessOutcome: BusinessOutcomeLedger,
  ): BusinessOutcomeLedger['observations'] {
    return businessOutcome.observations
      .filter((item) =>
        item.tagKey.toLowerCase() === initiative.tagKey.toLowerCase() &&
        item.tagValue === initiative.tagValue &&
        item.unit.toLowerCase() === initiative.unit.toLowerCase(),
      )
      .sort((left, right) => left.period.localeCompare(right.period));
  }

  private measureCosts(
    initiative: FinOpsInitiativeInput,
    month: string,
    ledgersBySubscription: ReadonlyMap<string, ResourceCostLedger>,
  ):
    | { kind: 'measured'; currency?: string; sourceSpend: number; destinationSpend: number; totalSpend: number; hasAdjustment: boolean }
    | { kind: 'unavailable' }
    | { kind: 'multiple_currencies' } {
    const source = this.sumResources(initiative.sourceResourceIds, month, ledgersBySubscription);
    const destination = this.sumResources(initiative.destinationResourceIds, month, ledgersBySubscription);
    if (source.kind === 'unavailable' || destination.kind === 'unavailable') return { kind: 'unavailable' };
    if (source.kind === 'multiple_currencies' || destination.kind === 'multiple_currencies') return { kind: 'multiple_currencies' };
    const currencies = new Set([source.currency, destination.currency].filter(Boolean));
    if (currencies.size > 1) return { kind: 'multiple_currencies' };
    const sourceSpend = source.total;
    const destinationSpend = destination.total;
    const currency = source.currency ?? destination.currency;
    return {
      kind: 'measured',
      ...(currency ? { currency } : {}),
      sourceSpend,
      destinationSpend,
      totalSpend: sourceSpend + destinationSpend,
      hasAdjustment: source.hasAdjustment || destination.hasAdjustment,
    };
  }

  private sumResources(
    resourceIds: string[],
    month: string,
    ledgersBySubscription: ReadonlyMap<string, ResourceCostLedger>,
  ):
    | { kind: 'measured'; currency?: string; total: number; hasAdjustment: boolean }
    | { kind: 'unavailable' }
    | { kind: 'multiple_currencies' } {
    const currencies = new Set<string>();
    let total = 0;
    let hasAdjustment = false;
    const subscriptionIds = new Set<string>();

    for (const id of resourceIds) {
      const subscriptionId = subscriptionIdFromResourceId(id);
      if (!subscriptionId) return { kind: 'unavailable' };
      subscriptionIds.add(subscriptionId);
    }

    for (const subscriptionId of subscriptionIds) {
      const ledger = ledgersBySubscription.get(subscriptionId);
      if (!ledger?.coveredMonths?.includes(month)) return { kind: 'unavailable' };
      currencies.add(ledger.currency);
    }
    if (currencies.size > 1) return { kind: 'multiple_currencies' };

    for (const resourceId of resourceIds) {
      const subscriptionId = subscriptionIdFromResourceId(resourceId)!;
      const ledger = ledgersBySubscription.get(subscriptionId)!;
      const amount = ledger.resources[resourceId.toLowerCase()]?.[month] ?? 0;
      total += amount;
      if (amount < 0) hasAdjustment = true;
    }
    return {
      kind: 'measured',
      ...(currencies.size > 0 ? { currency: [...currencies][0] } : {}),
      total,
      hasAdjustment,
    };
  }
}

const scopesForMonth = (
  initiativeId: string,
  period: string,
  side: 'baseline' | 'post',
  subscriptionIds: Set<string>,
  ledgersBySubscription: ReadonlyMap<string, ResourceCostLedger>,
): FinOpsInitiativeEvidenceIntegrity['billingCoverageChecks'] =>
  [...subscriptionIds].map((subscriptionId) => ({
    initiativeId,
    period,
    side,
    subscriptionId,
    status: ledgersBySubscription.get(subscriptionId)?.coveredMonths?.includes(period)
      ? 'covered' as const
      : 'unavailable' as const,
  }));
