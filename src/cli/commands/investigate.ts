import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command, Flags } from '@oclif/core';

import { generateInvestigationReport } from '@/dashboard/investigation-report';
import { INVESTIGATION_DEMO } from '../../demo/cost-investigation';
import {
  CostInvestigationService,
  MAX_INVESTIGATION_BYTES,
  type InvestigationInput,
} from '@/services/cost-investigation';

export default class InvestigateCommand extends Command {
  public static override description =
    'Investigate Azure FOCUS CSV billing changes offline, with exact decimal reconciliation and source-line evidence. No Azure login required.';

  public static override flags = {
    input: Flags.string({
      char: 'i',
      description:
        'FOCUS CSV path; repeat --input for multiple files/partitions (50 MiB combined).',
      multiple: true,
      exclusive: ['demo'],
    }),
    baseline: Flags.string({ description: 'Baseline billing-period start month (YYYY-MM).' }),
    current: Flags.string({ description: 'Current billing-period start month (YYYY-MM).' }),
    demo: Flags.boolean({
      description:
        'Use synthetic data with known billing movements; no files or credentials needed.',
      default: false,
    }),
    format: Flags.string({
      description: 'Output format; JSON is printed to stdout unless --output is provided.',
      options: ['html', 'json'],
      default: 'html',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output path (HTML defaults to azure-cost-investigation.html).',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InvestigateCommand);
    if (!flags.demo && !flags.input?.length) {
      throw new Error('Provide --input <focus.csv> or use --demo.');
    }
    if (!flags.demo && (!flags.baseline || !flags.current)) {
      throw new Error('CSV investigation requires --baseline YYYY-MM and --current YYYY-MM.');
    }
    if (flags.demo && (flags.baseline || flags.current)) {
      throw new Error('--demo uses fixed synthetic periods; omit --baseline and --current.');
    }
    const inputs: InvestigationInput[] = [];
    if (flags.demo) {
      inputs.push({ name: 'SYNTHETIC-DEMO.csv', content: INVESTIGATION_DEMO.csv });
    } else {
      let totalBytes = 0;
      for (const input of flags.input ?? []) {
        const absolute = path.resolve(input);
        const metadata = await stat(absolute);
        if (!metadata.isFile()) throw new Error(`${input}: expected a regular CSV file.`);
        totalBytes += metadata.size;
        if (totalBytes > MAX_INVESTIGATION_BYTES) {
          throw new Error('FOCUS inputs exceed the combined 50 MiB offline limit.');
        }
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          await readFile(absolute),
        );
        inputs.push({ name: path.basename(absolute), content });
      }
    }
    const investigation = new CostInvestigationService().analyze(
      inputs,
      flags.baseline ?? INVESTIGATION_DEMO.baseline,
      flags.current ?? INVESTIGATION_DEMO.current,
    );
    const output = flags.output
      ? path.resolve(flags.output)
      : flags.format === 'html'
        ? path.resolve('azure-cost-investigation.html')
        : undefined;
    if (output && (flags.input ?? []).some((input) => path.resolve(input) === output)) {
      throw new Error('Output must not overwrite an input CSV.');
    }
    const document =
      flags.format === 'json'
        ? JSON.stringify({ ...investigation, synthetic: flags.demo }, null, 2)
        : generateInvestigationReport(investigation, flags.demo);
    if (output) {
      await writeFile(output, document, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.log(`Investigation written to ${output}${flags.demo ? ' (SYNTHETIC DATA)' : ''}`);
    } else {
      this.log(document);
    }
  }
}
