import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command, Flags } from '@oclif/core';
import ora from 'ora';

import { generateStaticReport } from '@/dashboard/report';
import type { CostDiff, CostSummary, IdleResource, InactionCost, Resource } from '@/models';
import { AzureClientService, type AccessibleSubscription } from '@/services/azure-client';
import { CostAnalyzerService } from '@/services/cost-analyzer';
import { CostReconciliationService } from '@/services/cost-reconciliation';
import type { ReportSnapshot } from '@/services/cost-diff';
import { CostDiffService } from '@/services/cost-diff';
import { DecisionEngineService } from '@/services/decision-engine';
import { ExecutiveSummaryService } from '@/services/executive-summary';
import { OptimizerService } from '@/services/optimizer';
import { OwnershipService } from '@/services/ownership';
import { RemediationService } from '@/services/remediation';
import { ResourceDetectorService } from '@/services/resource-detector';
import { costManagementQpuLimiter } from '@/utils/qpu-limiter';
import { InactionCostService } from '@/services/inaction-cost';
import { PricingService } from '@/services/pricing';
import { WafScorecardService } from '@/services/waf-scorecard';

/**
 * Builds a default, timestamped output filename for the generated report.
 */
const defaultOutputPath = (): string => {
  const stamp = new Date().toISOString().replace(/:/g, '-').slice(0, 16);
  return `azure-cost-report-${stamp}.html`;
};

/**
 * Resolves which subscriptions the report should cover. When an explicit
 * subscription is given (flag or environment), only that one is analyzed.
 * Otherwise every enabled subscription the authenticated identity can access
 * in its tenant(s) is discovered and analyzed, so the command works out of
 * the box in Azure Cloud Shell without any prior configuration.
 */
const resolveSubscriptions = async (
  azureClient: AzureClientService,
  explicitSubscription?: string,
): Promise<AccessibleSubscription[]> => {
  if (explicitSubscription) {
    return [{ id: explicitSubscription, displayName: explicitSubscription }];
  }

  const configured = azureClient.getConfiguredSubscriptionId();
  if (configured) {
    return [{ id: configured, displayName: configured }];
  }

  return azureClient.listAccessibleSubscriptions();
};

const addBucket = (target: Record<string, number>, source: Record<string, number>): void => {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
};

/**
 * Merges per-subscription cost summaries into a single tenant-wide summary.
 */
const mergeCostSummaries = (summaries: CostSummary[]): CostSummary => {
  const merged: CostSummary = {
    period: summaries[0]?.period ?? 'N/A',
    totalAmount: 0,
    currency: summaries[0]?.currency ?? 'USD',
    byService: {},
    byResourceGroup: {},
    byLocation: {},
  };

  for (const summary of summaries) {
    merged.totalAmount += summary.totalAmount;
    addBucket(merged.byService, summary.byService);
    addBucket(merged.byResourceGroup, summary.byResourceGroup);
    addBucket(merged.byLocation, summary.byLocation);
  }

  return merged;
};

/**
 * Generates a static, self-contained HTML report (same visual design as the live
 * dashboard) that can be opened offline in a browser or hosted as a static site.
 */
export default class ExportCommand extends Command {
  public static override description =
    'Export a static HTML report with costs, idle resources, and recommendations. Works standalone (no server) and is ideal for Azure Cloud Shell. When --subscription is omitted, every subscription the authenticated identity can access in its tenant is analyzed.';

  public static override flags = {
    subscription: Flags.string({
      char: 's',
      description: 'Azure subscription id override. When omitted, all accessible subscriptions are analyzed.',
    }),
    period: Flags.integer({
      char: 'p',
      description: 'Trailing months to analyze',
      min: 1,
      max: 12,
      default: 1,
    }),
    output: Flags.string({ char: 'o', description: 'Output HTML file path' }),
    compare: Flags.string({
      char: 'c',
      description:
        'Path to a previously generated report (HTML or JSON) to compare against, revealing what changed since then.',
    }),
    'owner-tags': Flags.string({
      description:
        'Comma-separated tag keys used to attribute waste to an owner (default: owner, team, costCenter, ...).',
    }),
    currency: Flags.string({
      description: 'Currency for retail price lookups (ISO code, e.g. BRL). Defaults to the billing currency reported by Azure.',
    }),
    'no-remediation': Flags.boolean({
      description: 'Skip generating the executable remediation plan and apply-remediation.sh script.',
      default: false,
    }),
  };

  /**
   * Executes the command.
   */
  public async run(): Promise<void> {
    const { flags } = await this.parse(ExportCommand);
    const spinner = ora('Discovering accessible Azure subscriptions...').start();

    try {
      const azureClient = new AzureClientService();
      const subscriptions = await resolveSubscriptions(azureClient, flags.subscription);
      const costAnalyzer = new CostAnalyzerService(azureClient);
      const optimizer = new OptimizerService();

      const endDate = new Date();
      const startDate = new Date(
        Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - (flags.period - 1), 1),
      );

      const perSubscriptionCosts: CostSummary[] = [];
      const idleResources: IdleResource[] = [];
      const warnings: string[] = [];
      const analyzedSubscriptions: AccessibleSubscription[] = [];
      const inventory: Resource[] = [];

      // Pricing is looked up in the currency Azure bills the tenant in, which is only
      // known after the first cost query, so the service is created lazily.
      let pricingService: PricingService | undefined = flags.currency
        ? new PricingService({ currency: flags.currency })
        : undefined;

      // Cost Management enforces its quota per tenant, so a wait triggered by one
      // subscription is surfaced as progress instead of looking like a freeze.
      costManagementQpuLimiter.setWaitReporter((delayMs, reason) => {
        const seconds = Math.ceil(delayMs / 1000);
        spinner.text =
          reason === 'throttled'
            ? `Limite do Cost Management atingido, aguardando ${seconds}s antes de continuar...`
            : `Respeitando a cota de consultas do Cost Management, aguardando ${seconds}s...`;
      });

      for (const [index, subscription] of subscriptions.entries()) {
        const progress = `subscription ${index + 1}/${subscriptions.length}: ${subscription.displayName}`;
        let analyzed = false;

        // Requests are issued sequentially rather than in parallel: Azure Cost
        // Management and Monitor throttle aggressively, and bursting across several
        // subscriptions at once is what triggers HTTP 429 responses.
        spinner.text = `Querying costs for ${progress}`;
        try {
          const summary = await costAnalyzer.queryCosts(
            subscription.id,
            startDate.toISOString().slice(0, 10),
            endDate.toISOString().slice(0, 10),
            'service',
          );
          perSubscriptionCosts.push(summary);
          pricingService ??= new PricingService({ currency: summary.currency });
          analyzed = true;
        } catch (error: unknown) {
          warnings.push(
            `Custos indisponíveis para "${subscription.displayName}": ${error instanceof Error ? error.message : 'erro desconhecido'}`,
          );
        }

        spinner.text = `Detecting idle resources for ${progress}`;
        const resourceDetector = new ResourceDetectorService(azureClient, subscription.id, pricingService);
        let subscriptionFindings: IdleResource[] = [];
        try {
          subscriptionFindings = await resourceDetector.detectAll();
          analyzed = true;
        } catch (error: unknown) {
          warnings.push(
            `Detecção de recursos ociosos indisponível para "${subscription.displayName}": ${error instanceof Error ? error.message : 'erro desconhecido'}`,
          );
        }

        // Detection reasons about utilization and list prices, which is a projection of
        // what a resource would cost. Cost Management knows what it did cost. Claiming a
        // saving on something billed at zero, such as an App Service on the F1 Free tier,
        // is what makes a finance audience discard the entire report.
        if (subscriptionFindings.length > 0) {
          spinner.text = `Reconciling findings against billed cost for ${progress}`;
          try {
            const ledger = await costAnalyzer.queryResourceCosts(
              subscription.id,
              startDate.toISOString().slice(0, 10),
              endDate.toISOString().slice(0, 10),
            );
            const reconciliation = new CostReconciliationService().reconcile(subscriptionFindings, ledger);
            subscriptionFindings = reconciliation.idleResources;

            if (reconciliation.discarded.length > 0) {
              warnings.push(
                `${reconciliation.discarded.length} recurso(s) de "${subscription.displayName}" foram descartados por não gerarem custo faturado: ${reconciliation.discarded
                  .map((item) => item.name)
                  .join(', ')}.`,
              );
            }
          } catch (error: unknown) {
            warnings.push(
              `Sem conciliação com o custo faturado em "${subscription.displayName}": ${error instanceof Error ? error.message : 'erro desconhecido'}. As economias exibidas são projeções por preço de lista, não confirmadas pela fatura.`,
            );
          }
        }

        idleResources.push(...subscriptionFindings);

        // The inventory only feeds governance checks, so a failure here must not
        // discard the detection results that were already gathered successfully.
        try {
          inventory.push(...resourceDetector.getInventory());
        } catch {
          // Governance checks simply see a smaller sample.
        }

        if (analyzed) {
          analyzedSubscriptions.push(subscription);
        }
      }

      if (analyzedSubscriptions.length === 0) {
        throw new Error(
          `No data could be collected from any subscription. ${warnings.join(' | ')}`,
        );
      }

      spinner.text = 'Generating recommendations and rendering report...';
      const recommendations = await optimizer.generateRecommendations(idleResources);
      const costs = mergeCostSummaries(perSubscriptionCosts);
      const subscriptionLabel =
        analyzedSubscriptions.length === 1 && analyzedSubscriptions[0]
          ? analyzedSubscriptions[0].id
          : `${analyzedSubscriptions.length} subscriptions: ${analyzedSubscriptions.map((subscription) => subscription.displayName).join(', ')}`;

      const generatedAt = new Date().toISOString();

      const ownerTagKeys = flags['owner-tags']
        ?.split(',')
        .map((key) => key.trim())
        .filter(Boolean);
      const ownership = new OwnershipService(
        ownerTagKeys && ownerTagKeys.length > 0 ? ownerTagKeys : undefined,
      ).buildReport(idleResources);

      // Comparing against a previous report is best-effort: a missing or malformed
      // baseline must never prevent the current report from being produced.
      let diff: CostDiff | undefined;
      let previousSnapshot: ReportSnapshot | undefined;
      if (flags.compare) {
        spinner.text = `Comparing against ${flags.compare}...`;
        try {
          const costDiffService = new CostDiffService();
          const previous = await costDiffService.loadSnapshot(path.resolve(flags.compare));
          previousSnapshot = previous;
          diff = costDiffService.compare(previous, {
            generatedAt,
            subscriptionId: subscriptionLabel,
            costs,
            idleResources,
          });
        } catch (error: unknown) {
          warnings.push(
            `Comparativo indisponível: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
          );
        }
      }

      // Reuses the same baseline as the cost diff: a recommendation that survived
      // from one report to the next is quantified debt, not a fresh suggestion.
      let inaction: InactionCost | undefined;
      if (previousSnapshot) {
        inaction = new InactionCostService().analyze(previousSnapshot, idleResources);
      }

      const waf = new WafScorecardService().evaluate({
        costs,
        idleResources,
        recommendations,
        resources: inventory,
        ownerTagKeys: ownerTagKeys && ownerTagKeys.length > 0 ? ownerTagKeys : undefined,
        subscriptionCount: analyzedSubscriptions.length,
      });

      const remediationPlans = flags['no-remediation']
        ? []
        : new RemediationService().buildPlans(recommendations, idleResources);

      const decisionEngine = new DecisionEngineService().evaluate(recommendations, idleResources, costs.currency);

      const executiveSummary = new ExecutiveSummaryService().build({
        costs,
        idleResources,
        recommendations,
        ownership,
        diff,
        subscriptionCount: analyzedSubscriptions.length,
      });

      const html = generateStaticReport({
        generatedAt,
        subscriptionId: subscriptionLabel,
        costs,
        idleResources,
        recommendations,
        warnings,
        executiveSummary,
        ownership,
        diff,
        remediationPlans,
        waf,
        inaction,
        decisionEngine,
      });

      const outputPath = path.resolve(flags.output ?? defaultOutputPath());
      await writeFile(outputPath, html, 'utf8');

      let scriptPath: string | undefined;
      if (remediationPlans.length > 0) {
        scriptPath = path.join(path.dirname(outputPath), 'apply-remediation.sh');
        await writeFile(
          scriptPath,
          new RemediationService().buildApplyScript(remediationPlans),
          { encoding: 'utf8', mode: 0o755 },
        );
      }

      spinner.succeed(
        `Report generated at ${outputPath} (${analyzedSubscriptions.length} subscription${analyzedSubscriptions.length === 1 ? '' : 's'} analyzed)`,
      );

      for (const warning of warnings) {
        this.warn(warning);
      }

      this.log('Open it directly in a browser, or host the file as-is (Azure Storage static website, App Service, etc.).');
      if (scriptPath) {
        this.log(
          `Remediation script written to ${scriptPath} — it runs in dry-run mode by default; use APPLY=true to execute.`,
        );
      }
    } catch (error: unknown) {
      spinner.fail(error instanceof Error ? error.message : 'Report generation failed');
      throw error;
    }
  }
}

