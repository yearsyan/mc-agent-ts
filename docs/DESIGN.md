# mc-agent 设计文档

> 快速开始与整体架构见 [README](../README.md)。本文是能力详设：MCP 工具、动作、脚本、反射层、目录结构、实测结果与已知限制。

## MCP 工具（admin 21 个；agent token 自动过滤）

| 工具 | 说明 |
|---|---|
| `get_scene` / `get_view` / `get_map` | 场景 JSON（位置/血量/背包/附近实体/反射状态/死亡信息）· 第一人称 PNG · 顶视地图 PNG（两张图都附文字说明，见下） |
| `say` / `read_chat` | 发言（不执行命令）· 读聊天（按类型渲染 `* A 挥手`、`A 悄悄对你说: …`，带 key/self，seq 增量） |
| `run_command` | 以角色身份执行服务器命令。**权限完全由服务器决定**，结果区分「无权限」（附可用命令列表）与「参数错误」 |
| `act` / `wait_action` / `wait_event` | 异步动作（见下）· 等动作完成（新消息可中断，动作不中止）· 空闲长轮询等消息（≤180s，比轮询 read_chat 省调用） |
| `set_policy` | 反射策略（见下） |
| `run_script` / `script_status` / `stop_script` | 脚本动作（见下）· 运行中进度/新日志 · 中止（连同正在执行的子动作） |
| `get_block` / `find_block` / `list_inventory` / `get_container` | 方块查询 · 找方块 · 库存 · 容器槽位 |
| `spawn_agent` / `kill_agent` / `list_agents` | 生命周期（admin；agent 的 kill_agent = 自己下线歇会儿） |

**视觉**：图负责空间关系，随图附的文字给精确数字。
- `get_view`（默认 480×270）：方块按真实形状画（台阶/栅栏/门；草花火把画成细块不挡视线）、玻璃/水半透明、方块边缘描线可数格子；实体按真实大小画剪影并标 `#entity_id`，被墙挡住的不画（文字里单列）；中心十字=准星，顶部罗盘。文字含朝向、准星方块坐标、画面内实体及方位。
- `get_map`（默认半径 32、每格 6px）：上=北，每 16 格网格线（区块边界）并在边缘标坐标，红箭头=自己及朝向，实体标号；地表模式按起伏明暗、水按深度变暗；地下/室内自动切为脚下高度横切图（墙暗、地面亮、坑黑）。
- 渲染分段让出事件循环，最大图 640×360 渲染时 tick 延迟 ≤ 22ms。

**消息收件箱**：别人的聊天/私聊 + 自己死亡会主动推给 agent——任何工具返回末尾附 `{inbox:{unread, latest, hint}}`；`wait_event` 挂起等待、`wait_action` 立即中断送达（~200ms）；`read_chat` 读过即消。

### act 动作（异步，返回 actionId；死亡时全部取消，detail 给死因）

| 类别 | 动作 |
|---|---|
| 移动 | `move_to{x,z,y?,tolerance?,allow_dig?,allow_place?}`（自动开门/爬梯/游泳, 远距离分段；连续深水 ≥6 格自动冲刺游泳；挖穿/垫高/搭桥需确认，见下）· `go_home` · `jump` · `stop` |
| 采集 | `collect{block,count?,radius?}`（找→走→最佳工具挖→捡）· `dig{x,y,z}`（自动换工具）· `pickup_items` |
| 建造/合成 | `place{x,y,z,item?}` · `craft{item,count?}`（3×3 自动找放工作台）· `smelt{item,count?,fuel?}`（自动找放熔炉/选燃料） |
| 物品 | `equip{item}`（工具/盔甲/盾）· `eat` · `use_item` · `select_slot` · `drop_item` |
| 交互 | `use_block` · `sleep`/`wake` · `interact_entity{entity_id,item?}`（喂食/剪毛/骑乘）· `mount`/`dismount` · `trade{entity_id,index?,times?}` |
| 战斗 | `attack{entity_id,hits?}`（自动换武器）· `shoot{entity_id,shots?,pickup?}`（弓箭自动瞄准：弹道解算+移动预判，隔墙/会误伤村民玩家时不射，贴脸改近战，打完捡回箭） |
| 容器 | `open_container` · `chest_take{slot}` · `chest_put{slot}` · `close_window` |
| 死亡 | `respawn`（仅 autoRespawn=false 时需要） |

**改地形需确认**：寻路默认只走现成的路（开门/爬梯/游泳），不挖不搭。
- 走不通时动作失败，`detail` 写明原因，`proposals` 给出方案：只挖 / 只搭，两者都不行才给挖+搭。每个方案列出要挖掉的方块和坐标、要放方块的位置（搭桥/垫高）、会用掉哪些方块、背包还差几个（方案按最多 64 块估算）。
- LLM 选择不动、换目标，或者在原动作参数里加 `allow_dig:true` / `allow_place:true` 重新下达。
- 开了权限也会先试只走现成的路，不通才改地形。
- 结束时（完成、失败、取消都算）`detail` 末尾和 `route{dug,placed}` 列出实际挖掉/放置的方块及坐标。
- `collect`/`craft`/`smelt`/`use_block`/`sleep` 走去目标的路上规则相同：未获准时不会垫高够树顶、不会挖进去取埋着的矿，只返回改动最少的方案。
- 反射层：逃跑、夜间回家都不改地形。
- 规划时第一次搜索同步完成，之后的候选点、权限档位和方案计算每个 tick 只搜一次，不会长时间阻塞事件循环。

**死亡感知**：`death_combat_event` 为主源（关死亡消息时按伤害类型+攻击者推断，重登还原死亡点）；`get_scene.last_death` 给死因/凶手/死亡物品/掉落物剩余存活秒数；聊天推送 `[你死了]/[掉落]/[已复活]`。

### 脚本（`run_script`）

把有循环/重复的流程（挖矿道、按规律采集、建造）写成一段 JS 一次下发，跑完看报告再决定下一步。脚本是一个主动作（互斥/死亡/反射接管照常取消它），里面每个子动作都走现有 act 实现。
- API：动作 `await dig/moveTo/place/collect/equip/craft/…`（`moveTo(p,{allowDig,allowPlace})`；走不通时抛出的错误带 `e.extra.proposals`）、通用 `act`/`tryAct`；同步查询 `here/block/scan("*_ore",r)/reach/inv/hp/entities/fwd…`；`Vec` 坐标运算；`log`/`progress` 输出；参数经 `args` 传入
- 报告（`wait_action` 结束时、`script_status` 运行中）：status/result/error{line,code}/logs/progress + 自动统计 `stats{dug（含寻路途中挖的）, placed（寻路放置的）, items 物品增减, moved, hp, food, actions 子动作成败}`
- 跑在 `node:vm`（只防误伤：禁 eval/new Function；循环体插守卫，同步执行 >1.5s 判死循环）；默认 300s 超时（≤1800s）

```js
const f = fwd(); let p = here()
for (let i = 1; i <= 30; i++) {
  if (scan('lava', 3).length) return { stop: '岩浆', at: p, i }
  p = p.add(f); await dig(p); await dig(p.up()); await moveTo(p, { tolerance: 0 })
  for (const o of scan('*_ore', 4)) if (reach(o.pos) <= 4.5 && (await tryAct('dig', o.pos)).ok) log('挖到', o.name, o.pos)
}
```

### 反射层（`set_policy`，持久化于 `~/.mc-agent/policies.json`）

LLM 决策要数秒，保命行为由 bot 每 tick 自主执行，打断主动作时在 detail 注明原因：

| 策略 | 默认 | 行为 |
|---|---|---|
| `autoEat` / `eatAt` | true / 14 | 饱食不足时挑最好的食物吃，不打断动作 |
| `combat` / `fleeHealth` | defend / 8 | 敌对近身自动换武器还击；血过低或遇苦力怕逃跑 |
| `ranged` | auto | 有弓有箭时：远程怪 4-24 格 / 苦力怕 6-16 格 / 飞行怪用弓（会打断 LLM 动作）；LLM 空闲时也射逼近的近战怪；`never` 只近战 |
| `shield` | true | 副手有盾（空着会自动放上）时，箭飞来 / 骷髅拉弓 / 苦力怕点燃 / 怪近身 → 面向威胁举盾；砍怪时放下砍一刀再举；被斧头打掉后冷却期不举 |
| `avoidHazards` | true | 岩浆/火直接接管控制逃生；溺水上浮；空闲踩水 |
| `nightShelter` / `home` | false / null | 天黑空闲回家（`home:"here"` 设当前位置），有床就睡 |
| `autoRespawn` | true | 死后 0.8s 自动复活；false 则停在死亡界面等 `act respawn` |

## WebUI

`http://127.0.0.1:8767/webui`，打开即用（暂无鉴权）。

- **操作日志**：工具调用/动作结果/上下线/死亡/反射介入，按角色与类型筛选；落盘 `~/.mc-agent/logs/<角色>.jsonl`（5MB 轮转，重启恢复）
- **token 管理**：查看/轮换/增删角色（新角色需自行加服务器白名单）；「禁止上线」可阻止自动重连
- **MCP 接入**：弹窗按当前访问方式生成客户端配置（URL + x-token）

## 目录

- `src/conn/` — bot.ts（连接/tick/动作/聊天/死亡）、reflex.ts（反射层）、inventory.ts
- `src/actions/` — base.ts（Action/AsyncAction 框架）、actions.ts（移动/挖掘/容器）、tasks.ts（采集/合成/交互/交易）、combat.ts（远程战斗：弹道+瞄准）、script.ts（run_script 脚本引擎）、hands.ts（手持/背包操作）、astar.ts
- `src/world/` `src/physics/` `src/vision/` `src/game/` — 世界模型 · 物理适配 · raycast 渲染 · 物品/方块知识（knowledge.ts）+ 弹道（ballistics.ts）
- `src/http/` — serve.ts（MCP+REST+WebUI 单服务、工具注册与角色过滤）、tokens.ts、oplog.ts、webui.html
- `third_party/` — 26.2/26.3 协议数据（minecraft-data PR #1301, MIT, 见 NOTICE.md）· `scripts/setup-overlay.ts` 可重现 patch

## 已验证能力（测试服实测）

- **移动**：开门穿屋、爬梯、游泳、搭桥、垫高、248 格远程分段，原生地形 6 条路线
- **冲刺游泳**：按原版游泳姿态自行模拟（prismarine-physics 不支持），服务器侧 is_swimming/is_sprinting 一致、无移动纠正；60 格水道 25.7s → 16~18s，游泳中眼睛露出水面氧气不掉；饱食度 ≤6 自动退回普通游泳
- **生存链**：空背包 砍树→木板→工作台(自动放置)→木镐→石头→石镐，7 次 act 约 45 秒；熔炼自动放炉选燃料
- **反射**：僵尸近身换铁剑无伤击杀、苦力怕逃逸、自动挑牛排（不吃腐肉）、岩浆脱困 3/3、天黑回家睡觉
- **死亡**：/kill 打断动作并给死因、苦力怕/僵尸死因凶手正确、keepInventory 两态、关死亡消息可推断、死着重登还原
- **命令**：非 OP 被拒并附可用命令表；临时 op 后与 RCON 输出一致，deop 即时收回
- **消息**：两 agent `/msg`/`/me` 互通、公屏/私聊/死亡推送、wait_action 中断 <1s
- **弓箭**：静止靶 8~44 格 25/25；冲锋/斜向/横移的地面怪 17/17；幻翼 14/20；隔墙、村民挡线时拒射并说明；弹开的箭 3/3 捡回
- **盾牌**：骷髅 20s 对射 中箭 8→0；3 只僵尸围攻 挨打 33→10（击杀时间不变）；点燃苦力怕贴脸 掉血 16.7→0；斧头破盾后冷却期不举、到期自动恢复
- **战斗策略**：空闲时骷髅 6~9s 对射击杀；苦力怕远射→近了逃→点燃举盾，无伤；僵尸先射后砍无伤；LLM 赶路时骷髅出现会打断去射，僵尸只在近身时砍
- **脚本**：上例一次调用挖 27 格矿道 + 8 个矿、遇岩浆自行停下（52s）；失败报告给出行号与原因，改脚本后重跑通过；stop_script / 新动作顶掉 / 超时 / 同步死循环均能停下且子动作一并取消
- **视觉**：同一场景墙后僵尸不画、半露骷髅只画露出部分、玻璃后的羊可见；深海视角旧版栈溢出、新版正常；顶棚下自动切横切图

## 已知限制

- 3×3 以上岩浆池中央基本必死（预防靠寻路避让）
- 不会潜水（路线只走水面）；只能上下载具，不能驾驶；弩不支持（只用弓）；被斧头破盾后不会主动后撤
- 与骷髅对射是"互射"而非"挡箭-还击"交替；反射射击用掉的箭需 LLM 自己 `pickup_items` 捡（自己射出、插在地上的箭也算）
- 下界/末地高度仍按主世界解析；第一人称图为语义调色板（无贴图，有意为之）、无光照（夜晚/洞穴不变暗）；玩家实体只标 `player` 不显示名字
