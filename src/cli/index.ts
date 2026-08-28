#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv } from 'node:process';

import CostsCommand from '@/cli/commands/costs';
import DashboardCommand from '@/cli/commands/dashboard';
import DetectCommand from '@/cli/commands/detect';
import RecommendCommand from '@/cli/commands/recommend';

type CommandConstructor = typeof CostsCommand | typeof DashboardCommand | typeof DetectCommand | typeof RecommendCommand;
class CliUsageError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = exitCode;
  }
}

const { version } = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };

const commands: Record<string, CommandConstructor> = {
  costs: CostsCommand,
  dashboard: DashboardCommand,
  detect: DetectCommand,
  recommend: RecommendCommand,
};
const aliases: Record<string, keyof typeof commands> = {
  analyze: 'costs',
  'idle-resources': 'detect',
  'optimize-suggestions': 'recommend',
  export: 'costs',
};

const helpText = `Azure Cost Analyzer v${version}

Usage: cost-analyzer <command> [options]

Commands:
  costs       Analyze Azure costs
  detect      Detect idle Azure resources
  recommend   Generate prioritized savings recommendations
  analyze     Alias for costs
  idle-resources         Alias for detect
  optimize-suggestions   Alias for recommend
  export      Export cost analysis (requires --output)
  dashboard   Start the dashboard server

Options:
  --help, -h      Show this help message
  --version, -v   Show version number`;

/**
 * Runs the CLI dispatcher.
 */
export const runCli = async (input: string[] = argv.slice(2)): Promise<void> => {
  const [commandName, ...rest] = input;

  if (commandName === '--version' || commandName === '-v') {
    console.log(version);
    return;
  }

  if (!commandName || commandName === '--help' || commandName === '-h') {
    console.log(helpText);
    return;
  }

  const resolvedCommandName = aliases[commandName] ?? commandName;
  const command = commands[resolvedCommandName];
  if (!command) {
    throw new CliUsageError(`Unknown command: ${commandName}\n\n${helpText}`);
  }

  const commandArgs = [...rest];
  if (commandName === 'export') {
    if (!commandArgs.includes('--output')) {
      throw new CliUsageError('The export command requires --output <path>');
    }
    if (!commandArgs.includes('--format')) {
      commandArgs.unshift('--format', 'csv');
    }
  }

  await command.run(commandArgs);
};

if (require.main === module) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Command failed');
    process.exitCode = error instanceof CliUsageError ? error.exitCode : 1;
  });
}
