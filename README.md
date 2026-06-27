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
      "some-extension": "exm:@org/some-extension@^1.0.0",
      "local-tool": "link:../local-tool",
      "git-tool": "git+https://github.com/org/repo.git#main:extensions/tool"
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

Dependency keys are extension ids and must be single directory names. Installed extensions always go to `<project>/extensions/<extension-id>`.

## Publishing Extensions

`exm publish` reads the exm registry server from `package.json#exm.registry`. It still deploys and packs locally, but the registry server owns artifact upload and package metadata updates.

From either the workspace root or the target package root:

```bash
exm deploy @scope/extension-name
exm publish @scope/extension-name --dry-run
exm publish @scope/extension-name
```

Use `--dry-run` to validate the package and print the planned remote URLs without publishing.

## Registry Server

The registry server lives in `packages/exm-registry-server`. It exposes npm-compatible read endpoints and a small exm publish API:

```text
GET  /@scope%2fpkg
GET  /@scope/pkg
GET  /@scope/pkg/<version>/extension.tgz
GET  /-/v1/search?text=...
GET  /-/all
POST /-/exm/v1/publish/plan
PUT  /-/exm/v1/publish?name=@scope/pkg&version=1.2.3
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
