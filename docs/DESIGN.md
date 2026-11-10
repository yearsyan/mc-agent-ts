# mc-agent 设计文档

> 快速开始与整体架构见 [README](../README.md)。本文是能力详设：MCP 工具、动作、脚本、反射层、目录结构、实测结果与已知限制。

## MCP 工具（admin 21 个；agent token 自动过滤）

| 工具 | 说明 |
|---|---|
| `get_scene` / `get_view` / `get_map` | 场景 JSON（紧凑输出：位置/血量/经验等级/`action` 当前主动作/背包/附近实体/反射状态 state+home+最近事件/死亡信息；完整策略用不带参数的 `set_policy` 看）· 第一人称 PNG · 顶视地图 PNG（两张图都附文字说明，见下） |
| `say` / `read_chat` | 发言（不执行命令）· 读聊天（按类型渲染 `* A 挥手`、`A 悄悄对你说: …`，带 key/self；默认只给上次读过之后的新消息，最多 `limit` 条（默认 50，最大 200），`since` 可重看旧消息） |
| `run_command` | 以角色身份执行服务器命令。**权限完全由服务器决定**，结果区分「无权限」（附可用命令列表）与「参数错误」 |
| `act` / `wait_action` / `wait_event` | 异步动作（见下；带 `wait_ms` 在时限内等到结束直接返回结果，省一次 `wait_action`）· 等动作完成（新消息可中断，动作不中止）· 空闲长轮询等消息（≤180s，比轮询 read_chat 省调用） |
| `set_policy` | 反射策略（见下） |
| `run_script` / `script_status` / `stop_script` | 脚本动作（见下）· 运行中进度/新日志 · 中止（连同正在执行的子动作） |
| `get_block` / `find_block` / `list_inventory` / `get_container` | 方块查询（含 `props` 状态属性：作物 age、门 open、熔炉 lit…）· 找方块 · 库存（每格标注快捷栏/背包/盔甲/副手，附手持物与汇总；附魔/附魔书内容/耐久/自定义名/铁砧惩罚）· 当前容器（容器格与背包分开，带方块名/坐标/空格数/汇总） |
| `spawn_agent` / `kill_agent` / `list_agents` | 生命周期（admin；agent 的 kill_agent = 自己下线歇会儿） |

**视觉**：图负责空间关系，随图附的文字给精确数字。
- `get_view`（默认 480×270）：方块按真实形状画（台阶/栅栏/门；草花火把画成细块不挡视线）、玻璃/水半透明、方块边缘描线可数格子；实体按真实大小画剪影并标 `#entity_id`，被墙挡住的不画（文字里单列）；中心十字=准星，顶部罗盘。文字含朝向、准星方块坐标、画面内实体及方位。
- `get_map`（默认半径 32、每格 6px）：上=北，每 16 格网格线（区块边界）并在边缘标坐标，红箭头=自己及朝向，实体标号；地表模式按起伏明暗、水按深度变暗；地下/室内自动切为脚下高度横切图（墙暗、地面亮、坑黑）。
- 渲染分段让出事件循环，最大图 640×360 渲染时 tick 延迟 ≤ 22ms。

**消息收件箱**：别人的聊天/私聊 + 自己死亡会主动推给 agent——任何工具返回末尾附 `{inbox:{unread, latest, hint}}`；`wait_event` 挂起等待、`wait_action` 立即中断送达（~200ms）；`read_chat` 读过即消。

### act 动作（异步，返回 actionId；`wait_ms` 内联等待；死亡时全部取消，detail 给死因）

动作的参数、用法、一句说明都定义在**动作规格表** `src/actions/registry.ts`：`act` 工具的描述 / `type` 枚举 / 参数 schema、参数校验、是否参与主动作互斥都由它生成，加动作或改参数只改那一处。下表是给人看的详细说明，`pnpm check:actions` 核对它有没有漏动作。
- **参数校验**：缺参数、类型不对时直接报错，写明是哪个参数并附该动作的用法（`dig 缺少参数 y; 用法: dig{x,y,z}`）；数值超范围按边界截断。动作名写错会提示最像的那个。
- **驼峰写法照收**：`allowDig` / `entityId` / `maxDist` 当成 `allow_dig` / `entity_id` / `max_dist`（脚本 API 是驼峰，两套写法混用不出错）。
- **没认出来的参数**不拒绝，动作照常执行，结果里加 `warning` 列出没用上的参数和最像的正确名字。
- **旧用法**（`mount`、`craft_planks`、`chest_take{slot}`、只给 `slot` 的 `drop_item`）仍然接受，但不出现在枚举和描述里。
- 寻路走不通、结果带 `proposals` 时附 `hint` 说明怎么确认；这段细则不放在工具描述里。

| 类别 | 动作 |
|---|---|
| 移动 | `move_to{x,z,y?,tolerance?,max_dist?,confirm?,allow_dig?,allow_place?}`（单次最多走 `max_dist` 格，默认 128；自动开门/爬梯/游泳, 远距离分段；连续深水 ≥6 格自动冲刺游泳；有水桶时 5~32 格高处直接跳下用落地水缓冲；挖穿/垫高/搭桥需确认，见下）· `go_home` · `jump` · `stop` |
| 采集 | `collect{block,count?,radius?}`（先检查工具：挖了不会掉落的直接失败并说明至少要什么工具；找→走→最佳工具挖→等掉落物落地再捡；优先挑挖完能走进去捡、也走得出来的方块（上面两格是空的）；目标只被正上方**一块自然方块**盖着且挖得快（≤3s，如草方块下的泥土）时先把它挖开再挖目标，人造方块/盖了两层以上的不动；下去捡完若陷在两格深的坑里，先试走回原来那一层，走不回去就在脚下垫一块爬出来，挖开和垫的方块都记进 `route`；仍走不到的掉落物在结果里写明位置，加 `allow_dig` 可挖开去捡；背包满了装不下也会说明）· `dig{x,y,z}`（自动走近、自动换工具）· `pickup_items`（走不到的掉落物列出位置，背包满了装不下也说明，不再报成"附近没有"）|
| 建造/合成 | `place{x,y,z,item?}` · `craft{item,count?}`（3×3 自动找放工作台）· `smelt{item,count?,fuel?}`（自动找放熔炉/选燃料） |
| 附魔 | `enchant{item,option?,slot?}`：自动找/放附魔台、放青金石；不给 `option` 只返回三个选项（等级要求、花费 N 级+N 青金石、提示附魔、不可选原因、书架数），选好再带 `option` 0~2 执行并取出；默认挑没附过魔的那件 |
| 铁砧 | `anvil{item,with?,rename?,slot?,with_slot?,preview?}`：合并附魔书/同类物品修耐久/材料修复/改名（`rename:""` 去名）；先读花费，等级不够或 ≥40 级"过于昂贵"直接说明，`preview` 只看产物和花费；会把物品原有自定义名发回服务器，合并时不会丢名字；用坏铁砧会注明 |
| 物品 | `equip{item}`（工具/盔甲/盾）· `eat` · `use_item` · `select_slot` · `drop_item{item,count?,all?,slot?}`（按物品名丢，`count` 缺省 1，`all` 全丢可跨多组，先丢背包里的再丢快捷栏的；`slot` 只在同名多件时指定丢哪一格，并核对那格确实是 `item`，不是就报错不丢；什么都不传报错）|
| 交互 | `use_block` · `sleep`/`wake` · `interact_entity{entity_id,item?}`（喂食/剪毛/骑乘）· `dismount` · `trade{entity_id,index?,times?}` |
| 战斗 | `attack{entity_id,hits?}`（自动换武器；够不着或隔墙看不见会追过去，每次靠近一小段再判断；挥砍间隔按武器攻速：剑 0.63s、斧 1~1.25s；LLM 在近战/射击时反射层不抢着砍）· `shoot{entity_id,shots?,pickup?}`（弓箭自动瞄准：弹道解算+移动预判，隔墙/会误伤村民玩家时不射，贴脸改近战，打完捡回箭） |
| 容器 | `chest_take{item,count?,x?,y?,z?}` · `chest_put{item,count?,x?,y?,z?}`（按物品名存取，count 缺省为全部；带坐标就一步完成：走过去→开箱→存取→关箱；每步核对数量，满了停下并说明，返回 `moved/in_container/in_inventory`）· `open_container`（箱子上方被完整方块挡住或有猫坐着时直接说明原因）· `close_window` |
| 死亡 | `respawn`（仅 autoRespawn=false 时需要） |

**改地形需确认**：寻路默认只走现成的路（开门/爬梯/游泳），不挖不搭。
- 走不通时动作失败，`detail` 写明原因，`proposals` 给出方案：只挖 / 只搭，两者都不行才给挖+搭。每个方案列出要挖掉的方块和坐标、要放方块的位置（搭桥/垫高）、会用掉哪些方块、背包还差几个（方案按最多 64 块估算）。
- 挖掘代价按背包里最合适的工具实际耗时折算（泥土空手≈4、石头用木镐≈6、石头空手≈33 格步行当量）。人造方块（木板/砖/玻璃/羊毛/台阶…）额外加 40，能绕就绕；箱子/熔炉/床/门等功能方块永不挖。
- 每个方案标 `[推荐]`/`[不推荐]` 并给理由：挖掘方案要求全是自然方块，且每块 ≤3s（有合适的工具，或像泥土这样空手就快）；搭方块方案要求背包方块够用。推荐的方案排在前面，同样推荐时挖优先。`dig` 明细列出每块用的工具、耗时、是否自然、会不会掉落。
- 没有水桶、但有水桶就能从高处直接跳下时，失败信息会附上提示。
- **方案 id 与确认**：每个方案带 id（`p<动作id>-<序号>`），在 bot 上保存 10 分钟。LLM 在原动作参数里加 `confirm:"p12-1"`（多个用逗号分隔）就**只批准该方案列出的格**：A* 只能在这些格上挖或放；执行时如果某格必须挖却没获批（地形变了），就重新规划，不会越权去挖。`allow_dig` / `allow_place` 是"整趟都允许"，范围大，用于确实需要大范围改地形的情况。
- **分段时的方案**：远距离分段寻路失败时，方案只通往中途点。`toward.waypoint` 和失败信息里会写明中途点坐标，以及它离最终目标还有多少格。
- **单次路程上限**：`move_to` / `go_home` 默认一次最多走 128 格（按实际走过的路程算），可以用 `max_dist` 调整（8~512）。到上限后在安全的落脚点（在地上，不在水里或梯子上）停下，返回 `done` 并带 `arrived:false`、`traveled`、`remaining`，由 agent 看过情况再继续。任务内部的移动、反射层不受限；脚本里的 `moveTo` 默认也不限，可传 `maxDist`。
- LLM 选择不动、换目标，或者在原动作参数里加 `allow_dig:true` / `allow_place:true` 重新下达。
- 开了权限也会先试只走现成的路，不通才改地形。
- 结束时（完成、失败、取消都算）`detail` 末尾和 `route{dug,placed}` 列出实际挖掉/放置的方块及坐标。
- `collect`/`craft`/`smelt`/`use_block`/`sleep` 走去目标的路上规则相同：未获准时不会垫高够树顶、不会挖进去取埋着的矿，只返回改动最少的方案。
- 反射层：逃跑、夜间回家都不改地形。
- **落地水**：背包有 `water_bucket`、且不在下界（水会蒸发）时，A* 允许 5~32 格的下落，这不算改地形，不用开关。执行流程：先换上水桶；走下边缘；下落中眼睛够得着落地方块顶面（≤4.3 格）时对准倒水，本地世界同步放上水，物理按水里算；落地后低头用空桶收回。结果写进 `route.water_drops`，没收回的同时记进 `placed`。32 格的上限来自下落速度：再高时每 tick 下落超过 2 格，可能错过倒水的时机。也可以落进现成的水里，同样最高 32 格。
- 规划时第一次搜索同步完成，之后的候选点、权限档位和方案计算每个 tick 只搜一次，不会长时间阻塞事件循环。

**维度**：
- 世界高度按服务器下发的 `dimension_type` 注册表设置：主世界 -64..320，下界/末地 0..256。缺数据时按原版兜底。
- 换维度时：清空区块和实体，取消进行中的动作，聊天里推送 `[换维度]`。`get_scene.dimension` 给出维度名、高度范围、有无顶棚、床会不会爆炸。
- 有顶棚的维度（下界）里，远程分段的中途点、逃跑点都在自己高度附近找地面，不会选到 y=128 的顶棚上面。
- `home` 带维度（旧存档没记的按主世界）。不在同一维度时 `go_home` 直接拒绝并说明。
- 下界/末地拒绝 `sleep` 和对床 `use_block`（会爆炸）。
- 坐标不做 1:8 换算。

**走近操作**：`dig`、`place`、`open_container`、`use_block`、`sleep`、`collect`，以及 `craft`/`smelt` 找工作台或熔炉，都先走到够得着并看得见目标的位置。
- **触及**：从眼睛到方块包围盒最近点 ≤4.4（原版客户端是 4.5）。
- **视线**：DDA 射线检查眼睛到目标的中心和 6 个面（内缩 0.1），有一条不被别的实心方块挡住就算看得见。
- **当前位置**：够得着并看得见就原地操作。够得着但隔着方块，就去附近看得见的站位；附近没有，才隔着方块操作（服务器不校验视线），结果里注明。
- **站位候选**：水平 ±4 格，竖直按触及距离自然过滤，目标下方最多约 6 格（比如高 5 格的架子，在地面就能开）。看得见的排在前面，其次离自己近的。依次试最近的 3 个，只走现成的路，走不到再按改地形规则处理。
- **结果**：写明 `站到 (x,y,z) 操作`。
- **脚本**：`dig()` / `place()` 够不着时也会自动走近，不再直接失败。

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
| `nightShelter` / `home` | false / null | 天黑空闲回家（`home:"here"` 设当前位置，并记下所在维度），有床就睡；只在家所在维度、且能睡床的维度（主世界）触发 |
| `autoRespawn` | true | 死后 0.8s 自动复活；false 则停在死亡界面等 `act respawn` |

## WebUI

`http://127.0.0.1:8767/webui`，打开即用（暂无鉴权）。

- **操作日志**：工具调用/动作结果/上下线/死亡/反射介入，按角色与类型筛选；落盘 `~/.mc-agent/logs/<角色>.jsonl`（5MB 轮转，重启恢复）
- **token 管理**：查看/轮换/增删角色（新角色需自行加服务器白名单）；「禁止上线」可阻止自动重连
- **MCP 接入**：弹窗按当前访问方式生成客户端配置（URL + x-token）

## 目录

- `src/version.ts` — 游戏版本单一来源：`MC_VERSION`/协议号 + `mcData`/`Block`/`Chunk` 单例（其他模块不自己 require minecraft-data）
- `src/conn/` — bot.ts（连接/tick/动作/聊天/死亡；**所有发包都在这里**）、reflex.ts（反射层）、inventory.ts（库存 + 槽位布局常量 `SLOT`）
- `src/actions/` — base.ts（Action/AsyncAction 框架）、registry.ts（动作规格表：参数校验 + act 工具描述/schema 的来源）、actions.ts（移动/挖掘/容器）、tasks.ts（采集/合成/交互/交易）、combat.ts（远程战斗：弹道+瞄准）、script.ts（run_script 脚本引擎）、hands.ts（手持/背包操作）、astar.ts
- `src/world/` `src/physics/` `src/vision/` `src/game/` — 世界模型 · 物理适配 · raycast 渲染 · 物品/方块知识（knowledge.ts）+ 弹道（ballistics.ts）
- `src/http/` — serve.ts（MCP+REST+WebUI 单服务、工具注册与角色过滤）、tokens.ts、oplog.ts、webui.html
- `third_party/` — 26.2/26.3 协议数据（minecraft-data PR #1301, MIT, 见 NOTICE.md）· `scripts/setup-overlay.ts` 可重现 patch

## 版本适配分层与升级检查清单

只支持一个游戏版本（当前 26.3 / 协议 777），不做多版本兼容。但版本相关的东西收在固定位置，升级时按下表逐项核对：

| 层 | 位置 | 升级时做什么 |
|---|---|---|
| 版本号 | `src/version.ts` | 改 `MC_VERSION` / `PROTOCOL_VERSION`；启动时会核对 minecraft-data 的协议号 |
| 协议数据 | `third_party/minecraft-data-*` + `scripts/setup-overlay.ts` | 换成新版数据，`dataPaths` 里沿用旧版的文件（attributes/language/materials/sounds 等）逐个确认；overlay 靠字符串锚点改依赖，依赖升级后看脚本有没有打警告 |
| 协议补丁 | `third_party/patches/*.diff` | 上游已合并就删掉，否则重打 |
| 发包 | `src/conn/bot.ts`（`digStart/digFinish/releaseUseItem/useOnBlock/attackEntity/clickSlot/...`，`DIG_STATUS`） | 动作代码不直接 `client.write`；包名/字段/枚举值的变化只改这里 |
| 收包 | `src/conn/bot.ts`、`src/world/world.ts`、`src/conn/inventory.ts` | `grep -n '26\.3' src/conn src/world` 找出标注过的版本相关字段 (entityDelta、position flags、multi_block_change 等) 逐个核对 |
| 实体元数据 | `metaKeyName()`（world.ts） | 一律按 minecraft-data `metadataKeys` 的名字取，不写下标；新版改名时只需核对名字（`shared_flags/air_supply/pose/item/swell_dir/in_ground/living_entity_flags`…） |
| 槽位布局 | `SLOT` / `containerSize` / `toWindowSlot`（inventory.ts） | 核对玩家窗口和容器窗口布局；业务代码不写裸槽位号 |
| 运行时注册表 | `registry_data`（维度/伤害类型/聊天类型）、`dimension.ts` | 从服务器读，通常不用改；`parseDimType` 兼容新旧两种字段格式 |
| 游戏规则表 | `src/game/knowledge.ts`（工具速度/挖掘等级/攻速/武器伤害/天然方块） | 手写数据，新材质或数值调整不会报错只会算错，要对照版本更新日志 |
| 物理 | `prismarine-physics`（overlay 补版本号）+ `physics/runner.ts` 自己的游泳模拟 | 移动数值有变化时实测核对 |

升级后验证：`pnpm exec tsc --noEmit` → `pnpm setup` 看 overlay 输出 → 在**临时拷贝的服务器**上实测登录、移动、挖、放、开箱、战斗、换维度。

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
- 不会自己找/走传送门，也不做下界↔主世界 1:8 坐标换算；第一人称图为语义调色板（无贴图，有意为之）、无光照（夜晚/洞穴不变暗）；玩家实体只标 `player` 不显示名字
