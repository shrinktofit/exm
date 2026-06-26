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
import { deployExtensionPackage, publishExtensionPackage } from './publisher/extension-publisher.js';

export interface ProjectCommandOptions {
  readonly project?: string;
}

export interface InitCommandOptions extends ProjectCommandOptions {
  readonly local?: boolean;
}

export interface DeployCommandOptions {
  readonly package: string;
}

export interface PublishCommandOptions extends DeployCommandOptions {
  readonly dryRun?: boolean;
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
      'Update extensions from package.json exm.dependencies',
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
    .command(
      'deploy <package>',
      'Deploy a Cocos Creator extension package into .deploy',
      configureDeployCommand,
      async (args): Promise<void> => {
        try {
          await runDeployCommand(args);
        } catch (error) {
          console.error(formatError(error));
          exitCode = 1;
        }
      },
    )
    .command(
      'publish <package>',
      'Publish a pnpm-deployed Cocos Creator extension package',
      configurePublishCommand,
      async (args): Promise<void> => {
        try {
          await runPublishCommand(args);
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

function configureDeployCommand(argv: Argv): Argv<DeployCommandOptions> {
  return argv
    .positional('package', {
      describe: 'Package name to deploy',
      type: 'string',
      demandOption: true,
    });
}

function configurePublishCommand(argv: Argv): Argv<PublishCommandOptions> {
  return argv
    .positional('package', {
      describe: 'Package name to deploy and publish',
      type: 'string',
      demandOption: true,
    })
    .option('dry-run', {
      describe: 'Run deploy and registry validation without uploading to the exm registry',
      type: 'boolean',
      default: false,
    });
}

function configureProjectCommand(argv: Argv): Argv<ProjectCommandOptions> {
  return argv
    .option('project', {
      alias: 'C',
      describe: 'Project root directory',
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
    logger: console,
  });

  const changedCount = result.updated.length + result.adopted.length;

  if (changedCount === 0) {
    console.log('No exm dependencies changed.');
  } else {
    console.log(`Updated ${changedCount} extension(s).`);
  }
}

async function runDeployCommand(args: ArgumentsCamelCase<DeployCommandOptions>): Promise<void> {
  const result = await deployExtensionPackage({
    packageName: args.package,
    logger: console,
  });

  console.log(`Deployed ${result.packageName}@${result.version} to ${result.deployDir}.`);
}

async function runPublishCommand(args: ArgumentsCamelCase<PublishCommandOptions>): Promise<void> {
  const result = await publishExtensionPackage({
    packageName: args.package,
    dryRun: args.dryRun,
    logger: console,
  });

  if (result.dryRun) {
    console.log(`Dry-run published ${result.packageName}@${result.version} to ${result.artifactUrl}.`);
  } else {
    console.log(`Published ${result.packageName}@${result.version} to ${result.artifactUrl}.`);
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
