import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    /// 1. The working directory contains exm-registry-server.yaml.
    /// 2. The config defines the public URL, listen address, Nexus repositories, and basic auth.
    /// @expect
    /// The server config loads from YAML and metadata reads target the configured metadata repository.
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
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'exm-registry-config-'));
  tempDirs.push(tempDir);

  return tempDir;
}
