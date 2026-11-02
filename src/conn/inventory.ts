/**
 * 库存与容器跟踪: 玩家背包(窗口0) + 打开中的容器窗口。
 * 26.3 Slot 为组件式格式, 这里只取 itemId/count。
 */
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)
const mcData: any = require2('minecraft-data')('26.3')

export interface ItemStack {
  itemId: number
  name: string
  count: number
}

export interface OpenWindow {
  windowId: number
  type: number
  title: string
  slots: (ItemStack | null)[]
}

const itemNameById: Map<number, string> = (() => {
  const m = new Map<number, string>()
  for (const it of mcData.itemsArray ?? mcData.items ?? []) {
    if (it?.id !== undefined) m.set(it.id, it.name)
  }
  return m
})()

export function parseSlot (s: any): ItemStack | null {
  if (!s || typeof s !== 'object' || !s.itemId) return null
  return {
    itemId: s.itemId,
    name: itemNameById.get(s.itemId) ?? `item_${s.itemId}`,
    count: s.itemCount ?? 1,
  }
}

export class Inventory {
  stateId = 0
  /** 玩家窗口: 0-4合成区(0=产物) 5-8盔甲 9-35背包 36-44快捷栏 45副手 */
  slots: (ItemStack | null)[] = Array(46).fill(null)
  cursor: ItemStack | null = null
  windows = new Map<number, OpenWindow>()
  activeWindowId: number | null = null

  handleWindowItems (p: any) {
    if (process.env.MC_WIRE_DEBUG) console.log(`[window_items] window=${p.windowId} count=${p.items?.length ?? 0} stateId=${p.stateId}`)
    this.stateId = p.stateId ?? this.stateId
    const items = (p.items ?? []).map(parseSlot)
    if (p.windowId === 0) {
      this.slots = items.slice(0, 46)
      while (this.slots.length < 46) this.slots.push(null)
      this.cursor = parseSlot(p.carriedItem)
    } else {
      const w = this.windows.get(p.windowId)
      if (w) w.slots = items
    }
  }

  handleSetSlot (p: any) {
    this.stateId = p.stateId ?? this.stateId
    const item = parseSlot(p.item)
    if (p.windowId === 0) {
      if (p.slot >= 0 && p.slot < this.slots.length) this.slots[p.slot] = item
      if (p.slot === -1) this.cursor = item
    } else {
      const w = this.windows.get(p.windowId)
      if (w) {
        while (w.slots.length <= p.slot) w.slots.push(null)
        w.slots[p.slot] = item
      }
    }
  }

  handleOpenWindow (p: any) {
    this.windows.set(p.windowId, { windowId: p.windowId, type: p.inventoryType, title: '', slots: [] })
    this.activeWindowId = p.windowId
  }

  close (windowId: number) {
    this.windows.delete(windowId)
    if (this.activeWindowId === windowId) this.activeWindowId = null
  }

  /** 快捷栏摘要 */
  hotbar (): (ItemStack | null)[] {
    return this.slots.slice(36, 45)
  }

  /** 简要列表: 非空槽位 */
  list (): { slot: number, name: string, count: number }[] {
    const out: { slot: number, name: string, count: number }[] = []
    this.slots.forEach((s, i) => {
      if (s) out.push({ slot: i, name: s.name, count: s.count })
    })
    return out
  }

  findItem (name: string): { slot: number, item: ItemStack } | null {
    for (let i = 9; i < 46; i++) {
      const s = this.slots[i]
      if (s && s.name === name) return { slot: i, item: s }
    }
    // 也搜快捷栏之外? 9-35 是背包, 36-44 快捷栏, 全搜 9-45
    return null
  }
}
