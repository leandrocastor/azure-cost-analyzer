import type {
  AgingReport,
  FinOpsMaturityScore,
  ForgottenEnvironmentReport,
  GovernanceReport,
  MaturityDimension,
  WafScorecard,
} from '@/models';
import { FinOpsMaturityScoreSchema } from '@/models';

/**
 * Fixed, documented weights for each maturity dimension. They are declared
 * here (not tuned per run) so the same inputs always produce the same score,
 * and the formula can be explained to an executive audience without hand
 * waving. See README for the full rationale.
 */
const WEIGHTS = {
  wafOptimization: 0.35,
  ownerTagging: 0.25,
  environmentAndCostCenterTagging: 0.2,
  agingAndForgottenControl: 0.2,
} as const;

const clampScore = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Rolls up metrics already computed elsewhere in the report (WAF Cost
 * Optimization, tag governance, aging/ownerless and forgotten-environment
 * findings) into a single 0-100 maturity score with a letter grade, so an
 * executive can track FinOps maturity across runs with one number instead of
 * re-reading every section. Every dimension is a direct function of a metric
 * already validated against real data elsewhere in the pipeline — nothing new
 * is estimated here, this is only a documented weighted average.
 */
export class FinOpsMaturityScoreService {
  public build(input: {
    waf: WafScorecard;
    governance: GovernanceReport;
    aging: AgingReport;
    forgottenEnvironments: ForgottenEnvironmentReport;
  }): FinOpsMaturityScore {
    const { waf, governance, aging, forgottenEnvironments } = input;

    const ownerCoverage = governance.coverage.find((item) => item.tagKey === 'owner');
    const environmentCoverage = governance.coverage.find((item) => item.tagKey === 'environment');
    const costCenterCoverage = governance.coverage.find((item) => item.tagKey === 'costCenter');

    const ownerScore = ownerCoverage ? clampScore((1 - ownerCoverage.missingPercent) * 100) : 100;
    const envCostCenterScore =
      environmentCoverage && costCenterCoverage
        ? clampScore((1 - (environmentCoverage.missingPercent + costCenterCoverage.missingPercent) / 2) * 100)
        : 100;

    const resourcesInspected = Math.max(1, governance.resourcesInspected);
    const riskyResourceCount = aging.resources.length + forgottenEnvironments.resources.length;
    const agingScore = clampScore((1 - riskyResourceCount / resourcesInspected) * 100);

    const dimensions: MaturityDimension[] = [
      {
        name: 'Otimização de custos (WAF Cost Optimization)',
        score: Number(waf.score.toFixed(1)),
        weight: WEIGHTS.wafOptimization,
        evidence: `Nota ${waf.score.toFixed(0)}/100 no scorecard WAF (grau ${waf.grade}).`,
      },
      {
        name: 'Cobertura de tag de responsável (owner)',
        score: Number(ownerScore.toFixed(1)),
        weight: WEIGHTS.ownerTagging,
        evidence: ownerCoverage
          ? `${(ownerCoverage.missingPercent * 100).toFixed(0)}% dos recursos inspecionados não têm tag de responsável.`
          : 'Nenhum recurso inspecionado para avaliar a tag de responsável.',
      },
      {
        name: 'Cobertura de tags de ambiente e centro de custo',
        score: Number(envCostCenterScore.toFixed(1)),
        weight: WEIGHTS.environmentAndCostCenterTagging,
        evidence:
          environmentCoverage && costCenterCoverage
            ? `${(environmentCoverage.missingPercent * 100).toFixed(0)}% sem tag de ambiente e ${(costCenterCoverage.missingPercent * 100).toFixed(0)}% sem tag de centro de custo.`
            : 'Nenhum recurso inspecionado para avaliar ambiente/centro de custo.',
      },
      {
        name: 'Controle de recursos envelhecidos e ambientes esquecidos',
        score: Number(agingScore.toFixed(1)),
        weight: WEIGHTS.agingAndForgottenControl,
        evidence: `${riskyResourceCount} de ${governance.resourcesInspected} recurso(s) inspecionados são envelhecidos e sem responsável ou ambientes não produtivos esquecidos, ambos com custo faturado confirmado.`,
      },
    ];

    const score = clampScore(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0));

    return FinOpsMaturityScoreSchema.parse({
      score: Number(score.toFixed(1)),
      grade: this.toGrade(score),
      dimensions,
      summary: `Maturidade FinOps calculada a partir de ${dimensions.length} dimensões já validadas neste relatório (WAF, cobertura de tags e controle de recursos de risco), sem nenhuma métrica nova estimada.`,
    });
  }

  private toGrade(score: number): FinOpsMaturityScore['grade'] {
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
}
