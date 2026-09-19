export const BROWSER_NODE_RELATIVE: string
export const BUNDLED_PYTHON_RELATIVE: string
export const BROWSER_NODE_ENV: string
export function browserEnvironment(environment: NodeJS.ProcessEnv, resourcesRoot: string, python: string, packaged?: boolean): NodeJS.ProcessEnv
