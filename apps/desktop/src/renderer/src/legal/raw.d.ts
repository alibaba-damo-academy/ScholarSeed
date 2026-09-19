// tsconfig.web.json 的 types 只装了 node，没有 vite/client，所以 Vite 的 `?raw`
// 导入在类型层面是未知模块。这里只补法务文档用到的这一种后缀。
declare module '*.md?raw' {
  const content: string
  export default content
}
