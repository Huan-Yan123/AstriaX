#!/usr/bin/env node
// 只配置当前项目；证书选项只传给安装子进程。
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const root = join(__dirname, '..')
const pkg = require('../package.json')

if (Number(process.versions.node.split('.')[0]) !== 24 ||
    Number(process.versions.node.split('.')[1]) < 15) {
  console.error('请先安装 .node-version 指定的 Node.js 24.15.0（支持 24.15+ 的 24.x）。')
  process.exit(1)
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const command = process.platform === 'win32' ? 'cmd.exe' : pnpm
const prefix = process.platform === 'win32' ? ['/d', '/c', pnpm] : []
const version = spawnSync(command, [...prefix, '--version'], {
  cwd: root, encoding: 'utf8', windowsHide: true
})
if (version.status !== 0 || version.stdout.trim() !== pkg.packageManager.split('@')[1]) {
  console.error(`请先执行 npm install --global ${pkg.packageManager}，再重新运行本脚本。`)
  process.exit(1)
}

const installed = spawnSync(command, [...prefix, 'install', '--frozen-lockfile'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --use-system-ca`.trim()
  }
})
if (installed.status !== 0) {
  console.error('依赖安装失败。请检查网络连接与系统证书信任链，处理上述安装错误后重试。')
  process.exit(installed.status || 1)
}

// 新版 Electron 在首次 require 时才自动下载，初始化阶段显式安装以保留证书设置。
const electronInstalled = spawnSync(process.execPath, [join(root, 'node_modules', 'electron', 'install.js')], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --use-system-ca`.trim() }
})
if (electronInstalled.status !== 0) process.exit(electronInstalled.status || 1)

const checked = spawnSync(process.execPath, [join(__dirname, 'doctor.cjs')], {
  cwd: root, stdio: 'inherit', windowsHide: true
})
process.exit(checked.status || (checked.error ? 1 : 0))
