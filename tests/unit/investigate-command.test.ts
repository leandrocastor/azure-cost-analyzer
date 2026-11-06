import { mkdtemp, readFile, unlink, writeFile, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import InvestigateCommand from '@/cli/commands/investigate';
import { INVESTIGATION_DEMO } from '../../src/demo/cost-investigation';

describe('investigate command', () => {
  let directory: string;
  const created: string[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cost-investigation-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const file of created.splice(0)) await unlink(file);
    await rmdir(directory);
  });
  const target = (name: string): string => {
    const file = path.join(directory, name);
    created.push(file);
    return file;
  };

  it('runs the demonstration without Azure configuration and prints machine-readable JSON', async () => {
    const output = vi
      .spyOn(InvestigateCommand.prototype, 'log')
      .mockImplementation(() => undefined);
    await InvestigateCommand.run(['--demo', '--format', 'json']);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(JSON.parse(text)).toMatchObject({
      synthetic: true,
      baseline: '2026-08',
      current: '2026-09',
      currencies: [
        expect.objectContaining({ currency: 'BRL', delta: '830.00' }),
        expect.anything(),
      ],
    });
  });

  it('reads local FOCUS files and creates a private HTML report', async () => {
    const input = target('input.csv');
    const output = target('report.html');
    await writeFile(input, INVESTIGATION_DEMO.csv);
    await InvestigateCommand.run([
      '--input',
      input,
      '--baseline',
      '2026-08',
      '--current',
      '2026-09',
      '--output',
      output,
    ]);
    expect(await readFile(output, 'utf8')).toContain('BRL 830.00');
    expect(await readFile(output, 'utf8')).not.toContain('DEMONSTRAÇÃO');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it('does not overwrite an existing report or input', async () => {
    const input = target('input.csv');
    const output = target('existing.json');
    await writeFile(input, INVESTIGATION_DEMO.csv);
    await writeFile(output, 'preserve');
    await expect(
      InvestigateCommand.run(['--demo', '--format', 'json', '--output', output]),
    ).rejects.toThrow('EEXIST');
    await expect(
      InvestigateCommand.run([
        '--input',
        input,
        '--baseline',
        '2026-08',
        '--current',
        '2026-09',
        '--output',
        input,
      ]),
    ).rejects.toThrow('must not overwrite');
    expect(await readFile(output, 'utf8')).toBe('preserve');
    expect(await readFile(input, 'utf8')).toBe(INVESTIGATION_DEMO.csv);
  });

  it('rejects directories and invalid UTF-8 before creating a report', async () => {
    const invalid = target('invalid.csv');
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
    const args = ['--baseline', '2026-08', '--current', '2026-09', '--format', 'json'];
    await expect(InvestigateCommand.run(['--input', directory, ...args])).rejects.toThrow(
      'expected a regular CSV',
    );
    await expect(InvestigateCommand.run(['--input', invalid, ...args])).rejects.toThrow(
      'encoded data',
    );
  });

  it.each([
    [[], 'Provide --input'],
    [['--input', 'unused.csv'], 'requires --baseline'],
    [['--demo', '--baseline', '2026-08'], 'fixed synthetic periods'],
    [['--demo', '--input', 'unused.csv'], 'cannot also be provided'],
  ] satisfies [string[], string][])(
    'rejects ambiguous or incomplete input %j',
    async (args, message) => {
      await expect(InvestigateCommand.run(args)).rejects.toThrow(message);
    },
  );
});
