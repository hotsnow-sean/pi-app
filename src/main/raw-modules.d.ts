// Vite `?raw` imports (bundled text assets) used by the main process.
declare module '*.md?raw' {
  const text: string
  export default text
}

/** 插件面板桥脚本：构建期内联成字符串，运行时不读磁盘（避开 asar / chunk 路径问题） */
declare module '*.js?raw' {
  const text: string
  export default text
}
