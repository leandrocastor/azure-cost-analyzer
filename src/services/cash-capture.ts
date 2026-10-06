import type { CashCaptureItem, CashCapturePlan, IdleResource, Recommendation } from '@/models';
import { CashCapturePlanSchema } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { latestSettledMonth } from '@/utils/billing-period';
import { groupByBillingUnits } from '@/utils/billing-units';

const round = (value: number): number => Number(value.toFixed(2));
const add = (totals: Record<string, number>, currency: string, value: number): void => {
  totals[currency] = round((totals[currency] ?? 0) + value);
};

/**
 * A cost-backed opportunity is not a payment forecast. Retain at most one action
 * per connected set of overlapping billing units, pending contract validation.
 */
export class CashCaptureService {
  public build(
    recommendations: Recommendation[],
    idleResources: IdleResource[],
    generatedAt: string,
    fallbackCurrency: string,
    ledgers: ReadonlyMap<string, ResourceCostLedger> = new Map(),
  ): CashCapturePlan {
    const baselineMonth = latestSettledMonth(generatedAt);
    const idleById = new Map(idleResources.map((idle) => [idle.resource.id.toLowerCase(), idle]));
    const grossEstimateByCurrency: Record<string, number> = {};
    const conditionalEstimateByCurrency: Record<string, number> = {};
    const overlapExcludedByCurrency: Record<string, number> = {};
    const items: CashCaptureItem[] = recommendations
      .filter((rec) => !['completed', 'dismissed'].includes(rec.status))
      .map((rec) => {
        const idle = idleById.get(rec.resourceId.toLowerCase());
        const resource = idle?.resource;
        const type = (resource?.type ?? rec.type).toLowerCase();
        const evidence = idle?.evidence ?? rec.evidence;
        const billed = evidence?.billed;
        const subscription = /\/subscriptions\/([^/]+)/i.exec(rec.resourceId)?.[1]?.toLowerCase();
        const ledger = subscription ? ledgers.get(subscription) : undefined;
        const currency = billed?.currency ?? ledger?.currency ?? fallbackCurrency;
        const shared = type.includes('/sites') || type.endsWith('/servers/databases');
        const stoppedVm = type.includes('/virtualmachines') && rec.actionType === 'CLEANUP';
        const billingResourceIds = [...new Set(
          (resource?.billingResourceIds ?? (shared || stoppedVm ? [] : [rec.resourceId]))
            .map((id) => id.toLowerCase()),
        )];
        const blockers: string[] = [];
        let observedCost: number | undefined;
        if (billingResourceIds.length === 0) {
          blockers.push('Unidade de cobrança não confirmada: consulte o plano, pool ou discos vinculados; não inferimos relações pelo nome.');
        } else if (baselineMonth && ledger?.coveredMonths?.includes(baselineMonth)) {
          const costs = billingResourceIds.map((id) => ledger.resources[id]?.[baselineMonth]);
          if (costs.every((cost) => cost !== undefined && cost >= 0) && ledger.currency === currency) {
            observedCost = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
          }
        } else if (
          !ledger && baselineMonth && billed?.coveredMonths?.includes(baselineMonth) &&
          billingResourceIds.length === 1 && billingResourceIds[0] === rec.resourceId.toLowerCase()
        ) {
          const cost = billed.monthly[baselineMonth];
          if (cost !== undefined && cost >= 0) observedCost = cost;
        }
        if (observedCost === undefined) {
          blockers.push('Sem custo não negativo e cobertura comparável de mês fechado para todas as unidades de cobrança.');
        }
        if (!rec.billingRationale || !idle || !evidence || evidence.confidence === 'low' || evidence.savingsBasis === 'heuristic') {
          blockers.push('Valide a evidência e o modelo de cobrança antes de quantificar esta ação.');
        }
        if (!['/disks', '/publicipaddresses', '/virtualmachines', '/sites', '/serverfarms', '/storageaccounts', '/servers/databases']
          .some((suffix) => type.endsWith(suffix))) {
          blockers.push('Modelo de cobrança não suportado pelo plano nesta versão.');
        }
        if ((type.endsWith('/sites') || type.endsWith('/serverfarms')) && rec.actionType === 'SCHEDULE') {
          blockers.push('Agendar o desligamento não reduz a reserva cobrada do App Service Plan.');
        }
        const historical = billed?.billingStopped === true;
        const quantified = blockers.length === 0 && observedCost !== undefined && !historical;
        const conditionalMonthlySavings = quantified && observedCost !== undefined
          ? round(Math.min(rec.monthlySavings, observedCost)) : 0;
        add(grossEstimateByCurrency, currency, rec.monthlySavings);
        return {
          recommendationId: rec.id,
          resourceId: rec.resourceId,
          resourceName: resource?.name ?? rec.resourceId,
          currency,
          billingResourceIds,
          estimatedMonthlySavings: rec.monthlySavings,
          conditionalMonthlySavings,
          status: historical ? 'historical' : quantified ? 'conditional' : 'unquantified',
          overlapsWith: [],
          blockers,
          captureConditions: this.conditions(type, rec.actionType),
          verificationCriteria: [
            'Compare meses fechados com cobertura equivalente, na mesma moeda e nas unidades de cobrança indicadas.',
            'Confira origem e destino: novos custos, migração, transações, armazenamento residual e compromissos ainda pagos devem entrar no resultado líquido.',
            'Registre a ação e sua data; redução observada não prova causalidade nem redução do pagamento total.',
          ],
        };
      });

    for (const group of groupByBillingUnits(items, (item) => item.billingResourceIds)) {
      const winner = [...group].filter((entry) => entry.status === 'conditional')
        .sort((a, b) => b.conditionalMonthlySavings - a.conditionalMonthlySavings
          || a.recommendationId.localeCompare(b.recommendationId))[0];
      const mixedCurrency = new Set(group.map((entry) => entry.currency)).size > 1;
      for (const entry of group) {
        entry.overlapsWith = group.filter((other) => other !== entry).map((other) => other.recommendationId);
        if (entry.overlapsWith.length > 0) {
          entry.captureConditions.push('Escolha uma alternativa neste grupo; os valores das ações sobrepostas não são somáveis.');
        }
        if (mixedCurrency) {
          entry.blockers.push('Moedas divergentes na mesma unidade de cobrança: grupo não quantificado.');
          entry.conditionalMonthlySavings = 0;
          if (entry.status !== 'historical') entry.status = 'unquantified';
        } else if (entry.status === 'conditional' && entry !== winner) {
          entry.status = 'overlap';
          add(overlapExcludedByCurrency, entry.currency, entry.conditionalMonthlySavings);
          entry.conditionalMonthlySavings = 0;
        }
        if (entry.status === 'conditional') add(conditionalEstimateByCurrency, entry.currency, entry.conditionalMonthlySavings);
      }
    }
    return CashCapturePlanSchema.parse({
      baselineMonth,
      items,
      grossEstimateByCurrency,
      conditionalEstimateByCurrency,
      overlapExcludedByCurrency,
      limitations: [
        'A estimativa condicional não é redução de pagamento confirmada. Cobertura, utilização e vencimentos de reservas e Savings Plans não foram consultados.',
        'O valor retido é um teto de oportunidade limitado ao custo observado, não uma previsão: preço do destino, encargos residuais e custos de execução ainda precisam ser validados.',
        'Sem contratos e capacidade de destino, não quantificamos caixa recuperável nem capacidade contratada liberada.',
        'Em cada grupo de sobreposição retemos apenas a maior alternativa respaldada por custo, não um plano ótimo ou automaticamente seguro.',
        'Relações ausentes, ajustes negativos e cobertura incompleta ficam não quantificados. Não misturamos moedas.',
      ],
    });
  }

  private conditions(type: string, action: Recommendation['actionType']): string[] {
    const conditions = [
      'Validar contratos: reduzir consumo coberto por reserva ou Savings Plan pode não reduzir o pagamento; verificar reutilização e vencimento.',
      'Obter aprovação do responsável e validar impacto, manutenção e recuperação antes de aplicar.',
    ];
    if (type.includes('/sites') || type.includes('/serverfarms')) {
      conditions.push('Reduzir tier/workers ou excluir o plano de origem após validar todos os aplicativos; parar ou mover apenas o site não elimina a reserva do plano.');
    } else if (type.includes('/virtualmachines')) {
      conditions.push(action === 'CLEANUP'
        ? 'Confirmar backup e remover somente discos aprovados; a VM desalocada já não cobra computação.'
        : 'Medir CPU, memória e picos, precificar o tamanho de destino e verificar discos/IPs que continuam cobrados.');
    } else if (type.includes('/storageaccounts')) {
      conditions.push('Precificar acesso, recuperação, transações e exclusão antecipada antes de mudar a camada; preço de armazenamento menor não prova menor custo total.');
    } else if (type.includes('/databases')) {
      conditions.push('Confirmar pool compartilhado e capacidade de destino; reduzir um banco não reduz necessariamente a reserva do pool.');
    } else {
      conditions.push('Confirmar que a ação encerra ou reduz o meter cobrado; excluir dados exige validação de retenção e backup.');
    }
    return conditions;
  }
}
