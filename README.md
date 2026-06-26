# exm

`exm` is a small Cocos Creator extension manager. It installs project extensions into the fixed `extensions/` directory and can publish pnpm-deployed extension artifacts to an exm Raw registry such as Nexus Raw.

## Development

```bash
pnpm install
pnpm --filter @feb/exm build
pnpm --filter @feb/exm test
pnpm exec eslint packages/exm/src/*.ts packages/exm/src/**/*.ts packages/exm/test/*.ts
```

## Installing Extensions

Add exm config to the Cocos Creator project `package.json`:

```json
{
  "exm": {
    "registry": "http://nexus.example/repository/exm-registry/",
    "dependencies": {
      "addressable-assets": "exm:@feb/extension-addressable-assets@^0.0.1",
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

`exm publish` publishes to the exm Raw registry from `package.json#exm.registry`. It does not publish to npm.

From either the workspace root or the target package root:

```bash
exm deploy @scope/extension-name
exm publish @scope/extension-name --dry-run
exm publish @scope/extension-name
```

Publish flow:

1. Clean and regenerate `<target-package>/.deploy` with `pnpm deploy`.
2. Validate `.deploy/package.json` name and version.
3. Create a complete `extension.tgz` from `.deploy`, including `node_modules`.
4. Upload `extension.tgz` and update the package `index.json` in the Raw registry.

Dry-run performs deploy, packaging, hashing, and index validation, but does not upload anything. It prints the artifact URL, index URL, integrity, and size.

## Registry Auth

Raw registry reads may be anonymous, but publishing usually needs write auth. Configure it with `.npmrc`:

```ini
//nexus.example/repository/exm-registry/:username=exm-publisher
//nexus.example/repository/exm-registry/:_password=<base64-password>
//nexus.example/repository/exm-registry/:always-auth=true
```

For Nexus Raw, the publish user needs browse/read/add/edit permissions on the Raw repository because publish uploads a new artifact and updates `index.json`.
