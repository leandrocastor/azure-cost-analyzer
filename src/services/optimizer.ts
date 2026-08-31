import { randomUUID } from 'node:crypto';

import type { ActionType, BillingRationale, IdleResource, Recommendation, Resource } from '@/models';
import { RecommendationSchema } from '@/models';

const riskWeights: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 1.5,
  high: 2,
};

/**
 * How each service is billed, and which action actually changes that bill.
 *
 * This table exists because plausible-sounding advice can be flatly wrong for a given
 * service. Scheduling an App Service to shut down outside business hours saves nothing:
 * the App Service Plan keeps reserving its VM instances and keeps billing regardless of
 * whether the app is running. Every entry carries the Microsoft Learn page that states
 * the billing behavior, so a recommendation can always be traced back to documentation
 * instead of to an assumption.
 */
const BILLING_RATIONALES: { match: (resourceType: string) => boolean; action: ActionType; rationale: BillingRationale }[] = [
  {
    match: (type) => type.includes('disks'),
    action: 'CLEANUP',
    rationale: {
      billingModel: 'Managed disks são cobrados pelo tamanho provisionado do tier, independentemente de estarem anexados ou de haver I/O.',
      whySaves: 'A cobrança só cessa quando o disco é excluído; desanexar ou parar a VM não reduz o custo do disco.',
      documentationUrl: 'https://learn.microsoft.com/azure/virtual-machines/disks-types',
    },
  },
  {
    match: (type) => type.includes('publicIPAddresses'),
    action: 'CLEANUP',
    rationale: {
      billingModel: 'Endereços IP públicos Standard são cobrados por hora enquanto existirem, mesmo sem estarem associados a um recurso.',
      whySaves: 'Excluir o endereço encerra a cobrança horária; apenas desassociar mantém o custo.',
      documentationUrl: 'https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses',
    },
  },
  {
    match: (type) => type.includes('sites'),
    action: 'DOWNSIZE',
    rationale: {
      billingModel: 'O App Service é cobrado pelo App Service Plan, que reserva instâncias de VM pelo tier e pela quantidade configurada, e não pelo uso do aplicativo.',
      whySaves: 'A economia vem de reduzir o tier do plano, consolidar aplicativos em um plano compartilhado ou mover para o tier Free. Reduzir a reserva é o que reduz a fatura.',
      documentationUrl: 'https://learn.microsoft.com/azure/app-service/app-service-plan-manage#delete-an-app-service-plan',
      notApplicable: 'Parar o aplicativo ou agendar desligamento fora do horário comercial não gera economia: a documentação afirma que planos continuam sendo cobrados porque seguem reservando as instâncias de VM configuradas.',
    },
  },
  {
    match: (type) => type.includes('storageAccounts'),
    action: 'MIGRATE',
    rationale: {
      billingModel: 'Contas de armazenamento são cobradas por volume armazenado, camada de acesso, redundância e número de transações.',
      whySaves: 'Mover dados frios para as camadas Cool ou Archive, ou excluir a conta quando não houver dado útil, reduz o componente de armazenamento da fatura.',
      documentationUrl: 'https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview',
    },
  },
  {
    match: (type) => type.includes('Sql'),
    action: 'CHANGE_SKU',
    rationale: {
      billingModel: 'O Azure SQL Database é cobrado pelo modelo de compra escolhido (DTU ou vCore) e pelo tier provisionado, independentemente da carga aplicada.',
      whySaves: 'Reduzir o tier ou adotar o modo Serverless, que pausa automaticamente, diminui a capacidade cobrada.',
      documentationUrl: 'https://learn.microsoft.com/azure/azure-sql/database/serverless-tier-overview',
    },
  },
  {
    match: (type) => type.toLowerCase().includes('serverfarms'),
    action: 'DOWNSIZE',
    rationale: {
      billingModel: 'O App Service Plan reserva instâncias de VM pelo tier e pela quantidade de workers configurada, cobrando integralmente por essa reserva independentemente do uso agregado dos aplicativos que hospeda.',
      whySaves: 'Reduzir o tier do plano, reduzir a quantidade de workers ou consolidar os aplicativos em um plano menor reduz a reserva cobrada.',
      documentationUrl: 'https://learn.microsoft.com/azure/app-service/app-service-plan-manage#pricing-tiers',
    },
  },
];

/**
 * Billing rationale for a plan with zero applications: the reservation is
 * charged in full with no application to justify it, so deleting the plan
 * (not just downsizing it) is the action that actually removes the cost.
 */
const ORPHAN_APP_SERVICE_PLAN_RATIONALE: BillingRationale = {
  billingModel: 'Um App Service Plan continua reservando e cobrando as instâncias de VM configuradas mesmo sem nenhum aplicativo implantado nele.',
  whySaves: 'A economia só se confirma excluindo o plano; reduzir o tier de um plano vazio ainda deixaria uma reserva sem uso.',
  documentationUrl: 'https://learn.microsoft.com/azure/app-service/app-service-plan-manage#delete-an-app-service-plan',
};

/**
 * Billing rationale for a stopped VM, whose correct action differs from a running one:
 * the compute charge already stopped, so only the retained disks are still billed.
 */
const STOPPED_VM_RATIONALE: BillingRationale = {
  billingModel: 'Uma VM desalocada não gera custo de computação, mas os discos gerenciados que ela mantém continuam sendo cobrados pelo tamanho provisionado.',
  whySaves: 'A economia vem de excluir a VM e seus discos, ou de capturar uma imagem e liberar os discos. Manter a VM desligada não elimina o custo remanescente.',
  documentationUrl: 'https://learn.microsoft.com/azure/virtual-machines/states-billing',
};

/** Billing rationale for a running but underutilized VM. */
const RUNNING_VM_RATIONALE: BillingRationale = {
  billingModel: 'Máquinas virtuais em execução são cobradas por hora conforme o tamanho escolhido, independentemente da utilização de CPU.',
  whySaves: 'Reduzir o tamanho da VM diminui a taxa horária. Desalocar a VM interrompe a cobrança de computação, mas mantém a cobrança dos discos.',
  documentationUrl: 'https://learn.microsoft.com/azure/virtual-machines/states-billing',
};

/** Fallback used when the service has no documented entry in the table above. */
const GENERIC_RATIONALE: BillingRationale = {
  billingModel: 'Modelo de cobrança específico deste serviço não mapeado nesta versão.',
  whySaves: 'Revise a utilização e o tier contratado antes de agir; confirme o modelo de cobrança na documentação do serviço.',
  documentationUrl: 'https://learn.microsoft.com/azure/cost-management-billing/costs/cost-analysis-common-uses',
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
      const { actionType, rationale } = this.resolveAction(idleResource.resource.type, idleResource.reason);
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
        description: this.buildDescription(idleResource.reason, actionType, monthlySavings),
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
        billingRationale: rationale,
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
   * A measured number is never passed through the heuristic. Doing so used to inflate
   * list prices by up to 360 percent (a disk priced at 174.93 was published as 314.87),
   * and it also resurrected savings for resources that had already been reconciled down
   * to zero because their billing had stopped. Both cases publish a number the invoice
   * contradicts, which is exactly what the estimate must never do.
   */
  private resolveMonthlySavings(idleResource: IdleResource): number {
    const basis = idleResource.evidence?.savingsBasis;
    if (basis === 'retail-price' || basis === 'observed-cost') {
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
   * Writes the recommendation sentence.
   *
   * A finding reconciled down to zero must not read "recupera aproximadamente 0.00 por
   * mês": there is nothing to recover, and stating otherwise reads as a defect to anyone
   * reviewing the numbers. It is reported as a confirmation that the charge already ended.
   */
  private buildDescription(reason: string, actionType: ActionType, monthlySavings: number): string {
    if (monthlySavings <= 0) {
      return `${reason}. Não há economia futura a capturar: o recurso não gera custo no período mais recente. Mantido no relatório para registrar que a cobrança cessou.`;
    }

    return `${reason}. ${this.actionDescription(actionType)} recupera aproximadamente ${monthlySavings.toFixed(2)} por mês.`;
  }

  /**
   * Human-readable, Portuguese description of what each action does.
   */
  private actionDescription(actionType: ActionType): string {
    const descriptions: Record<ActionType, string> = {
      DELETE: 'Excluir o recurso',
      DOWNSIZE: 'Reduzir a capacidade provisionada',
      CHANGE_SKU: 'Alterar o SKU',
      SCHEDULE: 'Agendar a desalocação fora do horário comercial, que interrompe a cobrança de computação',
      MIGRATE: 'Migrar para um tier de menor custo',
      CLEANUP: 'Remover o recurso órfão',
    };
    return descriptions[actionType];
  }

  /**
   * Resolves the action and the documented billing reason behind it.
   *
   * Action and rationale are chosen together on purpose: an action that cannot be
   * justified by the service billing model has no business being recommended.
   */
  private resolveAction(resourceType: string, reason = ''): { actionType: ActionType; rationale: BillingRationale } {
    if (resourceType.includes('virtualMachines')) {
      // A VM that is already deallocated cannot be downsized into savings: what is
      // still being billed are the disks it holds.
      return /desligada|deallocated/i.test(reason)
        ? { actionType: 'CLEANUP', rationale: STOPPED_VM_RATIONALE }
        : { actionType: 'DOWNSIZE', rationale: RUNNING_VM_RATIONALE };
    }

    // A plan with zero apps has nothing left to downsize into: the whole
    // reservation is waste, so the action that saves money is deleting it.
    if (resourceType.toLowerCase().includes('serverfarms') && /sem nenhum aplicativo/i.test(reason)) {
      return { actionType: 'DELETE', rationale: ORPHAN_APP_SERVICE_PLAN_RATIONALE };
    }

    const entry = BILLING_RATIONALES.find((candidate) => candidate.match(resourceType));
    return entry
      ? { actionType: entry.action, rationale: entry.rationale }
      : { actionType: 'MIGRATE', rationale: GENERIC_RATIONALE };
  }
}
