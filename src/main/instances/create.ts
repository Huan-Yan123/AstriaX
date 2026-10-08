import { cpSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { allocate, OccupancyProbe, PortRangeExhausted } from '../ports/allocator'
import { PORT_RANGE, TEMPLATE_VERSION, type InstanceType } from '../constants'
import type { InstanceRepo } from '../store/instance-repo'

export class TemplateNotReady extends Error {
  constructor(type: InstanceType, edition: string) {
    super(
      edition === 'pull'
        ? '运行时模板尚未就绪，请先联网下载（首次启动引导）'
        : '离线包内运行时模板缺失，安装包可能被损坏'
    )
    this.name = 'TemplateNotReady'
    void type
  }
}

export interface TemplateInfo {
  templatesRoot: string
  type: InstanceType
  edition: 'bundled' | 'pull'
}

/** 模板目录命名约定：安装目录 resources/templates/<astrbot|napcat>-template */
export function templatePath(templatesRoot: string, type: InstanceType): string {
  const name = type === 'a' ? 'astrbot-template' : 'napcat-template'
  return join(templatesRoot, name)
}

export function assertTemplateReady(t: TemplateInfo): void {
  if (!existsSync(templatePath(t.templatesRoot, t.type))) {
    throw new TemplateNotReady(t.type, t.edition)
  }
}

export interface CreateInstanceParams {
  type: InstanceType
  name: string
  templatesRoot: string
  dataRoot: string
  repo: InstanceRepo
  probe: OccupancyProbe
  edition: 'bundled' | 'pull'
}

export async function createInstance(p: CreateInstanceParams) {
  assertTemplateReady({
    templatesRoot: p.templatesRoot,
    type: p.type,
    edition: p.edition
  })

  // 端口：段内跳过仓库已占 + 系统实占
  const taken = p.repo.list().map((x) => x.port)
  const port = await allocate(p.probe, [PORT_RANGE.min, PORT_RANGE.max], taken)

  const rec = p.repo.create({
    type: p.type,
    name: p.name,
    allocatePort: () => port
  })

  mkdirSync(join(rec.dir, 'data'), { recursive: true })
  cpSync(templatePath(p.templatesRoot, p.type), join(rec.dir, 'runtime'), {
    recursive: true
  })

  writeFileSync(
    join(rec.dir, 'instance.json'),
    JSON.stringify(
      {
        id: rec.id,
        type: rec.type,
        name: rec.name,
        templateVersion: TEMPLATE_VERSION,
        port: rec.port,
        createdAt: rec.createdAt
      },
      null,
      2
    ),
    'utf8'
  )
  return rec
}

export { PortRangeExhausted }
