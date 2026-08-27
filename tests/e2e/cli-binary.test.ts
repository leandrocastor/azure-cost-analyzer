import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const binaryPath = path.resolve(__dirname, '../../dist/cli/index.js');
const binaryExists = existsSync(binaryPath);

const runBinary = (args: string[]): { stdout: string; stderr: string; code: number } => {
  const result = spawnSync(process.execPath, [binaryPath, ...args], { encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
};

describe.skipIf(!binaryExists)('CLI binary E2E (subprocess)', () => {
  it('exits with code 0 for --help', () => {
    const { code, stdout } = runBinary(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Azure Cost Analyzer');
    expect(stdout).toContain('Commands:');
  });

  it('exits with code 0 for -h', () => {
    const { code, stdout } = runBinary(['-h']);
    expect(code).toBe(0);
    expect(stdout).toContain('costs');
    expect(stdout).toContain('detect');
    expect(stdout).toContain('recommend');
    expect(stdout).toContain('dashboard');
  });

  it('exits with code 0 for --version', () => {
    const { code, stdout } = runBinary(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits with code 0 for -v', () => {
    const { code, stdout } = runBinary(['-v']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits with non-zero code for unknown command', () => {
    const { code, stderr } = runBinary(['not-a-command']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('Unknown command: not-a-command');
  });

  it('exits with non-zero code for multiple bad arguments', () => {
    const { code } = runBinary(['bad', '--arg', 'value']);
    expect(code).not.toBe(0);
  });

  it('prints help when no arguments are provided', () => {
    const { code, stdout } = runBinary([]);
    expect(code).toBe(0);
    expect(stdout).toContain('Azure Cost Analyzer');
  });
});
