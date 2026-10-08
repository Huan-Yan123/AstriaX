import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { captureStartupFailure } from '../../src/main/logs/startup-failure'
import { testStage } from '../helpers/stage'

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('startup failure report', () => {
  it('writes the stack, synchronously packages it, and returns the exact zip path for the dialog', () => {
    root = testStage('startup-report-')
    const zipPath = join(root, 'logs-export', 'astriax-logs-test.zip')
    let packaged = false
    const result = captureStartupFailure({
      dataRoot: root,
      error: new Error('window creation failed'),
      version: '0.2.1',
      log: () => undefined,
      exportZipSync: () => {
        packaged = true
        return zipPath
      }
    })

    expect(packaged).toBe(true)
    expect(readFileSync(join(root, 'startup-error.txt'), 'utf8')).toContain('window creation failed')
    expect(result.message).toContain(zipPath)
    expect(result.zipPath).toBe(zipPath)
  })

  it('reports raw log paths when synchronous packaging fails', () => {
    root = testStage('startup-report-fail-')
    const result = captureStartupFailure({
      dataRoot: root,
      error: new Error('cannot create window'),
      version: '0.2.1',
      log: () => undefined,
      exportZipSync: () => { throw new Error('zip unavailable') }
    })

    expect(result.zipPath).toBeUndefined()
    expect(result.message).toContain(join(root, 'startup-error.txt'))
    expect(result.message).toContain(join(root, 'logs'))
    expect(existsSync(join(root, 'startup-error.txt'))).toBe(true)
  })
})
