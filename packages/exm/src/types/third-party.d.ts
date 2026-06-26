declare module 'pacote' {
  const pacote: unknown;
  export default pacote;
}

declare module 'semver' {
  const semver: unknown;
  export default semver;
}

declare module '@npmcli/config' {
  const Config: unknown;
  export default Config;
}

declare module '@npmcli/config/lib/definitions/index.js' {
  export const definitions: Record<string, unknown>;
  export const shorthands: Record<string, readonly string[]>;
  export const nerfDarts: readonly string[];
  export function flatten(input: Record<string, unknown>, output?: Record<string, unknown>): Record<string, unknown>;
}

declare module 'npm-registry-fetch' {
  const registryFetch: unknown;
  export default registryFetch;
}
