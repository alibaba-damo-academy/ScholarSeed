import type { PluginObj, TransformOptions } from '@babel/core'

declare const localizationDom: () => PluginObj
export declare function developmentLocalization(command: 'build' | 'serve'): TransformOptions | undefined

export default localizationDom
