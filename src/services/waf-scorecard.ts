/**
 * Scores the tenant against the Cost Optimization pillar of the Azure
 * Well-Architected Framework.
 *
 * The official WAF review is a manual questionnaire: someone answers from memory
 * and the result is only as good as their recollection. Every check here is instead
 * answered from data already collected in the run, so the verdict carries the
 * evidence that produced it and can be re-run and compared over time.
 *
 * @see https://learn.microsoft.com/azure/well-architected/cost-optimization/checklist
 */

import type { CostSummary, IdleResource, Recommendation, Resource, WafCheck, WafScorecard } from '@/models';
import { WafScorecardSchema } from '@/models';

export type WafInput = {
  costs: CostSummary;
  idleResources: IdleResource[];
  recommendations: Recommendation[];
  /** Every resource discovered, used for governance checks such as tagging. */
  resources: Resource[];
  /** Tag keys that identify an accountable owner, e.g. owner, cost-center. */
  ownerTagKeys?: string[] | undefined;
  subscriptionCount: number;
};

const DEFAULT_OWNER_TAG_KEYS = ['owner', 'dono', 'responsavel', 'responsável', 'cost-center', 'costcenter', 'centro-de-custo'];

/** Percentage of total spend above which waste is considered material. */
const WASTE_TOLERANCE_PERCENT = 5;

const round = (value: number): number => Number(value.toFixed(2));

const percent = (part: number, total: number): number => (total <= 0 ? 0 : (part / total) * 100);

/**
 * Evaluates the Cost Optimization pillar and produces a comparable score.
 */
export class WafScorecardService {
  public evaluate(input: WafInput): WafScorecard {
    const checks: WafCheck[] = [
      this.checkWasteRatio(input),
      this.checkOrphanedResources(input),
      this.checkOwnershipTagging(input),
      this.checkEnvironmentTagging(input),
      this.checkRightsizing(input),
      this.checkCostVisibility(input),
      this.checkSpendConcentration(input),
      this.checkActionability(input),
    ];

    const applicable = checks.filter((check) => check.status !== 'not-applicable');
    const earned = applicable.reduce((sum, check) => sum + check.score, 0);
    const possible = applicable.reduce((sum, check) => sum + check.weight, 0);
    const score = possible <= 0 ? 0 : round(percent(earned, possible));

    return WafScorecardSchema.parse({
      score,
      grade: this.toGrade(score),
      summary: this.buildSummary(score, checks),
      checks,
      evaluatedAt: new Date().toISOString(),
    });
  }

  private toGrade(score: number): WafScorecard['grade'] {
    if (score >= 90) {
      return 'A';
    }
    if (score >= 75) {
      return 'B';
    }
    if (score >= 60) {
      return 'C';
    }
    if (score >= 40) {
      return 'D';
    }
    return 'E';
  }

  private buildSummary(score: number, checks: WafCheck[]): string {
    const failed = checks.filter((check) => check.status === 'fail').length;
    const partial = checks.filter((check) => check.status === 'partial').length;
    const passed = checks.filter((check) => check.status === 'pass').length;

    if (failed === 0 && partial === 0) {
      return `Pilar Cost Optimization com ${score.toFixed(0)} de 100. Todos os ${passed} controles avaliados estão em conformidade.`;
    }

    return `Pilar Cost Optimization com ${score.toFixed(0)} de 100: ${passed} controles em conformidade, ${partial} parciais e ${failed} não atendidos.`;
  }

  /** CO:05 — spend must be continuously optimized, so idle waste stays marginal. */
  private checkWasteRatio(input: WafInput): WafCheck {
    const waste = input.idleResources.reduce((sum, item) => sum + item.estimatedMonthlySavings, 0);
    const total = input.costs.totalAmount;
    const ratio = percent(waste, total);
    const weight = 20;

    if (total <= 0) {
      return this.buildCheck({
        id: 'waste-ratio',
        code: 'CO:05',
        title: 'Desperdício sob controle',
        status: 'not-applicable',
        evidence: 'Custos indisponíveis no período, portanto a proporção de desperdício não pôde ser calculada.',
        impact: 'high',
        recommendation: 'Garanta acesso de Cost Management Reader para que o desperdício possa ser medido em relação ao gasto.',
        score: 0,
        weight,
      });
    }

    const status = ratio <= WASTE_TOLERANCE_PERCENT ? 'pass' : ratio <= 15 ? 'partial' : 'fail';
    return this.buildCheck({
      id: 'waste-ratio',
      code: 'CO:05',
      title: 'Desperdício sob controle',
      status,
      evidence: `Recursos ociosos representam ${ratio.toFixed(1)}% do gasto do período (${round(waste)} de ${round(total)} ${input.costs.currency}).`,
      impact: 'high',
      recommendation:
        status === 'pass'
          ? 'Mantenha a revisão periódica de recursos ociosos.'
          : `Reduza o desperdício para até ${WASTE_TOLERANCE_PERCENT}% do gasto aplicando as recomendações de maior ROI.`,
      score: status === 'pass' ? weight : status === 'partial' ? weight / 2 : 0,
      weight,
    });
  }

  /** CO:07 — resources with no purpose must be decommissioned. */
  private checkOrphanedResources(input: WafInput): WafCheck {
    const orphanTypes = ['disks', 'publicipaddresses', 'loadbalancers'];
    const orphans = input.idleResources.filter((item) =>
      orphanTypes.some((type) => item.resource.type.toLowerCase().includes(type)),
    );
    const weight = 15;
    const status = orphans.length === 0 ? 'pass' : orphans.length <= 3 ? 'partial' : 'fail';

    return this.buildCheck({
      id: 'orphaned-resources',
      code: 'CO:07',
      title: 'Recursos órfãos removidos',
      status,
      evidence:
        orphans.length === 0
          ? 'Nenhum disco, Public IP ou Load Balancer órfão foi encontrado.'
          : `${orphans.length} recurso(s) órfão(s) continuam provisionados e cobrados sem uso.`,
      impact: 'medium',
      recommendation:
        orphans.length === 0
          ? 'Mantenha a limpeza automática de recursos desassociados.'
          : 'Remova os recursos órfãos: eles não têm dependências e a exclusão é de baixo risco.',
      score: status === 'pass' ? weight : status === 'partial' ? weight / 2 : 0,
      weight,
    });
  }

  /** CO:02 — spend must be attributable to an accountable owner. */
  private checkOwnershipTagging(input: WafInput): WafCheck {
    const keys = (input.ownerTagKeys ?? DEFAULT_OWNER_TAG_KEYS).map((key) => key.toLowerCase());
    const weight = 15;

    if (input.resources.length === 0) {
      return this.buildCheck({
        id: 'ownership-tagging',
        code: 'CO:02',
        title: 'Gasto atribuível a um responsável',
        status: 'not-applicable',
        evidence: 'Nenhum recurso foi inventariado, portanto a cobertura de tags não pôde ser avaliada.',
        impact: 'high',
        recommendation: 'Execute a detecção de recursos para avaliar a cobertura de tags de responsável.',
        score: 0,
        weight,
      });
    }

    const tagged = input.resources.filter((resource) =>
      Object.keys(resource.tags ?? {}).some((tag) => keys.includes(tag.toLowerCase())),
    );
    const coverage = percent(tagged.length, input.resources.length);
    const status = coverage >= 90 ? 'pass' : coverage >= 50 ? 'partial' : 'fail';

    return this.buildCheck({
      id: 'ownership-tagging',
      code: 'CO:02',
      title: 'Gasto atribuível a um responsável',
      status,
      evidence: `${coverage.toFixed(0)}% dos recursos possuem tag de responsável (${tagged.length} de ${input.resources.length}).`,
      impact: 'high',
      recommendation:
        status === 'pass'
          ? 'Mantenha a tag de responsável obrigatória via Azure Policy.'
          : 'Torne a tag de responsável obrigatória via Azure Policy: sem ela, o custo não tem dono e a otimização não avança.',
      score: round((coverage / 100) * weight),
      weight,
    });
  }

  /** CO:04 — environments must be distinguishable so non-production can be optimized. */
  private checkEnvironmentTagging(input: WafInput): WafCheck {
    const weight = 10;
    const envKeys = ['environment', 'env', 'ambiente'];

    if (input.resources.length === 0) {
      return this.buildCheck({
        id: 'environment-tagging',
        code: 'CO:04',
        title: 'Ambientes identificados por tag',
        status: 'not-applicable',
        evidence: 'Nenhum recurso foi inventariado, portanto a identificação de ambiente não pôde ser avaliada.',
        impact: 'medium',
        recommendation: 'Execute a detecção de recursos para avaliar a identificação de ambientes.',
        score: 0,
        weight,
      });
    }

    const tagged = input.resources.filter((resource) =>
      Object.keys(resource.tags ?? {}).some((tag) => envKeys.includes(tag.toLowerCase())),
    );
    const coverage = percent(tagged.length, input.resources.length);
    const status = coverage >= 80 ? 'pass' : coverage >= 40 ? 'partial' : 'fail';

    return this.buildCheck({
      id: 'environment-tagging',
      code: 'CO:04',
      title: 'Ambientes identificados por tag',
      status,
      evidence: `${coverage.toFixed(0)}% dos recursos identificam o ambiente por tag (${tagged.length} de ${input.resources.length}).`,
      impact: 'medium',
      recommendation:
        status === 'pass'
          ? 'Mantenha a padronização de tags de ambiente.'
          : 'Padronize a tag de ambiente: sem ela não é possível desligar recursos de desenvolvimento fora do horário comercial.',
      score: round((coverage / 100) * weight),
      weight,
    });
  }

  /** CO:06 — provisioned capacity must match observed demand. */
  private checkRightsizing(input: WafInput): WafCheck {
    const weight = 15;
    const underused = input.idleResources.filter((item) => item.metrics.length > 0);
    const status = underused.length === 0 ? 'pass' : underused.length <= 3 ? 'partial' : 'fail';

    return this.buildCheck({
      id: 'rightsizing',
      code: 'CO:06',
      title: 'Capacidade dimensionada pela demanda',
      status,
      evidence:
        underused.length === 0
          ? 'Nenhum recurso com telemetria apresentou subutilização sustentada.'
          : `${underused.length} recurso(s) apresentam utilização muito abaixo da capacidade provisionada.`,
      impact: 'high',
      recommendation:
        underused.length === 0
          ? 'Mantenha o acompanhamento contínuo de utilização.'
          : 'Redimensione ou desligue os recursos subutilizados; a telemetria já comprova a folga de capacidade.',
      score: status === 'pass' ? weight : status === 'partial' ? weight / 2 : 0,
      weight,
    });
  }

  /** CO:01 — the team must be able to see what it spends. */
  private checkCostVisibility(input: WafInput): WafCheck {
    const weight = 10;
    const hasCosts = input.costs.totalAmount > 0;
    const hasBreakdown = Object.keys(input.costs.byService).length > 1;
    const status = hasCosts && hasBreakdown ? 'pass' : hasCosts ? 'partial' : 'fail';

    return this.buildCheck({
      id: 'cost-visibility',
      code: 'CO:01',
      title: 'Visibilidade de custo por serviço',
      status,
      evidence: hasCosts
        ? `Custos disponíveis e detalhados em ${Object.keys(input.costs.byService).length} serviço(s).`
        : 'Não foi possível obter custos para as assinaturas analisadas.',
      impact: 'high',
      recommendation: hasCosts
        ? 'Mantenha a exportação periódica do relatório para acompanhar a evolução.'
        : 'Conceda o papel Cost Management Reader: sem visibilidade de custo não há como priorizar otimizações.',
      score: status === 'pass' ? weight : status === 'partial' ? weight / 2 : 0,
      weight,
    });
  }

  /** CO:03 — concentrated spend deserves dedicated attention. */
  private checkSpendConcentration(input: WafInput): WafCheck {
    const weight = 5;
    const services = Object.entries(input.costs.byService).sort(([, left], [, right]) => right - left);
    const top = services[0];

    if (!top || input.costs.totalAmount <= 0) {
      return this.buildCheck({
        id: 'spend-concentration',
        code: 'CO:03',
        title: 'Concentração de gasto conhecida',
        status: 'not-applicable',
        evidence: 'Sem dados de custo suficientes para avaliar a concentração de gasto.',
        impact: 'low',
        recommendation: 'Garanta acesso aos dados de custo para identificar os serviços mais representativos.',
        score: 0,
        weight,
      });
    }

    const share = percent(top[1], input.costs.totalAmount);
    const status = share < 60 ? 'pass' : 'partial';

    return this.buildCheck({
      id: 'spend-concentration',
      code: 'CO:03',
      title: 'Concentração de gasto conhecida',
      status,
      evidence: `O serviço ${top[0]} concentra ${share.toFixed(0)}% do gasto do período.`,
      impact: 'low',
      recommendation:
        status === 'pass'
          ? 'Gasto distribuído entre serviços; mantenha o acompanhamento.'
          : `Priorize a otimização de ${top[0]}: qualquer ganho percentual nele tem impacto desproporcional no total.`,
      score: status === 'pass' ? weight : weight / 2,
      weight,
    });
  }

  /** CO:05 — findings must translate into actionable, prioritized work. */
  private checkActionability(input: WafInput): WafCheck {
    const weight = 10;
    const lowRisk = input.recommendations.filter((item) => item.risk === 'low');
    const status =
      input.recommendations.length === 0 ? 'pass' : lowRisk.length > 0 ? 'partial' : 'fail';

    return this.buildCheck({
      id: 'actionability',
      code: 'CO:05',
      title: 'Otimizações priorizadas e acionáveis',
      status,
      evidence:
        input.recommendations.length === 0
          ? 'Nenhuma recomendação pendente no período analisado.'
          : `${input.recommendations.length} recomendação(ões) pendentes, das quais ${lowRisk.length} são de baixo risco.`,
      impact: 'medium',
      recommendation:
        input.recommendations.length === 0
          ? 'Mantenha a análise periódica para detectar novas oportunidades.'
          : 'Comece pelas recomendações de baixo risco: elas entregam economia imediata sem impacto operacional.',
      score: status === 'pass' ? weight : status === 'partial' ? weight / 2 : 0,
      weight,
    });
  }

  private buildCheck(check: WafCheck): WafCheck {
    return check;
  }
}
