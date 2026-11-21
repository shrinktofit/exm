---
'@bsgames/exm': patch
---

Use the required manifest `vortex.extensionId` for registry publication and dependency identity while preserving the source package name. Registry dependency values now contain only versions or ranges; remove `exm.extensionId`, `exm.registryPackageName` and the old `exm:` dependency prefix. Validate installed manifests against dependency IDs for registry, npm, Git and local link sources.
