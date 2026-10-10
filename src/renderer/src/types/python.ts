export interface PythonStatus {
  ready: boolean
  version: string
  exe?: string
  source?: 'system' | 'manual' | 'bundled' | 'none'
  reason?: string
}
