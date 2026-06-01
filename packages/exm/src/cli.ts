import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import type { ArgumentsCamelCase, Argv } from 'yargs';
import { initProjectConfig } from './config/init-project.js';
import { readJsonObject } from './config/package-json.js';
import { EXM_LOCAL_FILE } from './config/project-config.js';
import { installProjectExtensions, updateProjectExtensions } from './installer/extension-installer.js';
import { EXM_LOCAL_LOCK_FILE } from './lock/exm-lock.js';

export interface ProjectCommandOptions {
  readonly project?: string;
  readonly installDir?: string;
}

export interface InitCommandOptions extends ProjectCommandOptions {
  readonly local?: boolean;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let exitCode = 0;
  const version = await readPackageVersion();
  const parser = yargs(argv)
    .scriptName('exm')
    .usage('$0 <command> [options]')
    .command(
      'init',
      'Initialize exm config',
      configureInitCommand,
      async (args): Promise<void> => {
        try {
          await runInitCommand(args);
        } catch (error) {
          console.error(formatError(error));
          exitCode = 1;
        }
      },
    )
    .command(
      ['i', 'install'],
      'Install Cocos Creator extensions from package.json exm.dependencies',
      configureProjectCommand,
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
      configureProjectCommand,
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

function configureProjectCommand(argv: Argv): Argv<ProjectCommandOptions> {
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

function configureInitCommand(argv: Argv): Argv<InitCommandOptions> {
  return configureProjectCommand(argv)
    .option('local', {
      describe: `Initialize ${EXM_LOCAL_FILE} instead of package.json`,
      type: 'boolean',
      default: false,
    });
}

async function runInitCommand(args: ArgumentsCamelCase<InitCommandOptions>): Promise<void> {
  const result = await initProjectConfig({
    projectRoot: args.project,
    installDir: args.installDir,
    local: args.local,
  });
  const target = result.local ? EXM_LOCAL_FILE : 'package.json';

  if (result.status === 'initialized') {
    console.log(`Initialized exm config in ${target}.`);
  } else if (result.status === 'updated') {
    console.log(`Updated exm config in ${target}.`);
  } else {
    console.log(`${target} already has exm config.`);
  }

  if (result.local && result.status !== 'unchanged') {
    console.log(`Tip: add ${EXM_LOCAL_FILE} and ${EXM_LOCAL_LOCK_FILE} to .gitignore if this project tracks local files.`);
  }
}

async function runInstallCommand(args: ArgumentsCamelCase<ProjectCommandOptions>): Promise<void> {
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

async function runUpdateCommand(args: ArgumentsCamelCase<ProjectCommandOptions>): Promise<void> {
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
