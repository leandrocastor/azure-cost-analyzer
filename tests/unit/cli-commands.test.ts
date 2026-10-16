import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { validEnv, mockCostSummary, mockIdleResources, mockRecommendations } from '../fixtures/mock-data';
import { generateStaticReport } from '@/dashboard/report';

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
  queryCostsByTag: vi.fn(async () => []),
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
const previousReportPath = path.resolve(__dirname, '../fixtures/previous-report-command-output.html');
const remediationScriptPath = path.resolve(__dirname, '../fixtures/apply-remediation.sh');
const businessMetricsPath = path.resolve(__dirname, '../fixtures/business-metrics-command-input.csv');
const initiativesPath = path.resolve(__dirname, '../fixtures/initiative-ledger-command-input.json');

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
    costAnalyzerMock.queryResourceCosts.mockClear();
    costAnalyzerMock.queryCostsByTag.mockClear();
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
    costAnalyzerMock.queryResourceCosts.mockResolvedValue({
      currency: mockCostSummary.currency,
      months: [],
      resources: {},
    });
    costAnalyzerMock.queryCostsByTag.mockResolvedValue([]);
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
    if (existsSync(previousReportPath)) {
      unlinkSync(previousReportPath);
    }
    if (existsSync(businessMetricsPath)) unlinkSync(businessMetricsPath);
    if (existsSync(initiativesPath)) unlinkSync(initiativesPath);
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
    if (existsSync(previousReportPath)) {
      unlinkSync(previousReportPath);
    }
    if (existsSync(businessMetricsPath)) unlinkSync(businessMetricsPath);
    if (existsSync(initiativesPath)) unlinkSync(initiativesPath);
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
    expect(html).toContain('"cashCapture"');
    expect(html).toContain('Plano de Captura de Caixa');
  });

  it('queries monthly billing by business tag and embeds outcome efficiency in the report', async () => {
    const monthAtOffset = (offset: number): string => {
      const date = new Date();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - offset);
      return date.toISOString().slice(0, 7);
    };
    const currentMonth = monthAtOffset(0);
    const settledCandidates = [monthAtOffset(1), monthAtOffset(2)];
    const now = new Date();
    const settledMonth = now.getUTCDate() <= 7 ? settledCandidates[1]! : settledCandidates[0]!;
    const previousDate = new Date(`${settledMonth}-01T00:00:00.000Z`);
    previousDate.setUTCMonth(previousDate.getUTCMonth() - 1);
    const previousMonth = previousDate.toISOString().slice(0, 7);
    writeFileSync(businessMetricsPath, [
      'period,tag_key,tag_value,unit,quantity',
      `${previousMonth},app,checkout,orders,100`,
      `${settledMonth},app,checkout,orders,120`,
      `${currentMonth},app,checkout,orders,130`,
    ].join('\n'));
    costAnalyzerMock.queryCostsByTag.mockResolvedValue([
      { period: previousMonth, tagValue: 'checkout', amount: 100, currency: 'USD' },
      { period: settledMonth, tagValue: 'checkout', amount: 150, currency: 'USD' },
    ]);

    await ExportCommand.run([
      '--output', reportOutputPath,
      '--period', '4',
      '--business-metrics', businessMetricsPath,
    ]);

    expect(costAnalyzerMock.queryCostsByTag).toHaveBeenCalledTimes(2);
    expect(costAnalyzerMock.queryCostsByTag).toHaveBeenCalledWith(
      'sub-a', expect.any(String), expect.any(String), 'app', ['checkout'],
    );
    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('"businessOutcomeLedger"');
    expect(html).toContain('"efficiencyGap":60');
    expect(html).toContain('Eficiência de Custo por Resultado');
  });

  it('queries per-resource billing for registered initiatives and embeds their outcome ledger', async () => {
    const monthAtOffset = (offset: number): string => {
      const date = new Date();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - offset);
      return date.toISOString().slice(0, 7);
    };
    const now = new Date();
    const settledMonth = monthAtOffset(now.getUTCDate() <= 7 ? 2 : 1);
    const appliedMonth = monthAtOffset(3);
    const baselineMonth = monthAtOffset(4);
    const sourceId = '/subscriptions/sub-a/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/old';
    const destinationId = '/subscriptions/sub-a/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/new';
    writeFileSync(businessMetricsPath, [
      'period,tag_key,tag_value,unit,quantity',
      `${baselineMonth},app,checkout,orders,100`,
      `${settledMonth},app,checkout,orders,120`,
    ].join('\n'));
    writeFileSync(initiativesPath, JSON.stringify({ initiatives: [{
      id: 'move-checkout',
      appliedMonth,
      description: 'Move checkout workload',
      recommendationId: 'rec-42',
      sourceResourceIds: [sourceId],
      destinationResourceIds: [destinationId],
      tagKey: 'app',
      tagValue: 'checkout',
      unit: 'orders',
    }] }));
    resourceDetectorMock.detectAll.mockResolvedValueOnce([]);
    costAnalyzerMock.queryCostsByTag.mockResolvedValueOnce([
      { period: baselineMonth, tagValue: 'checkout', amount: 500, currency: 'USD' },
      { period: settledMonth, tagValue: 'checkout', amount: 700, currency: 'USD' },
    ]);
    costAnalyzerMock.queryResourceCosts.mockResolvedValueOnce({
      currency: 'USD',
      months: [baselineMonth, settledMonth],
      coveredMonths: [baselineMonth, settledMonth],
      resources: {
        [sourceId.toLowerCase()]: { [baselineMonth]: 200, [settledMonth]: 0 },
        [destinationId.toLowerCase()]: { [baselineMonth]: 0, [settledMonth]: 100 },
      },
    });

    await ExportCommand.run([
      '--output', reportOutputPath,
      '--subscription', 'sub-a',
      '--period', '6',
      '--business-metrics', businessMetricsPath,
      '--initiatives', initiativesPath,
    ]);

    expect(costAnalyzerMock.queryResourceCosts).toHaveBeenCalledWith(
      'sub-a', expect.any(String), expect.any(String),
    );
    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('"initiativeLedger"');
    expect(html).toContain('"status":"improved"');
    expect(html).toContain('"netSpendReduction":100');
    expect(html).toContain('"evidenceIntegrity"');
    expect(html).toContain('"comparableCount":1');
    expect(html).toContain('Ledger de Iniciativas');
  });

  it('rejects an invalid business metrics CSV before contacting Azure', async () => {
    writeFileSync(businessMetricsPath, 'period,tag_key,tag_value,unit,quantity\n2026-09,app,checkout,orders,-1');
    await expect(ExportCommand.run([
      '--output', reportOutputPath,
      '--business-metrics', businessMetricsPath,
    ])).rejects.toThrow('CSV line 2: invalid month, tag, unit, or non-negative numeric quantity.');
    expect(azureClientMock.listAccessibleSubscriptions).not.toHaveBeenCalled();
  });

  it('requires business metrics for an initiative manifest before contacting Azure', async () => {
    writeFileSync(initiativesPath, JSON.stringify({ initiatives: [{
      id: 'resize-api',
      appliedMonth: '2026-07',
      description: 'Move API workload',
      sourceResourceIds: ['/subscriptions/sub-a/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/old'],
      destinationResourceIds: ['/subscriptions/sub-a/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/new'],
      tagKey: 'app',
      tagValue: 'api',
      unit: 'requests',
    }] }));

    await expect(ExportCommand.run([
      '--output', reportOutputPath,
      '--initiatives', initiativesPath,
    ])).rejects.toThrow('--initiatives requires --business-metrics');
    expect(azureClientMock.listAccessibleSubscriptions).not.toHaveBeenCalled();
  });

  it('reports export failures through spinner', async () => {
    azureClientMock.getConfiguredSubscriptionId.mockReturnValueOnce(undefined);
    azureClientMock.listAccessibleSubscriptions.mockRejectedValueOnce(new Error('export failed'));
    await expect(ExportCommand.run(['--output', reportOutputPath])).rejects.toThrow('export failed');
    expect(spinner.fail).toHaveBeenCalledWith('export failed');
  });

  it('analyzes every accessible subscription when no flag is passed', async () => {
    await ExportCommand.run(['--output', reportOutputPath]);
    expect(azureClientMock.listAccessibleSubscriptions).toHaveBeenCalledOnce();
    expect(costAnalyzerMock.queryCosts).toHaveBeenCalledWith('sub-a', expect.any(String), expect.any(String), 'service');
    expect(costAnalyzerMock.queryCosts).toHaveBeenCalledWith('sub-b', expect.any(String), expect.any(String), 'service');
    expect(spinner.succeed).toHaveBeenCalledWith(expect.stringContaining('2 subscriptions analyzed'));

    const html = readFileSync(reportOutputPath, 'utf8');
    expect(html).toContain('2 subscriptions: Subscription A, Subscription B');
  });

  it('still generates a report when one subscription is throttled', async () => {
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

  it('queries per-resource billing for previously flagged subscriptions to measure resolved findings', async () => {
    const previousFinding = {
      ...mockIdleResources[0]!,
      resource: {
        ...mockIdleResources[0]!.resource,
        id: '/subscriptions/sub-a/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-a',
      },
      evidence: {
        observationWindowDays: 30,
        dataPoints: 30,
        metrics: [],
        savingsBasis: 'observed-cost' as const,
        savingsBasisDetail: 'Custo observado na fatura.',
        confidence: 'high' as const,
        billed: {
          observedTotal: 100,
          currency: 'USD',
          monthly: { '2026-05': 100 },
          lastMonthWithCost: '2026-05',
          latestMonth: '2026-06',
          billingStopped: false,
          coveredMonths: ['2026-05', '2026-06'],
        },
      },
    };
    writeFileSync(
      previousReportPath,
      generateStaticReport({
        generatedAt: '2026-06-15T12:00:00.000Z',
        subscriptionId: 'sub-a',
        costs: mockCostSummary,
        idleResources: [previousFinding],
        recommendations: [],
      }),
    );
    resourceDetectorMock.detectAll.mockResolvedValue([]);

    await ExportCommand.run([
      '--output',
      reportOutputPath,
      '--subscription',
      'sub-a',
      '--compare',
      previousReportPath,
      '--period',
      '3',
    ]);

    expect(costAnalyzerMock.queryResourceCosts).toHaveBeenCalledTimes(1);
    expect(costAnalyzerMock.queryResourceCosts).toHaveBeenCalledWith(
      'sub-a',
      expect.any(String),
      expect.any(String),
    );
    expect(readFileSync(reportOutputPath, 'utf8')).toContain('"status":"awaiting_period"');
  });
});
