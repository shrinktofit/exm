import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRegistryStorage } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('file registry storage', () => {
  it('should persist metadata JSON and artifacts on disk', async () => {
    /// @case
    /// 1. A registry server stores metadata and artifact bytes through file storage.
    /// 2. A new storage instance points at the same root directory.
    /// @expect
    /// The stored JSON and artifact bytes remain readable from disk.
    const root = await createTempDir();
    const storage = new FileRegistryStorage({ root });
    await storage.writeMetadataJson('%40feb/extension-feb/index.json', { name: '@feb/extension-feb' });
    await storage.writeArtifact('%40feb/extension-feb/0.0.81/extension.tgz', Buffer.from('artifact'), 'application/gzip');

    const reloaded = new FileRegistryStorage({ root });

    expect(await reloaded.readMetadataJson('%40feb/extension-feb/index.json')).toEqual({ name: '@feb/extension-feb' });
    expect((await reloaded.readArtifact('%40feb/extension-feb/0.0.81/extension.tgz'))?.toString('utf8')).toBe('artifact');
  });

  it('should reject unsafe storage paths', async () => {
    /// @case
    /// 1. A caller tries to read or write paths that could escape the storage root.
    /// 2. The paths include absolute paths, empty segments, dot segments, and backslashes.
    /// @expect
    /// File storage rejects every unsafe path before touching the filesystem.
    const storage = new FileRegistryStorage({ root: await createTempDir() });

    await expect(storage.writeMetadataJson('../index.json', {})).rejects.toThrow('Invalid registry storage path');
    await expect(storage.writeMetadataJson('/index.json', {})).rejects.toThrow('Invalid registry storage path');
    await expect(storage.writeMetadataJson('C:/index.json', {})).rejects.toThrow('Invalid registry storage path');
    await expect(storage.writeMetadataJson('pkg//index.json', {})).rejects.toThrow('Invalid registry storage path');
    await expect(storage.writeMetadataJson('pkg/./index.json', {})).rejects.toThrow('Invalid registry storage path');
    await expect(storage.writeMetadataJson('pkg\\index.json', {})).rejects.toThrow('Invalid registry storage path');
  });

  it('should include the storage path when metadata JSON is invalid', async () => {
    /// @case
    /// 1. A metadata file exists on disk but contains invalid JSON.
    /// 2. The server tries to read it as package metadata.
    /// @expect
    /// The read fails with an error that names the logical storage path.
    const root = await createTempDir();
    await mkdir(path.join(root, 'metadata'), { recursive: true });
    await writeFile(path.join(root, 'metadata', '-'), 'not json', 'utf8');
    const storage = new FileRegistryStorage({ root });

    await expect(storage.readMetadataJson('-')).rejects.toThrow('Failed to parse registry metadata JSON at -');
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'exm-registry-storage-'));
  tempDirs.push(tempDir);

  return tempDir;
}
