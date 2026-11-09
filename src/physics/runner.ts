/**
 * 物理运行器: 包装 prismarine-physics 的 simulatePlayer。
 * 每个 tick: 动作系统设置 control → 模拟一步 → 写回 bot.pos。
 *
 * 冲刺游泳 (1.13+ 游泳姿态) prismarine-physics 不支持, 这里按原版自己模拟:
 * - 进入: 疾跑 + 眼睛在水下 + 脚下格是水; 保持: 疾跑 + 碰撞箱在水里
 * - 姿态: 碰撞箱 0.6×0.6×0.6, 眼高 0.4
 * - 运动 (Player.travel + LivingEntity.travelInFluid): 竖直速度向视线 y 分量收敛 (俯仰控制上浮/下潜),
 *   水平惯性 0.9 (普通游泳 0.8, 约快一倍), 疾跑时水中无重力
 */
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import type { World } from '../world/world.js'
import { mcData, Block, MC_VERSION } from '../version.js'

const require2 = createRequire(import.meta.url)
const { Physics, PlayerState } = require2('prismarine-physics')

export interface ControlState {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
  jump: boolean
  sprint: boolean
  sneak: boolean
}

/** physics 需要的 world 接口: getBlock(pos) -> 带 .type/.position 的方块对象 */
function makePhysicsWorld (world: World) {
  return {
    getBlock (pos: any) {
      const b = world.getBlock(pos.x, pos.y, pos.z)
      if (!b) return null
      try {
        const block = Block.fromStateId(b.stateId, 0)
        block.position = new Vec3(pos.x, pos.y, pos.z) // physics 会读 block.position
        return block
      } catch {
        return null
      }
    },
    getBlockCollisionShapes: null,
  }
}

// ---------- 水 / 碰撞 (游泳姿态用) ----------

const WATERY = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
const shapeCache = new Map<number, number[][]>()
function blockShapes (stateId: number): number[][] {
  let s = shapeCache.get(stateId)
  if (!s) { try { s = Block.fromStateId(stateId, 0).shapes ?? [] } catch { s = [] } shapeCache.set(stateId, s!) }
  return s!
}
const waterlogged = new Map<number, boolean>()
function isWaterlogged (stateId: number) {
  let w = waterlogged.get(stateId)
  if (w === undefined) { try { w = Block.fromStateId(stateId, 0).getProperties?.().waterlogged === true } catch { w = false } waterlogged.set(stateId, w!) }
  return w!
}

/** 格内水面高度 (0 = 没有水); 源/含水 8/9, 流动按等级, 上方也是水则为整格 */
export function fluidHeight (world: World, x: number, y: number, z: number): number {
  const b = world.getBlock(x, y, z)
  if (!b) return 0
  const wet = WATERY.has(b.name) || isWaterlogged(b.stateId)
  if (!wet) return 0
  const up = world.getBlock(x, y + 1, z)
  if (up && (WATERY.has(up.name) || isWaterlogged(up.stateId))) return 1
  if (b.name === 'water') {
    let level = 0
    try { level = Number(Block.fromStateId(b.stateId, 0).getProperties?.().level ?? 0) } catch {}
    if (level >= 8) return 1
    return (8 - level) / 9
  }
  return 8 / 9
}

type Box = [number, number, number, number, number, number]

function blockBoxes (world: World, box: Box): Box[] {
  const out: Box[] = []
  for (let x = Math.floor(box[0]); x <= Math.floor(box[3]); x++) {
    for (let y = Math.floor(box[1]) - 1; y <= Math.floor(box[4]); y++) {
      for (let z = Math.floor(box[2]); z <= Math.floor(box[5]); z++) {
        const b = world.getBlock(x, y, z)
        if (!b) continue
        for (const s of blockShapes(b.stateId)) out.push([x + s[0], y + s[1], z + s[2], x + s[3], y + s[4], z + s[5]])
      }
    }
  }
  return out
}

/** 沿一轴裁剪位移 (原版 Shapes.collide 的逐轴做法) */
function clip (axis: number, box: Box, d: number, obstacles: Box[]) {
  const a = axis, b = (axis + 1) % 3, c = (axis + 2) % 3
  for (const o of obstacles) {
    if (o[b + 3] <= box[b] + 1e-7 || o[b] >= box[b + 3] - 1e-7 || o[c + 3] <= box[c] + 1e-7 || o[c] >= box[c + 3] - 1e-7) continue
    if (d > 0 && o[a] >= box[a + 3] - 1e-7) d = Math.min(d, o[a] - box[a + 3])
    else if (d < 0 && o[a + 3] <= box[a] + 1e-7) d = Math.max(d, o[a + 3] - box[a])
  }
  return d
}

export const SWIM_HEIGHT = 0.6
export const SWIM_EYE = 0.4
export const STAND_EYE = 1.62

export class PhysicsRunner {
  control: ControlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  /** 当前速度 (PlayerState.apply 每 tick 会换对象, 故每次从实体上取) */
  get velocity (): any { return this.botLike.entity.velocity }
  private physics: any
  private botLike: any
  private pworld: any
  /** 游泳姿态 (原版 isSwimming) */
  swimming = false
  /** 本 tick 实际疾跑 (control.sprint 经原版规则过滤后; bot 据此给服务器发 start/stop_sprinting) */
  sprinting = false
  /** 外部可禁止疾跑 (饱食度 ≤ 6) */
  canSprint = true

  constructor (private world: World, private bot: { pos: { x: number, y: number, z: number }, yaw: number, pitch: number, onGround: boolean }) {
    this.pworld = makePhysicsWorld(world)
    this.physics = Physics(mcData, this.pworld)
    this.botLike = {
      version: MC_VERSION,
      entity: {
        position: new Vec3(bot.pos.x, bot.pos.y, bot.pos.z),
        velocity: new Vec3(0, 0, 0),
        onGround: true,
        isInWater: false, isInLava: false, isInWeb: false,
        isCollidedHorizontally: false, isCollidedVertically: false,
        elytraFlying: false,
        attributes: {},
        effects: [],
        yaw: 0, pitch: 0,
      },
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      usingHeldItem: false,
      inventory: { slots: [] },
    }
  }

  /** 是否在水中 (上一 tick 物理结果) */
  get inWater (): boolean { return this.swimming || !!this.botLike.entity.isInWater }

  get eyeHeight () { return this.swimming ? SWIM_EYE : STAND_EYE }

  /** 碰撞箱 (按当前姿态) 是否泡在水里 (原版: 水面高度 ≥ 箱底) */
  private boxInWater (x: number, y: number, z: number, h: number) {
    for (let bx = Math.floor(x - 0.3 + 0.001); bx <= Math.floor(x + 0.3 - 0.001); bx++) {
      for (let by = Math.floor(y + 0.001); by <= Math.floor(y + h - 0.001); by++) {
        for (let bz = Math.floor(z - 0.3 + 0.001); bz <= Math.floor(z + 0.3 - 0.001); bz++) {
          const f = fluidHeight(this.world, bx, by, bz)
          if (f > 0 && by + f >= y + 0.001) return true
        }
      }
    }
    return false
  }

  /** 眼睛是否在水下 (原版 isEyeInFluid: 眼高 - 1/9 处) */
  eyeUnderWater (eye = this.eyeHeight) {
    const p = this.bot.pos
    const ey = p.y + eye - 0.11111111
    const by = Math.floor(ey)
    const f = fluidHeight(this.world, Math.floor(p.x), by, Math.floor(p.z))
    return f > 0 && by + f > ey
  }

  /** 原版 updateSwimming + LocalPlayer 的疾跑规则 */
  private updateSwimState () {
    const p = this.bot.pos
    const wantSprint = this.control.sprint && this.canSprint && (this.control.forward)
    if (this.swimming) {
      this.swimming = wantSprint && this.boxInWater(p.x, p.y, p.z, SWIM_HEIGHT)
      // 出水/松开疾跑: 站立箱放得下才起身, 放不下 (1 格高的缝) 保持趴着游
      if (!this.swimming && this.collides([p.x - 0.3, p.y, p.z - 0.3, p.x + 0.3, p.y + 1.8, p.z + 0.3])) this.swimming = true
    } else {
      const feet = fluidHeight(this.world, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) > 0
      this.swimming = wantSprint && feet && this.eyeUnderWater(STAND_EYE)
    }
    const inWater = this.swimming || !!this.botLike.entity.isInWater
    // 原版: 在水里但眼睛露出水面且没在游泳时, 疾跑会被取消
    this.sprinting = wantSprint && !(inWater && !this.swimming && !this.eyeUnderWater(STAND_EYE))
  }

  private collides (box: number[]) {
    return blockBoxes(this.world, box as Box).some(o => o[0] < box[3] - 1e-7 && o[3] > box[0] + 1e-7 && o[1] < box[4] - 1e-7 && o[4] > box[1] + 1e-7 && o[2] < box[5] - 1e-7 && o[5] > box[2] + 1e-7)
  }

  /** 游泳姿态一 tick (原版 Player.travel 游泳段 + travelInFluid) */
  private swimTick () {
    const p = this.bot.pos
    const v = this.velocity
    const c = this.control
    // 竖直: 向视线 y 分量收敛; 朝上看只有头顶还有水或按跳时才生效 (不能直接"飞"出水面)
    const lookY = -Math.sin(this.bot.pitch * Math.PI / 180)
    const k = lookY < -0.2 ? 0.085 : 0.06
    if (lookY <= 0 || c.jump || fluidHeight(this.world, Math.floor(p.x), Math.floor(p.y + 1 - 0.1), Math.floor(p.z)) > 0) v.y += (lookY - v.y) * k
    if (c.jump) v.y += 0.04 // jumpInLiquid
    // 水平加速 (moveRelative, 速度 0.02)
    let f = ((c.forward ? 1 : 0) - (c.back ? 1 : 0)) * 0.98
    let s = ((c.left ? 1 : 0) - (c.right ? 1 : 0)) * 0.98
    const len = Math.hypot(f, s)
    if (len > 1e-4) {
      if (len > 1) { f /= len; s /= len }
      f *= 0.02; s *= 0.02
      const yaw = this.bot.yaw * Math.PI / 180, sin = Math.sin(yaw), cos = Math.cos(yaw)
      v.x += s * cos - f * sin
      v.z += f * cos + s * sin
    }
    // 移动 + 逐轴碰撞 (y → x → z)
    const y0 = p.y
    const box: Box = [p.x - 0.3, p.y, p.z - 0.3, p.x + 0.3, p.y + SWIM_HEIGHT, p.z + 0.3]
    const obstacles = blockBoxes(this.world, [box[0] + Math.min(0, v.x) - 1, box[1] + Math.min(0, v.y) - 1, box[2] + Math.min(0, v.z) - 1, box[3] + Math.max(0, v.x) + 1, box[4] + Math.max(0, v.y) + 1, box[5] + Math.max(0, v.z) + 1])
    const dy = clip(1, box, v.y, obstacles); box[1] += dy; box[4] += dy
    const dx = clip(0, box, v.x, obstacles); box[0] += dx; box[3] += dx
    const dz = clip(2, box, v.z, obstacles); box[2] += dz; box[5] += dz
    const hColl = Math.abs(dx - v.x) > 1e-7 || Math.abs(dz - v.z) > 1e-7
    this.bot.onGround = v.y < 0 && Math.abs(dy - v.y) > 1e-7
    if (Math.abs(dy - v.y) > 1e-7) v.y = 0
    if (Math.abs(dx - v.x) > 1e-7) v.x = 0
    if (Math.abs(dz - v.z) > 1e-7) v.z = 0
    p.x = box[0] + 0.3; p.y = box[1]; p.z = box[2] + 0.3
    // 惯性: 疾跑时水平 0.9, 竖直 0.8, 无重力
    v.x *= 0.9; v.y *= 0.8; v.z *= 0.9
    // 撞到岸边且上方空着: 冲出水面 (同原版)
    if (hColl) {
      const nb = [p.x - 0.3 + v.x, p.y + v.y + 0.6 - p.y + y0, p.z - 0.3 + v.z]
      const test = [nb[0], nb[1], nb[2], nb[0] + 0.6, nb[1] + SWIM_HEIGHT, nb[2] + 0.6]
      if (!this.collides(test) && !this.boxInWater(test[0] + 0.3, test[1], test[2] + 0.3, SWIM_HEIGHT)) v.y = 0.3
    }
    // 同步给 prismarine 的状态, 退出游泳时连续
    this.botLike.entity.position.set(p.x, p.y, p.z)
    this.botLike.entity.onGround = this.bot.onGround
    this.botLike.entity.isInWater = true
  }

  syncFromBot () {
    this.botLike.entity.position.set(this.bot.pos.x, this.bot.pos.y, this.bot.pos.z)
    this.velocity.set(0, 0, 0)
  }

  tick () {
    // 与 bot.pos 对账: 初始化/服务器传送/回弹时偏差会 > 2 格, 强制重同步
    const p = this.botLike.entity.position
    if (Math.abs(p.x - this.bot.pos.x) > 2 || Math.abs(p.y - this.bot.pos.y) > 2 || Math.abs(p.z - this.bot.pos.z) > 2) {
      this.syncFromBot()
    }
    // prismarine-physics 用 mineflayer 约定 (弧度, yaw = π - notchYaw, pitch = -notchPitch), bot 内部是原版角度制
    this.botLike.entity.yaw = Math.PI - this.bot.yaw * Math.PI / 180
    this.botLike.entity.pitch = -this.bot.pitch * Math.PI / 180
    try {
      this.updateSwimState()
      if (this.swimming) { this.swimTick(); return }
      // 原版 goDownInWater: 水里按 shift 下沉 (prismarine 没实现)
      if (this.botLike.entity.isInWater && this.control.sneak && !this.control.jump) this.botLike.entity.velocity.y -= 0.04
      const state = new PlayerState(this.botLike, { ...this.control, sprint: this.sprinting })
      this.physics.simulatePlayer(state, this.pworld)
      state.apply(this.botLike)
      // 写回 bot
      this.bot.pos.x = this.botLike.entity.position.x
      this.bot.pos.y = this.botLike.entity.position.y
      this.bot.pos.z = this.botLike.entity.position.z
      this.bot.onGround = this.botLike.entity.onGround
    } catch (e: any) {
      // 物理异常不致命: 保持原地
      console.warn(`[physics] tick 失败: ${e.message}`)
    }
  }
}
