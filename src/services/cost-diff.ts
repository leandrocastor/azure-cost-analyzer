import { readFile } from 'node:fs/promises';

import type { CostDelta, CostDiff, CostSummary, IdleResource } from '@/models';
import { CostDiffSchema } from '@/models';
import { ValidationError } from '@/utils/errors';

/**
 * Minimal shape read back from a previously generated report.
 */
export type ReportSnapshot = {
  generatedAt: string;
  subscriptionId: string;
  costs: CostSummary;
  idleResources: IdleResource[];
};

const EMBEDDED_DATA_PATTERN =
  /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/;

const MAX_BUCKET_ROWS = 12;

/**
 * Compares the current run against a previously generated report, answering the
 * question native Azure Cost Management does not: "what changed since last time,
 * and which service or resource group caused it?".
 */
export class CostDiffService {
  /**
   * Reads a snapshot from a previously generated HTML report or from a raw JSON
   * snapshot file. Accepting the HTML directly means users can diff against the
   * exact artifact they already keep, with no extra bookkeeping.
   */
  public async loadSnapshot(filePath: string): Promise<ReportSnapshot> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      throw new ValidationError(`Não foi possível ler o relatório anterior em "${filePath}".`);
    }

    const embedded = EMBEDDED_DATA_PATTERN.exec(raw);
    const payload = embedded?.[1] ?? raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ValidationError(
        `O arquivo "${filePath}" não é um relatório válido do Azure Cost Analyzer.`,
      );
    }

    return this.toSnapshot(parsed, filePath);
  }

  /**
   * Produces the delta between a previous snapshot and the current run.
   */
  public compare(previous: ReportSnapshot, current: ReportSnapshot): CostDiff {
    const totalDelta = current.costs.totalAmount - previous.costs.totalAmount;

    const previousIdleIds = new Set(previous.idleResources.map((idle) => idle.resource.id));
    const currentIdleIds = new Set(current.idleResources.map((idle) => idle.resource.id));

    const nameById = new Map<string, string>();
    for (const idle of [...previous.idleResources, ...current.idleResources]) {
      nameById.set(idle.resource.id, idle.resource.name);
    }

    return CostDiffSchema.parse({
      previousGeneratedAt: previous.generatedAt,
      previousPeriod: previous.costs.period,
      currentPeriod: current.costs.period,
      totalPrevious: Number(previous.costs.totalAmount.toFixed(2)),
      totalCurrent: Number(current.costs.totalAmount.toFixed(2)),
      totalDelta: Number(totalDelta.toFixed(2)),
      totalPercentChange: this.percentChange(previous.costs.totalAmount, current.costs.totalAmount),
      currency: current.costs.currency,
      byService: this.diffBuckets(previous.costs.byService, current.costs.byService),
      byResourceGroup: this.diffBuckets(previous.costs.byResourceGroup, current.costs.byResourceGroup),
      idleCountPrevious: previous.idleResources.length,
      idleCountCurrent: current.idleResources.length,
      newIdleResources: [...currentIdleIds]
        .filter((id) => !previousIdleIds.has(id))
        .map((id) => nameById.get(id) ?? id),
      resolvedIdleResources: [...previousIdleIds]
        .filter((id) => !currentIdleIds.has(id))
        .map((id) => nameById.get(id) ?? id),
    });
  }

  /**
   * Computes per-bucket deltas, keeping only the largest absolute movements so
   * the report highlights signal instead of listing every long-tail entry.
   */
  private diffBuckets(
    previous: Record<string, number>,
    current: Record<string, number>,
  ): CostDelta[] {
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);

    return [...keys]
      .map((key) => {
        const previousValue = previous[key] ?? 0;
        const currentValue = current[key] ?? 0;
        return {
          key,
          previous: Number(previousValue.toFixed(2)),
          current: Number(currentValue.toFixed(2)),
          delta: Number((currentValue - previousValue).toFixed(2)),
          percentChange: this.percentChange(previousValue, currentValue),
        };
      })
      .filter((entry) => entry.delta !== 0)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
      .slice(0, MAX_BUCKET_ROWS);
  }

  /**
   * Returns the relative change, or null when there is no baseline to divide by.
   */
  private percentChange(previous: number, current: number): number | null {
    if (previous === 0) {
      return null;
    }
    return Number((((current - previous) / previous) * 100).toFixed(2));
  }

  private toSnapshot(parsed: unknown, filePath: string): ReportSnapshot {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ValidationError(`O relatório anterior "${filePath}" está vazio ou corrompido.`);
    }

    const candidate = parsed as Partial<ReportSnapshot>;
    if (!candidate.costs || typeof candidate.costs.totalAmount !== 'number') {
      throw new ValidationError(
        `O relatório anterior "${filePath}" não contém dados de custo comparáveis.`,
      );
    }

    return {
      generatedAt: candidate.generatedAt ?? 'desconhecido',
      subscriptionId: candidate.subscriptionId ?? 'desconhecido',
      costs: candidate.costs,
      idleResources: Array.isArray(candidate.idleResources) ? candidate.idleResources : [],
    };
  }
}
