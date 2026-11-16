import fs from 'node:fs/promises'

const OPENUI_BOOTSTRAP = /[/\\]@openuidev[/\\]react-lang[/\\]dist[/\\]index\.(?:mjs|cjs)$/
const ENVIRONMENT = /process\.env\.NODE_ENV/g

export const OPENUI_PRIMITIVES = [
  '@openuidev/react-ui/Charts/BarChart',
  '@openuidev/react-ui/Charts/LineChart',
  '@openuidev/react-ui/Charts/PieChart',
  '@openuidev/react-ui/Table',
  '@openuidev/react-ui/ThemeProvider',
]

export function closedOpenUI() {
  return {
    name: 'scholarseed-openui-no-devtools',
    setup(builder) {
      builder.onLoad({ filter: OPENUI_BOOTSTRAP }, async ({ path }) => ({
        contents: (await fs.readFile(path, 'utf8')).replace(ENVIRONMENT, '"production"'),
        loader: 'js',
      }))
    },
  }
}

