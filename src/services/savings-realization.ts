import type { SavingsRealization, SavingsRealizationItem, IdleResource } from '@/models';
import { SavingsRealizationSchema } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import type { ReportSnapshot } from '@/services/cost-diff';

const round = (value: number): number => Number(value.toFixed(2));
const RESOURCE_SUBSCRIPTION_PATTERN = /\/subscriptions\/([^/]+)/i;

const subscriptionIdFromResourceId = (resourceId: string): string | undefined =>
  RESOURCE_SUBSCRIPTION_PATTERN.exec(resourceId)?.[1]?.toLowerCase();

/**
 * Returns the latest month that has had seven days to receive billing updates.
 * Comparing this month avoids treating a newly closed, still-changing invoice
 * period as realized savings.
 */
const latestSettledMonth = (generatedAt: string): string | undefined => {
  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) {
    return undefined;
  }

  const settledThrough = new Date(generated.getTime() - 7 * 24 * 60 * 60 * 1000);
  settledThrough.setUTCDate(1);
  settledThrough.setUTCMonth(settledThrough.getUTCMonth() - 1);
  return settledThrough.toISOString().slice(0, 7);
};

/**
 * Measures invoice reductions for previously reported findings that are no
 * longer present. A reduction is only verified when both reports cover distinct,
 * settled months and the resource-level actual cost is available in both.
 */
export class SavingsRealizationService {
  public analyze(
    previous: ReportSnapshot,
    currentIdleResources: IdleResource[],
    currentGeneratedAt: string,
    currentLedgers: ReadonlyMap<string, ResourceCostLedger>,
  ): SavingsRealization {
    const currentIdleIds = new Set(currentIdleResources.map((item) => item.resource.id.toLowerCase()));
    const baselineMonth = latestSettledMonth(previous.generatedAt);
    const currentMonth = latestSettledMonth(currentGeneratedAt);
    const candidates = previous.idleResources.filter(
      (item) => !currentIdleIds.has(item.resource.id.toLowerCase()),
    );

    const items = candidates.map((item) =>
      this.measure(item, baselineMonth, currentMonth, currentLedgers),
    );
    const verified = items.filter((item) => item.status === 'verified_reduction');
    const verifiedMonthlyReductionByCurrency: Record<string, number> = {};
    for (const item of verified) {
      verifiedMonthlyReductionByCurrency[item.currency] = round(
        (verifiedMonthlyReductionByCurrency[item.currency] ?? 0) + item.monthlyReduction,
      );
    }
    const verifiedCount = verified.length;
    const unmeasuredCount = items.length - verifiedCount;
    const reductionSummary = Object.entries(verifiedMonthlyReductionByCurrency)
      .map(([currency, amount]) => {
        try {
          return new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(amount);
        } catch {
          return `${currency} ${amount.toFixed(2)}`;
        }
      })
      .join(', ');

    return SavingsRealizationSchema.parse({
      comparedTo: previous.generatedAt,
      items,
      verifiedMonthlyReductionByCurrency,
      verifiedCount,
      unmeasuredCount,
      summary:
        verifiedCount > 0
          ? `${verifiedCount} recurso(s) resolvido(s) tiveram redução observada na fatura, totalizando ${reductionSummary} por mês. A comparação confirma a variação de cobrança, mas não prova que a recomendação foi sua causa.`
          : items.length > 0
            ? 'Há recomendações resolvidas, mas ainda não existe evidência comparável suficiente para confirmar redução de cobrança por recurso.'
            : 'Nenhum achado de recurso foi resolvido desde o relatório anterior.',
    });
  }

  private measure(
    idle: IdleResource,
    baselineMonth: string | undefined,
    currentMonth: string | undefined,
    currentLedgers: ReadonlyMap<string, ResourceCostLedger>,
  ): SavingsRealizationItem {
    const previousBilled = idle.evidence?.billed;
    const subscriptionId = subscriptionIdFromResourceId(idle.resource.id);
    const ledger = subscriptionId ? currentLedgers.get(subscriptionId) : undefined;
    const currency = previousBilled?.currency ?? ledger?.currency ?? 'USD';
    const base = {
      resourceId: idle.resource.id,
      resourceName: idle.resource.name,
      finding: idle.reason,
      monthlyReduction: 0,
      currency,
    };

    if (!baselineMonth || !previousBilled?.coveredMonths?.includes(baselineMonth)) {
      return {
        ...base,
        status: 'baseline_unavailable',
        ...(baselineMonth ? { baselineMonth } : {}),
        explanation: 'O relatório anterior não contém cobertura de fatura suficiente para o mês-base.',
      };
    }

    if (!ledger || !subscriptionId) {
      return {
        ...base,
        status: 'current_cost_unavailable',
        baselineMonth,
        baselineCost: previousBilled.monthly[baselineMonth] ?? 0,
        explanation: 'Não foi possível consultar os custos atuais por recurso nesta assinatura.',
      };
    }

    if (previousBilled.currency !== ledger.currency) {
      return {
        ...base,
        status: 'currency_mismatch',
        baselineMonth,
        ...(currentMonth ? { currentMonth } : {}),
        baselineCost: previousBilled.monthly[baselineMonth] ?? 0,
        explanation: 'A moeda da fatura mudou entre os relatórios; os valores não foram comparados.',
      };
    }

    if (
      !currentMonth ||
      currentMonth <= baselineMonth ||
      !ledger.coveredMonths?.includes(currentMonth)
    ) {
      return {
        ...base,
        status: 'awaiting_period',
        baselineMonth,
        ...(currentMonth ? { currentMonth } : {}),
        baselineCost: previousBilled.monthly[baselineMonth] ?? 0,
        explanation: 'Aguarde um mês posterior fechado e coberto pela consulta para medir o efeito na fatura.',
      };
    }

    const baselineCost = previousBilled.monthly[baselineMonth] ?? 0;
    const currentCost = ledger.resources[idle.resource.id.toLowerCase()]?.[currentMonth] ?? 0;

    if (baselineCost <= 0) {
      return {
        ...base,
        status: 'no_baseline_spend',
        baselineMonth,
        currentMonth,
        baselineCost,
        currentCost,
        explanation: 'Não havia custo faturado no mês-base para comprovar uma redução.',
      };
    }

    const monthlyReduction = currentCost < 0 ? 0 : round(Math.max(0, baselineCost - currentCost));
    const status = monthlyReduction > 0 ? 'verified_reduction' : 'no_reduction';

    return {
      ...base,
      status,
      baselineMonth,
      currentMonth,
      baselineCost,
      currentCost,
      monthlyReduction,
      explanation:
        status === 'verified_reduction'
          ? 'Redução observada no custo faturado deste recurso entre meses fechados; a comparação não atribui causalidade à ação.'
          : currentCost < 0
            ? 'O custo atual contém créditos ou ajustes negativos; não é seguro atribuir uma redução realizada.'
            : 'A cobrança não diminuiu entre os meses comparados; não há economia realizada a reportar.',
    };
  }
}
