import { writeFile } from 'node:fs/promises';

import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import Table from 'cli-table3';

import { AzureClientService } from '@/services/azure-client';
import { CostAnalyzerService } from '@/services/cost-analyzer';

type OutputFormat = 'table' | 'json' | 'csv';

const renderCsv = (summary: Awaited<ReturnType<CostAnalyzerService['queryCosts']>>): string => {
  const lines = ['dimension,name,amount'];
  for (const [name, amount] of Object.entries(summary.byService)) {
    lines.push(`service,${name},${amount}`);
  }
  for (const [name, amount] of Object.entries(summary.byResourceGroup)) {
    lines.push(`resourceGroup,${name},${amount}`);
  }
  for (const [name, amount] of Object.entries(summary.byLocation)) {
    lines.push(`location,${name},${amount}`);
  }
  return lines.join('\n');
};

/**
 * Retrieves Azure cost summaries and renders them in terminal-friendly formats.
 */
export default class CostsCommand extends Command {
  public static override description = 'Analyze Azure costs over a configurable period';

  public static override flags = {
    subscription: Flags.string({ char: 's', description: 'Azure subscription id' }),
    period: Flags.integer({
      char: 'p',
      description: 'Trailing months to analyze',
      min: 1,
      max: 12,
      default: 1,
    }),
    'group-by': Flags.string({
      description: 'Cost grouping dimension',
      options: ['service', 'resource-group', 'location', 'tags'],
      default: 'service',
    }),
    format: Flags.string({
      description: 'Output format',
      options: ['table', 'json', 'csv'],
      default: 'table',
    }),
    output: Flags.string({ description: 'Optional file path for exported output' }),
  };

  /**
   * Executes the command.
   */
  public async run(): Promise<void> {
    const { flags } = await this.parse(CostsCommand);
    const azureClient = new AzureClientService();
    const analyzer = new CostAnalyzerService(azureClient);
    const subscriptionId = azureClient.getSubscriptionId(flags.subscription);
    const endDate = new Date();
    const startDate = new Date(
      Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - (flags.period - 1), 1),
    );
    const summary = await analyzer.queryCosts(
      subscriptionId,
      startDate.toISOString().slice(0, 10),
      endDate.toISOString().slice(0, 10),
      flags['group-by'] as 'service' | 'resource-group' | 'location' | 'tags',
    );

    const rendered = this.render(summary, flags.format as OutputFormat);
    if (flags.output) {
      await writeFile(flags.output, rendered, 'utf8');
    }

    this.log(rendered);
  }

  private render(
    summary: Awaited<ReturnType<CostAnalyzerService['queryCosts']>>,
    format: OutputFormat,
  ): string {
    if (format === 'json') {
      return JSON.stringify(summary, null, 2);
    }

    if (format === 'csv') {
      return renderCsv(summary);
    }

    const table = new Table({
      head: [chalk.cyan('Dimension'), chalk.cyan('Name'), chalk.cyan('Cost')],
    });

    for (const [name, amount] of Object.entries(summary.byService)) {
      table.push(['Service', name, chalk.green(`$${amount.toFixed(2)}`)]);
    }
    for (const [name, amount] of Object.entries(summary.byResourceGroup)) {
      table.push(['Resource Group', name, chalk.yellow(`$${amount.toFixed(2)}`)]);
    }
    for (const [name, amount] of Object.entries(summary.byLocation)) {
      table.push(['Location', name, chalk.magenta(`$${amount.toFixed(2)}`)]);
    }

    return [
      `Period: ${summary.period}`,
      `Total: $${summary.totalAmount.toFixed(2)} ${summary.currency}`,
      table.toString(),
    ].join('\n');
  }
}
