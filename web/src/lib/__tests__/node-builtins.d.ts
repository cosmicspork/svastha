// Ambient declarations for the couple of Node builtins import.test.ts needs
// to load the committed zip fixture from disk. tsconfig.app.json typechecks
// against DOM libs only (see sync.test.ts's `setImmediate` comment on why) —
// this is the same idea, kept in its own file (with no top-level
// import/export) so `declare module` here is a fresh ambient declaration
// rather than an "augmentation" of an already-open import elsewhere, which TS
// rejects when the base module can't be resolved.
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...paths: string[]): string
}
