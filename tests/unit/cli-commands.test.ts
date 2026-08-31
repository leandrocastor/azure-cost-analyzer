import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { validEnv, mockCostSummary, mockIdleResources, mockRecommendations } from '../fixtures/mock-data';

const spinner = {
  start: vi.fn(() => spinner),
  succeed: vi.fn(),
  fail: vi.fn(),
};

const spawnMock = vi.hoisted(() => vi.fn(() => {
  const emitter = new EventEmitter();
  setImmediate(() => emitter.emit('exit', 0));
  return emitter;
}));

const azureClientMock = vi.hoisted(() => ({
  getSubscriptionId: vi.fn((value?: string) => value ?? validEnv.AZURE_SUBSCRIPTION_ID),
  getConfiguredSubscriptionId: vi.fn(() => validEnv.AZURE_SUBSCRIPTION_ID),
  getCredential: vi.fn(() => ({})),
  listAccessibleSubscriptions: vi.fn(async () => [
    { id: 'sub-a', displayName: 'Subscription A' },
    { id: 'sub-b', displayName: 'Subscription B' },
  ]),
}));
const costAnalyzerMock = vi.hoisted(() => ({
  queryCosts: vi.fn(async () => mockCostSummary),
  queryResourceCosts: vi.fn(async () => ({ currency: mockCostSummary.currency, months: [], resources: {} })),
  getCostsByPeriod: vi.fn(async () => []),
  detectAnomalies: vi.fn(() => []),
}));
const resourceGraphMock = vi.hoisted(() => ({
  getCreationTimes: vi.fn(async () => new Map()),
}));
const resourceDetectorMock = vi.hoisted(() => ({
  detectAll: vi.fn(async () => mockIdleResources),
  getInventory: vi.fn(() => mockIdleResources.map((item) => item.resource)),
  detectIdleVMs: vi.fn(async () => mockIdleResources.slice(0, 1)),
  detectIdleAppServices: vi.fn(async () => mockIdleResources.slice(0, 1)),
  detectIdleAppServicePlans: vi.fn(async () => mockIdleResources.slice(0, 1)),
  detectIdleStorage: vi.fn(async () => mockIdleResources.slice(1)),
  detectIdleSqlDatabases: vi.fn(async () => mockIdleResources.slice(0, 1)),
  detectUnattachedDisks: vi.fn(async () => mockIdleResources.slice(0, 1)),
  detectUnusedPublicIPs: vi.fn(async () => mockIdleResources.slice(0, 1)),
  detectUnusedLoadBalancers: vi.fn(async () => mockIdleResources.slice(0, 1)),
}));
const optimizerMock = vi.hoisted(() => ({
  generateRecommendations: vi.fn(async () => mockRecommendations),
}));
const startDashboardServerMock = vi.hoisted(() =>
  vi.fn(async () => ({ address: () => ({ port: 4321 }) })),
);

vi.mock('ora', () => ({ default: vi.fn(() => spinner) }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('@/services/azure-client', () => ({
  AzureClientService: vi.fn(function () {
    return azureClientMock;
  }),
}));
vi.mock('@/services/cost-analyzer', () => ({
  CostAnalyzerService: vi.fn(function () {
    return costAnalyzerMock;
  }),
}));
vi.mock('@/services/resource-detector', () => ({
  ResourceDetectorService: vi.fn(function () {
    return resourceDetectorMock;
  }),
}));
vi.mock('@/services/optimizer', () => ({
  OptimizerService: vi.fn(function () {
    return optimizerMock;
  }),
}));
vi.mock('@/services/resource-graph', () => ({
  ResourceGraphService: vi.fn(function () {
    return resourceGraphMock;
  }),
}));
vi.mock('@/dashboard/server', () => ({
  startDashboardServer: startDashboardServerMock,
}));

import CostsCommand from '@/cli/commands/costs';
import DashboardCommand from '@/cli/commands/dashboard';
import DetectCommand from '@/cli/commands/detect';
import ExportCommand from '@/cli/commands/export';
import RecommendCommand from '@/cli/commands/recommend';

const outputPath = path.resolve(__dirname, '../fixtures/cost-command-output.csv');
const reportOutputPath = path.resolve(__dirname, '../fixtures/report-command-output.html');
const remediationScriptPath = path.resolve(__dirname, '../fixtures/apply-remediation.sh');

describe('CLI command classes', () => {
  beforeEach(() => {
    process.env = { ...process.env, ...validEnv };
    spinner.start.mockClear();
    spinner.succeed.mockClear();
    spinner.fail.mockClear();
    spawnMock.mockClear();
    azureClientMock.getSubscriptionId.mockClear();
    azureClientMock.getConfiguredSubscriptionId.mockClear();
    azureClientMock.listAccessibleSubscriptions.mockClear();
    costAnalyzerMock.queryCosts.mockClear();
    costAnalyzerMock.getCostsByPeriod.mockClear();
    costAnalyzerMock.detectAnomalies.mockClear();
    resourceDetectorMock.detectAll.mockClear();
    resourceDetectorMock.getInventory.mockClear();
    resourceDetectorMock.detectIdleVMs.mockClear();
    resourceDetectorMock.detectIdleAppServices.mockClear();
    resourceDetectorMock.detectIdleAppServicePlans.mockClear();
    resourceDetectorMock.detectIdleStorage.mockClear();
    resourceDetectorMock.detectIdleSqlDatabases.mockClear();
    resourceDetectorMock.detectUnattachedDisks.mockClear();
    resourceDetectorMock.detectUnusedPublicIPs.mockClear();
    resourceDetectorMock.detectUnusedLoadBalancers.mockClear();
    optimizerMock.generateRecommendations.mockClear();
    startDashboardServerMock.mockClear();

    // Some tests replace these implementations to simulate Azure throttling; restore
    // the defaults so they do not leak into subsequent tests.
    azureClientMock.getConfiguredSubscriptionId.mockReturnValue(validEnv.AZURE_SUBSCRIPTION_ID);
    azureClientMock.listAccessibleSubscriptions.mockResolvedValue([
      { id: 'sub-a', displayName: 'Subscription A' },
      { id: 'sub-b', displayName: 'Subscription B' },
    ]);
    costAnalyzerMock.queryCosts.mockResolvedValue(mockCostSummary);
    costAnalyzerMock.getCostsByPeriod.mockResolvedValue([]);
    costAnalyzerMock.detectAnomalies.mockReturnValue([]);
    resourceDetectorMock.detectAll.mockResolvedValue(mockIdleResources);
    optimizerMock.generateRecommendations.mockResolvedValue(mockRecommendations);
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }
    if (existsSync(reportOutputPath)) {
      unlinkSync(reportOutputPath);
    }
    if (existsSync(remediationScriptPath)) {
      unlinkSync(remediationScriptPath);
    }
  });

  afterAll(() => {
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }
    if (existsSync(reportOutputPath)) {
      unlinkSync(reportOutputPath);
    }
    if (existsSync(remediationScriptPath)) {
      unlinkSync(remediationScriptPath);
    }
  });

  it('renders costs in table format', async () => {
    const logSpy = vi.spyOn(CostsCommand.prototype, 'log').mockImplementation(() => undefined);
    await CostsCommand.run(['--period', '3']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Total: $1105.00 USD'));
    logSpy.mockRestore();
  });

  it('renders costs in json format', async () => {
    const logSpy = vi.spyOn(CostsCommand.prototype, 'log').mockImplementation(() => undefined);
    await CostsCommand.run(['--format', 'json']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"totalAmount": 1105'));
    logSpy.mockRestore();
  });

  it('renders costs in csv format and writes output file', async () => {
    const logSpy = vi.spyOn(CostsCommand.prototype, 'log').mockImplementation(() => undefined);
    await CostsCommand.run(['--format', 'csv', '--output', outputPath]);
    expect(readFileSync(outputPath, 'utf8')).toContain('dimension,name,amount');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('service,Compute,205'));
    logSpy.mockRestore();
  });

  it.each([
    ['all', 'detectAll'],
    ['vm', 'detectIdleVMs'],
    ['app-service', 'detectIdleAppServices'],
    ['app-service-plan', 'detectIdleAppServicePlans'],
    ['storage', 'detectIdleStorage'],
    ['sql', 'detectIdleSqlDatabases'],
    ['disk', 'detectUnattachedDisks'],
    ['ip', 'detectUnusedPublicIPs'],
    ['lb', 'detectUnusedLoadBalancers'],
  ])('dispatches detect command for %s', async (resourceType, methodName) => {
    const logSpy = vi.spyOn(DetectCommand.prototype, 'log').mockImplementation(() => undefined);
    await DetectCommand.run(['--resource-type', resourceType]);
    expect(resourceDetectorMock[methodName as keyof typeof resourceDetectorMock]).toHaveBeenCalled();
    expect(spinner.succeed).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('renders detect command as json', async () => {
    const logSpy = vi.spyOn(DetectCommand.prototype, 'log').mockImplementation(() => undefined);
    await DetectCommand.run(['--format', 'json']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('estimatedMonthlySavings'));
    logSpy.mockRestore();
  });

  it('renders detect command as csv', async () => {
    const logSpy = vi.spyOn(DetectCommand.prototype, 'log').mockImplementation(() => undefined);
    await DetectCommand.run(['--format', 'csv']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('type,name,resourceGroup'));
    logSpy.mockRestore();
  });

  it('reports detect failures through spinner', async () => {
    resourceDetectorMock.detectAll.mockRejectedValueOnce(new Error('detect failed'));
    await expect(DetectCommand.run([])).rejects.toThrow('detect failed');
    expect(spinner.fail).toHaveBeenCalledWith('detect failed');
  });

  it('filters and renders recommendations as table', async () => {
    const logSpy = vi.spyOn(RecommendCommand.prototype, 'log').mockImplementation(() => undefined);
    await RecommendCommand.run(['--min-savings', '100', '--max-risk', 'low']);
    expect(optimizerMock.generateRecommendations).toHaveBeenCalledWith(mockIdleResources);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Projected Annual Savings: $2160.00'));
    logSpy.mockRestore();
  });

  it('renders recommendations as json', async () => {
    const logSpy = vi.spyOn(RecommendCommand.prototype, 'log').mockImplementation(() => undefined);
    await RecommendCommand.run(['--format', 'json']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"annualSavings": 2160'));
    logSpy.mockRestore();
  });

  it('renders recommendations as csv', async () => {
    const logSpy = vi.spyOn(RecommendCommand.prototype, 'log').mockImplementation(() => undefined);
    await RecommendCommand.run(['--format', 'csv']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('title,actionType,monthlySavings'));
    logSpy.mockRestore();
  });

  it('starts the dashboard server without opening a browser', async () => {
    const logSpy = vi.spyOn(DashboardCommand.prototype, 'log').mockImplementation(() => undefined);
    await DashboardCommand.run(['--port', '4000']);
    expect(startDashboardServerMock).toHaveBeenCalledWith({ port: 4000 });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Dashboard available at http://localhost:4321');
    logSpy.mockRestore();
  });

  it('opens the dashboard in a browser when requested', async () => {
    const logSpy = vi.spyOn(DashboardCommand.prototype, 'log').mockImplementation(() => undefined);
    await DashboardCommand.run(['--subscription', 'sub-2', '--open']);
    expect(startDashboardServerMock).toHaveBeenCalledWith({ subscriptionId: 'sub-2' });
    expect(spawnMock).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Dashboard available at http://localhost:4321');
    logSpy.mockRestore();
  });

  it('generates a static HTML report with embedded data', async () => {
    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3']);
    expect(costAnalyzerMock.queryCosts).toHaveBeenCalledWith(
      'sub-3',
      expect.any(String),
      expect.any(String),
      'service',
    );
    expect(resourceDetectorMock.detectAll).toHaveBeenCalled();
    expect(optimizerMock.generateRecommendations).toHaveBeenCalledWith(mockIdleResources);
    expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining(reportOutputPath));

    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('"subscriptionId":"sub-3"');
  });

  it('reports export failures through spinner', async () => {
    azureClientMock.getConfiguredSubscriptionId.mockReturnValueOnce(undefined);
    azureClientMock.listAccessibleSubscriptions.mockRejectedValueOnce(new Error('export failed'));
    await expect(ExportCommand.run(['--output', reportOutputPath])).rejects.toThrow('export failed');
    expect(spinner.fail).toHaveBeenCalledWith('export failed');
  });

  it('analyzes every accessible subscription when none is configured or passed', async () => {
    azureClientMock.getConfiguredSubscriptionId.mockReturnValueOnce(undefined);
    await ExportCommand.run(['--output', reportOutputPath]);
    expect(azureClientMock.listAccessibleSubscriptions).toHaveBeenCalledOnce();
    expect(costAnalyzerMock.queryCosts).toHaveBeenCalledWith('sub-a', expect.any(String), expect.any(String), 'service');
    expect(costAnalyzerMock.queryCosts).toHaveBeenCalledWith('sub-b', expect.any(String), expect.any(String), 'service');
    expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining('2 subscriptions analyzed'));

    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('2 subscriptions: Subscription A, Subscription B');
  });

  it('still generates a report when one subscription is throttled', async () => {
    azureClientMock.getConfiguredSubscriptionId.mockReturnValueOnce(undefined);
    costAnalyzerMock.queryCosts.mockRejectedValueOnce(new Error('Too many requests. Please retry.'));
    const warnSpy = vi.spyOn(ExportCommand.prototype, 'warn').mockImplementation(((message: string) => message) as never);

    await ExportCommand.run(['--output', reportOutputPath]);

    expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining('2 subscriptions analyzed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Custos indisponíveis para "Subscription A"'));

    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('Too many requests. Please retry.');
    warnSpy.mockRestore();
  });

  it('writes an executable remediation script alongside the report', async () => {
    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3']);

    expect(existsSync(remediationScriptPath)).toBe(true);
    const script = readFileSync(remediationScriptPath, 'utf8');
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('APPLY="${APPLY:-false}"');

    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('"remediationPlans"');
    expect(html).toContain('Plano de Remediação');
  });

  it('skips the remediation plan when --no-remediation is passed', async () => {
    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3', '--no-remediation']);

    expect(existsSync(remediationScriptPath)).toBe(false);
    expect(readFileSync(reportOutputPath, 'utf8')).toContain('"remediationPlans":[]');
  });

  it('embeds the executive summary and the ownership breakdown', async () => {
    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3']);
    const html = readFileSync(reportOutputPath, 'utf8');

    expect(html).toContain('"executiveSummary"');
    expect(html).toContain('"generatedBy":"heuristic"');
    expect(html).toContain('"ownership"');
    expect(html).toContain('Desperdício por Responsável');
  });

  it('attributes waste using the tag keys given by --owner-tags', async () => {
    resourceDetectorMock.detectAll.mockResolvedValueOnce([
      {
        ...mockIdleResources[0],
        resource: { ...mockIdleResources[0].resource, tags: { responsavel: 'time-infra' } },
      },
    ]);

    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3', '--owner-tags', 'responsavel']);

    expect(readFileSync(reportOutputPath, 'utf8')).toContain('"owner":"time-infra"');
  });

  it('compares against a previously generated report', async () => {
    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3']);
    const baseline = path.resolve(__dirname, '../fixtures/report-baseline.html');
    writeFileSync(baseline, readFileSync(reportOutputPath, 'utf8'), 'utf8');

    costAnalyzerMock.queryCosts.mockResolvedValueOnce({ ...mockCostSummary, totalAmount: 1305 });
    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3', '--compare', baseline]);

    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('"totalDelta":200');
    expect(html).toContain('Comparativo com a Execução Anterior');
    unlinkSync(baseline);
  });

  it('degrades to a warning when the comparison baseline cannot be read', async () => {
    const warnSpy = vi.spyOn(ExportCommand.prototype, 'warn').mockImplementation(((message: string) => message) as never);

    await ExportCommand.run(['--output', reportOutputPath, '--subscription', 'sub-3', '--compare', '/tmp/nope-123.html']);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Comparativo indisponível'));
    expect(existsSync(reportOutputPath)).toBe(true);
    warnSpy.mockRestore();
  });

  it('fails only when no subscription yields any data', async () => {
    azureClientMock.getConfiguredSubscriptionId.mockReturnValueOnce(undefined);
    costAnalyzerMock.queryCosts.mockRejectedValue(new Error('Too many requests. Please retry.'));
    resourceDetectorMock.detectAll.mockRejectedValue(new Error('Too many requests. Please retry.'));

    await expect(ExportCommand.run(['--output', reportOutputPath])).rejects.toThrow(
      'No data could be collected from any subscription',
    );
  });
});
