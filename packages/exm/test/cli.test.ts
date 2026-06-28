import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { readJsonObject } from '../src/config/package-json.js';

let logMessages: string[];
let errorMessages: string[];

beforeEach(() => {
  logMessages = [];
  errorMessages = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logMessages.push(String(message));
  });
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errorMessages.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('main', () => {
  it('should print top-level help with --help', async () => {
    await expect(main(['--help'])).resolves.toBe(0);

    expect(logMessages.join('\n')).toContain('exm <command> [options]');
    expect(logMessages.join('\n')).toContain('exm i');
    expect(logMessages.join('\n')).toContain('[aliases: install]');
    expect(logMessages.join('\n')).toContain('exm deploy <package>');
    expect(logMessages.join('\n')).toContain('exm publish <package>');
  });

  it('should print top-level help with -h', async () => {
    await expect(main(['-h'])).resolves.toBe(0);

    expect(logMessages.join('\n')).toContain('exm <command> [options]');
  });

  it('should print the package version with --version and -v', async () => {
    const packageJson = await readJsonObject('package.json');
    const version = packageJson.version;
    expect(version).toBeTypeOf('string');

    await expect(main(['--version'])).resolves.toBe(0);
    await expect(main(['-v'])).resolves.toBe(0);

    expect(logMessages).toEqual([version, version]);
  });

  it('should print install command help without installDir', async () => {
    /// @case
    /// 1. A user requests install command help.
    /// 2. installDir support has been removed.
    /// @expect
    /// Help lists project selection but no install directory override.
    await expect(main(['i', '--help'])).resolves.toBe(0);

    const output = logMessages.join('\n');
    expect(output).toContain('--project');
    expect(output).not.toContain('--install-dir');
  });

  it('should print init command help without installDir', async () => {
    /// @case
    /// 1. A user requests init command help.
    /// 2. installDir support has been removed.
    /// @expect
    /// Help lists project and local options but no install directory override.
    await expect(main(['init', '--help'])).resolves.toBe(0);

    const output = logMessages.join('\n');
    expect(output).toContain('--project');
    expect(output).toContain('--local');
    expect(output).not.toContain('--install-dir');
  });

  it('should print deploy command help without dry-run', async () => {
    /// @case
    /// 1. A user requests deploy command help.
    /// 2. deploy only creates the .deploy directory and does not publish.
    /// @expect
    /// Help shows the required package argument and no npm publish dry-run option.
    await expect(main(['deploy', '--help'])).resolves.toBe(0);

    const output = logMessages.join('\n');
    expect(output).toContain('exm deploy <package>');
    expect(output).not.toContain('--dry-run');
  });

  it('should print publish command help with dry-run and registry override', async () => {
    /// @case
    /// 1. A user requests publish command help.
    /// 2. publish supports dry-run mode and an explicit registry override.
    /// @expect
    /// Help shows the required package argument, dry-run option, and registry option.
    await expect(main(['publish', '--help'])).resolves.toBe(0);

    const output = logMessages.join('\n');
    expect(output).toContain('exm publish <package>');
    expect(output).toContain('--dry-run');
    expect(output).toContain('--registry');
  });

  it('should reject deploy without a package argument', async () => {
    /// @case
    /// 1. A user runs deploy without a package argument.
    /// 2. deploy requires an explicit pnpm deploy package name.
    /// @expect
    /// The CLI exits with an argument validation error.
    await expect(main(['deploy'])).resolves.toBe(1);

    expect(errorMessages.join('\n')).toContain('Not enough non-option arguments');
  });

  it('should reject publish without a package argument', async () => {
    /// @case
    /// 1. A user runs publish dry-run without a package argument.
    /// 2. publish requires an explicit pnpm deploy package name.
    /// @expect
    /// The CLI exits with an argument validation error.
    await expect(main(['publish', '--dry-run'])).resolves.toBe(1);

    expect(errorMessages.join('\n')).toContain('Not enough non-option arguments');
  });

  it('should reject unknown commands', async () => {
    await expect(main(['unknown'])).resolves.toBe(1);

    expect(errorMessages.join('\n')).toContain('Unknown command: unknown');
  });
});
