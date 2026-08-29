import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { OptimizerService } from '@/services/optimizer';
import { RemediationService } from '@/services/remediation';
import type { Recommendation } from '@/models';
import { mockIdleResources } from '../fixtures/mock-data';

const buildRecommendations = async (): Promise<Recommendation[]> =>
  new OptimizerService().generateRecommendations(mockIdleResources);

const recommendationFor = (
  overrides: Partial<Recommendation> = {},
): Recommendation => ({
  id: 'rec-1',
  type: 'Microsoft.Compute/virtualMachines',
  resourceId:
    '/subscriptions/sub-1/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a',
  title: 'Optimize vm-a',
  description: 'ociosa',
  monthlySavings: 150,
  annualSavings: 1800,
  risk: 'low',
  effort: 'low',
  roi: 12,
  actionType: 'DOWNSIZE',
  status: 'new',
  ...overrides,
});

describe('RemediationService', () => {
  const service = new RemediationService();

  it('builds one plan per recommendation with pre-checks, apply and rollback steps', async () => {
    const plans = service.buildPlans(await buildRecommendations(), mockIdleResources);

    expect(plans).toHaveLength(mockIdleResources.length);
    for (const plan of plans) {
      expect(plan.preChecks.length).toBeGreaterThan(0);
      expect(plan.apply.length).toBeGreaterThan(0);
      expect(plan.rollback.length).toBeGreaterThan(0);
      expect(plan.iac.terraform).not.toBe('');
      expect(plan.iac.bicep).not.toBe('');
    }
  });

  it('extracts subscription and resource group from the resource id', () => {
    const [plan] = service.buildPlans([recommendationFor()], []);

    expect(plan?.subscriptionId).toBe('sub-1');
    expect(plan?.resourceGroup).toBe('rg-a');
    expect(plan?.resourceName).toBe('vm-a');
  });

  it('uses az vm resize for virtual machine downsizing', () => {
    const [plan] = service.buildPlans([recommendationFor()], []);

    expect(plan?.apply.some((step) => step.command.includes('az vm resize'))).toBe(true);
    expect(plan?.apply.some((step) => step.command.includes('az vm list-vm-resize-options'))).toBe(true);
  });

  it('backs up the resource before any destructive action', () => {
    const [plan] = service.buildPlans([recommendationFor({ actionType: 'DELETE', risk: 'high' })], []);

    expect(plan?.apply[0]?.command).toContain('az resource show');
    expect(plan?.apply[1]?.command).toContain('az resource delete');
    expect(plan?.requiresDowntime).toBe(true);
  });

  it('marks scheduling as a non-destructive action with an auto-shutdown command', () => {
    const [plan] = service.buildPlans([recommendationFor({ actionType: 'SCHEDULE' })], []);

    expect(plan?.apply.some((step) => step.command.includes('auto-shutdown'))).toBe(true);
    expect(plan?.rollback.some((step) => step.command.includes('--off'))).toBe(true);
  });

  it('escapes single quotes in resource names so the generated script stays valid bash', () => {
    const plans = service.buildPlans(
      [
        recommendationFor({
          resourceId: "/subscriptions/sub-1/resourceGroups/rg-a/providers/p/t/vm'; rm -rf /; echo '",
        }),
      ],
      [],
    );

    const directory = mkdtempSync(path.join(tmpdir(), 'aca-rem-'));
    const file = path.join(directory, 'apply.sh');
    writeFileSync(file, service.buildApplyScript(plans), 'utf8');

    // `bash -n` parses without executing: a broken quote would be a syntax error.
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
  });

  it('generates a dry-run-by-default bash script', async () => {
    const plans = service.buildPlans(await buildRecommendations(), mockIdleResources);
    const script = service.buildApplyScript(plans);

    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('set -Eeuo pipefail');
    expect(script).toContain('APPLY="${APPLY:-false}"');
    expect(script).toContain('MODO SIMULAÇÃO');
    for (const plan of plans) {
      expect(script).toContain(plan.resourceName);
    }
  });

  it('requires an explicit confirmation for high-risk actions in the script', () => {
    const plans = service.buildPlans([recommendationFor({ actionType: 'DELETE', risk: 'high' })], []);
    const script = service.buildApplyScript(plans);

    expect(script).toContain('Digite CONFIRMO para continuar');
  });

  it('does not require confirmation for low-risk actions', () => {
    const plans = service.buildPlans([recommendationFor({ risk: 'low' })], []);

    expect(service.buildApplyScript(plans)).not.toContain('CONFIRMO');
  });

  it('produces an empty-but-valid script when there is nothing to remediate', () => {
    const script = service.buildApplyScript([]);

    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('Economia mensal potencial: 0.00');
  });
});
