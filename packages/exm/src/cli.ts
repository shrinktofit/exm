import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import type { ArgumentsCamelCase, Argv } from 'yargs';
import { readJsonObject } from './config/package-json.js';
import { installProjectExtensions, updateProjectExtensions } from './installer/extension-installer.js';

export interface InstallCommandOptions {
  readonly project?: string;
  readonly installDir?: string;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let exitCode = 0;
  const version = await readPackageVersion();
  const parser = yargs(argv)
    .scriptName('exm')
    .usage('$0 <command> [options]')
    .command(
      ['i', 'install'],
      'Install Cocos Creator extensions from package.json exm.dependencies',
      configureInstallCommand,
      async (args): Promise<void> => {
        try {
          await runInstallCommand(args);
        } catch (error) {
          console.error(formatError(error));
          exitCode = 1;
        }
      },
    )
    .command(
      ['update', 'up'],
      'Update git extensions from package.json exm.dependencies',
      configureInstallCommand,
      async (args): Promise<void> => {
        try {
          await runUpdateCommand(args);
        } catch (error) {
          console.error(formatError(error));
          exitCode = 1;
        }
      },
    )
    .demandCommand(1, 'A command is required.')
    .strictCommands()
    .strict()
    .help('help')
    .alias('help', 'h')
    .version(version)
    .alias('version', 'v')
    .showHelpOnFail(false)
    .exitProcess(false)
    .fail((message, error, yargsInstance): void => {
      if (error !== undefined && error !== null) {
        console.error(formatError(error));
      } else if (message !== undefined && message !== null) {
        console.error(message);
      }

      console.error(yargsInstance.help());
      exitCode = 1;
    });

  await parser.parseAsync();

  return exitCode;
}

function configureInstallCommand(argv: Argv): Argv<InstallCommandOptions> {
  return argv
    .option('project', {
      alias: 'C',
      describe: 'Project root directory',
      type: 'string',
    })
    .option('install-dir', {
      describe: 'Extension install directory relative to the project root',
      type: 'string',
    });
}

async function runInstallCommand(args: ArgumentsCamelCase<InstallCommandOptions>): Promise<void> {
  const result = await installProjectExtensions({
    projectRoot: args.project,
    installDir: args.installDir,
    logger: console,
  });

  const changedCount = result.installed.length + result.adopted.length;

  if (changedCount === 0) {
    console.log('No exm dependencies changed.');
  } else {
    console.log(`Installed ${changedCount} extension(s).`);
  }
}

async function runUpdateCommand(args: ArgumentsCamelCase<InstallCommandOptions>): Promise<void> {
  const result = await updateProjectExtensions({
    projectRoot: args.project,
    installDir: args.installDir,
    logger: console,
  });

  const changedCount = result.updated.length + result.adopted.length;

  if (changedCount === 0) {
    console.log('No git extensions changed.');
  } else {
    console.log(`Updated ${changedCount} git extension(s).`);
  }
}

async function readPackageVersion(): Promise<string> {
  const packageJson = await readJsonObject(path.join(getPackageRoot(), 'package.json'));
  const version = packageJson.version;

  if (typeof version !== 'string') {
    throw new Error('@feb/exm package.json must include a string version');
  }

  return version;
}

function getPackageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectEntry(moduleUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined) {
    return false;
  }

  return fileURLToPath(moduleUrl) === path.resolve(entryPath);
}

if (isDirectEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
