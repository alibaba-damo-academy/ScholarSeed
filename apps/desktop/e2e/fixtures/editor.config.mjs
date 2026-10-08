import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('../../../../tmp/editor-fixture', import.meta.url)),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./editor.tsx', import.meta.url)),
      name: 'EditorFixture',
      formats: ['iife'],
      fileName: () => 'editor.js'
    }
  }
})
