import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertDirectory, assertPathInside, createDirectoryLink, isSameRealPath, pathExists } from '../fs/path.js';
import { elapsedMs, nowMs } from '../timing.js';
import { withSupportedDependencySpecifiers } from './specifier-help.js';
import type { ExtensionRequest, ExtensionSource, MaterializedExtension, ResolvedExtension, SourceContext } from './source.js';

export interface GitSpecifier {
  readonly url: string;
  readonly ref?: string;
  readonly subpath?: string;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: RunCommandOptions
) => Promise<string | void>;

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
      reference: formatGitReference(git),
      sourcePath,
      git,
    };
  }

  public async adoptExisting(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension | undefined> {
    const targetPath = path.join(context.installRoot, resolved.id);
    const git = resolved.git;

    if (git === undefined) {
      throw new Error(`Resolved extension "${resolved.id}" is missing git metadata`);
    }

    if (git.subpath === undefined) {
      if (!await pathExists(path.join(targetPath, '.git'))) {
        return undefined;
      }

      const commit = await ensureGitCheckout(git, targetPath, this.commandRunner);

      return {
        id: resolved.id,
        path: targetPath,
        mode: 'clone',
        git: {
          commit,
        },
      };
    }

    const checkoutPath = path.join(context.cacheRoot, 'git', createGitCacheKey(git));
    const sourcePath = resolveGitSourcePath(checkoutPath, git);
    const commit = await ensureGitCheckout(git, checkoutPath, this.commandRunner);
    await assertDirectory(sourcePath, `git source for "${resolved.id}"`);

    if (!await isSameRealPath(sourcePath, targetPath)) {
      return undefined;
    }

    return {
      id: resolved.id,
      path: targetPath,
      mode: 'link',
      git: {
        commit,
      },
    };
  }

  public async materialize(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension> {
    const targetPath = path.join(context.installRoot, resolved.id);
    const git = resolved.git;

    if (git === undefined) {
      throw new Error(`Resolved extension "${resolved.id}" is missing git metadata`);
    }

    if (git.subpath === undefined) {
      const gitSyncStartMs = nowMs();
      const commit = await ensureGitCheckout(git, targetPath, this.commandRunner);
      const gitSyncMs = elapsedMs(gitSyncStartMs);

      return {
        id: resolved.id,
        path: targetPath,
        mode: 'clone',
        git: {
          commit,
        },
        timing: {
          gitSyncMs,
        },
      };
    }

    const checkoutPath = path.join(context.cacheRoot, 'git', createGitCacheKey(git));
    const sourcePath = resolveGitSourcePath(checkoutPath, git);
    const cacheHit = await pathExists(checkoutPath);
    const gitSyncStartMs = nowMs();
    const commit = await ensureGitCheckout(git, checkoutPath, this.commandRunner);
    const gitSyncMs = elapsedMs(gitSyncStartMs);
    await assertDirectory(sourcePath, `git source for "${resolved.id}"`);
    const linkStartMs = nowMs();
    await createDirectoryLink(sourcePath, targetPath);
    const linkMs = elapsedMs(linkStartMs);

    return {
      id: resolved.id,
      path: targetPath,
      mode: 'link',
      git: {
        commit,
      },
      cache: {
        path: checkoutPath,
        hit: cacheHit,
      },
      timing: {
        gitSyncMs,
        linkMs,
      },
    };
  }
}

export function parseGitSpecifier(spec: string): GitSpecifier {
  const normalized = stripGitPlusPrefix(spec);
  const fragmentIndex = normalized.lastIndexOf('#');
  const url = fragmentIndex < 0 ? normalized : normalized.slice(0, fragmentIndex);

  if (url.length === 0) {
    throw new Error(withSupportedDependencySpecifiers(
      `Git source "${spec}" must include a repository URL`,
    ));
  }

  const parsedFragment = fragmentIndex < 0 ? {} : parseGitFragment(spec, normalized.slice(fragmentIndex + 1));

  return {
    url,
    ...parsedFragment,
  };
}

export function createGitCacheKey(specifier: GitSpecifier): string {
  return createHash('sha256')
    .update(specifier.url)
    .update('\0')
    .update(specifier.ref ?? '')
    .digest('hex')
    .slice(0, 16);
}

async function ensureGitCheckout(
  specifier: GitSpecifier,
  checkoutPath: string,
  runCommand: RunCommand,
): Promise<string> {
  const exists = await pathExists(checkoutPath);

  if (!exists) {
    await mkdir(path.dirname(checkoutPath), { recursive: true });
    await runCommand('git', createGitCloneArgs(specifier, checkoutPath));
  }

  if (specifier.ref === undefined) {
    if (exists) {
      await runCommand('git', ['pull', '--ff-only'], { cwd: checkoutPath });
    }

    return await readGitHeadCommit(checkoutPath, runCommand);
  }

  await runCommand('git', ['fetch', '--depth=1', 'origin', specifier.ref], { cwd: checkoutPath });
  await runCommand('git', ['checkout', '--force', 'FETCH_HEAD'], { cwd: checkoutPath });

  return await readGitHeadCommit(checkoutPath, runCommand);
}

function stripGitPlusPrefix(spec: string): string {
  return spec.startsWith('git+') ? spec.slice('git+'.length) : spec;
}

function parseGitFragment(spec: string, fragment: string): Pick<GitSpecifier, 'ref' | 'subpath'> {
  if (fragment.length === 0) {
    return {};
  }

  if (fragment.startsWith(':')) {
    return {
      subpath: normalizeGitSubpath(spec, fragment.slice(1)),
    };
  }

  const subpathSeparatorIndex = fragment.indexOf(':');
  const ref = subpathSeparatorIndex < 0 ? fragment : fragment.slice(0, subpathSeparatorIndex);
  const subpath = subpathSeparatorIndex < 0 ? undefined : fragment.slice(subpathSeparatorIndex + 1);
  validateGitRef(spec, ref);

  if (subpath === undefined) {
    return {
      ref,
    };
  }

  return {
    ref,
    subpath: normalizeGitSubpath(spec, subpath),
  };
}

function validateGitRef(spec: string, ref: string): void {
  if (
    ref.length === 0
    || ref.startsWith('-')
    || ref.startsWith('/')
    || ref.endsWith('/')
    || ref.endsWith('.')
    || ref.endsWith('.lock')
    || ref.includes('..')
    || ref.includes('//')
    || ref.includes('@{')
    || ref === '@'
    || hasInvalidRefCharacter(ref)
  ) {
    throw new Error(withSupportedDependencySpecifiers(
      `Git source "${spec}" ref must be a branch, tag, or commit-ish`,
    ));
  }
}

function hasInvalidRefCharacter(ref: string): boolean {
  for (const character of ref) {
    if (character.charCodeAt(0) <= 32 || '~^:?*[\\'.includes(character)) {
      return true;
    }
  }

  return false;
}

function normalizeGitSubpath(spec: string, subpath: string): string {
  const normalized = subpath.replaceAll('\\', '/');

  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new Error(withSupportedDependencySpecifiers(
      `Git source "${spec}" subpath must be relative`,
    ));
  }

  const segments = normalized.split('/');

  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(withSupportedDependencySpecifiers(
      `Git source "${spec}" subpath must not contain empty, "." or ".." segments`,
    ));
  }

  return segments.join('/');
}

function createGitCloneArgs(specifier: GitSpecifier, checkoutPath: string): readonly string[] {
  if (specifier.ref === undefined) {
    return ['clone', specifier.url, checkoutPath];
  }

  return ['clone', '--no-checkout', specifier.url, checkoutPath];
}

function formatGitReference(specifier: GitSpecifier): string {
  const reference = specifier.ref ?? 'HEAD';

  return specifier.subpath === undefined ? reference : `${reference}:${specifier.subpath}`;
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
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
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
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }

      const output = Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8');
      reject(new Error(`Command failed: ${file} ${args.join(' ')}\n${output}`));
    });
  });
}

async function readGitHeadCommit(checkoutPath: string, runCommand: RunCommand): Promise<string> {
  const output = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath });
  const commit = String(output ?? '').trim();

  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`Git checkout did not resolve to a full commit hash: ${checkoutPath}`);
  }

  return commit;
}
