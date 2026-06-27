import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvironmentConfig } from '../src/index.js';

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.map(async (tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('exm registry server config', () => {
  it('should load the default YAML config and route metadata storage to the configured Nexus repository', async () => {
    /// @case
    /// 1. The working directory contains exm-registry-server.yaml with legacy Nexus config.
    /// 2. The config omits storage.kind.
    /// @expect
    /// The server keeps using Nexus so existing deployments do not silently switch storage backends.
    const cwd = await createTempDir();
    await writeFile(path.join(cwd, 'exm-registry-server.yaml'), `
publicUrl: https://exm.example.com/
listen:
  host: 127.0.0.1
  port: 4874
nexus:
  baseUrl: http://nexus.example/
  metadataRepository: exm-metadata
  artifactRepository: exm-artifacts
  username: user
  password: pass
`, 'utf8');
    let requestUrl = '';
    let authorization = '';
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';

      return new Response('{}', { status: 200, statusText: 'OK' });
    };

    const config = await loadEnvironmentConfig({ cwd, env: {} });
    await config.storage.readMetadataJson('%40feb/extension-feb/index.json');

    expect(config.publicUrl).toBe('https://exm.example.com/');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4874);
    expect(requestUrl).toBe('http://nexus.example/repository/exm-metadata/%40feb/extension-feb/index.json');
    expect(authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('should load file storage from YAML config', async () => {
    /// @case
    /// 1. The YAML config selects file storage with a relative root.
    /// 2. The server writes metadata and artifacts through the configured storage.
    /// @expect
    /// Files are stored under metadata and artifacts directories below the configured root.
    const cwd = await createTempDir();
    await writeFile(path.join(cwd, 'exm-registry-server.yaml'), `
publicUrl: https://exm.example.com/
listen:
  host: 127.0.0.1
  port: 4874
storage:
  kind: file
  root: registry-data
`, 'utf8');

    const config = await loadEnvironmentConfig({ cwd, env: {} });
    await config.storage.writeMetadataJson('-/search.json', { packages: {} });
    await config.storage.writeArtifact('%40feb/extension-feb/0.0.81/extension.tgz', Buffer.from('tgz'), 'application/gzip');

    expect(config.publicUrl).toBe('https://exm.example.com/');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4874);
    expect(JSON.parse(await readFile(path.join(cwd, 'registry-data', 'metadata', '-', 'search.json'), 'utf8'))).toEqual({ packages: {} });
    expect(await readFile(path.join(cwd, 'registry-data', 'artifacts', '%40feb', 'extension-feb', '0.0.81', 'extension.tgz'), 'utf8')).toBe('tgz');
  });

  it('should let environment variables override YAML config values', async () => {
    /// @case
    /// 1. A YAML config provides default registry and Nexus values.
    /// 2. Deployment environment variables override public URL, listen address, artifact repository, and token.
    /// @expect
    /// The effective config uses environment values and artifact reads target the overridden repository.
    const cwd = await createTempDir();
    const configPath = path.join(cwd, 'registry.yaml');
    await writeFile(configPath, `
publicUrl: https://yaml.example.com/
listen:
  host: 127.0.0.1
  port: 4874
nexus:
  baseUrl: http://yaml-nexus.example/
  metadataRepository: yaml-metadata
  artifactRepository: yaml-artifacts
`, 'utf8');
    let requestUrl = '';
    let authorization = '';
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';

      return new Response(new Uint8Array([1, 2, 3]), { status: 200, statusText: 'OK' });
    };

    const config = await loadEnvironmentConfig({
      cwd,
      configPath,
      env: {
        EXM_REGISTRY_PUBLIC_URL: 'https://env.example.com/',
        EXM_REGISTRY_HOST: '0.0.0.0',
        EXM_REGISTRY_PORT: '4999',
        EXM_NEXUS_BASE_URL: 'http://env-nexus.example/',
        EXM_NEXUS_ARTIFACT_REPOSITORY: 'env-artifacts',
        EXM_NEXUS_TOKEN: 'secret-token',
      },
    });
    await config.storage.readArtifact('%40feb/extension-feb/0.0.81/extension.tgz');

    expect(config.publicUrl).toBe('https://env.example.com/');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(4999);
    expect(requestUrl).toBe('http://env-nexus.example/repository/env-artifacts/%40feb/extension-feb/0.0.81/extension.tgz');
    expect(authorization).toBe('Bearer secret-token');
  });

  it('should let environment variables select file storage', async () => {
    /// @case
    /// 1. No YAML config file exists.
    /// 2. Environment variables select file storage and provide the data root.
    /// @expect
    /// The server uses the environment-defined file root for persistent storage.
    const cwd = await createTempDir();
    const root = path.join(cwd, 'env-data');
    const config = await loadEnvironmentConfig({
      cwd,
      env: {
        EXM_REGISTRY_PUBLIC_URL: 'https://env.example.com/',
        EXM_REGISTRY_STORAGE_KIND: 'file',
        EXM_REGISTRY_FILE_ROOT: root,
      },
    });

    await config.storage.writeArtifact('%40feb/extension-feb/0.0.81/extension.tgz', Buffer.from('env tgz'), 'application/gzip');

    expect(await readFile(path.join(root, 'artifacts', '%40feb', 'extension-feb', '0.0.81', 'extension.tgz'), 'utf8')).toBe('env tgz');
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'exm-registry-config-'));
  tempDirs.push(tempDir);

  return tempDir;
}
