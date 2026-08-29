import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command, Flags } from '@oclif/core';
import ora from 'ora';

import { generateStaticReport } from '@/dashboard/report';
import { AzureClientService } from '@/services/azure-client';
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
 * Generates a static, self-contained HTML report (same visual design as the live
 * dashboard) that can be opened offline in a browser or hosted as a static site.
 */
export default class ExportCommand extends Command {
  public static override description =
    'Export a static HTML report with costs, idle resources, and recommendations. Works standalone (no server) and is ideal for Azure Cloud Shell.';

  public static override flags = {
    subscription: Flags.string({ char: 's', description: 'Azure subscription id override' }),
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
    const spinner = ora('Generating Azure cost report...').start();

    try {
      const azureClient = new AzureClientService();
      const subscriptionId = azureClient.getSubscriptionId(flags.subscription);
      const costAnalyzer = new CostAnalyzerService(azureClient);
      const resourceDetector = new ResourceDetectorService(azureClient, subscriptionId);
      const optimizer = new OptimizerService();

      const endDate = new Date();
      const startDate = new Date(
        Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - (flags.period - 1), 1),
      );

      const [costs, idleResources] = await Promise.all([
        costAnalyzer.queryCosts(
          subscriptionId,
          startDate.toISOString().slice(0, 10),
          endDate.toISOString().slice(0, 10),
          'service',
        ),
        resourceDetector.detectAll(),
      ]);
      const recommendations = await optimizer.generateRecommendations(idleResources);

      const html = generateStaticReport({
        generatedAt: new Date().toISOString(),
        subscriptionId,
        costs,
        idleResources,
        recommendations,
      });

      const outputPath = path.resolve(flags.output ?? defaultOutputPath());
      await writeFile(outputPath, html, 'utf8');

      spinner.succeed(`Report generated at ${outputPath}`);
      this.log('Open it directly in a browser, or host the file as-is (Azure Storage static website, App Service, etc.).');
    } catch (error: unknown) {
      spinner.fail(error instanceof Error ? error.message : 'Report generation failed');
      throw error;
    }
  }
}
