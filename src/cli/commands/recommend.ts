import { Command, Flags } from '@oclif/core';
import Table from 'cli-table3';

import { OptimizerService } from '@/services/optimizer';
import { ResourceDetectorService } from '@/services/resource-detector';

/**
 * Generates prioritized savings recommendations from detected idle resources.
 */
export default class RecommendCommand extends Command {
  public static override description = 'Generate optimization recommendations for Azure resources';

  public static override flags = {
    subscription: Flags.string({ char: 's', description: 'Azure subscription id override' }),
    'min-savings': Flags.integer({ description: 'Minimum monthly savings', min: 0, default: 0 }),
    'max-risk': Flags.string({
      description: 'Maximum recommendation risk',
      options: ['low', 'medium', 'high'],
      default: 'high',
    }),
    format: Flags.string({
      description: 'Output format',
      options: ['table', 'json', 'csv'],
      default: 'table',
    }),
    limit: Flags.integer({ description: 'Maximum recommendations returned', min: 1, default: 25 }),
  };

  /**
   * Executes the command.
   */
  public async run(): Promise<void> {
    const { flags } = await this.parse(RecommendCommand);
    const detector = new ResourceDetectorService(undefined, flags.subscription);
    const optimizer = new OptimizerService();
    const riskOrder: Record<'low' | 'medium' | 'high', number> = { low: 1, medium: 2, high: 3 };
    const idleResources = await detector.detectAll();
    const recommendations = (await optimizer.generateRecommendations(idleResources))
      .filter((item) => item.monthlySavings >= flags['min-savings'])
      .filter(
        (item) => riskOrder[item.risk] <= riskOrder[flags['max-risk'] as 'low' | 'medium' | 'high'],
      )
      .slice(0, flags.limit);

    this.log(this.render(recommendations, flags.format));
  }

  private render(
    recommendations: Awaited<ReturnType<OptimizerService['generateRecommendations']>>,
    format: string,
  ): string {
    const annualSavings = recommendations.reduce((sum, item) => sum + item.annualSavings, 0);

    if (format === 'json') {
      return JSON.stringify({ annualSavings, recommendations }, null, 2);
    }

    if (format === 'csv') {
      return [
        'title,actionType,monthlySavings,annualSavings,risk,effort,roi',
        ...recommendations.map((item) =>
          [
            item.title,
            item.actionType,
            item.monthlySavings,
            item.annualSavings,
            item.risk,
            item.effort,
            item.roi,
          ].join(','),
        ),
      ].join('\n');
    }

    const table = new Table({
      head: ['Title', 'Action', 'Monthly', 'Annual', 'Risk', 'Effort', 'ROI'],
      wordWrap: true,
    });
    for (const recommendation of recommendations) {
      table.push([
        recommendation.title,
        recommendation.actionType,
        `$${recommendation.monthlySavings.toFixed(2)}`,
        `$${recommendation.annualSavings.toFixed(2)}`,
        recommendation.risk,
        recommendation.effort,
        recommendation.roi,
      ]);
    }
    return [`Projected Annual Savings: $${annualSavings.toFixed(2)}`, table.toString()].join('\n');
  }
}
