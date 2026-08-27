const mocks = vi.hoisted(() => ({
  costsRun: vi.fn(async () => undefined),
  detectRun: vi.fn(async () => undefined),
  recommendRun: vi.fn(async () => undefined),
  dashboardRun: vi.fn(async () => undefined),
}));

vi.mock('@/cli/commands/costs', () => ({ default: { run: mocks.costsRun } }));
vi.mock('@/cli/commands/detect', () => ({ default: { run: mocks.detectRun } }));
vi.mock('@/cli/commands/recommend', () => ({ default: { run: mocks.recommendRun } }));
vi.mock('@/cli/commands/dashboard', () => ({ default: { run: mocks.dashboardRun } }));

import { runCli } from '@/cli/index';

describe('CLI dispatcher', () => {
  beforeEach(() => {
    mocks.costsRun.mockClear();
    mocks.detectRun.mockClear();
    mocks.recommendRun.mockClear();
    mocks.dashboardRun.mockClear();
  });

  it('prints help when no command is provided', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCli([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Azure Cost Analyzer'));
    consoleSpy.mockRestore();
  });

  it.each([
    ['costs', mocks.costsRun],
    ['detect', mocks.detectRun],
    ['recommend', mocks.recommendRun],
    ['dashboard', mocks.dashboardRun],
  ])('dispatches %s command', async (command, spy) => {
    await runCli([command, '--flag']);
    expect(spy).toHaveBeenCalledWith(['--flag']);
  });

  it.each(['--help', '-h'])('prints help for %s', async (flag) => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCli([flag]);
    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it.each(['--version', '-v'])('prints version for %s', async (flag) => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCli([flag]);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+$/));
    consoleSpy.mockRestore();
  });

  it('throws for unknown commands', async () => {
    await expect(runCli(['missing'])).rejects.toThrow('Unknown command: missing');
  });

  it('preserves trailing args for commands', async () => {
    await runCli(['costs', '--period', '6']);
    expect(mocks.costsRun).toHaveBeenCalledWith(['--period', '6']);
  });

  it('routes repeated calls independently', async () => {
    await runCli(['detect']);
    await runCli(['recommend']);
    expect(mocks.detectRun).toHaveBeenCalledOnce();
    expect(mocks.recommendRun).toHaveBeenCalledOnce();
  });
});
