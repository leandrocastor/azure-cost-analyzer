/**
 * Measures the cost of not acting on previous recommendations.
 *
 * Optimization reports usually restate the same findings month after month with no
 * memory of what was already advised. By comparing the current run against an
 * earlier snapshot, a recommendation stops being a suggestion and becomes
 * quantified debt: "this disk has been idle for 94 days and has already cost
 * R$ 940". That reframing is what moves an application team to act.
 */

import type { IdleResource, InactionCost, StaleRecommendation } from '@/models';
import { InactionCostSchema } from '@/models';
import type { ReportSnapshot } from '@/services/cost-diff';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 30;

const round = (value: number): number => Number(value.toFixed(2));

/**
 * Correlates findings across two runs to expose accumulated, avoidable spend.
 */
export class InactionCostService {
  /**
   * Compares the findings of a previous report with the current ones.
   *
   * A finding counts as stale when the same resource is still flagged as idle. The
   * wasted amount is charged from the moment it was first reported, using the
   * savings figure of the current run so the number reflects today's prices.
   */
  public analyze(previous: ReportSnapshot, current: IdleResource[], now: Date = new Date()): InactionCost {
    const previousById = new Map(previous.idleResources.map((item) => [item.resource.id, item]));
    const firstSeenAt = new Date(previous.generatedAt);
    const daysBetween = this.daysBetween(firstSeenAt, now);

    const stale: StaleRecommendation[] = [];

    for (const item of current) {
      if (!previousById.has(item.resource.id)) {
        continue;
      }

      const dailyWaste = item.estimatedMonthlySavings / DAYS_PER_MONTH;
      stale.push({
        resourceId: item.resource.id,
        resourceName: item.resource.name,
        title: item.reason,
        monthlySavings: round(item.estimatedMonthlySavings),
        firstSeenAt: previous.generatedAt,
        daysOpen: daysBetween,
        wastedSoFar: round(dailyWaste * daysBetween),
      });
    }

    stale.sort((left, right) => right.wastedSoFar - left.wastedSoFar);

    const currentIds = new Set(current.map((item) => item.resource.id));
    const resolved = previous.idleResources.filter((item) => !currentIds.has(item.resource.id)).length;
    const totalWasted = round(stale.reduce((sum, item) => sum + item.wastedSoFar, 0));
    const projectedAnnualWaste = round(stale.reduce((sum, item) => sum + item.monthlySavings, 0) * 12);

    return InactionCostSchema.parse({
      comparedTo: previous.generatedAt,
      daysBetween,
      stale,
      resolved,
      totalWasted,
      projectedAnnualWaste,
      summary: this.buildSummary({ stale: stale.length, resolved, totalWasted, daysBetween, projectedAnnualWaste }),
    });
  }

  private daysBetween(from: Date, to: Date): number {
    if (Number.isNaN(from.getTime())) {
      return 0;
    }
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
  }

  private buildSummary(input: {
    stale: number;
    resolved: number;
    totalWasted: number;
    daysBetween: number;
    projectedAnnualWaste: number;
  }): string {
    if (input.stale === 0) {
      return input.resolved > 0
        ? `Nenhuma recomendação ficou em aberto desde a análise anterior e ${input.resolved} foram resolvidas. Excelente cadência de otimização.`
        : 'Nenhuma recomendação pendente desde a análise anterior.';
    }

    const resolvedText =
      input.resolved > 0 ? ` No mesmo período, ${input.resolved} recomendação(ões) foram resolvidas.` : '';

    return (
      `${input.stale} recomendação(ões) continuam em aberto há ${input.daysBetween} dias, ` +
      `acumulando ${input.totalWasted.toFixed(2)} em gasto evitável. ` +
      `Mantido esse ritmo, o desperdício chega a ${input.projectedAnnualWaste.toFixed(2)} em 12 meses.${resolvedText}`
    );
  }
}
