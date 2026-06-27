import { Buffer } from 'node:buffer';
import fastify, { type FastifyInstance } from 'fastify';
import {
  addPackageVersion,
  createArtifactPath,
  createArtifactStoragePath,
  createArtifactUrl,
  createEmptyPackageDocument,
  createPackageMetadataUrl,
  createPackageStoragePath,
  createSha512Integrity,
  decodePackagePath,
  normalizePackageDocument,
  normalizeRegistryUrl,
  normalizeSearchIndex,
  updateSearchIndex,
  validatePackageName,
  validateVersion,
  type ExmArtifactMetadata,
  type ExmPackageDocument,
  type ExmPublishPlan,
} from './model.js';
import type { RegistryStorage } from './storage.js';

const SEARCH_INDEX_PATH = '-/search.json';
const DEFAULT_BODY_LIMIT = 256 * 1024 * 1024;

export interface ExmRegistryServerOptions {
  readonly publicUrl: string;
  readonly storage: RegistryStorage;
  readonly bodyLimit?: number;
}

export function createExmRegistryServer(options: ExmRegistryServerOptions): FastifyInstance {
  const publicUrl = normalizeRegistryUrl(options.publicUrl, 'EXM_REGISTRY_PUBLIC_URL');
  const storage = options.storage;
  const locks = new PackagePublishLocks();
  const app = fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
  });

  app.addContentTypeParser(['application/gzip', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/-/exm/v1/publish/plan', async (request, reply) => {
    const body = readObject(request.body, 'publish plan body');
    const packageName = readString(body.name, 'publish plan body.name');
    const version = readString(body.version, 'publish plan body.version');
    const integrity = readString(body.integrity, 'publish plan body.integrity');
    const size = readPositiveInteger(body.size, 'publish plan body.size');
    validatePackageName(packageName);
    await validateVersion(version);

    const document = await readPackageDocument(storage, publicUrl, packageName);

    if (document.versions[version] !== undefined) {
      return await reply.code(409).send({
        error: `exm registry package "${packageName}" version ${version} already exists`,
      });
    }

    return await reply.send(createPublishPlan(publicUrl, packageName, version, integrity, size));
  });

  app.put('/-/exm/v1/publish', async (request, reply) => {
    const query = readObject(request.query, 'publish query');
    const packageName = readString(query.name, 'publish query.name');
    const version = readString(query.version, 'publish query.version');
    const expectedIntegrity = readString(request.headers['x-exm-integrity'], 'x-exm-integrity');
    const expectedSize = Number(readString(request.headers['x-exm-size'], 'x-exm-size'));
    const artifactBody = request.body;

    if (!Number.isInteger(expectedSize) || expectedSize <= 0) {
      throw new Error('x-exm-size must be a positive integer');
    }

    if (!Buffer.isBuffer(artifactBody)) {
      throw new Error('publish artifact body must be a Buffer');
    }

    validatePackageName(packageName);
    await validateVersion(version);

    const actualIntegrity = createSha512Integrity(artifactBody);

    if (actualIntegrity !== expectedIntegrity) {
      throw new Error(`publish artifact integrity mismatch for ${packageName}@${version}`);
    }

    if (artifactBody.byteLength !== expectedSize) {
      throw new Error(`publish artifact size mismatch for ${packageName}@${version}`);
    }

    try {
      const result = await locks.run(packageName, async () => {
        const document = await readPackageDocument(storage, publicUrl, packageName);

        if (document.versions[version] !== undefined) {
          const duplicate = new Error(`exm registry package "${packageName}" version ${version} already exists`);
          duplicate.name = 'DuplicateVersionError';
          throw duplicate;
        }

        const artifact: ExmArtifactMetadata = {
          type: 'tgz',
          path: createArtifactPath(version),
          integrity: expectedIntegrity,
          size: expectedSize,
        };
        await storage.writeArtifact(createArtifactStoragePath(packageName, version), artifactBody, 'application/gzip');
        const nextDocument = await addPackageVersion(document, version, artifact, publicUrl);
        await storage.writeMetadataJson(createPackageStoragePath(packageName), nextDocument);
        const searchIndex = normalizeSearchIndex(await storage.readMetadataJson(SEARCH_INDEX_PATH));
        await storage.writeMetadataJson(SEARCH_INDEX_PATH, updateSearchIndex(searchIndex, nextDocument));

        return createPublishPlan(publicUrl, packageName, version, expectedIntegrity, expectedSize);
      });

      return await reply.send(result);
    } catch (error) {
      if (error instanceof Error && error.name === 'DuplicateVersionError') {
        return await reply.code(409).send({ error: error.message });
      }

      throw error;
    }
  });

  app.get('/-/v1/search', async (request, reply) => {
    const query = readObject(request.query, 'search query');
    const text = typeof query.text === 'string' ? query.text.toLowerCase() : '';
    const index = normalizeSearchIndex(await storage.readMetadataJson(SEARCH_INDEX_PATH));
    const packages = Object.values(index.packages).filter((entry) => entry.name.toLowerCase().includes(text));

    return await reply.send({
      objects: packages.map((entry) => ({
        package: {
          name: entry.name,
          version: entry.version,
          links: {
            npm: createPackageMetadataUrl(publicUrl, entry.name),
          },
        },
        score: {
          final: 1,
          detail: {
            quality: 1,
            popularity: 0,
            maintenance: 1,
          },
        },
        searchScore: 1,
      })),
      total: packages.length,
    });
  });

  app.get('/-/all', async (_request, reply) => {
    const index = normalizeSearchIndex(await storage.readMetadataJson(SEARCH_INDEX_PATH));
    const packages: Record<string, ExmPackageDocument> = {};

    for (const packageName of Object.keys(index.packages)) {
      packages[packageName] = await readPackageDocument(storage, publicUrl, packageName);
    }

    return await reply.send(packages);
  });

  app.get('/*', async (request, reply) => {
    const pathname = new URL(request.url, publicUrl).pathname;
    const artifactRequest = parseArtifactPath(pathname);

    if (artifactRequest !== undefined) {
      const artifact = await storage.readArtifact(createArtifactStoragePath(artifactRequest.packageName, artifactRequest.version));

      if (artifact === undefined) {
        return await reply.code(404).send({ error: 'artifact not found' });
      }

      return await reply.type('application/gzip').send(artifact);
    }

    const packageName = decodePackagePath(pathname);
    validatePackageName(packageName);
    const value = await storage.readMetadataJson(createPackageStoragePath(packageName));

    if (value === undefined) {
      return await reply.code(404).send({ error: 'package not found' });
    }

    return await reply.send(await normalizePackageDocument(value, packageName, publicUrl, createPackageStoragePath(packageName)));
  });

  return app;
}

export async function readPackageDocument(storage: RegistryStorage, publicUrl: string, packageName: string): Promise<ExmPackageDocument> {
  const value = await storage.readMetadataJson(createPackageStoragePath(packageName));

  if (value === undefined) {
    return createEmptyPackageDocument(packageName);
  }

  return await normalizePackageDocument(value, packageName, publicUrl, createPackageStoragePath(packageName));
}

export function createPublishPlan(publicUrl: string, packageName: string, version: string, integrity: string, size: number): ExmPublishPlan {
  return {
    packageName,
    version,
    metadataUrl: createPackageMetadataUrl(publicUrl, packageName),
    artifactUrl: createArtifactUrl(publicUrl, packageName, version),
    integrity,
    size,
  };
}

class PackagePublishLocks {
  private readonly locks = new Map<string, Promise<void>>();

  public async run<Result>(packageName: string, action: () => Promise<Result>): Promise<Result> {
    const previous = this.locks.get(packageName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.locks.set(packageName, next);
    await previous.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();

      if (this.locks.get(packageName) === next) {
        this.locks.delete(packageName);
      }
    }
  }
}

function parseArtifactPath(pathname: string): { readonly packageName: string; readonly version: string } | undefined {
  const parts = pathname.replace(/^\/+/, '').split('/');

  if (parts.length < 3 || parts.at(-1) !== 'extension.tgz') {
    return undefined;
  }

  const version = decodeURIComponent(parts.at(-2)!);
  const packageName = decodePackagePath(parts.slice(0, -2).join('/'));
  validatePackageName(packageName);

  return {
    packageName,
    version,
  };
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string): string {
  if (Array.isArray(value)) {
    return readString(value[0], label);
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function readPositiveInteger(value: unknown, label: string): number {
  const number = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return number;
}
