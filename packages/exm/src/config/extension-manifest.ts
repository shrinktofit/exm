import path from 'node:path';
import { isJsonObject, readJsonObject } from './package-json.js';
import type { JsonObject } from './package-json.js';

const extensionIdPattern = /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;

export function validateExtensionId(value: unknown, label = 'extensionId'): asserts value is string {
  if (typeof value !== 'string' || extensionIdPattern.exec(value)?.[0] !== value) {
    throw new Error(
      `${label} must contain at least two dot-separated segments of ASCII letters, digits and hyphens; `
      + 'each segment must start with a letter and must not end with a hyphen',
    );
  }
}

export function readManifestExtensionId(manifest: JsonObject, label: string): string {
  const id = isJsonObject(manifest.vortex) ? manifest.vortex.extensionId : undefined;
  validateExtensionId(id, `${label} vortex.extensionId`);
  return id;
}

export async function assertExtensionIdentity(directory: string, expectedId: string): Promise<void> {
  const file = path.join(directory, 'package.json');
  const id = readManifestExtensionId(await readJsonObject(file), file);
  if (id !== expectedId) {
    throw new Error(`Extension identity mismatch at ${file}: expected '${expectedId}', found '${id}'`);
  }
}
