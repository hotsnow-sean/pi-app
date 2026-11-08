import './bootstrap-path'
import { app, shell, type BrowserWindow, dialog, session, Menu } from 'electron'
import { registerPluginProtocolScheme } from './plugins/protocol'
import { isPluginUiUrl } from '@shared/plugin-panel-url'
import { createWindow, getMainWindow } from './window'
import { refreshGitWorkspaceWatch } from './git-workspace-watch'
import { releaseSessionTailsForSender } from './session-tails'
import { registerAllHandlers } from './ipc'
import { workerManager } from './worker-manager'
import { sessionPreviewProcess } from './session-preview-process'
import { guardAppQuit, setRunningTerminalsProbe } from './window-close-guard'
import { runningTerminalCount, shutdownTerminals } from './terminal/terminal-service'
import { configStore } from './config-store'
import { scheduleStartupWarmupFallback } from './startup-warmup'
import { bindWslPersistence } from './wsl/wsl-env'
import { is } from '@electron-toolkit/utils'
import { destroyAppTray, ensureAppTray, focusMainWindow } from './tray'
import {
  disposeCompletionNotifications,
  initializeCompletionNotifications,
} from './completion-notification'
import { notifyForegroundChanged } from './completion-notification-events'
import { disposeCompletionDelivery, focusCompletionNotificationHost } from './completion-notification-delivery'
import { isCompletionNotificationShortcut } from './completion-notification-shortcut'
// Prevent EPIPE / write errors from crashing the main process
process.stdout?.on?.('error', () => {})
process.stderr?.on?.('error', () => {})

// 开发期调试端口：仅在非打包且显式指定端口时开启（用于插件面板/iframe 的 CDP 检查）
if (!app.isPackaged && process.env.PI_DEVTOOLS_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PI_DEVTOOLS_PORT)
}
process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return
  console.error('[Main] Uncaught exception:', err)
  try {
    const win = getMainWindow()
    const msg = err instanceof Error ? err.message : String(err)
    const opts = {
      type: 'error' as const,
      title: 'pi Desktop',
      message: 'A critical error occurred. Please restart the app.',
      detail: msg.slice(0, 500),
    }
    if (win && !win.isDestroyed()) void dialog.showMessageBox(win, opts)
    else void dialog.showMessageBox(opts)
  } catch (e) {
    /* dialog unavailable during early boot */
  }
  setTimeout(() => app.quit(), 2000)
})

function attachCompletionNotificationShortcut(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (!isCompletionNotificationShortcut(input)) return
    if (focusCompletionNotificationHost()) event.preventDefault()
  })
}

/**
 * 会话文件监听的句柄回收。
 *
 * 按窗口记账的订阅必须在窗口消失时收回，否则 main 侧会留一个永远不会退订的
 * `fs.watch`，对着一个可能已经没人看的会话每 1.2 秒 stat 一次。
 *
 * 除 `destroyed` 外还要盯 `did-navigate`：reload 后 webContents id 不变，
 * 订阅关系看起来「还活着」，但新页面根本没打开任何预览——这种残留最容易被忽略。
 */
function attachSessionTailCleanup(win: BrowserWindow): void {
  win.webContents.on('destroyed', () => releaseSessionTailsForSender(win.webContents))
  win.webContents.on('did-navigate', () => releaseSessionTailsForSender(win.webContents))
}

function createMenu(): void {
  // macOS keeps a minimal app menu (system convention); Windows/Linux remove the menu bar entirely.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
        { role: 'help', submenu: [{ label: 'Documentation', click: () => shell.openExternal('https://pi.dev') }] },
      ] as Electron.MenuItemConstructorOptions[]),
    )
    return
  }
  Menu.setApplicationMenu(null)
}

// pi-plugin:// scheme must be registered before app ready
registerPluginProtocolScheme()

// Built-in browser: never advertise automation. Chromium sets navigator.webdriver whenever a
// debugging/automation switch is present (e.g. a test harness); pages use it as a bot signal.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', focusMainWindow)
}

app.whenReady().then(() => {
  if (!gotLock) return
  if (process.env.PI_AUDIO_TRACE === '1' || process.env.PI_ALERT_TRACE === '1') {
    void import('./audio-trace').then(({ getAudioTraceLogHint }) => {
      console.log('[audio-trace] enabled — log file:', getAudioTraceLogHint())
    })
  }
  createMenu()
  const closeToTray = ensureAppTray() !== null
  initializeCompletionNotifications()

  // CSP: inject Content-Security-Policy header in production (skip dev for Vite HMR)
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // pi-plugin:// 的响应自带 CSP（见 plugins/protocol.ts），这里必须整份让给协议层。
      // 覆盖的后果不是「更严格」而是「桥脚本变跨源」：插件文档 origin 是
      // pi-plugin://<插件>，桥在 pi-plugin://__host，而应用级 CSP 的 script-src 只有
      // 'self' —— 安装版一开面板就是「插件桥未加载」。两份 CSP 并存也等于取交集，
      // 所以不能合并，只能跳过。
      if (isPluginUiUrl(details.url)) {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.github.com https://chatgpt.com; font-src 'self' data:; frame-src pi-plugin:"
            ]
        }
      })
    })
  }

  bindWslPersistence({
    get: (key) => configStore.get(key),
    set: (key, value) => configStore.set(key, value as never),
  })
  // WSL mode without a captured environment (first run after an upgrade): start capturing now so
  // it usually lands before the first WSL-aware dir lookup would have to block on wsl.exe.
  // Also boot the distro VM right away (async) so startup reads over \\wsl.localhost don't
  // have to boot it inside a synchronous fs call.
  {
    const runtime = configStore.get('agentRuntime')
    if (runtime?.mode === 'wsl' && runtime.distro) {
      const distro = runtime.distro
      void import('./wsl/wsl-env').then((m) => {
        void m.startWslVm(distro)
        if (!configStore.get('wslEnvCache')?.[distro]) void m.resolveWslEnv(distro)
      })
    }
  }
  registerAllHandlers()
  void import('./plugins/protocol').then((m) => m.registerPluginProtocolHandler())
  void import('./plugins/ipc').then(async (m) => {
    m.registerPluginHandlers()
    await m.activateEnabledPlugins()
  })
  void import('./clipboard-temp-images').then(({ pruneStaleClipboardImages }) => {
    try {
      pruneStaleClipboardImages()
    } catch (e) {
      console.warn('[clipboard-images] prune failed:', e)
    }
  })
  const win = createWindow(closeToTray)
  workerManager.setMainWindow(win)
  attachSessionTailCleanup(win)
  // Mobile gateway: only listens when the user left it on (Settings → 手机连接).
  void import('./remote-gateway-service').then((m) => m.startRemoteGatewayIfEnabled())
  attachCompletionNotificationShortcut(win)
  win.on('focus', () => notifyForegroundChanged())
  win.on('restore', () => notifyForegroundChanged())
  win.on('closed', disposeCompletionDelivery)
  void refreshGitWorkspaceWatch(win)
  // SDK / extension warm-up starts when the renderer reports its shell painted (app.shellReady);
  // the fallback covers a renderer that never gets there. See startup-warmup.ts.
  win.webContents.once('did-finish-load', () => scheduleStartupWarmupFallback())
  if (process.env.PI_E2E !== '1' && process.env.PI_E2E !== 'true') {
    win.once('show', () => {
      setTimeout(() => {
        import('./updater').then(({ initUpdater }) => initUpdater(win)).catch((e) => {
          console.warn('[Updater] Failed to initialize:', e)
        })
      }, 3000)
    })
  }

  // 不自动打开上次项目：进 app 显示空 Project Home，用户自行选择项目

  app.on('activate', () => {
    if (!getMainWindow()) {
      const w = createWindow(ensureAppTray() !== null)
      workerManager.setMainWindow(w)
      attachSessionTailCleanup(w)
      attachCompletionNotificationShortcut(w)
      w.on('focus', () => notifyForegroundChanged())
      w.on('restore', () => notifyForegroundChanged())
      w.on('closed', disposeCompletionDelivery)
    } else {
      focusMainWindow()
    }
  })
})

let isQuittingGracefully = false
let gracefulShutdownPromise: Promise<void> | null = null

/**
 * Force-quit mid-stream used to kill workers before abort could write a terminal
 * assistant leaf — reopen then showed empty unrewindable sessions.
 * Await abort+dispose flush on every quit path.
 */
function gracefulShutdownWorkers(): Promise<void> {
  return gracefulShutdownPromise ??= performGracefulShutdown()
}

async function performGracefulShutdown(): Promise<void> {
  isQuittingGracefully = true
  try {
    await import('./remote-gateway-service').then((m) => m.stopRemoteGateway()).catch(() => {})
    await workerManager.stop()
  } catch (error) {
    console.error('[Main] graceful worker stop failed:', error)
  } finally {
    sessionPreviewProcess.stop()
    disposeCompletionNotifications()
    shutdownTerminals()
  }
  try {
    const asr = await import('./asr/codex-asr-manager')
    asr.stopBuiltinCodexAsrServe()
  } catch {
    /* optional */
  }
}

setRunningTerminalsProbe(runningTerminalCount)

app.on('before-quit', (event) => {
  // A running turn must get the close-decision prompt first (tray Quit / Cmd+Q).
  // Keep the tray alive while the user decides so a hidden window remains reachable.
  if (!guardAppQuit(event)) return
  destroyAppTray()
  event.preventDefault()
  void gracefulShutdownWorkers().finally(() => {
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // before-quit will flush workers; do not fire-and-forget stop() here
    if (!isQuittingGracefully) {
      void gracefulShutdownWorkers().finally(() => app.quit())
    }
  } else {
    void gracefulShutdownWorkers()
  }
})
