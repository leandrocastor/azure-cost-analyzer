#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv } from 'node:process';

import CostsCommand from '@/cli/commands/costs';
import DashboardCommand from '@/cli/commands/dashboard';
import DetectCommand from '@/cli/commands/detect';
import RecommendCommand from '@/cli/commands/recommend';

type CommandConstructor = typeof CostsCommand | typeof DashboardCommand | typeof DetectCommand | typeof RecommendCommand;

const { version } = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };

const commands: Record<string, CommandConstructor> = {
  costs: CostsCommand,
  dashboard: DashboardCommand,
  detect: DetectCommand,
  recommend: RecommendCommand,
};

const helpText = `Azure Cost Analyzer v${version}

Usage: cost-analyzer <command> [options]

Commands:
  costs       Analyze Azure costs
  detect      Detect idle Azure resources
  recommend   Generate prioritized savings recommendations
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

  const command = commands[commandName];
  if (!command) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  await command.run(rest);
};

if (require.main === module) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Command failed');
    process.exitCode = 1;
  });
}
