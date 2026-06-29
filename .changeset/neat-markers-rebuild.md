---
"@bsgames/exm": patch
---

Track copied install state in project temp data so `exm install` and `exm update` rebuild stale `exm:` and `npm:` extension directories instead of trusting lock/spec matches alone.
