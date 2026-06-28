import { performance } from 'node:perf_hooks';

export function nowMs(): number {
  return performance.now();
}

export function elapsedMs(startMs: number): number {
  return performance.now() - startMs;
}

export function formatDurationMs(durationMs: number): string {
  return `${Math.round(durationMs)}ms`;
}
