import { randomUUID } from 'node:crypto';

import type { ActionType, IdleResource, Recommendation, Resource } from '@/models';
import { RecommendationSchema } from '@/models';

const riskWeights: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 1.5,
  high: 2,
};

/**
 * Turns idle-resource detections into prioritized cost-saving recommendations.
 */
export class OptimizerService {
  /**
   * Generates actionable optimization recommendations.
   */
  public async generateRecommendations(idleResources: IdleResource[]): Promise<Recommendation[]> {
    const recommendations = idleResources.map((idleResource) => {
      const actionType = this.pickActionType(idleResource.resource.type, idleResource.reason);
      const monthlySavings = this.resolveMonthlySavings(idleResource);
      const annualSavings = monthlySavings * 12;
      const risk = this.assessRisk(idleResource.resource, actionType);
      const effort = this.estimateEffort(actionType);
      const roi = this.calculateROI({ monthlySavings, annualSavings, risk, effort });

      return RecommendationSchema.parse({
        id: randomUUID(),
        type: idleResource.resource.type,
        resourceId: idleResource.resource.id,
        title: `Otimizar ${idleResource.resource.name}`,
        description: `${idleResource.reason}. ${this.actionDescription(actionType)} recupera aproximadamente ${monthlySavings.toFixed(2)} por mês.`,
        monthlySavings,
        annualSavings,
        risk,
        effort,
        roi,
        actionType,
        status: 'new',
        // Carrying the evidence forward keeps the recommendation auditable: the
        // reader can check the measurements and the price basis behind the figure.
        ...(idleResource.evidence ? { evidence: idleResource.evidence } : {}),
      });
    });

    return this.prioritize(recommendations);
  }

  /**
   * Calculates a normalized ROI score for comparison.
   */
  public calculateROI(recommendation: Pick<Recommendation, 'monthlySavings' | 'annualSavings' | 'risk' | 'effort'>): number {
    const effortWeight = recommendation.effort === 'low' ? 1 : recommendation.effort === 'medium' ? 1.5 : 2;
    return Number((recommendation.annualSavings / (100 * riskWeights[recommendation.risk] * effortWeight)).toFixed(2));
  }

  /**
   * Assesses rollout risk for an optimization action.
   */
  public assessRisk(resource: Resource, actionType: ActionType): 'low' | 'medium' | 'high' {
    const criticalTag = resource.tags['criticality']?.toLowerCase();
    if (criticalTag === 'high' || actionType === 'DELETE') {
      return 'high';
    }
    if (resource.type.includes('Sql') || actionType === 'MIGRATE' || actionType === 'CHANGE_SKU') {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Estimates operator effort to implement a recommendation.
   */
  public estimateEffort(actionType: ActionType): 'low' | 'medium' | 'high' {
    if (actionType === 'DELETE' || actionType === 'CLEANUP') {
      return 'low';
    }
    if (actionType === 'SCHEDULE' || actionType === 'DOWNSIZE') {
      return 'medium';
    }
    return 'high';
  }

  /**
   * Chooses the saving figure to publish for a finding.
   *
   * When the detector resolved a real list price, that number is used verbatim.
   * Passing it through the heuristic used to inflate it by up to 360 percent
   * (a disk priced at 174.93 was published as 314.87), which silently undid the
   * price lookup and overstated the headline savings of the whole report.
   */
  private resolveMonthlySavings(idleResource: IdleResource): number {
    if (idleResource.evidence?.savingsBasis === 'retail-price') {
      return Number(idleResource.estimatedMonthlySavings.toFixed(2));
    }

    return this.calculateMonthlySavings(idleResource.resource, idleResource.estimatedMonthlySavings);
  }

  /**
   * Estimates monthly savings from resource metadata, used only when no list price
   * could be resolved for the resource.
   */
  public calculateMonthlySavings(resource: Resource, baseline = 0): number {
    const skuName = resource.sku.toLowerCase();
    const multiplier = skuName.includes('premium') ? 1.8 : skuName.includes('standard') ? 1.2 : 1;
    const typeAdjustment = resource.type.includes('virtualMachines')
      ? 150
      : resource.type.includes('storageAccounts')
        ? 25
        : resource.type.includes('Sql')
          ? 110
          : 45;
    return Number((Math.max(baseline, typeAdjustment) * multiplier).toFixed(2));
  }

  /**
   * Sorts recommendations by descending ROI.
   */
  public prioritize(recommendations: Recommendation[]): Recommendation[] {
    return [...recommendations].sort((left, right) => right.roi - left.roi);
  }

  /**
   * Human-readable, Portuguese description of what each action does.
   */
  private actionDescription(actionType: ActionType): string {
    const descriptions: Record<ActionType, string> = {
      DELETE: 'Excluir o recurso',
      DOWNSIZE: 'Reduzir o porte do recurso',
      CHANGE_SKU: 'Alterar o SKU',
      SCHEDULE: 'Agendar o desligamento fora do horário comercial',
      MIGRATE: 'Migrar para um tier de menor custo',
      CLEANUP: 'Remover o recurso órfão',
    };
    return descriptions[actionType];
  }

  private pickActionType(resourceType: string, reason = ''): ActionType {
    if (resourceType.includes('disks') || resourceType.includes('publicIPAddresses')) {
      return 'CLEANUP';
    }
    if (resourceType.includes('virtualMachines')) {
      // A VM that is already deallocated cannot be downsized into savings: what is
      // still being billed are the disks it holds.
      return /desligada|deallocated/i.test(reason) ? 'CLEANUP' : 'DOWNSIZE';
    }
    if (resourceType.includes('storageAccounts')) {
      return 'DELETE';
    }
    if (resourceType.includes('sites')) {
      return 'SCHEDULE';
    }
    if (resourceType.includes('Sql')) {
      return 'CHANGE_SKU';
    }
    return 'MIGRATE';
  }
}
