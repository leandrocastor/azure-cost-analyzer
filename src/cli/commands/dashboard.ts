import { spawn } from 'node:child_process';

import { Command, Flags } from '@oclif/core';

import { startDashboardServer } from '@/dashboard/server';

const openUrl = async (url: string): Promise<void> => {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'start'
      : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
};

/**
 * Starts the dashboard HTTP server.
 */
export default class DashboardCommand extends Command {
  public static override description = 'Start the Azure Cost Analyzer dashboard server';

  public static override flags = {
    port: Flags.integer({ char: 'p', description: 'HTTP port to listen on' }),
    subscription: Flags.string({ char: 's', description: 'Azure subscription id override' }),
    open: Flags.boolean({ description: 'Open the dashboard in the default browser', default: false }),
  };

  /**
   * Executes the command.
   */
  public async run(): Promise<void> {
    const { flags } = await this.parse(DashboardCommand);
    const options = {
      ...(flags.port !== undefined ? { port: flags.port } : {}),
      ...(flags.subscription ? { subscriptionId: flags.subscription } : {}),
    };
    const server = await startDashboardServer(options);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : flags.port ?? 3000;
    const url = `http://localhost:${port}`;

    if (flags.open) {
      await openUrl(url);
    }

    this.log(`Dashboard available at ${url}`);
  }
}
