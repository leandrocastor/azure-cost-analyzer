import type { BilledCost, IdleResource } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { createLogger } from '@/utils/logger';

/**
 * Cost below which a month is treated as "not billed". Cost Management emits
 * residual fractions of a cent for metered resources that were only briefly active,
 * and reporting those as real spend would reintroduce the noise this check removes.
 */
const BILLING_NOISE_THRESHOLD = 0.01;

const formatMonthLabel = (month: string): string => {
  const [year, monthNumber] = month.split('-');
  const names = [
    'janeiro',
    'fevereiro',
    'março',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ];
  const index = Number(monthNumber) - 1;
  const name = names[index];
  return name && year ? `${name} de ${year}` : month;
};

const money = (value: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
};

/**
 * The outcome of comparing one finding against the invoice.
 *
 * - `billed`: the resource is currently generating cost, so the saving is real.
 * - `stopped`: it was billed earlier in the period but no longer is. The finding stays
 *    visible, because the executive audience needs to know a cost ended, but it no
 *    longer claims a forward-looking saving.
 * - `never-billed`: no charge was ever observed, as happens with an App Service on the
 *    F1 Free tier. There is nothing to save and the finding is dropped.
 * - `unknown`: the resource is absent from the cost data for a reason other than being
 *    free, so the estimate is kept as-is and flagged as unverified.
 */
export type ReconciliationOutcome = 'billed' | 'stopped' | 'never-billed' | 'unknown';

export type ReconciliationResult = {
  /** Findings that survived the reconciliation, with savings and evidence adjusted. */
  idleResources: IdleResource[];
  /** Findings dropped because the resource never generated cost. */
  discarded: { resourceId: string; name: string; reason: string }[];
  /** Findings whose billing already ended during the analyzed period. */
  stopped: { resourceId: string; name: string; lastMonthWithCost?: string }[];
};

/**
 * Reconciles idle findings against what Azure actually billed.
 *
 * Idle detection reasons about utilization and list prices, which is a projection of
 * what a resource *would* cost. Cost Management knows what it *did* cost. When the two
 * disagree, the invoice wins: claiming a saving on a resource billed at zero is the
 * fastest way to lose the trust of a finance audience.
 */
export class CostReconciliationService {
  private readonly logger = createLogger({ service: 'cost-reconciliation' });

  public reconcile(idleResources: IdleResource[], ledger: ResourceCostLedger): ReconciliationResult {
    const latestMonth = ledger.months.at(-1);
    if (!latestMonth) {
      // No cost data at all means there is nothing to reconcile against; keeping the
      // estimates untouched is safer than discarding every finding.
      return { idleResources, discarded: [], stopped: [] };
    }

    const kept: IdleResource[] = [];
    const discarded: ReconciliationResult['discarded'] = [];
    const stopped: ReconciliationResult['stopped'] = [];

    for (const idle of idleResources) {
      const monthly = ledger.resources[idle.resource.id.toLowerCase()];

      if (!monthly) {
        kept.push(this.markUnverified(idle));
        continue;
      }

      const billed = this.buildBilledCost(monthly, ledger.currency, latestMonth);
      const outcome = this.classify(billed);

      if (outcome === 'never-billed') {
        discarded.push({
          resourceId: idle.resource.id,
          name: idle.resource.name,
          reason: 'Nenhum custo faturado no período: o recurso não gera cobrança.',
        });
        continue;
      }

      if (outcome === 'stopped') {
        stopped.push({
          resourceId: idle.resource.id,
          name: idle.resource.name,
          ...(billed.lastMonthWithCost ? { lastMonthWithCost: billed.lastMonthWithCost } : {}),
        });
        kept.push(this.markStopped(idle, billed));
        continue;
      }

      kept.push(this.markBilled(idle, billed));
    }

    this.logger.info('Reconciled findings against billed cost', {
      analyzed: idleResources.length,
      kept: kept.length,
      discarded: discarded.length,
      stopped: stopped.length,
    });

    return { idleResources: kept, discarded, stopped };
  }

  private buildBilledCost(
    monthly: Record<string, number>,
    currency: string,
    latestMonth: string,
  ): BilledCost {
    const observedTotal = Object.values(monthly).reduce((total, value) => total + value, 0);
    const monthsWithCost = Object.entries(monthly)
      .filter(([, value]) => value >= BILLING_NOISE_THRESHOLD)
      .map(([month]) => month)
      .sort();

    const lastMonthWithCost = monthsWithCost.at(-1);
    const latestMonthCost = monthly[latestMonth] ?? 0;

    return {
      observedTotal: Math.max(observedTotal, 0),
      currency,
      monthly,
      ...(lastMonthWithCost ? { lastMonthWithCost } : {}),
      latestMonth,
      billingStopped: monthsWithCost.length > 0 && latestMonthCost < BILLING_NOISE_THRESHOLD,
    };
  }

  private classify(billed: BilledCost): ReconciliationOutcome {
    if (!billed.lastMonthWithCost) {
      return 'never-billed';
    }

    return billed.billingStopped ? 'stopped' : 'billed';
  }

  /**
   * The resource is currently billed, so the saving is real. The estimate is capped at
   * the observed monthly cost: no action can save more than the resource actually costs,
   * and an estimate above the invoice is indefensible in a cost review.
   */
  private markBilled(idle: IdleResource, billed: BilledCost): IdleResource {
    const observedMonthly = billed.monthly[billed.latestMonth] ?? 0;
    const capped = Math.min(idle.estimatedMonthlySavings, observedMonthly);
    const wasCapped = capped < idle.estimatedMonthlySavings;

    const evidence = idle.evidence
      ? {
          ...idle.evidence,
          billed,
          metrics: [
            ...idle.evidence.metrics,
            {
              label: `Custo faturado em ${formatMonthLabel(billed.latestMonth)}`,
              value: Number(observedMonthly.toFixed(2)),
              unit: billed.currency,
            },
          ],
          ...(wasCapped
            ? {
                savingsBasis: 'observed-cost' as const,
                savingsBasisDetail: `Economia limitada ao custo realmente faturado em ${formatMonthLabel(billed.latestMonth)} (${money(observedMonthly, billed.currency)}), abaixo da estimativa por preço de lista.`,
              }
            : {}),
        }
      : undefined;

    return {
      ...idle,
      estimatedMonthlySavings: Number(capped.toFixed(2)),
      ...(evidence ? { evidence } : {}),
    };
  }

  /**
   * The resource was billed earlier in the period but is not billed anymore. There is no
   * forward-looking saving to claim, yet hiding the finding would leave the reader
   * wondering why a previously expensive resource vanished from the report.
   */
  private markStopped(idle: IdleResource, billed: BilledCost): IdleResource {
    const lastMonth = billed.lastMonthWithCost;
    const lastCost = lastMonth ? (billed.monthly[lastMonth] ?? 0) : 0;
    const note = lastMonth
      ? `sem custo faturado desde ${formatMonthLabel(lastMonth)}, quando custou ${money(lastCost, billed.currency)}`
      : 'sem custo faturado no mês mais recente';

    const evidence = idle.evidence
      ? {
          ...idle.evidence,
          billed,
          savingsBasis: 'observed-cost' as const,
          savingsBasisDetail: `O recurso deixou de gerar custo durante o período analisado: ${note}. Não há economia futura a capturar, apenas confirmação de que a cobrança cessou.`,
          confidence: 'high' as const,
          caveat: 'Recurso mantido no relatório por transparência: gerou custo no período, mas não gera mais.',
        }
      : undefined;

    return {
      ...idle,
      reason: `${idle.reason} — ${note}`,
      estimatedMonthlySavings: 0,
      ...(evidence ? { evidence } : {}),
    };
  }

  /**
   * The resource has no rows in the cost data. That is not proof it is free: charges can
   * be absent because the resource is billed at another scope, or because usage has not
   * been emitted yet. The estimate is kept, but explicitly flagged as unverified so it is
   * never mistaken for a reconciled number.
   */
  private markUnverified(idle: IdleResource): IdleResource {
    if (!idle.evidence) {
      return idle;
    }

    return {
      ...idle,
      evidence: {
        ...idle.evidence,
        confidence: idle.evidence.confidence === 'high' ? 'medium' : idle.evidence.confidence,
        caveat:
          idle.evidence.caveat ??
          'Não foi possível localizar cobranças deste recurso no Cost Management, então a economia é uma projeção não confirmada pela fatura.',
      },
    };
  }
}
