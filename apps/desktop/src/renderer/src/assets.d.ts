/// <reference types="vite/client" />

// Ambient declarations for static asset imports (Vite resolves these to URLs).
// Kept in a script-context .d.ts (no top-level import/export) so the wildcard
// module declaration is global.

declare module '*.png' {
  const src: string
  export default src
}
