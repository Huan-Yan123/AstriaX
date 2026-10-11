export interface PythonStatus {
  ready: boolean
  version: string
  exe?: string
  source?: 'system' | 'manual' | 'bundled' | 'none'
  reason?: string
}
export interface PythonDownloadRequest { base: string; version: string }
export interface PythonDownloadSource { label: string; base: string; builtin?: boolean }
export interface PythonDownloadSourceState { sources: PythonDownloadSource[]; pref: string }
export interface PythonDownloadVersion { version: string; assetName: string; assetUrl: string; base: string }
export interface PythonSourceHealth { base: string; status: 'ok' | 'unstable' | 'down'; ms: number | null; successes: number; attempts: number; reason?: string }
export interface PythonDownloadApi {
  versions(p: { base: string; noCache?: boolean }): Promise<{ versions: PythonDownloadVersion[]; warning?: string }>
  sources: {
    state(): Promise<PythonDownloadSourceState>
    add(p: { label: string; base: string }): Promise<PythonDownloadSourceState>
    remove(base: string): Promise<PythonDownloadSourceState>
    pref(base: string): Promise<PythonDownloadSourceState>
    test(): Promise<PythonSourceHealth[]>
  }
}
