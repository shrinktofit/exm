import process from 'node:process';
import { loadEnvironmentConfig } from './config.js';
import { createExmRegistryServer } from './server.js';

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const cliOptions = readCliOptions(args);

    if (cliOptions.help) {
      console.log('Usage: exm-registry-server [--config <path>]');
      return 0;
    }

    const config = await loadEnvironmentConfig({
      ...optionalStringField('configPath', cliOptions.configPath),
    });
    const app = createExmRegistryServer({
      publicUrl: config.publicUrl,
      storage: config.storage,
    });
    await app.listen({
      host: config.host,
      port: config.port,
    });
    console.log(`exm registry server listening on ${config.host}:${config.port}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function readCliOptions(args: readonly string[]): { readonly configPath?: string; readonly help: boolean } {
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    if (arg === '--config' || arg === '-c') {
      const value = args[index + 1];

      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a config path`);
      }

      configPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      continue;
    }

    throw new Error(`Unsupported exm registry server argument: ${arg}`);
  }

  return {
    help: false,
    ...optionalStringField('configPath', configPath),
  };
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined || value.length === 0 ? {} : { [key]: value } as Record<Key, string>;
}
