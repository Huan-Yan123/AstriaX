#!/usr/bin/env node
// 无网络、无写入：验证工具、Electron 可执行文件与资源清单。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.join(__dirname, '..')
const pkg = require('../package.json')
const resources = require('../resources.manifest.json')
let failures = 0

function check(label, fn) {
  try {
    const detail = fn()
    console.log(`[OK] ${label}${detail ? `: ${detail}` : ''}`)
  } catch (error) {
    failures++
    console.error(`[FAIL] ${label}: ${error.message}`)
  }
}

function commandVersion(command) {
  const isBatch = command.endsWith('.cmd')
  const result = spawnSync(isBatch ? 'cmd.exe' : command,
    isBatch ? ['/d', '/c', command, '--version'] : ['--version'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    timeout: 15000
  })
  if (result.error || result.status !== 0) throw new Error(`无法执行 ${command} --version`)
  return result.stdout.trim()
}

check('Node.js', () => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major !== 24 || minor < 15) throw new Error(`当前 ${process.version}；需要 ${pkg.engines.node}`)
  return process.version
})
check('pnpm', () => {
  const version = commandVersion(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  const expected = pkg.packageManager.split('@')[1]
  if (version !== expected) throw new Error(`当前 ${version}；需要 ${expected}`)
  return version
})
check('Git', () => commandVersion('git'))
check('Windows x64', () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`当前 ${process.platform}/${process.arch}；应用与真机测试面向 Windows x64`)
  }
  return `${process.platform}/${process.arch}`
})
check('直接依赖', () => {
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const name of Object.keys(dependencies)) {
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'))
    if (installed.name !== name || !installed.version) throw new Error(`依赖不完整：${name}`)
  }
  return `${Object.keys(dependencies).length} 项已安装`
})
check('Electron 二进制', () => {
  const electronRoot = path.join(root, 'node_modules', 'electron')
  const executableName = fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim()
  const exe = path.join(electronRoot, 'dist', executableName)
  if (typeof exe !== 'string' || !fs.existsSync(exe)) throw new Error('缺少二进制，请运行 pnpm dev:setup')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(exe, ['--version'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000, env
  })
  if (result.error || result.status !== 0) throw new Error('Electron 无法运行，请运行 pnpm dev:setup')
  const version = result.stdout.trim().replace(/^v/, '')
  const expected = require('electron/package.json').version
  if (version !== expected) throw new Error(`二进制 ${version} 与 npm 包 ${expected} 不一致`)
  return version
})

for (const [group, files] of Object.entries(resources.groups)) {
  check(`资源 ${group}`, () => {
    for (const file of files) {
      const absolute = path.resolve(root, file)
      if (!absolute.startsWith(root + path.sep)) throw new Error(`清单路径越界：${file}`)
      const data = fs.readFileSync(absolute)
      if (data.length === 0) throw new Error(`空文件：${file}`)
      if (file.endsWith('.png')) {
        if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
            data.readUInt32BE(16) === 0 || data.readUInt32BE(20) === 0) {
          throw new Error(`PNG 文件头异常：${file}`)
        }
      }
      if (file.endsWith('.webp') &&
          (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP')) {
        throw new Error(`WebP 文件头异常：${file}`)
      }
    }
    return `${files.length} 个文件完整`
  })
}

console.log('\n运行时资源：Python / AstrBot / NapCat 在应用的「资源与环境」页安装；NapCat 另需 QQNT。')
console.log('源码构建说明：README.md；资源清单：resources.manifest.json')
if (failures) {
  console.error(`\n发现 ${failures} 项环境问题。`)
  process.exitCode = 1
} else {
  console.log('\n开发环境检查通过。')
}
