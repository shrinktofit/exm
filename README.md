# exm

`exm` is a small Cocos Creator extension manager. It installs project extensions into the fixed `extensions/` directory and publishes pnpm-deployed extension artifacts through an exm registry server.

## Development

```bash
pnpm install
pnpm --filter @bsgames/exm build
pnpm --filter @bsgames/exm test
pnpm --filter @bsgames/exm-registry-server build
pnpm --filter @bsgames/exm-registry-server test
pnpm exec eslint packages/exm/src/*.ts packages/exm/src/**/*.ts packages/exm/test/*.ts packages/exm-registry-server/src/*.ts packages/exm-registry-server/test/*.ts
```

## Installing Extensions

Add exm config to the Cocos Creator project `package.json`. The registry is the public exm registry server URL:

```json
{
  "exm": {
    "registry": "https://exm.example/",
    "dependencies": {
      "org.some-extension": "^1.0.0",
      "org.local-tool": "link:../local-tool",
      "org.git-tool": "git+https://github.com/org/repo.git#main:extensions/tool"
    }
  }
}
```

Then run:

```bash
exm install
# or
exm i
```

Useful install commands:

```bash
exm init              # add package.json#exm if missing
exm init --local      # add exm.local.yaml if missing
exm i -C path/to/project
exm update
```

Dependency keys are the extensions' manifest `vortex.extensionId` values. Registry dependencies contain only a semver version or range; `link:`, `git+` and `npm:` select explicit alternative sources. EXM checks that the source manifest declares the exact dependency ID, including case.

IDs contain ASCII letters, digits, hyphens and dots, with at least two dot-separated segments. Each segment starts with a letter and cannot end in a hyphen. IDs are case-sensitive; uppercase letters are allowed.

On a case-insensitive filesystem, EXM rejects an install whose target directory collides with a differently cased ID; it does not replace the existing extension. The registry's file storage preserves both identities independently.

EXM installs managed extensions into `<project>/extensions/<extensionId>`. This is EXM's directory convention, not a Vortex identity requirement: source directory names and package names may differ from the ID. Manually installed Vortex extensions can live in differently named directories.

Git installations validate identity before exposing the checkout as an extension. Updates of an existing Git checkout validate the incoming revision before changing its files. Cached subdirectory checkouts are isolated by project and extension ID, so updating one consumer leaves other installed consumers on their own revision. Changing a dependency's URL or ref uses the existing replacement behavior and can remove the old target before installation succeeds.

`exm` caches downloaded and extracted artifacts under `~/.exm/cache` by default. CI can persist that directory between runs, or set `EXM_CACHE_ROOT=<path>` to use a different cache directory such as a workspace-local `.exm/cache`.

For copied registry and `npm:` installs, `exm` records local installed artifact identity in `<project>/temp/.exm/install-state.json`; deleting that file forces one rebuild check without changing `exm-lock.yaml`.

## Publishing Extensions

`exm publish` reads the exm registry server from `package.json#exm.registry`, unless `--registry` is provided. It still deploys and packs locally, but the registry server owns artifact upload and package metadata updates.

Publishing uses `vortex.extensionId` as the registry identity. The source package name selects the pnpm workspace package and is preserved in the artifact:

```json
{
  "name": "@org/source-package",
  "vortex": {
    "extensionId": "org.some-extension"
  },
  "exm": {
    "registry": "https://exm.example/"
  }
}
```

Every extension must declare `vortex.extensionId`. The removed `exm.registryPackageName` and `exm.extensionId` fields are rejected when deploying or publishing. EXM does not derive the ID from `name` or rewrite `name` in the generated artifact.

From either the workspace root or the target package root:

```bash
exm deploy @scope/extension-name
exm publish @scope/extension-name --dry-run
exm publish @scope/extension-name --registry https://exm.example/
exm publish @scope/extension-name
```

Use `--dry-run` to validate the package and print the planned remote URLs without publishing.

### Migrating existing projects

Publish each extension under its manifest ID, remove the two old publishing fields, and change project dependency keys to those IDs. Replace `exm:@org/package@^1.0.0` with `^1.0.0`. Update local override keys and any paths that refer to EXM-managed directories.

Old registry names are not aliases for extension IDs. Existing artifacts must be published under the new identity before a registry installation can succeed. Remove obsolete lock entries and regenerate them after publication; do not reuse an old artifact's integrity for a changed manifest. With a local override, installation generates `exm-lock.local.yaml` instead of the shared registry lock.

Remove old managed directories after verifying their contents or link targets, so Vortex does not discover duplicate copies of an extension during the migration. This directory cleanup is a project migration step; EXM does not delete arbitrary unmanaged extensions.

## Registry Server

The registry server lives in `packages/exm-registry-server`. It exposes npm-compatible read endpoints and a small exm publish API:

```text
GET  /org.some-extension
GET  /org.some-extension/<version>/extension.tgz
GET  /-/v1/search?text=...
GET  /-/all
POST /-/exm/v1/publish/plan
PUT  /-/exm/v1/publish?name=org.some-extension&version=1.2.3
```

The package metadata response includes npm-compatible `name`, `versions`, `dist.tarball`, and `dist.integrity`, plus `exm.artifact` metadata with `type`, `path`, `integrity`, and `size`.

Server configuration can live in YAML. The server auto-loads `exm-registry-server.yaml` or `exm-registry-server.yml` from the current directory, or you can pass `--config <path>`:

```yaml
publicUrl: http://localhost:4873/

listen:
  host: 0.0.0.0
  port: 4873

storage:
  kind: file
  root: /data
```

Start it after building:

```bash
pnpm --filter @bsgames/exm-registry-server build
pnpm --filter @bsgames/exm-registry-server start -- --config packages/exm-registry-server/exm-registry-server.example.yaml
```

Or run it with Docker:

```bash
docker build -f packages/exm-registry-server/Dockerfile -t bsgames/exm-registry-server:local .
docker run --rm -p 4873:4873 -v exm-registry-data:/data -e EXM_REGISTRY_PUBLIC_URL=http://localhost:4873/ bsgames/exm-registry-server:local
# or
docker compose -f packages/exm-registry-server/docker-compose.example.yml up --build
```

Environment variables override YAML values:

```bash
EXM_REGISTRY_PUBLIC_URL=http://localhost:4873/
EXM_REGISTRY_STORAGE_KIND=file
EXM_REGISTRY_FILE_ROOT=/data
EXM_REGISTRY_SERVER_CONFIG=/etc/exm/exm-registry-server.yaml
```

File storage writes package metadata and search documents under `<root>/metadata` and `extension.tgz` artifacts under `<root>/artifacts`. v1 is designed for one server process writing one storage root. Nexus Raw remains available as an optional backend by setting `storage.kind: nexus` and the `EXM_NEXUS_*` variables.

Publish uses an in-memory per-package lock, so v1 protects a single server instance from same-package lost updates. If artifact upload succeeds but metadata update fails, v1 may leave an orphan artifact in the artifact storage directory.

## Registry Auth

Clients authenticate to the exm registry server URL if needed. When file storage is used, the server does not need backend repository credentials. When Nexus storage is configured, the server authenticates to Nexus using its own environment variables, so normal clients still do not need backend repository URLs in their exm config.
