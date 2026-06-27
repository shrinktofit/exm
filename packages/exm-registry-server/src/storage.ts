import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeRegistryUrl } from './model.js';

export interface RegistryStorage {
  readMetadataJson(path: string): Promise<unknown | undefined>;
  writeMetadataJson(path: string, value: unknown): Promise<void>;
  readArtifact(path: string): Promise<Buffer | undefined>;
  writeArtifact(path: string, value: Buffer, contentType: string): Promise<void>;
}

export interface FileRegistryStorageOptions {
  readonly root: string;
}

export interface NexusRawStorageOptions {
  readonly nexusBaseUrl: string;
  readonly metadataRepository: string;
  readonly artifactRepository: string;
  readonly username?: string;
  readonly password?: string;
  readonly token?: string;
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class FileRegistryStorage implements RegistryStorage {
  private readonly metadataRoot: string;
  private readonly artifactRoot: string;

  public constructor(options: FileRegistryStorageOptions) {
    const root = path.resolve(options.root);
    this.metadataRoot = path.join(root, 'metadata');
    this.artifactRoot = path.join(root, 'artifacts');
  }

  public async readMetadataJson(storagePath: string): Promise<unknown | undefined> {
    const filePath = createStorageFilePath(this.metadataRoot, storagePath);

    try {
      const content = await readFile(filePath, 'utf8');

      try {
        return JSON.parse(content) as unknown;
      } catch (error) {
        throw new Error(`Failed to parse registry metadata JSON at ${storagePath}`, { cause: error });
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  public async writeMetadataJson(storagePath: string, value: unknown): Promise<void> {
    await writeFileAtomically(createStorageFilePath(this.metadataRoot, storagePath), Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  }

  public async readArtifact(storagePath: string): Promise<Buffer | undefined> {
    try {
      return await readFile(createStorageFilePath(this.artifactRoot, storagePath));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  public async writeArtifact(storagePath: string, value: Buffer, _contentType: string): Promise<void> {
    await writeFileAtomically(createStorageFilePath(this.artifactRoot, storagePath), value);
  }
}

export class NexusRawStorage implements RegistryStorage {
  private readonly metadataBaseUrl: string;
  private readonly artifactBaseUrl: string;
  private readonly authorizationHeader?: string;

  public constructor(options: NexusRawStorageOptions) {
    const nexusBaseUrl = normalizeRegistryUrl(options.nexusBaseUrl, 'EXM_NEXUS_BASE_URL');
    this.metadataBaseUrl = new URL(`repository/${options.metadataRepository}/`, nexusBaseUrl).href;
    this.artifactBaseUrl = new URL(`repository/${options.artifactRepository}/`, nexusBaseUrl).href;
    this.authorizationHeader = createAuthorizationHeader(options);
  }

  public async readMetadataJson(path: string): Promise<unknown | undefined> {
    const response = await this.fetchPath(this.metadataBaseUrl, path, { method: 'GET' });

    if (response.status === 404) {
      return undefined;
    }

    assertOk(response, path);
    return JSON.parse(await response.text()) as unknown;
  }

  public async writeMetadataJson(path: string, value: unknown): Promise<void> {
    const response = await this.fetchPath(this.metadataBaseUrl, path, {
      method: 'PUT',
      body: `${JSON.stringify(value, null, 2)}\n`,
      headers: {
        'content-type': 'application/json',
      },
    });
    assertOk(response, path);
  }

  public async readArtifact(path: string): Promise<Buffer | undefined> {
    const response = await this.fetchPath(this.artifactBaseUrl, path, { method: 'GET' });

    if (response.status === 404) {
      return undefined;
    }

    assertOk(response, path);
    return Buffer.from(await response.arrayBuffer());
  }

  public async writeArtifact(path: string, value: Buffer, contentType: string): Promise<void> {
    const response = await this.fetchPath(this.artifactBaseUrl, path, {
      method: 'PUT',
      body: value as unknown as BodyInit,
      headers: {
        'content-type': contentType,
      },
    });
    assertOk(response, path);
  }

  private async fetchPath(baseUrl: string, path: string, init: RequestInit): Promise<FetchResponseLike> {
    const headers = new Headers(init.headers);

    if (this.authorizationHeader !== undefined) {
      headers.set('authorization', this.authorizationHeader);
    }

    return await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
    }) as FetchResponseLike;
  }
}

export class MemoryRegistryStorage implements RegistryStorage {
  public readonly metadataJson = new Map<string, unknown>();
  public readonly artifacts = new Map<string, Buffer>();

  public async readMetadataJson(path: string): Promise<unknown | undefined> {
    return cloneJson(this.metadataJson.get(path));
  }

  public async writeMetadataJson(path: string, value: unknown): Promise<void> {
    this.metadataJson.set(path, cloneJson(value));
  }

  public async readArtifact(path: string): Promise<Buffer | undefined> {
    const artifact = this.artifacts.get(path);

    return artifact === undefined ? undefined : Buffer.from(artifact);
  }

  public async writeArtifact(path: string, value: Buffer): Promise<void> {
    this.artifacts.set(path, Buffer.from(value));
  }
}

function createAuthorizationHeader(options: NexusRawStorageOptions): string | undefined {
  if (options.token !== undefined && options.token.length > 0) {
    return `Bearer ${options.token}`;
  }

  if (options.username !== undefined && options.password !== undefined) {
    return `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
  }

  return undefined;
}

function assertOk(response: FetchResponseLike, path: string): void {
  if (!response.ok) {
    throw new Error(`Nexus Raw request failed for ${path}: ${response.status} ${response.statusText}`);
  }
}

function createStorageFilePath(root: string, storagePath: string): string {
  const parts = parseStoragePath(storagePath);
  const filePath = path.resolve(root, ...parts);
  const relativePath = path.relative(root, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid registry storage path: ${storagePath}`);
  }

  return filePath;
}

function parseStoragePath(storagePath: string): string[] {
  if (storagePath.length === 0 || storagePath.includes('\\') || storagePath.includes('\0') || path.isAbsolute(storagePath) || path.win32.isAbsolute(storagePath)) {
    throw new Error(`Invalid registry storage path: ${storagePath}`);
  }

  const parts = storagePath.split('/');

  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`Invalid registry storage path: ${storagePath}`);
  }

  return parts;
}

async function writeFileAtomically(filePath: string, value: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempPath, 'w');

    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
