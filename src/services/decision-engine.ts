/**
 * Classifies every recommendation by how ready it is to be executed.
 *
 * A flat list of recommendations forces the reader to open each one to find out
 * whether it is safe to run today, needs a human check first, or is not backed by
 * enough evidence to act on at all. Executives and operators need that triage done
 * for them: this engine turns "here are 40 findings" into "12 are safe to execute
 * now, 18 need a quick validation, 6 are historical record only, and 4 need more
 * data" — and splits the savings total into confirmed, probable and unconfirmed so
 * the headline number never overstates what the evidence actually supports.
 */

import type { Decision, DecisionEngineReport, IdleResource, Recommendation } from '@/models';
import { DecisionEngineReportSchema } from '@/models';

const round = (value: number): number => Number(value.toFixed(2));

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
 * Assigns each recommendation a readiness category and a savings-trust status,
 * then aggregates the totals an executive summary needs.
 */
export class DecisionEngineService {
  /**
   * Classifies every recommendation against the idle finding that backs it.
   */
  public evaluate(recommendations: Recommendation[], idleResources: IdleResource[], currency = 'USD'): DecisionEngineReport {
    const idleById = new Map(idleResources.map((item) => [item.resource.id, item]));
    const decisions: Decision[] = recommendations.map((recommendation) =>
      this.classify(recommendation, idleById.get(recommendation.resourceId)),
    );

    const totals = this.aggregate(decisions);

    return DecisionEngineReportSchema.parse({
      decisions,
      confirmedMonthlySavings: totals.confirmed,
      probableMonthlySavings: totals.probable,
      unconfirmedMonthlySavings: totals.unconfirmed,
      executableNowCount: decisions.filter((decision) => decision.category === 'EXECUTAVEL_AGORA').length,
      summary: this.buildSummary(decisions, totals, currency),
    });
  }

  private classify(recommendation: Recommendation, idle: IdleResource | undefined): Decision {
    const evidence = idle?.evidence;
    const billed = evidence?.billed;
    const confidence = evidence?.confidence ?? 'low';
    const basis = evidence?.savingsBasis ?? 'heuristic';

    // The invoice already shows this cost is gone: there is nothing left to
    // execute, only a fact worth keeping on record.
    if (billed?.billingStopped) {
      return {
        recommendationId: recommendation.id,
        resourceId: recommendation.resourceId,
        resourceName: idle?.resource.name ?? recommendation.resourceId,
        category: 'SOMENTE_HISTORICO',
        savingsStatus: 'nao-confirmada',
        monthlySavings: round(recommendation.monthlySavings),
        reasoning: `A cobrança deste recurso já cessou${billed.lastMonthWithCost ? ` desde ${billed.lastMonthWithCost}` : ''}; não há economia futura a executar, apenas o registro histórico do achado.`,
      };
    }

    const savingsStatus =
      basis === 'observed-cost' ? 'confirmada' : basis === 'retail-price' && confidence !== 'low' ? 'provavel' : 'nao-confirmada';

    // Weak evidence needs investigation before it can be trusted as an action,
    // regardless of how cheap or risky the underlying action looks.
    if (confidence === 'low' || basis === 'heuristic') {
      return {
        recommendationId: recommendation.id,
        resourceId: recommendation.resourceId,
        resourceName: idle?.resource.name ?? recommendation.resourceId,
        category: 'INVESTIGAR',
        savingsStatus,
        monthlySavings: round(recommendation.monthlySavings),
        reasoning: 'Evidência insuficiente (poucos pontos de dados ou preço de lista indisponível) para confiar neste valor sem investigação adicional.',
      };
    }

    // A confirmed saving with low risk is the safest combination this tool can
    // produce: real invoice cost, high confidence, and an action unlikely to
    // cause an incident.
    if (savingsStatus === 'confirmada' && recommendation.risk === 'low') {
      return {
        recommendationId: recommendation.id,
        resourceId: recommendation.resourceId,
        resourceName: idle?.resource.name ?? recommendation.resourceId,
        category: 'EXECUTAVEL_AGORA',
        savingsStatus,
        monthlySavings: round(recommendation.monthlySavings),
        reasoning: 'Economia confirmada pela fatura, alta confiança na evidência e risco baixo: pode ser executada pelo plano de remediação sem validação adicional.',
      };
    }

    // A high-confidence, low-risk, low-effort configuration finding (e.g. an
    // orphaned disk or an empty App Service Plan) is just as safe even without
    // an invoice match, because the waste is structural, not usage-derived.
    if (savingsStatus === 'provavel' && recommendation.risk === 'low' && recommendation.effort === 'low' && confidence === 'high') {
      return {
        recommendationId: recommendation.id,
        resourceId: recommendation.resourceId,
        resourceName: idle?.resource.name ?? recommendation.resourceId,
        category: 'EXECUTAVEL_AGORA',
        savingsStatus,
        monthlySavings: round(recommendation.monthlySavings),
        reasoning: 'Achado de configuração (não depende de uso) com alta confiança, risco e esforço baixos: seguro para execução direta.',
      };
    }

    return {
      recommendationId: recommendation.id,
      resourceId: recommendation.resourceId,
      resourceName: idle?.resource.name ?? recommendation.resourceId,
      category: 'VALIDAR_ANTES',
      savingsStatus,
      monthlySavings: round(recommendation.monthlySavings),
      reasoning:
        recommendation.risk === 'high'
          ? 'Ação de risco alto: confirme o impacto com o time responsável antes de executar, mesmo com boa evidência de economia.'
          : 'Evidência razoável, mas risco, esforço ou confiança parcial recomendam uma validação manual antes de executar.',
    };
  }

  private aggregate(decisions: Decision[]): { confirmed: number; probable: number; unconfirmed: number } {
    const sumBy = (status: Decision['savingsStatus']): number =>
      round(decisions.filter((decision) => decision.savingsStatus === status).reduce((sum, decision) => sum + decision.monthlySavings, 0));

    return {
      confirmed: sumBy('confirmada'),
      probable: sumBy('provavel'),
      unconfirmed: sumBy('nao-confirmada'),
    };
  }

  private buildSummary(
    decisions: Decision[],
    totals: { confirmed: number; probable: number; unconfirmed: number },
    currency: string,
  ): string {
    if (decisions.length === 0) {
      return 'Nenhuma recomendação para classificar neste ciclo.';
    }

    const countBy = (category: Decision['category']): number => decisions.filter((decision) => decision.category === category).length;

    return (
      `${countBy('EXECUTAVEL_AGORA')} recomendação(ões) prontas para execução imediata, ` +
      `${countBy('VALIDAR_ANTES')} exigem validação antes de agir, ` +
      `${countBy('SOMENTE_HISTORICO')} são apenas registro histórico e ` +
      `${countBy('INVESTIGAR')} precisam de mais evidência. ` +
      `Economia mensal confirmada pela fatura: ${money(totals.confirmed, currency)}; provável (preço de lista): ${money(totals.probable, currency)}; não confirmada: ${money(totals.unconfirmed, currency)}.`
    );
  }
}
