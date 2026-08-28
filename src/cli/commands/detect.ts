import { Command, Flags } from '@oclif/core';
import CliTable from 'cli-table3';
import ora from 'ora';

import { ResourceDetectorService } from '@/services/resource-detector';

type ResourceTypeFlag = 'all' | 'vm' | 'app-service' | 'storage' | 'sql' | 'disk' | 'ip' | 'lb';

/**
 * Detects idle Azure resources.
 */
export default class DetectCommand extends Command {
  public static override description = 'Detect idle Azure resources and estimate savings';

  public static override flags = {
    subscription: Flags.string({ char: 's', description: 'Azure subscription id override' }),
    'resource-type': Flags.string({
      description: 'Detector scope',
      options: ['all', 'vm', 'app-service', 'storage', 'sql', 'disk', 'ip', 'lb'],
      default: 'all',
    }),
    format: Flags.string({
      description: 'Output format',
      options: ['table', 'json', 'csv'],
      default: 'table',
    }),
    threshold: Flags.integer({
      description: 'Minimum idle score to include',
      min: 0,
      max: 100,
      default: 0,
    }),
  };

  /**
   * Executes the command.
   */
  public async run(): Promise<void> {
    const { flags } = await this.parse(DetectCommand);
    const detector = new ResourceDetectorService(undefined, flags.subscription);
    const spinner = ora('Detecting idle resources...').start();

    try {
      const detections = (
        await this.detect(detector, flags['resource-type'] as ResourceTypeFlag)
      ).filter((item) => item.idleScore >= flags.threshold);
      spinner.succeed(`Detected ${detections.length} idle resources`);
      this.log(this.render(detections, flags.format));
    } catch (error: unknown) {
      spinner.fail(error instanceof Error ? error.message : 'Detection failed');
      throw error;
    }
  }

  private async detect(
    detector: ResourceDetectorService,
    resourceType: ResourceTypeFlag,
  ): Promise<Awaited<ReturnType<ResourceDetectorService['detectAll']>>> {
    switch (resourceType) {
      case 'vm':
        return detector.detectIdleVMs();
      case 'app-service':
        return detector.detectIdleAppServices();
      case 'storage':
        return detector.detectIdleStorage();
      case 'sql':
        return detector.detectIdleSqlDatabases();
      case 'disk':
        return detector.detectUnattachedDisks();
      case 'ip':
        return detector.detectUnusedPublicIPs();
      case 'lb':
        return detector.detectUnusedLoadBalancers();
      case 'all':
      default:
        return detector.detectAll();
    }
  }

  private render(
    detections: Awaited<ReturnType<ResourceDetectorService['detectAll']>>,
    format: string,
  ): string {
    if (format === 'json') {
      return JSON.stringify(detections, null, 2);
    }

    if (format === 'csv') {
      return [
        'type,name,resourceGroup,idleScore,estimatedMonthlySavings,reason',
        ...detections.map((item) =>
          [
            item.resource.type,
            item.resource.name,
            item.resource.resourceGroup,
            item.idleScore,
            item.estimatedMonthlySavings,
            item.reason,
          ].join(','),
        ),
      ].join('\n');
    }

    const table = new CliTable({
      head: ['Type', 'Name', 'Resource Group', 'Idle Score', 'Savings', 'Reason'],
      wordWrap: true,
    });
    for (const detection of detections) {
      table.push([
        detection.resource.type,
        detection.resource.name,
        detection.resource.resourceGroup,
        detection.idleScore,
        `$${detection.estimatedMonthlySavings.toFixed(2)}`,
        detection.reason,
      ]);
    }
    return table.toString();
  }
}
