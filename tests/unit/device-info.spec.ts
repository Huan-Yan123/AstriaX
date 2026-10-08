import { describe, expect, it } from 'vitest'
import { collectDeviceInfo } from '../../src/main/logs/device-info'

describe('device info report', () => {
  it('writes detected GPU into system-info hardware section', async () => {
    const report = await collectDeviceInfo({
      dataRoot: 'C:\\AstriaX\\data',
      run: async (_cmd, args) => {
        const command = args.join(' ')
        if (command.includes('Win32_VideoController')) {
          return { status: 0, stdout: 'NVIDIA GeForce RTX 4070 Laptop GPU' }
        }
        if (command.includes('Win32_OperatingSystem')) {
          return { status: 0, stdout: '16777216 5242880' }
        }
        if (command.includes('Get-PSDrive')) return { status: 0, stdout: '107374182400' }
        if (command.includes('Get-NetTCPConnection')) return { status: 0, stdout: '12' }
        return { status: 0, stdout: '' }
      }
    })

    expect(report).toContain('显卡: NVIDIA GeForce RTX 4070 Laptop GPU')
  })
})
