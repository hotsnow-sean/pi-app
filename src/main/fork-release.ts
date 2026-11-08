/**
 * 本 fork 的发布源。
 *
 * 上游默认值是 `justhil/pi-app`。fork 版装在自己机器上后如果还指向上游，一旦上游发了
 * 0.7.8 / 0.8.0，应用就会提示「有新版本」并把用户引去装一个不含插件系统的官方包——
 * 等于把 fork 的功能卸掉。所以默认值改成 fork 自己的仓库：检查更新、下载安装包、
 * 「打开发布页」三处都只认它。
 *
 * `PI_DESKTOP_GITHUB_REPO` 仍然优先，留给调试和临时验证（比如想看看上游有没有新版）。
 */
export const FORK_RELEASE_REPO = 'hotsnow-sean/pi-app'

export function releaseRepoSlug(): string {
  return (process.env.PI_DESKTOP_GITHUB_REPO || FORK_RELEASE_REPO).trim()
}
