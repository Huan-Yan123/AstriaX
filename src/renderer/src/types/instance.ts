export interface Instance {
  id: string
  name: string
  type: 'a' | 'n'
  status: string
  port: number
  runtimeVersion?: string
  /**
   * 绑定的运行时 tag（如 "v4.28.0"）。
   *
   * 由主进程在 instance:list 里补上（读 <实例目录>\instance.json 得来）——
   * 记录本身没这个字段，但「切到哪个版本」「删版本时谁在用」都要它。
   */
  runtimeTag?: string
}
