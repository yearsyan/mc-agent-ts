/**
 * 动作基类。
 * - Action: 每 tick 由 BotAgent 驱动 step() 的状态机式动作
 * - AsyncAction: 用 async run() 写的多步动作 (合成/采集/交易…), 支持等待、子动作、取消传播
 */
import type { BotAgent } from '../conn/bot.js'

export type ActionStatus = 'running' | 'done' | 'failed' | 'cancelled'

export abstract class Action {
  id: number
  status: ActionStatus = 'running' as ActionStatus
  detail = ''
  /** 结构化附加结果, 随 wait_action 一起返回 (如寻路的 route 改动记录 / proposals 挖搭方案) */
  extra?: Record<string, unknown>
  readonly createdAt = Date.now()
  /** 状态离开 running 时回调一次 (操作日志用) */
  onSettle?: (a: Action) => void
  /** 由反射层发起 (不是 LLM 下达的) */
  byReflex = false
  private static nextId = 1
  constructor (readonly type: string) { this.id = Action.nextId++ }
  abstract start (): void
  abstract step (nowMs: number): void
  cancel (reason = '') {
    if (this.status !== 'running') return
    this.status = 'cancelled'
    if (reason) this.detail = reason
    this.onSettle?.(this)
  }
  // 异步回调 (setTimeout 轮询) 可能在取消后才触发, 只允许从 running 转出
  finish (detail = '') { if (this.status !== 'running') return; this.status = 'done'; this.detail = detail; this.onSettle?.(this) }
  fail (detail = '') { if (this.status !== 'running') return; this.status = 'failed'; this.detail = detail; this.onSettle?.(this) }
}

/** run() 内检测到动作已取消时抛出, 用于跳出 await 链 */
export class Cancelled extends Error {}

export abstract class AsyncAction extends Action {
  private children = new Set<Action>()
  constructor (protected bot: BotAgent, type: string) { super(type) }

  /** 返回值作为完成说明; 抛错 = 失败 */
  protected abstract run (): Promise<string>

  start () {
    this.run().then(
      (detail) => this.finish(detail),
      (e: any) => { if (!(e instanceof Cancelled)) this.fail(e?.message ?? String(e)) },
    ).finally(() => this.cleanup())
  }

  step () {}

  /** 结束 (含失败/取消) 后的清理, 如释放手、关窗口 */
  protected cleanup () {}

  cancel (reason = '') {
    super.cancel(reason)
    for (const c of this.children) c.cancel(reason)
  }

  check () { if (this.status !== 'running') throw new Cancelled() }

  async sleep (ms: number) {
    await new Promise(r => setTimeout(r, ms))
    this.check()
  }

  /** 轮询直到条件成立; 超时抛错 */
  async until (pred: () => boolean, timeoutMs: number, what = '条件'): Promise<void> {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时 (${(timeoutMs / 1000).toFixed(1)}s)`)
      await this.sleep(50)
    }
  }

  /** 运行子动作并等它结束; 子动作不进操作日志, 本动作取消时一并取消 */
  protected async sub<T extends Action> (a: T): Promise<T> {
    this.check()
    this.children.add(a)
    this.bot.runChild(a)
    try {
      while (a.status === 'running') await this.sleep(50)
    } finally {
      this.children.delete(a)
      if (a.status === 'running') a.cancel('父动作已结束')
    }
    return a
  }

  /** 运行子动作, 失败则抛出 (带前缀说明) */
  protected async must<T extends Action> (a: T, what: string): Promise<T> {
    await this.sub(a)
    if (a.status !== 'done') throw new Error(`${what}失败: ${a.detail}`)
    return a
  }
}
