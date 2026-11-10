/**
 * 附魔台 / 铁砧。
 * - enchant: 放物品+青金石 → 读三个选项 (等级要求/提示附魔) → 不给 option 只返回选项, 给了就附魔并取出
 * - anvil: 合并 (附魔书→工具 / 两件同类修耐久 / 材料修复) 与改名; 先读花费, 等级不够/过于昂贵直接说明; preview 只看不做
 * 关窗口时原版会把附魔台/铁砧输入格里剩下的东西退回背包。
 */
import type { BotAgent } from '../conn/bot.js'
import { Task } from './tasks.js'
import { PLAYER_STORAGE, toWindowSlot, enchantName, describeItem, itemExtras, type ItemStack } from '../conn/inventory.js'

const LAPIS = 'lapis_lazuli'
const ANVILS = ['anvil', 'chipped_anvil', 'damaged_anvil']
/** 原版生存模式铁砧花费 ≥40 级 = "过于昂贵", 不让取 */
const TOO_EXPENSIVE = 40

/** 从背包选一件 name: 指定 slot 时校验; 否则优先满足 prefer 的, 跳过 exclude 槽 */
function pickItem (bot: BotAgent, name: string, slot?: number, prefer?: (it: ItemStack) => boolean, exclude?: number): { slot: number, item: ItemStack } {
  if (slot !== undefined) {
    const it = bot.inventory.slots[slot]
    if (!it || it.name !== name) throw new Error(`槽位 ${slot} 不是 ${name} (是 ${it?.name ?? '空'})`)
    if (slot === exclude) throw new Error(`两件物品不能是同一个槽位 ${slot}`)
    return { slot, item: it }
  }
  const hits = bot.inventory.find(s => s.name === name).filter(h => h.slot !== exclude)
  if (!hits.length) throw new Error(`背包里没有${exclude !== undefined ? '另一件' : ''} ${name}`)
  return hits.find(h => prefer?.(h.item)) ?? hits[0]
}

/** 附魔台周围有效书架数 (原版: 水平距离 2 的一圈, 高 0~1, 中间格要空着; 最多算 15 个) */
function countBookshelves (bot: BotAgent, t: { x: number, y: number, z: number }): number {
  let n = 0
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 0; dy <= 1; dy++) {
    if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue
    if (bot.world.getBlock(t.x + dx, t.y + dy, t.z + dz)?.name !== 'bookshelf') continue
    const mid = bot.world.getBlock(t.x + Math.trunc(dx / 2), t.y + dy, t.z + Math.trunc(dz / 2))?.name ?? 'air'
    if (/^(air|cave_air|void_air)$/.test(mid) || /carpet|snow$|short_grass|tall_grass|fern|torch/.test(mid)) n++
  }
  return Math.min(n, 15)
}

const roman = (n: number) => ['', 'I', 'II', 'III', 'IV', 'V'][n] ?? String(n)

/**
 * 工作方块窗口的公共部分: 记下"哪个窗口格的东西来自背包哪一格", 结束前 (只看选项/预览/失败/用剩的) 放回原格。
 * 不放回的话关窗口时服务器会随便塞进空格, LLM 刚从 list_inventory 看到的槽位号就对不上了。
 */
abstract class StationTask extends Task {
  protected wid: number | null = null
  protected ownSize = 0
  private moves: { win: number, slot: number }[] = []
  protected toWin = (s: number) => toWindowSlot(s, this.ownSize)

  protected abstract work (): Promise<string>
  protected async run () {
    try { return await this.work() } finally { await this.putBack() }
  }

  /** 背包 src 格 → 窗口 win 格 (n 缺省整组), 并记下来源 */
  protected async moveIn (src: number, win: number, n?: number) {
    await this.putFrom(this.wid!, this.toWin, src, win, n)
    this.moves.push({ win, slot: src })
  }

  /** 把窗口 win 格的东西拿回背包: 优先放到 prefer 格 (空着时), 否则 shift 点击 */
  protected async takeOut (win: number, prefer: number, what: string) {
    const bot = this.bot, wid = this.wid!
    const it = this.winSlot(wid, win)
    if (!it) return
    if (!bot.inventory.slots[prefer]) {
      bot.clickSlot(wid, win, 0, 0)
      bot.clickSlot(wid, this.toWin(prefer), 0, 0)
    } else bot.clickSlot(wid, win, 0, 1)
    await this.until(() => !this.winSlot(wid, win), 2000, what)
  }

  private async putBack () {
    const bot = this.bot, wid = this.wid
    if (wid === null || bot.inventory.activeWindowId !== wid || this.status !== 'running') return
    for (const m of this.moves) {
      try {
        const it = this.winSlot(wid, m.win)
        if (!it || bot.inventory.slots[m.slot]) continue // 原格被占了: 交给关窗口自动退回
        bot.clickSlot(wid, m.win, 0, 0)
        bot.clickSlot(wid, this.toWin(m.slot), 0, 0)
        await this.until(() => bot.inventory.slots[m.slot]?.name === it.name, 1500, '放回原格')
      } catch { break }
    }
  }

  protected cleanup () { if (this.wid !== null) this.bot.closeWindow(this.wid) }
}

export class EnchantAction extends StationTask {
  constructor (bot: BotAgent, private item: string, private option?: number, private slot?: number) { super(bot, 'enchant') }

  protected async work () {
    const bot = this.bot
    if (this.option !== undefined && ![0, 1, 2].includes(this.option)) throw new Error('option 须为 0/1/2 (附魔台从上到下三个选项)')
    const creative = bot.gameMode === 'creative'
    // 默认挑还没附魔的那件
    const src = pickItem(bot, this.item, this.slot, it => !it.enchantments?.length && !it.stored?.length)
    if (src.item.enchantments?.length) throw new Error(`${describeItem(src.item)} 已经有附魔了, 附魔台只能附魔没附过魔的物品 (要叠加用铁砧 + 附魔书)`)
    const lapis = bot.inventory.count(LAPIS)
    if (!lapis && !creative) throw new Error('背包里没有青金石 (lapis_lazuli), 附魔一次要 1~3 个')

    const t = await this.ensureStation('enchanting_table', '附魔台')
    const shelves = countBookshelves(bot, t)
    this.ownSize = 2 // 附魔台窗口: 0 物品, 1 青金石, 之后是玩家物品
    const wid = this.wid = await this.openAt(t.x, t.y, t.z, 2 + PLAYER_STORAGE, '附魔台')
    if (bot.inventory.slots[src.slot]?.name !== this.item) throw new Error(`槽位 ${src.slot} 的 ${this.item} 不见了`)
    await this.moveIn(src.slot, 0, 1)
    const lap = bot.inventory.find(s => s.name === LAPIS).sort((a, b) => b.item.count - a.item.count)[0]
    if (lap) await this.moveIn(lap.slot, 1) // 最大的一叠整组放进去, 用剩的放回原格

    // 服务器算好选项后用窗口属性下发: 0-2 等级要求, 4-6 提示附魔 id, 7-9 提示等级
    const w = bot.inventory.windows.get(wid)!
    try { await this.until(() => [0, 1, 2].some(i => (w.props[i] ?? 0) > 0), 2000, '附魔选项') } catch {
      throw new Error(`${this.item} 不能附魔 (附魔台没给出选项)`)
    }
    await this.sleep(200) // 同一批的其他属性
    const lapisIn = this.winSlot(wid, 1)?.count ?? 0
    const options = [0, 1, 2].map(i => {
      const req = w.props[i] ?? 0, hid = w.props[4 + i] ?? -1, hl = w.props[7 + i] ?? -1
      const why = req <= 0 ? '' : creative ? '' : bot.xp.level < req ? `等级不够 (要 ${req} 级, 有 ${bot.xp.level})` : lapisIn < i + 1 ? `青金石不够 (要 ${i + 1}, 有 ${lapisIn})` : ''
      return { option: i, level_required: req, costs: `${i + 1} 级 + ${i + 1} 青金石`, hint: hid >= 0 ? `${enchantName(hid)} ${roman(hl)}` : null, ok: req > 0 && !why, ...(why ? { why } : {}) }
    }).filter(o => o.level_required > 0)
    this.extra = { options, xp_level: bot.xp.level, lapis: lapisIn, bookshelves: shelves, table: t }
    const head = `附魔台 (${t.x},${t.y},${t.z}), 书架 ${shelves}/15`
    const list = options.map(o => `  [${o.option}] 要求 ${o.level_required} 级, 花 ${o.costs}${o.hint ? `, 至少有 ${o.hint}` : ''}${o.ok ? '' : ` — 不可选: ${o.why}`}`).join('\n')

    if (this.option === undefined) {
      return `${head}; ${this.item} 的附魔选项 (你 ${bot.xp.level} 级, 青金石 ${lapisIn}):\n${list}\n选好后 enchant{item:"${this.item}", option:N}。选项在附魔一次之前不会变 (提示只保证有该附魔, 可能还附带别的)`
    }
    const o = options.find(x => x.option === this.option)
    if (!o) throw new Error(`没有第 ${this.option} 个选项 (书架少时等级低的选项可能空着):\n${list}`)
    if (!o.ok) throw new Error(`选项 ${this.option} ${o.why}\n${list}`)

    const xp0 = bot.xp.level
    bot.enchantItem(wid, this.option)
    await this.until(() => { const it = this.winSlot(wid, 0); return !!it && (!!it.enchantments?.length || !!it.stored?.length) }, 3000, '附魔生效')
    const result = this.winSlot(wid, 0)!
    await this.takeOut(0, src.slot, '取出附魔好的物品') // 放回原来那格
    try { await this.until(() => creative || bot.xp.level < xp0, 1000, '扣经验') } catch {}
    this.extra = { item: { name: result.name, ...itemExtras(result) }, option: this.option, xp_level: bot.xp.level, bookshelves: shelves }
    return `附魔完成: ${describeItem(result)} (选项 ${this.option}, 花了 ${xp0 - bot.xp.level} 级 + ${this.option + 1} 青金石, 剩 ${bot.xp.level} 级)`
  }
}

export class AnvilAction extends StationTask {
  constructor (bot: BotAgent, private item: string, private opts: { with?: string, rename?: string, slot?: number, withSlot?: number, preview?: boolean } = {}) { super(bot, 'anvil') }

  protected async work () {
    const bot = this.bot
    const { rename, preview } = this.opts
    if (!this.opts.with && rename === undefined) throw new Error('anvil 要给 with (合并/修复用的第二件: 附魔书/同类物品/修复材料) 或 rename (改名)')
    if (rename !== undefined && rename.length > 50) throw new Error('名字最长 50 个字符')
    const creative = bot.gameMode === 'creative'
    const left = pickItem(bot, this.item, this.opts.slot)
    const right = this.opts.with ? pickItem(bot, this.opts.with, this.opts.withSlot, undefined, left.slot) : null
    const leftDesc = describeItem(left.item), rightDesc = right ? describeItem(right.item) : ''

    const t = await this.ensureStation(ANVILS, '铁砧')
    const anvil0 = bot.world.getBlock(t.x, t.y, t.z)?.name
    this.ownSize = 3 // 铁砧窗口: 0 左, 1 右, 2 产物, 之后是玩家物品
    const wid = this.wid = await this.openAt(t.x, t.y, t.z, 3 + PLAYER_STORAGE, '铁砧')
    if (bot.inventory.slots[left.slot]?.name !== this.item) throw new Error(`槽位 ${left.slot} 的 ${this.item} 不见了`)
    await this.moveIn(left.slot, 0)
    if (right) await this.moveIn(right.slot, 1) // 修复材料整组放, 用剩的放回原格
    // 原版客户端放入物品后会把名字框内容发给服务器; 不发的话服务器当名字为空, 会把已有的自定义名去掉
    bot.nameItem(rename ?? left.item.customName ?? '')

    const w = bot.inventory.windows.get(wid)!
    const what = `${leftDesc}${right ? ` + ${rightDesc}` : ''}${rename !== undefined ? ` 改名「${rename}」` : ''}`
    // 原版生存模式花费 ≥40 时服务器把产物格清空 (客户端据花费属性显示"过于昂贵"), 所以"有产物"或"花费 ≥40"都算有结果
    const settled = () => (!!this.winSlot(wid, 2) && (w.props[0] ?? 0) > 0) || (!creative && (w.props[0] ?? 0) >= TOO_EXPENSIVE)
    const none = `铁砧上 ${what} 没有产物: ${right ? '合不出新东西 (物品不同类 / 附魔互斥或用不到这件上 / 修复材料不对 / 左边满耐久且右边没有新附魔可加)' : '名字没变化'}`
    try { await this.until(settled, 2000, '铁砧产物') } catch { throw new Error(none) }
    await this.sleep(150)
    const cost = w.props[0] ?? 0
    const result = this.winSlot(wid, 2)
    const repairNote = `物品每过一次铁砧惩罚翻倍, 左边累计 ${left.item.repairCost ?? 0}${right?.item.repairCost ? `、右边 ${right.item.repairCost}` : ''}`
    if (!result) {
      if (!creative && cost >= TOO_EXPENSIVE) {
        this.extra = { cost, too_expensive: true, xp_level: bot.xp.level }
        throw new Error(`过于昂贵: ${what} 要 ${cost} 级, ≥${TOO_EXPENSIVE} 级原版不让做 (${repairNote})`)
      }
      throw new Error(none)
    }
    this.extra = { result: { name: result.name, ...itemExtras(result) }, cost, xp_level: bot.xp.level }
    const plan = `${what} → ${describeItem(result)}, 花费 ${cost} 级`
    if (preview) return `预览: ${plan} (你 ${bot.xp.level} 级${!creative && bot.xp.level < cost ? '; 等级不够' : ''}); 去掉 preview 执行`
    if (!creative && bot.xp.level < cost) throw new Error(`等级不够: ${plan}, 你只有 ${bot.xp.level} 级`)

    const xp0 = bot.xp.level
    await this.takeOut(2, left.slot, '取出产物') // 这时才扣经验、消耗材料; 产物放回左边物品原来那格
    try { await this.until(() => creative || bot.xp.level < xp0, 1000, '扣经验') } catch {}
    await this.sleep(100)
    const anvilNow = bot.world.getBlock(t.x, t.y, t.z)?.name ?? 'air'
    const worn = !ANVILS.includes(anvilNow) ? ' (铁砧用坏消失了)' : anvilNow !== anvil0 ? ` (铁砧磨损成 ${anvilNow})` : ''
    this.extra = { ...this.extra, xp_level: bot.xp.level }
    return `铁砧完成: ${describeItem(result)} (花了 ${xp0 - bot.xp.level} 级, 剩 ${bot.xp.level} 级)${worn}`
  }
}
