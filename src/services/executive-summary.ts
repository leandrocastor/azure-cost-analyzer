import type {
  CostDiff,
  CostSummary,
  ExecutiveSummary,
  IdleResource,
  OwnershipReport,
  Recommendation,
} from '@/models';
import { ExecutiveSummarySchema } from '@/models';

export type ExecutiveSummaryInput = {
  costs: CostSummary;
  idleResources: IdleResource[];
  recommendations: Recommendation[];
  ownership: OwnershipReport;
  diff?: CostDiff | undefined;
  subscriptionCount: number;
};

const money = (value: number, currency: string): string =>
  `${currency} ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const percent = (value: number): string =>
  `${(value * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

/**
 * Produces the plain-language narrative that opens the report, turning raw
 * numbers into the three things a decision maker actually needs: how much is
 * being wasted, who owns it and what to do first.
 *
 * The summary is derived deterministically from the collected data, so it works
 * offline in Azure Cloud Shell with no model endpoint or extra credentials.
 */
export class ExecutiveSummaryService {
  /**
   * Builds the executive summary for a report.
   */
  public build(input: ExecutiveSummaryInput): ExecutiveSummary {
    const { costs, idleResources, recommendations, ownership, diff, subscriptionCount } = input;
    const currency = costs.currency;
    const annualSavings = recommendations.reduce((sum, item) => sum + item.annualSavings, 0);
    const monthlySavings = recommendations.reduce((sum, item) => sum + item.monthlySavings, 0);
    const wasteRatio = costs.totalAmount > 0 ? monthlySavings / costs.totalAmount : 0;

    return ExecutiveSummarySchema.parse({
      headline: this.buildHeadline(annualSavings, currency, wasteRatio, idleResources.length),
      paragraphs: this.buildParagraphs({ ...input, annualSavings, monthlySavings, wasteRatio }),
      highlights: this.buildHighlights({ costs, ownership, diff, annualSavings, wasteRatio, subscriptionCount }),
      topActions: this.buildTopActions(recommendations, currency),
      generatedBy: 'heuristic',
    });
  }

  private buildHeadline(
    annualSavings: number,
    currency: string,
    wasteRatio: number,
    idleCount: number,
  ): string {
    if (idleCount === 0) {
      return 'Nenhum desperdício relevante identificado neste ciclo. O ambiente está aderente ao uso contratado.';
    }
    return `Há ${money(annualSavings, currency)} por ano em desperdício recuperável, o equivalente a ${percent(wasteRatio)} do custo atual do ambiente.`;
  }

  private buildParagraphs(
    input: ExecutiveSummaryInput & { annualSavings: number; monthlySavings: number; wasteRatio: number },
  ): string[] {
    const { costs, idleResources, recommendations, ownership, diff, subscriptionCount } = input;
    const currency = costs.currency;
    const paragraphs: string[] = [];

    const scope =
      subscriptionCount === 1
        ? '1 subscription analisada'
        : `${subscriptionCount} subscriptions analisadas`;
    paragraphs.push(
      `No período ${costs.period}, ${scope} somaram ${money(costs.totalAmount, currency)}. ` +
        `Foram identificados ${idleResources.length} recursos ociosos ou subutilizados, que geram ` +
        `${money(input.monthlySavings, currency)} por mês em custo sem contrapartida de uso.`,
    );

    const topService = this.topEntry(costs.byService);
    if (topService) {
      const share = costs.totalAmount > 0 ? topService[1] / costs.totalAmount : 0;
      paragraphs.push(
        `A maior concentração de gasto está em ${topService[0]}, responsável por ${money(topService[1], currency)} ` +
          `(${percent(share)} do total). Priorizar a revisão desse serviço tende a produzir o maior impacto financeiro.`,
      );
    }

    const topOwner = ownership.owners[0];
    if (topOwner && ownership.totalMonthlyWaste > 0) {
      const coverageNote =
        ownership.tagCoverage < 0.5
          ? ` Apenas ${percent(ownership.tagCoverage)} dos recursos possuem tag de responsável, o que limita a cobrança interna — padronizar a tag de owner é um pré-requisito de governança.`
          : '';
      paragraphs.push(
        `O maior volume de desperdício está atribuído a "${topOwner.owner}", com ${money(topOwner.monthlyWaste, currency)} por mês ` +
          `em ${topOwner.resourceCount} recurso(s), ou ${percent(topOwner.shareOfTotal)} de todo o desperdício mapeado.${coverageNote}`,
      );
    }

    if (diff) {
      paragraphs.push(this.describeDiff(diff));
    }

    const quickWins = recommendations.filter((item) => item.risk === 'low' && item.effort === 'low');
    if (quickWins.length > 0) {
      const quickWinSavings = quickWins.reduce((sum, item) => sum + item.annualSavings, 0);
      paragraphs.push(
        `Existem ${quickWins.length} ação(ões) de baixo risco e baixo esforço que liberam ${money(quickWinSavings, currency)} por ano ` +
          'e podem ser executadas imediatamente pelo plano de remediação gerado junto a este relatório.',
      );
    }

    return paragraphs;
  }

  private describeDiff(diff: CostDiff): string {
    const direction = diff.totalDelta > 0 ? 'aumento' : diff.totalDelta < 0 ? 'redução' : 'estabilidade';
    const variation =
      diff.totalPercentChange === null
        ? ''
        : ` (${diff.totalPercentChange > 0 ? '+' : ''}${diff.totalPercentChange.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%)`;

    const driver = diff.byService[0];
    const driverNote = driver
      ? ` O principal responsável pela variação foi ${driver.key}, com ${driver.delta > 0 ? '+' : ''}${money(driver.delta, diff.currency)}.`
      : '';

    const idleNote =
      diff.resolvedIdleResources.length > 0
        ? ` ${diff.resolvedIdleResources.length} recurso(s) ocioso(s) da execução anterior já não aparecem nesta.`
        : diff.newIdleResources.length > 0
          ? ` Surgiram ${diff.newIdleResources.length} novo(s) recurso(s) ocioso(s) desde a última execução.`
          : '';

    return (
      `Comparado ao relatório de ${new Date(diff.previousGeneratedAt).toLocaleDateString('pt-BR')}, houve ${direction} de ` +
      `${money(Math.abs(diff.totalDelta), diff.currency)}${variation}.${driverNote}${idleNote}`
    );
  }

  private buildHighlights(input: {
    costs: CostSummary;
    ownership: OwnershipReport;
    diff?: CostDiff | undefined;
    annualSavings: number;
    wasteRatio: number;
    subscriptionCount: number;
  }): ExecutiveSummary['highlights'] {
    const { costs, ownership, diff, annualSavings, wasteRatio, subscriptionCount } = input;
    const currency = costs.currency;

    const highlights: ExecutiveSummary['highlights'] = [
      {
        label: 'Economia anual recuperável',
        value: money(annualSavings, currency),
        tone: annualSavings > 0 ? 'positive' : 'neutral',
      },
      {
        label: 'Desperdício sobre o custo total',
        value: percent(wasteRatio),
        tone: wasteRatio > 0.15 ? 'negative' : wasteRatio > 0.05 ? 'neutral' : 'positive',
      },
      {
        label: 'Cobertura de tag de responsável',
        value: percent(ownership.tagCoverage),
        tone: ownership.tagCoverage >= 0.8 ? 'positive' : ownership.tagCoverage >= 0.5 ? 'neutral' : 'negative',
      },
      {
        label: 'Escopo analisado',
        value: `${subscriptionCount} subscription${subscriptionCount === 1 ? '' : 's'}`,
        tone: 'neutral',
      },
    ];

    if (diff) {
      highlights.push({
        label: 'Variação vs. relatório anterior',
        value: `${diff.totalDelta > 0 ? '+' : ''}${money(diff.totalDelta, diff.currency)}`,
        tone: diff.totalDelta > 0 ? 'negative' : diff.totalDelta < 0 ? 'positive' : 'neutral',
      });
    }

    return highlights;
  }

  private buildTopActions(recommendations: Recommendation[], currency: string): string[] {
    return [...recommendations]
      .sort((left, right) => right.annualSavings - left.annualSavings)
      .slice(0, 3)
      .map(
        (item, index) =>
          `${index + 1}. ${item.title} — ${money(item.annualSavings, currency)}/ano ` +
          `(risco ${this.level(item.risk)}, esforço ${this.level(item.effort)}).`,
      );
  }

  private level(value: 'low' | 'medium' | 'high'): string {
    return value === 'low' ? 'baixo' : value === 'medium' ? 'médio' : 'alto';
  }

  private topEntry(bucket: Record<string, number>): [string, number] | undefined {
    return Object.entries(bucket).sort((left, right) => right[1] - left[1])[0];
  }
}
