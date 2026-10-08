import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

function warningsOnly(config) {
  return {
    ...config,
    rules: Object.fromEntries(
      Object.entries(config.rules ?? {}).map(([name, setting]) => [
        name,
        Array.isArray(setting)
          ? ['warn', ...setting.slice(1)]
          : setting === 'off'
            ? 'off'
            : 'warn',
      ])
    ),
  }
}

export default tseslint.config(
  { ignores: ['out/', 'coverage/', 'node_modules/', '*.config.*', 'scripts/', '**/*.js', '**/*.mjs', '**/*.cjs'] },
  warningsOnly(js.configs.recommended),
  ...tseslint.configs.recommended.map(warningsOnly),
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: Object.fromEntries(
        [
          'console', 'document', 'window', 'navigator', 'location', 'history',
          'HTMLElement', 'HTMLDivElement', 'HTMLButtonElement', 'HTMLInputElement',
          'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLAnchorElement',
          'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'PointerEvent',
          'FocusEvent', 'DragEvent', 'ClipboardEvent', 'WheelEvent', 'InputEvent',
          'requestAnimationFrame', 'cancelAnimationFrame',
          'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
          'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
          'fetch', 'Headers', 'Request', 'Response',
          'FormData', 'File', 'FileList', 'Blob',
          'ReadableStream', 'WritableStream', 'TransformStream',
          'TextDecoder', 'TextEncoder',
          'Intl', 'performance', 'crypto',
          'localStorage', 'sessionStorage',
          'atob', 'btoa', 'structuredClone',
          'queueMicrotask', 'reportError',
          'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
          'ImageBitmap', 'OffscreenCanvas', 'CanvasRenderingContext2D',
          'Worker', 'SharedWorker', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
          'DOMParser', 'XMLSerializer',
          'getComputedStyle', 'matchMedia',
          'openDatabase', 'indexedDB',
          'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Promise', 'Proxy', 'Reflect',
          'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
          'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array',
          'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
          'BigInt', 'BigInt64Array', 'BigUint64Array',
          'globalThis', 'self',
        ].map((name) => [name, 'readonly'])
      ),
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      'no-undef': 'off',
      'no-prototype-builtins': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
)
