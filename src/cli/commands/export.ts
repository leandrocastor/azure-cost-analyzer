import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command, Flags } from '@oclif/core';
import ora from 'ora';

import { generateStaticReport } from '@/dashboard/report';
import type { CostSummary, IdleResource } from '@/models';
import { AzureClientService, type AccessibleSubscription } from '@/services/azure-client';
import { CostAnalyzerService } from '@/services/cost-analyzer';
import { OptimizerService } from '@/services/optimizer';
import { ResourceDetectorService } from '@/services/resource-detector';

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

      for (const [index, subscription] of subscriptions.entries()) {
        const progress = `subscription ${index + 1}/${subscriptions.length}: ${subscription.displayName}`;
        const resourceDetector = new ResourceDetectorService(azureClient, subscription.id);
        let analyzed = false;

        // Requests are issued sequentially rather than in parallel: Azure Cost
        // Management and Monitor throttle aggressively, and bursting across several
        // subscriptions at once is what triggers HTTP 429 responses.
        spinner.text = `Querying costs for ${progress}`;
        try {
          perSubscriptionCosts.push(
            await costAnalyzer.queryCosts(
              subscription.id,
              startDate.toISOString().slice(0, 10),
              endDate.toISOString().slice(0, 10),
              'service',
            ),
          );
          analyzed = true;
        } catch (error: unknown) {
          warnings.push(
            `Costs unavailable for "${subscription.displayName}": ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }

        spinner.text = `Detecting idle resources for ${progress}`;
        try {
          idleResources.push(...(await resourceDetector.detectAll()));
          analyzed = true;
        } catch (error: unknown) {
          warnings.push(
            `Idle resource detection unavailable for "${subscription.displayName}": ${error instanceof Error ? error.message : 'unknown error'}`,
          );
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

      const html = generateStaticReport({
        generatedAt: new Date().toISOString(),
        subscriptionId: subscriptionLabel,
        costs,
        idleResources,
        recommendations,
        warnings,
      });

      const outputPath = path.resolve(flags.output ?? defaultOutputPath());
      await writeFile(outputPath, html, 'utf8');

      spinner.succeed(
        `Report generated at ${outputPath} (${analyzedSubscriptions.length} subscription${analyzedSubscriptions.length === 1 ? '' : 's'} analyzed)`,
      );

      for (const warning of warnings) {
        this.warn(warning);
      }

      this.log('Open it directly in a browser, or host the file as-is (Azure Storage static website, App Service, etc.).');
    } catch (error: unknown) {
      spinner.fail(error instanceof Error ? error.message : 'Report generation failed');
      throw error;
    }
  }
}

