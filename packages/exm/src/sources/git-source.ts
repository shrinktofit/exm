import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertDirectory, assertPathInside, createDirectoryLink, pathExists } from '../fs/path.js';
import type { ExtensionRequest, ExtensionSource, MaterializedExtension, ResolvedExtension, SourceContext } from './source.js';

export interface GitSpecifier {
  readonly url: string;
  readonly commit: string;
  readonly subpath?: string;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: RunCommandOptions
) => Promise<void>;

export interface RunCommandOptions {
  readonly cwd?: string;
}

export class GitExtensionSource implements ExtensionSource {
  public readonly protocol = 'git';

  public constructor(private readonly commandRunner: RunCommand = runCommand) {}

  public canResolve(spec: string): boolean {
    if (spec.startsWith('link:')) {
      return false;
    }

    const normalized = stripGitPlusPrefix(spec);

    return normalized.includes('#')
      || normalized.includes('://')
      || normalized.startsWith('git@')
      || normalized.endsWith('.git');
  }

  public async resolve(request: ExtensionRequest, context: SourceContext): Promise<ResolvedExtension> {
    const git = parseGitSpecifier(request.spec);
    const checkoutPath = path.join(context.cacheRoot, 'git', createGitCacheKey(git));
    const sourcePath = git.subpath === undefined
      ? path.join(context.installRoot, request.id)
      : resolveGitSourcePath(checkoutPath, git);

    return {
      id: request.id,
      spec: request.spec,
      sourceType: this.protocol,
      reference: git.subpath === undefined ? git.commit : `${git.commit}:${git.subpath}`,
      sourcePath,
      git,
    };
  }

  public async materialize(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension> {
    const targetPath = path.join(context.installRoot, resolved.id);
    const git = resolved.git;

    if (git === undefined) {
      throw new Error(`Resolved extension "${resolved.id}" is missing git metadata`);
    }

    if (git.subpath === undefined) {
      await ensureGitCheckout(git, targetPath, this.commandRunner);

      return {
        id: resolved.id,
        path: targetPath,
        mode: 'clone',
      };
    }

    const checkoutPath = path.join(context.cacheRoot, 'git', createGitCacheKey(git));
    const sourcePath = resolveGitSourcePath(checkoutPath, git);
    await ensureGitCheckout(git, checkoutPath, this.commandRunner);
    await assertDirectory(sourcePath, `git source for "${resolved.id}"`);
    await createDirectoryLink(sourcePath, targetPath);

    return {
      id: resolved.id,
      path: targetPath,
      mode: 'link',
    };
  }
}

export function parseGitSpecifier(spec: string): GitSpecifier {
  const normalized = stripGitPlusPrefix(spec);
  const fragmentIndex = normalized.lastIndexOf('#');

  if (fragmentIndex < 0) {
    throw new Error(`Git source "${spec}" must include a commit fragment, for example <url>#<commit>`);
  }

  const url = normalized.slice(0, fragmentIndex);
  const fragment = normalized.slice(fragmentIndex + 1);
  const parsedFragment = parseGitFragment(spec, fragment);

  if (url.length === 0) {
    throw new Error(`Git source "${spec}" must include a repository URL`);
  }

  return {
    url,
    ...parsedFragment,
  };
}

export function createGitCacheKey(specifier: GitSpecifier): string {
  return createHash('sha256')
    .update(specifier.url)
    .update('\0')
    .update(specifier.commit)
    .digest('hex')
    .slice(0, 16);
}

async function ensureGitCheckout(
  specifier: GitSpecifier,
  checkoutPath: string,
  runCommand: RunCommand,
): Promise<void> {
  const exists = await pathExists(checkoutPath);

  if (!exists) {
    await mkdir(path.dirname(checkoutPath), { recursive: true });
    await runCommand('git', ['clone', '--no-checkout', specifier.url, checkoutPath]);
  }

  await runCommand('git', ['fetch', '--depth=1', 'origin', specifier.commit], { cwd: checkoutPath });
  await runCommand('git', ['checkout', '--force', specifier.commit], { cwd: checkoutPath });
}

function stripGitPlusPrefix(spec: string): string {
  return spec.startsWith('git+') ? spec.slice('git+'.length) : spec;
}

function parseGitFragment(spec: string, fragment: string): Pick<GitSpecifier, 'commit' | 'subpath'> {
  const match = /^(?<commit>[0-9a-f]{7,40})(?::(?<subpath>.+))?$/i.exec(fragment);

  if (match?.groups === undefined) {
    throw new Error(`Git source "${spec}" must pin a 7-40 character commit hash`);
  }

  const subpath = match.groups.subpath;

  if (subpath === undefined) {
    return {
      commit: match.groups.commit,
    };
  }

  return {
    commit: match.groups.commit,
    subpath: normalizeGitSubpath(spec, subpath),
  };
}

function normalizeGitSubpath(spec: string, subpath: string): string {
  const normalized = subpath.replaceAll('\\', '/');

  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(`Git source "${spec}" subpath must be relative`);
  }

  const segments = normalized.split('/');

  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Git source "${spec}" subpath must not contain empty, "." or ".." segments`);
  }

  return segments.join('/');
}

function resolveGitSourcePath(checkoutPath: string, specifier: GitSpecifier): string {
  if (specifier.subpath === undefined) {
    return checkoutPath;
  }

  const sourcePath = path.join(checkoutPath, ...specifier.subpath.split('/'));
  assertPathInside(checkoutPath, sourcePath, 'git source subpath');

  return sourcePath;
}

async function runCommand(
  file: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code): void => {
      if (code === 0) {
        resolve();
        return;
      }

      const output = Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8');
      reject(new Error(`Command failed: ${file} ${args.join(' ')}\n${output}`));
    });
  });
}
