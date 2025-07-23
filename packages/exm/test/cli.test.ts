import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

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
  });

  it('should print top-level help with -h', async () => {
    await expect(main(['-h'])).resolves.toBe(0);

    expect(logMessages.join('\n')).toContain('exm <command> [options]');
  });

  it('should print the package version with --version and -v', async () => {
    await expect(main(['--version'])).resolves.toBe(0);
    await expect(main(['-v'])).resolves.toBe(0);

    expect(logMessages).toEqual(['0.0.1', '0.0.1']);
  });

  it('should print install command help', async () => {
    await expect(main(['i', '--help'])).resolves.toBe(0);

    const output = logMessages.join('\n');
    expect(output).toContain('--project');
    expect(output).toContain('--install-dir');
  });

  it('should reject unknown commands', async () => {
    await expect(main(['unknown'])).resolves.toBe(1);

    expect(errorMessages.join('\n')).toContain('Unknown command: unknown');
  });
});
