import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExmRegistryServer, createPackageStoragePath, createSha512Integrity, FileRegistryStorage, MemoryRegistryStorage, type RegistryStorage } from '../src/index.js';
import type { FastifyInstance } from 'fastify';

interface TestPackageMetadata {
  readonly name: string;
  readonly versions: Record<string, {
    readonly dist: {
      readonly tarball: string;
      readonly integrity: string;
    };
    readonly exm: {
      readonly artifact: {
        readonly size: number;
      };
    };
  }>;
}

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.map(async (app) => app.close()));
  apps.length = 0;
  await Promise.all(tempDirs.map(async (tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('exm registry server', () => {
  it('keeps case-sensitive IDs distinct in file-backed storage', async () => {
    /// @case Two valid IDs differ only in case and publish the same version.
    /// @expect Metadata and artifact bytes stay distinct on every filesystem.
    const root = await createTempDir();
    const app = createApp(new FileRegistryStorage({ root }));
    for (const id of ['Example.Tools', 'example.tools']) {
      const response = await publish(app, id, '1.0.0');
      expect(response.statusCode, response.body).toBe(200);
    }
    for (const id of ['Example.Tools', 'example.tools']) {
      const metadata = await app.inject({ method: 'GET', url: `/${id}` });
      expect(JSON.parse(metadata.body).name).toBe(id);
      const artifact = await app.inject({ method: 'GET', url: `/${id}/1.0.0/extension.tgz` });
      expect(artifact.body).toBe(`${id}@1.0.0`);
    }
  });

  it.each(['single', 'a..b', 'a.b-', '1a.b', 'a/b.c', '@org/package'])(
    'rejects an invalid extension identity at the HTTP boundary: %s', async (id) => {
      /// @case A client asks to publish under an identity outside the manifest grammar.
      /// @expect The registry rejects it without writing artifacts or metadata.
      const storage = new MemoryRegistryStorage();
      const response = await publish(createApp(storage), id, '1.0.0');
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(storage.artifacts.size).toBe(0);
      expect(storage.metadataJson.size).toBe(0);
    },
  );

  it('serves npm-compatible metadata keyed by persistent extension ID', async () => {
    /// @case
    /// 1. Storage contains an existing legacy exm package index.
    /// 2. A client requests the extension by its persistent ID.
    /// @expect
    /// The server returns npm-compatible metadata with a public tarball URL and exm artifact metadata.
    const storage = new MemoryRegistryStorage();
    storage.metadataJson.set(createPackageStoragePath('tech.bsgames.feb'), {
      schemaVersion: 1,
      name: 'tech.bsgames.feb',
      versions: {
        '0.0.81': {
          version: '0.0.81',
          artifact: {
            type: 'tgz',
            path: '0.0.81/extension.tgz',
            integrity: 'sha512-test',
            size: 123,
          },
        },
      },
    });
    const app = createApp(storage);

    const response = await app.inject({ method: 'GET', url: '/tech.bsgames.feb' });
    const body = JSON.parse(response.body) as TestPackageMetadata;

    expect(response.statusCode).toBe(200);
    expect(body.name).toBe('tech.bsgames.feb');
    expect(body.versions['0.0.81'].dist).toEqual({
      tarball: 'https://exm.example.com/tech.bsgames.feb/0.0.81/extension.tgz',
      integrity: 'sha512-test',
    });
    expect(body.versions['0.0.81'].exm.artifact.size).toBe(123);
  });

  it('should publish an artifact and create package metadata', async () => {
    /// @case
    /// 1. A CLI uploads a complete extension.tgz through the custom publish endpoint.
    /// 2. The package version does not exist yet.
    /// @expect
    /// The server stores the artifact, writes npm-compatible metadata, and returns public URLs.
    const storage = new MemoryRegistryStorage();
    const app = createApp(storage);
    const artifact = Buffer.from('package artifact');
    const integrity = createSha512Integrity(artifact);

    const response = await app.inject({
      method: 'PUT',
      url: '/-/exm/v1/publish?name=tech.bsgames.feb&version=0.0.81',
      headers: {
        'content-type': 'application/gzip',
        'x-exm-integrity': integrity,
        'x-exm-size': String(artifact.byteLength),
      },
      payload: artifact,
    });
    const result = JSON.parse(response.body) as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(result).toMatchObject({
      packageName: 'tech.bsgames.feb',
      version: '0.0.81',
      metadataUrl: 'https://exm.example.com/tech.bsgames.feb',
      artifactUrl: 'https://exm.example.com/tech.bsgames.feb/0.0.81/extension.tgz',
      integrity,
      size: artifact.byteLength,
    });
    expect(storage.artifacts.get('tech.bsgames.feb/0.0.81/extension.tgz')?.equals(artifact)).toBe(true);

    const metadata = storage.metadataJson.get('tech.bsgames.feb/index.json') as TestPackageMetadata;
    expect(metadata.versions['0.0.81'].dist.tarball).toBe('https://exm.example.com/tech.bsgames.feb/0.0.81/extension.tgz');
    expect(metadata.versions['0.0.81'].exm.artifact).toEqual({
      type: 'tgz',
      path: '0.0.81/extension.tgz',
      integrity,
      size: artifact.byteLength,
    });
  });

  it('should expose search and all package endpoints', async () => {
    /// @case
    /// 1. A package has been published through the registry server.
    /// 2. A Unity/npm-like client queries search endpoints.
    /// @expect
    /// The server returns npm search-compatible package summaries and package documents.
    const storage = new MemoryRegistryStorage();
    const app = createApp(storage);
    await publish(app, 'tech.bsgames.feb', '0.0.81');

    const search = await app.inject({ method: 'GET', url: '/-/v1/search?text=feb' });
    const all = await app.inject({ method: 'GET', url: '/-/all' });

    expect(search.statusCode).toBe(200);
    expect(JSON.parse(search.body)).toMatchObject({
      total: 1,
      objects: [
        {
          package: {
            name: 'tech.bsgames.feb',
            version: '0.0.81',
          },
        },
      ],
    });
    expect(Object.keys(JSON.parse(all.body) as Record<string, unknown>)).toEqual(['tech.bsgames.feb']);
  });

  it('should persist published packages through file storage', async () => {
    /// @case
    /// 1. A package is published through the registry server using file storage.
    /// 2. A new server instance starts with the same file storage root.
    /// @expect
    /// Metadata, search data, and artifact bytes remain available from the persistent data directory.
    const root = await createTempDir();
    const app = createApp(new FileRegistryStorage({ root }));
    await publish(app, 'tech.bsgames.feb', '0.0.81');

    expect(await readFile(path.join(root, 'artifacts', 'tech.bsgames.feb', '0.0.81', 'extension.tgz'), 'utf8')).toBe('tech.bsgames.feb@0.0.81');
    expect(JSON.parse(await readFile(path.join(root, 'metadata', 'tech.bsgames.feb', 'index.json'), 'utf8'))).toMatchObject({
      name: 'tech.bsgames.feb',
      versions: {
        '0.0.81': {},
      },
    });
    expect(JSON.parse(await readFile(path.join(root, 'metadata', '-', 'search.json'), 'utf8'))).toMatchObject({
      packages: {
        'tech.bsgames.feb': {
          version: '0.0.81',
        },
      },
    });

    const reloadedApp = createApp(new FileRegistryStorage({ root }));
    const metadata = await reloadedApp.inject({ method: 'GET', url: '/tech.bsgames.feb' });
    const artifact = await reloadedApp.inject({ method: 'GET', url: '/tech.bsgames.feb/0.0.81/extension.tgz' });

    expect(metadata.statusCode).toBe(200);
    expect(Object.keys((JSON.parse(metadata.body) as TestPackageMetadata).versions)).toEqual(['0.0.81']);
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toBe('tech.bsgames.feb@0.0.81');
  });

  it('should reject duplicate package versions', async () => {
    /// @case
    /// 1. A package version has already been published.
    /// 2. A second publish tries to upload that same version.
    /// @expect
    /// The server rejects the duplicate without overwriting the immutable version.
    const storage = new MemoryRegistryStorage();
    const app = createApp(storage);

    await publish(app, 'tech.bsgames.feb', '0.0.81');
    const duplicate = await publish(app, 'tech.bsgames.feb', '0.0.81');

    expect(duplicate.statusCode).toBe(409);
    expect(JSON.parse(duplicate.body).error).toContain('version 0.0.81 already exists');
  });

  it('should serialize concurrent publishes for the same package', async () => {
    /// @case
    /// 1. Two publishes for different versions of the same package arrive concurrently.
    /// 2. Both read and update the same package document.
    /// @expect
    /// The per-package lock preserves both versions instead of losing one metadata update.
    const storage = new MemoryRegistryStorage();
    const app = createApp(storage);

    const [left, right] = await Promise.all([
      publish(app, 'tech.bsgames.feb', '0.0.81'),
      publish(app, 'tech.bsgames.feb', '0.0.82'),
    ]);

    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    const metadata = JSON.parse((await app.inject({ method: 'GET', url: '/tech.bsgames.feb' })).body) as TestPackageMetadata;
    expect(Object.keys(metadata.versions)).toEqual(['0.0.81', '0.0.82']);
  });
});

function createApp(storage: RegistryStorage): FastifyInstance {
  const app = createExmRegistryServer({
    publicUrl: 'https://exm.example.com/',
    storage,
  });
  apps.push(app);

  return app;
}

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'exm-registry-server-'));
  tempDirs.push(tempDir);

  return tempDir;
}

async function publish(app: FastifyInstance, packageName: string, version: string) {
  const artifact = Buffer.from(`${packageName}@${version}`);
  const integrity = createSha512Integrity(artifact);

  return await app.inject({
    method: 'PUT',
    url: `/-/exm/v1/publish?name=${encodeURIComponent(packageName)}&version=${encodeURIComponent(version)}`,
    headers: {
      'content-type': 'application/gzip',
      'x-exm-integrity': integrity,
      'x-exm-size': String(artifact.byteLength),
    },
    payload: artifact,
  });
}
