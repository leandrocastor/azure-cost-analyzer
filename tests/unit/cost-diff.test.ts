import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateStaticReport } from '@/dashboard/report';
import { CostDiffService, type ReportSnapshot } from '@/services/cost-diff';
import { ValidationError } from '@/utils/errors';
import { mockCostSummary, mockIdleResources } from '../fixtures/mock-data';

const snapshot = (overrides: Partial<ReportSnapshot> = {}): ReportSnapshot => ({
  generatedAt: '2026-01-01T00:00:00.000Z',
  subscriptionId: 'sub-id',
  costs: mockCostSummary,
  idleResources: mockIdleResources,
  ...overrides,
});

describe('CostDiffService', () => {
  const service = new CostDiffService();

  it('computes the total delta and percentage change', () => {
    const diff = service.compare(
      snapshot(),
      snapshot({ costs: { ...mockCostSummary, totalAmount: 1326 } }),
    );

    expect(diff.totalPrevious).toBe(1105);
    expect(diff.totalCurrent).toBe(1326);
    expect(diff.totalDelta).toBe(221);
    expect(diff.totalPercentChange).toBe(20);
  });

  it('returns a null percentage change when there is no baseline value', () => {
    const diff = service.compare(
      snapshot({ costs: { ...mockCostSummary, totalAmount: 0 } }),
      snapshot({ costs: { ...mockCostSummary, totalAmount: 500 } }),
    );

    expect(diff.totalPercentChange).toBeNull();
  });

  it('ranks bucket deltas by absolute movement and drops unchanged entries', () => {
    const diff = service.compare(
      snapshot(),
      snapshot({
        costs: {
          ...mockCostSummary,
          byService: { Compute: 205, Storage: 400, Database: 800 },
        },
      }),
    );

    expect(diff.byService.map((entry) => entry.key)).toEqual(['Storage', 'Database']);
    expect(diff.byService[0]?.delta).toBe(270);
    expect(diff.byService[1]?.delta).toBe(30);
  });

  it('identifies new and resolved idle resources by resource id', () => {
    const diff = service.compare(
      snapshot({ idleResources: [mockIdleResources[0]!] }),
      snapshot({ idleResources: [mockIdleResources[1]!] }),
    );

    expect(diff.newIdleResources).toEqual(['storea']);
    expect(diff.resolvedIdleResources).toEqual(['vm-a']);
  });

  it('loads a snapshot back from a generated HTML report', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aca-diff-'));
    const file = path.join(directory, 'report.html');
    await writeFile(
      file,
      generateStaticReport({
        generatedAt: '2026-01-01T00:00:00.000Z',
        subscriptionId: 'sub-id',
        costs: mockCostSummary,
        idleResources: mockIdleResources,
        recommendations: [],
      }),
      'utf8',
    );

    const loaded = await service.loadSnapshot(file);

    expect(loaded.costs.totalAmount).toBe(1105);
    expect(loaded.idleResources).toHaveLength(mockIdleResources.length);
    expect(loaded.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('loads a snapshot from a raw JSON file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aca-diff-'));
    const file = path.join(directory, 'snapshot.json');
    await writeFile(file, JSON.stringify(snapshot()), 'utf8');

    const loaded = await service.loadSnapshot(file);

    expect(loaded.costs.totalAmount).toBe(1105);
  });

  it('rejects a missing file with a clear message', async () => {
    await expect(service.loadSnapshot('/tmp/does-not-exist-42.html')).rejects.toThrow(ValidationError);
  });

  it('rejects a file that is not a valid report', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aca-diff-'));
    const file = path.join(directory, 'garbage.html');
    await writeFile(file, '<html><body>não é um relatório</body></html>', 'utf8');

    await expect(service.loadSnapshot(file)).rejects.toThrow(ValidationError);
  });

  it('rejects a report without comparable cost data', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aca-diff-'));
    const file = path.join(directory, 'partial.json');
    await writeFile(file, JSON.stringify({ generatedAt: 'x' }), 'utf8');

    await expect(service.loadSnapshot(file)).rejects.toThrow(/dados de custo compar/i);
  });
});
