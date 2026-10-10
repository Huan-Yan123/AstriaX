export interface LauncherTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, handler: (...args: any[]) => void): void
  removeListener(channel: string, handler: (...args: any[]) => void): void
}
export const createLauncherApi = (transport: LauncherTransport) => ({
  ping: () => transport.invoke('app:ping'),
  windowCtl: {
    minimize: () => transport.invoke('window:minimize'),
    toggleMaximize: () => transport.invoke('window:toggleMaximize'),
    close: () => transport.invoke('window:close')
  },
  paths: {
    defaults: () => transport.invoke('paths:defaults')
  },
  instance: {
    list: () => transport.invoke('instance:list'),
    create: (p: unknown) => transport.invoke('instance:create', p),
    start: (id: string) => transport.invoke('instance:start', id),
    stop: (id: string) => transport.invoke('instance:stop', id),
    remove: (id: string) => transport.invoke('instance:remove', id),
    creds: (id: string) => transport.invoke('instance:creds', id),
    resetCreds: (id: string) => transport.invoke('instance:resetCreds', id),
    log: (id: string) => transport.invoke('instance:log', id),
    backup: (id: string) => transport.invoke('backup:make', id),
    setRuntime: (p: { id: string; tag: string; type: 'a' | 'n' }) =>
      transport.invoke('instance:setRuntime', p),
    update: (id: string) => transport.invoke('instance:update', { id })
  },
  config: {
    get: () => transport.invoke('config:get'),
    set: (p: unknown) => transport.invoke('config:set', p),
    moveDataDir: (target: string) => transport.invoke('config:moveDataRoot', target),
    moving: () => transport.invoke('config:moving')
  },
  dialog: {
    pickDataDir: () => transport.invoke('dialog:pickDataDir')
  },
  stats: {
    overview: () => transport.invoke('stats:overview')
  },
  webui: {
    open: (id: string) => transport.invoke('webui:open', id),
    close: (id: string) => transport.invoke('webui:close', id),
    list: () => transport.invoke('webui:list'),
    visible: () => transport.invoke('webui:visible'),
    onClosed: (cb: () => void) => {
      const h = (): void => cb()
      transport.on('webui:closed', h)
      return () => transport.removeListener('webui:closed', h)
    }
  },
  logs: {
    exportZip: () => transport.invoke('logs:export'),
    exportBusy: () => transport.invoke('logs:exportBusy')
  },
  downloadSessions: () => transport.invoke('download:sessions'),
  shell: {
    showItem: (p: string) => transport.invoke('shell:showItem', p)
  },
  audit: {
    days: () => transport.invoke('audit:days'),
    read: (date?: string) => transport.invoke('audit:read', date)
  },
  templates: {
    status: () => transport.invoke('templates:status'),
    download: (type: 'a' | 'n') => transport.invoke('templates:download', type)
  },
  versions: {
    list: (p: unknown) => transport.invoke('versions:list', p),
    prewarm: () => transport.invoke('versions:prewarm')
  },
  runtime: {
    install: (p: unknown) => transport.invoke('runtime:install', p)
  },
  runtimes: {
    list: () => transport.invoke('runtimes:list'),
    remove: (p: unknown) => transport.invoke('runtimes:remove', p),
    pickFile: () => transport.invoke('runtimes:pickFile'),
    probeFile: (file: string) => transport.invoke('runtimes:probeFile', file),
    importFile: (p: unknown) => transport.invoke('runtimes:importFile', p),
    cancel: (p: { type: 'a' | 'n' | 'python'; tag: string }) => transport.invoke('runtimes:cancel', p),
    installPip: (p: { tag: string; packageSpec: string }) =>
      transport.invoke('runtime:installPip', p)
  },
  python: {
    status: () => transport.invoke('python:status'),
    install: () => transport.invoke('python:install'),
    discover: () => transport.invoke('python:discover'),
    select: (path: string) => transport.invoke('python:select', path),
    pickFile: () => transport.invoke('python:pickFile')
  },
  onDownloadProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown): void => cb(p)
    transport.on('download:progress', handler)
    return () => transport.removeListener('download:progress', handler)
  },
  mirrors: {
    test: () => transport.invoke('mirrors:test'),
    state: () => transport.invoke('mirrors:state'),
    add: (m: unknown) => transport.invoke('mirrors:add', m),
    remove: (base: string) => transport.invoke('mirrors:remove', base),
    pref: (patch: unknown) => transport.invoke('mirrors:pref', patch)
  },
  pysrc: {
    state: () => transport.invoke('pysrc:state'),
    test: () => transport.invoke('pysrc:test'),
    pref: (label: string) => transport.invoke('pysrc:pref', label),
    add: (s: unknown) => transport.invoke('pysrc:add', s),
    remove: (indexUrl: string) => transport.invoke('pysrc:remove', indexUrl)
  },
  backups: {
    list: () => transport.invoke('backup:list'),
    del: (file: string) => transport.invoke('backup:del', file),
    restore: (args: unknown) => transport.invoke('backup:restore', args),
    openFolder: (folder: string) => transport.invoke('backup:openFolder', folder),
    updateList: () => transport.invoke('backup:updateList')
  },
  app: {
    qqStatus: () => transport.invoke('qq:status'),
    openExternal: (url: string) => transport.invoke('app:openExternal', url),
    version: () => transport.invoke('app:version'),
    installUpdate: () => transport.invoke('app:installUpdate'),
    pendingUpdate: () => transport.invoke('app:pendingUpdate'),
    lastCrash: () => transport.invoke('app:lastCrash'),
    checkUpdate: (p?: { force?: boolean }) => transport.invoke('app:checkUpdate', p),
    downloadUpdate: (p: { url: string; version: string; sha256?: string }) =>
      transport.invoke('app:downloadUpdate', p),
    skipVersion: (v: string) => transport.invoke('app:skipVersion', v),
    onUpdateProgress: (cb: (p: { percent: number; got: number; total?: number }) => void) => {
      const handler = (_e: unknown, p: { percent: number; got: number; total?: number }): void => cb(p)
      transport.on('update:progress', handler)
      return () => transport.removeListener('update:progress', handler)
    }
  },
  onAskClose: (cb: () => void) => {
    const handler = (): void => cb()
    transport.on('close:ask', handler)
    return () => transport.removeListener('close:ask', handler)
  },
  answerClose: (v: 'tray' | 'quit') => transport.send('close:answer', v)
})
