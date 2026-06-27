import { Buffer } from 'node:buffer';
import { normalizeRegistryUrl } from './model.js';

export interface RegistryStorage {
  readMetadataJson(path: string): Promise<unknown | undefined>;
  writeMetadataJson(path: string, value: unknown): Promise<void>;
  readArtifact(path: string): Promise<Buffer | undefined>;
  writeArtifact(path: string, value: Buffer, contentType: string): Promise<void>;
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

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
