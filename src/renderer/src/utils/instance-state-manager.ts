/**
 * 实例状态同步管理器
 * 解决 busyIds/updatingIds/switching 不同步的问题
 */
export interface InstanceState {
  busy: boolean
  updating: boolean
  switching: 'starting' | 'stopping' | null
}

export class InstanceStateManager {
  private states = new Map<string, InstanceState>()

  /**
   * 获取实例状态
   */
  getState(id: string): InstanceState {
    return this.states.get(id) ?? {
      busy: false,
      updating: false,
      switching: null
    }
  }

  /**
   * 设置忙碌状态
   */
  setBusy(id: string, busy: boolean): void {
    const state = this.getState(id)
    this.states.set(id, { ...state, busy })
    
    // 忙碌状态清除时，同时清除其他状态
    if (!busy) {
      this.states.set(id, {
        busy: false,
        updating: false,
        switching: null
      })
    }
  }

  /**
   * 设置更新状态
   */
  setUpdating(id: string, updating: boolean): void {
    const state = this.getState(id)
    this.states.set(id, { ...state, updating })
    
    // 更新开始时自动设置忙碌
    if (updating) {
      this.setBusy(id, true)
    }
  }

  /**
   * 设置切换状态
   */
  setSwitching(id: string, switching: 'starting' | 'stopping' | null): void {
    const state = this.getState(id)
    this.states.set(id, { ...state, switching })
    
    // 切换开始时自动设置忙碌
    if (switching !== null) {
      this.setBusy(id, true)
    }
  }

  /**
   * 清除实例的所有状态
   */
  clear(id: string): void {
    this.states.delete(id)
  }

  /**
   * 清除所有状态
   */
  clearAll(): void {
    this.states.clear()
  }

  /**
   * 获取所有忙碌的实例 ID
   */
  getBusyIds(): Set<string> {
    return new Set(
      Array.from(this.states.entries())
        .filter(([_, state]) => state.busy)
        .map(([id]) => id)
    )
  }

  /**
   * 获取所有更新中的实例 ID
   */
  getUpdatingIds(): Set<string> {
    return new Set(
      Array.from(this.states.entries())
        .filter(([_, state]) => state.updating)
        .map(([id]) => id)
    )
  }
}
