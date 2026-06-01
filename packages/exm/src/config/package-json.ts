import { readFile, writeFile } from 'node:fs/promises';

export type JsonValue = null | boolean | number | string | JsonObject | JsonArray;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export async function readJsonObject(path: string): Promise<JsonObject> {
  let content: string;

  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read package.json at ${path}`, { cause: error });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Expected ${path} to contain a JSON object`);
  }

  return parsed;
}

export async function writeJsonObject(path: string, value: JsonObject): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
