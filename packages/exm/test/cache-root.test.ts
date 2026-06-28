import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExtensionSourceRegistry,
  installProjectExtensions,
  resolveExmCacheRoot,
  saveExmLock,
  updateProjectExtensions,
} from '../src/index.js';
import type {
  ExtensionRequest,
  ExtensionSource,
  MaterializedExtension,
  MaterializedExtensionTiming,
  ResolvedExtension,
  SourceContext,
} from '../src/index.js';

const tempRoots: string[] = [];
const originalCacheRoot = process.env.EXM_CACHE_ROOT;

afterEach(async () => {
  if (originalCacheRoot === undefined) {
    delete process.env.EXM_CACHE_ROOT;
  } else {
    process.env.EXM_CACHE_ROOT = originalCacheRoot;
  }

  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('resolveExmCacheRoot', () => {
  it('should use the user-level exm cache by default', () => {
    /// 1. No explicit cache root or environment override is provided.
    /// exm resolves cache entries under the user home so CI can reuse the directory across project checkouts.
    delete process.env.EXM_CACHE_ROOT;

    expect(resolveExmCacheRoot('C:/project')).toBe(path.join(homedir(), '.exm', 'cache'));
  });

  it('should allow EXM_CACHE_ROOT to override the default cache location', () => {
    /// 1. The environment provides an explicit cache root.
    /// exm resolves it relative to the project when it is not absolute, preserving project-local opt-in.
    process.env.EXM_CACHE_ROOT = '.exm/cache';

    expect(resolveExmCacheRoot('C:/project')).toBe(path.resolve('C:/project', '.exm/cache'));
  });
});

describe('installProjectExtensions cache root', () => {
  it('should pass the configured cache root to extension sources during install', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-cache-install-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const cacheRoot = path.join(workspace, 'global-cache');
    const source = new RecordingSource();
    await writeProject(projectRoot);

    await installProjectExtensions({
      projectRoot,
      cacheRoot,
      registry: new ExtensionSourceRegistry([source]),
    });

    expect(source.cacheRoots).toEqual([cacheRoot, cacheRoot]);
  });

  it('should pass the configured cache root to extension sources during update', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-cache-update-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const cacheRoot = path.join(workspace, 'global-cache');
    const source = new RecordingSource();
    await writeProject(projectRoot);

    await updateProjectExtensions({
      projectRoot,
      cacheRoot,
      registry: new ExtensionSourceRegistry([source]),
    });

    expect(source.cacheRoots).toEqual([cacheRoot, cacheRoot]);
  });
  it('should include cache misses and timing in the install output', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-cache-log-miss-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const cacheRoot = path.join(projectRoot, '.exm', 'cache');
    const messages: string[] = [];
    await writeProject(projectRoot);

    await installProjectExtensions({
      projectRoot,
      cacheRoot,
      registry: new ExtensionSourceRegistry([new RecordingSource(false, {
        cachePopulateMs: 34,
        cacheCopyMs: 12,
      })]),
      logger: {
        info: (message): void => {
          messages.push(message);
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(new RegExp(
      `^installed sample from record -> ${escapeRegExp(path.join('extensions', 'sample'))} \\[cache=miss resolve=\\d+ms materialize=\\d+ms populate=34ms copy=12ms total=\\d+ms\\]$`,
    ));
  });

  it('should include external cache hits and timing in the update output', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-cache-log-hit-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const cacheRoot = path.join(workspace, 'global-cache');
    const messages: string[] = [];
    await writeProject(projectRoot);

    await updateProjectExtensions({
      projectRoot,
      cacheRoot,
      registry: new ExtensionSourceRegistry([new RecordingSource(true, {
        cacheCopyMs: 12,
      })]),
      logger: {
        info: (message): void => {
          messages.push(message);
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(new RegExp(
      `^updated sample from record -> ${escapeRegExp(path.join('extensions', 'sample'))} \\[cache=hit resolve=\\d+ms materialize=\\d+ms copy=12ms total=\\d+ms\\]$`,
    ));
  });

  it('should include remove timing when replacing an existing target', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-cache-log-remove-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const cacheRoot = path.join(projectRoot, '.exm', 'cache');
    const messages: string[] = [];
    await writeProject(projectRoot);
    await mkdir(path.join(projectRoot, 'extensions', 'sample'), { recursive: true });

    await installProjectExtensions({
      projectRoot,
      cacheRoot,
      registry: new ExtensionSourceRegistry([new RecordingSource(false, {
        cacheCopyMs: 7,
      })]),
      logger: {
        info: (message): void => {
          messages.push(message);
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(new RegExp(
      `^reinstalled sample from record -> ${escapeRegExp(path.join('extensions', 'sample'))} \\[cache=miss resolve=\\d+ms remove=\\d+ms materialize=\\d+ms copy=7ms total=\\d+ms\\]$`,
    ));
  });

  it('should not print timing when an extension is skipped', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-cache-log-skip-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const cacheRoot = path.join(projectRoot, '.exm', 'cache');
    const messages: string[] = [];
    await writeProject(projectRoot);
    await mkdir(path.join(projectRoot, 'extensions', 'sample'), { recursive: true });
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        sample: {
          spec: 'record:sample',
          resolution: {
            commit: '0123456789abcdef0123456789abcdef01234567',
          },
        },
      },
    });

    await installProjectExtensions({
      projectRoot,
      cacheRoot,
      registry: new ExtensionSourceRegistry([new RecordingSource()]),
      logger: {
        info: (message): void => {
          messages.push(message);
        },
      },
    });

    expect(messages).toEqual(['skipped sample; already installed']);
  });
});

class RecordingSource implements ExtensionSource {
  public readonly protocol = 'record:';
  public readonly cacheRoots: string[] = [];

  public constructor(
    private readonly cacheHit?: boolean,
    private readonly timing?: MaterializedExtensionTiming,
  ) {}

  public canResolve(spec: string): boolean {
    return spec.startsWith(this.protocol);
  }

  public async resolve(request: ExtensionRequest, context: SourceContext): Promise<ResolvedExtension> {
    this.cacheRoots.push(context.cacheRoot);

    return {
      id: request.id,
      spec: request.spec,
      sourceType: 'record',
      reference: request.spec.slice(this.protocol.length),
      sourcePath: path.join(context.cacheRoot, 'record', request.id),
    };
  }

  public async materialize(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension> {
    this.cacheRoots.push(context.cacheRoot);
    const targetPath = path.join(context.installRoot, resolved.id);
    await mkdir(targetPath, { recursive: true });

    return {
      id: resolved.id,
      path: targetPath,
      mode: 'copy',
      ...this.createMaterializedMetadata(resolved),
    };
  }

  private createMaterializedMetadata(resolved: ResolvedExtension): Pick<MaterializedExtension, 'cache' | 'timing'> {
    return {
      ...(this.cacheHit === undefined
        ? {}
        : {
          cache: {
            path: resolved.sourcePath,
            hit: this.cacheHit,
          },
        }),
      ...(this.timing === undefined ? {} : { timing: this.timing }),
    };
  }
}

async function writeProject(projectRoot: string): Promise<void> {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    exm: {
      dependencies: {
        sample: 'record:sample',
      },
    },
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
