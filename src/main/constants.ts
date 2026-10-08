// 规格全局常量：数值一律以规格为准，改动要回写规格
export const PORT_RANGE_A = { min: 6100, max: 6199 } as const // AstrBot 段
export const PORT_RANGE_N = { min: 6200, max: 6299 } as const // NapCat 段
export const PORT_RANGE = { min: PORT_RANGE_A.min, max: PORT_RANGE_N.max } as const // 全局覆盖（迁移/统计用）
export const BACKUP_KEEP_DEFAULT = 5
export const TEMPLATE_VERSION = 1 // 模板结构版本，模板内容升级时递增
export type InstanceType = 'a' | 'n' // a=AstrBot  n=NapCat
export const INSTANCE_DIR_PREFIX: Record<InstanceType, string> = { a: 'a_', n: 'n_' }

/**
 * 重置凭据时的固定值（用户点「重置」后拿到的就是这两个，好记）。
 *
 * AstrBot 重置后**用户名和密码都是 astrbot**（用户明确要求，比 admin/mx123456 好记）。
 *
 * NapCat 的 token 走两个途径同时生效：
 * - 环境变量 NAPCAT_WEBUI_SECRET_KEY（启动时 NapCat 会采用它并写回配置）
 * - <工作目录>\config\webui.json 的 token 字段（明文，可直接读）
 * 两者必须一致，否则重置后配置文件和实际生效值会对不上。
 */
export const ASTRBOT_DEFAULT_USER = 'astrbot'
export const ASTRBOT_DEFAULT_PASSWORD = 'astrbot'
export const NAPCAT_DEFAULT_TOKEN = '114514'
