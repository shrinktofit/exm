import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { extract } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { ExmRegistrySource, ExtensionSourceRegistry, installProjectExtensions, publishExtensionPackage, updateProjectExtensions } from '../src/index.js';
import type { ExmRegistryPublishRequest } from '../src/index.js';

const roots: string[] = [];
const gitCommand = promisify(execFile);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; extension: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'exm-identity-'));
  roots.push(root);
  const extension = path.join(root, 'packages', 'arbitrary-directory');
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(path.join(extension, 'package.json'), JSON.stringify({
    name: '@example/source-package',
    version: '1.0.0',
    vortex: { extensionId: 'Example.Tools' },
    exm: { registry: 'https://registry.example/' },
  }));
  return { root, extension };
}

async function commitGitManifest(repository: string, id: string | undefined, manifestPath = 'package.json'): Promise<void> {
  const file = path.join(repository, manifestPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ name: '@fixture/source-package', vortex: { extensionId: id } }));
  await gitCommand('git', ['add', manifestPath], { cwd: repository });
  await gitCommand('git', [
    '-c', 'user.name=EXM Test', '-c', 'user.email=exm-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Write extension manifest',
  ], { cwd: repository });
}

describe('one persistent identity for EXM publishing and installation', () => {
  it('publishes by manifest identity and preserves the source package name in the tarball', async () => {
    /// @case A differently named source package declares a mixed-case persistent ID.
    /// @expect Publishing selects the ID, retains both manifest fields, and never patches name.
    const { root, extension } = await workspace();
    let request: ExmRegistryPublishRequest | undefined;
    const result = await publishExtensionPackage({
      cwd: root,
      packageName: '@example/source-package',
      commandRunner: async () => {
        const deploy = path.join(extension, '.deploy');
        await mkdir(deploy);
        await cp(path.join(extension, 'package.json'), path.join(deploy, 'package.json'));
      },
      registryClient: {
        async plan() { throw new Error('Unexpected dry-run'); },
        async publish(value) {
          request = value;
          const unpacked = path.join(root, 'unpacked');
          await mkdir(unpacked);
          await extract({ file: value.tarballPath, cwd: unpacked });
          const json = JSON.parse(await readFile(path.join(unpacked, 'package/package.json'), 'utf8'));
          expect(json.name).toBe('@example/source-package');
          expect(json.vortex.extensionId).toBe('Example.Tools');
          return { ...value, metadataUrl: 'https://registry.example/Example.Tools', artifactUrl: 'https://registry.example/artifact' };
        },
      },
    });
    expect(request?.packageName).toBe('Example.Tools');
    expect(result.extensionId).toBe('Example.Tools');
  });

  it('rejects invalid identities and the removed publishing aliases', async () => {
    /// @case A source has no valid ID or still configures either EXM publishing identity field.
    /// @expect Publication fails before deployment or registry access instead of deriving an identity.
    for (const fields of [
      { vortex: {} },
      { vortex: { extensionId: 'single-segment' } },
      { vortex: { extensionId: 'Example.1tools' } },
      { vortex: { extensionId: 'Example.Tools' }, exm: { extensionId: 'old-name' } },
      { vortex: { extensionId: 'Example.Tools' }, exm: { registryPackageName: '@example/old' } },
    ]) {
      const { root, extension } = await workspace();
      await writeFile(path.join(extension, 'package.json'), JSON.stringify({
        name: '@example/source-package', version: '1.0.0', ...fields,
      }));
      let deployed = false;
      await expect(publishExtensionPackage({
        cwd: root,
        packageName: '@example/source-package',
        commandRunner: async () => { deployed = true; },
      })).rejects.toThrow(/extensionId|registryPackageName/);
      expect(deployed).toBe(false);
    }
  });

  it('uses the dependency ID with a bare registry version range', async () => {
    /// @case A dependency uses a version range without an EXM prefix or repeated ID.
    /// @expect Registry resolution receives the dependency key unchanged, including case.
    let requested: unknown;
    const source = new ExmRegistrySource({
      async resolve(value) {
        requested = value;
        return { ...value, version: '1.2.3', resolved: 'https://registry.example/artifact', integrity: 'sha512-test' };
      },
      async resolveLocked() { throw new Error('No lock'); },
      async extract() { throw new Error('No extraction'); },
    });
    expect(source.canResolve('^1.0.0')).toBe(true);
    await source.resolve({ id: 'Example.Tools', spec: '^1.0.0' }, {
      projectRoot: '/project', cacheRoot: '/cache', installRoot: '/extensions',
      exmRegistry: 'https://registry.example/',
    });
    expect(requested).toMatchObject({ packageName: 'Example.Tools', range: '^1.0.0' });
  });

  it('links an arbitrary source directory by ID and rejects a mismatching manifest', async () => {
    /// @case An ID-keyed link points to an unrelated directory and package name, then changes identity.
    /// @expect Initial installation succeeds under the ID directory; reinstall and update reject mismatch.
    const { root, extension } = await workspace();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      exm: { dependencies: { 'Example.Tools': `link:${extension}` } },
    }));
    const result = await installProjectExtensions({ projectRoot: root });
    expect(result.installed[0]?.path).toBe(path.join(root, 'extensions/Example.Tools'));
    await writeFile(path.join(extension, 'package.json'), JSON.stringify({
      name: '@example/source-package', vortex: { extensionId: 'Example.Other' },
    }));
    await expect(installProjectExtensions({ projectRoot: root })).rejects.toThrow(/Example.Tools.*Example.Other|Example.Other.*Example.Tools/);
    await expect(updateProjectExtensions({ projectRoot: root })).rejects.toThrow(/Example.Tools.*Example.Other|Example.Other.*Example.Tools/);
  });

  it.each([undefined, 'Example.Other', 'example.tools'])(
    'rejects a registry artifact whose manifest identity is %s', async (artifactId) => {
      /// @case Registry metadata matches the requested ID, but the downloaded manifest does not.
      /// @expect Installation rejects the payload before copying it into the extension directory.
      const { root } = await workspace();
      await writeFile(path.join(root, 'package.json'), JSON.stringify({
        exm: { registry: 'https://registry.example/', dependencies: { 'Example.Tools': '1.0.0' } },
      }));
      const source = new ExmRegistrySource({
        async resolve(value) {
          return { ...value, version: '1.0.0', resolved: 'https://registry.example/artifact', integrity: 'sha512-test' };
        },
        async resolveLocked() { throw new Error('No lock'); },
        async extract(_resolved, directory) {
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, 'package.json'), JSON.stringify({
            name: 'different-package-name', vortex: { extensionId: artifactId },
          }));
        },
      });
      await expect(installProjectExtensions({
        projectRoot: root, cacheRoot: path.join(root, 'cache'), registry: new ExtensionSourceRegistry([source]),
      })).rejects.toThrow(/vortex.extensionId|identity mismatch/);
      await expect(readFile(path.join(root, 'extensions/Example.Tools/package.json'))).rejects.toThrow(/ENOENT/);
    },
  );

  it.each([
    { ref: '', id: 'Example.Other' },
    { ref: '#main', id: undefined },
  ])('does not leave a rejected Git extension installed: $ref / $id', async ({ ref, id }) => {
    /// @case A real Git repository omits the requested ID or declares another valid ID.
    /// @expect Rejected installation leaves no extension at the public installation path.
    const { root, extension } = await workspace();
    await gitCommand('git', ['init', '--initial-branch=main'], { cwd: extension });
    await commitGitManifest(extension, id);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      exm: { dependencies: { 'Example.Tools': `git+${pathToFileURL(extension).href}${ref}` } },
    }));
    await expect(installProjectExtensions({ projectRoot: root })).rejects.toThrow(/vortex.extensionId|identity mismatch/);
    await expect(access(path.join(root, 'extensions/Example.Tools'))).rejects.toThrow(/ENOENT/);
  });

  it.each([
    { ref: '', manifestPath: 'package.json' },
    { ref: '#main:packages/tool', manifestPath: 'packages/tool/package.json' },
  ])('preserves the installed Git extension when an update changes identity: $ref', async ({ ref, manifestPath }) => {
    /// @case A root checkout or linked monorepo subdirectory has a valid installed identity, then Git changes it.
    /// @expect Rejected update preserves the installed manifest, local files and existing lock.
    const { root, extension } = await workspace();
    await gitCommand('git', ['init', '--initial-branch=main'], { cwd: extension });
    await commitGitManifest(extension, 'Example.Tools', manifestPath);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      exm: { dependencies: { 'Example.Tools': `git+${pathToFileURL(extension).href}${ref}` } },
    }));
    await installProjectExtensions({ projectRoot: root, cacheRoot: path.join(root, 'cache') });
    const target = path.join(root, 'extensions/Example.Tools');
    const manifestBefore = await readFile(path.join(target, 'package.json'), 'utf8');
    const lockBefore = await readFile(path.join(root, 'exm-lock.yaml'), 'utf8');
    await writeFile(path.join(target, 'local-notes.txt'), 'keep local content');
    await commitGitManifest(extension, 'Example.Other', manifestPath);
    await expect(updateProjectExtensions({ projectRoot: root, cacheRoot: path.join(root, 'cache') })).rejects.toThrow(/identity mismatch/);
    expect(await readFile(path.join(target, 'package.json'), 'utf8')).toBe(manifestBefore);
    expect(await readFile(path.join(target, 'local-notes.txt'), 'utf8')).toBe('keep local content');
    expect(await readFile(path.join(root, 'exm-lock.yaml'), 'utf8')).toBe(lockBefore);
  });

  it.runIf(process.platform === 'win32')('rejects case-colliding target directories without replacing the existing extension', async () => {
    /// @case Two different IDs map to the same Windows directory name.
    /// @expect EXM reports the directory collision and preserves the first extension.
    const { root, extension } = await workspace();
    const second = path.join(root, 'packages/other-source');
    await mkdir(second);
    await writeFile(path.join(second, 'package.json'), JSON.stringify({
      name: 'other-source', vortex: { extensionId: 'example.tools' },
    }));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      exm: { dependencies: { 'Example.Tools': `link:${extension}` } },
    }));
    await installProjectExtensions({ projectRoot: root });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      exm: { dependencies: { 'Example.Tools': `link:${extension}`, 'example.tools': `link:${second}` } },
    }));
    await expect(installProjectExtensions({ projectRoot: root })).rejects.toThrow(/directory.*case|case.*directory/i);
    const installed = JSON.parse(await readFile(path.join(root, 'extensions/Example.Tools/package.json'), 'utf8'));
    expect(installed.vortex.extensionId).toBe('Example.Tools');
  });
});
