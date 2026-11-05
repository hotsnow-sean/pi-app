/**
 * 回话测试插件（e2e fixture）。
 *
 * 唯一职责：证明 `ctx.sessions.send` 这条链路真的通——
 *   工具被调用（worker 带 sessionFile 过来）→ 插件把消息投回那个会话
 *   → 宿主驱动新一轮 → 模型在下一轮请求里读到这条消息。
 *
 * 不写存储、不做 UI：任何多余行为都会让 e2e 的失败原因变模糊。
 */

let ctx = null

export async function activate(pluginCtx) {
  ctx = pluginCtx
  return {
    invoke: async (method, params) => {
      if (method !== 'tool.execute') return { text: `unknown method ${method}`, isError: true }
      if (params?.name !== 'ping_back') return { text: `unknown tool ${params?.name}`, isError: true }
      const sessionFile = String(params.sessionFile || '')
      if (!sessionFile) return { text: 'sessionFile not passed to the plugin', isError: true }
      try {
        await ctx.sessions.send({
          sessionFile,
          content: '【回话测试】后台任务回报已送达',
          origin: { pluginId: 'ping-back', label: '回话测试', kind: 'report' },
        })
      } catch (error) {
        return { text: `send failed: ${error?.message ?? error}`, isError: true }
      }
      return { text: 'sent' }
    },
  }
}
