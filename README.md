# mc-agent — Minecraft 26.3 LLM Agent Bot

> **免责声明**：本仓库为非官方社区项目，与 Mojang Studios / Microsoft 无任何关联，亦未获其认可。
> 仓库不包含、也不分发任何 Minecraft 游戏代码、资源或反编译产物；
> `third_party/` 中的协议数据来自 MIT 许可的 PrismarineJS/minecraft-data（见 [third_party/NOTICE.md](third_party/NOTICE.md)）。
> "Minecraft" 是 Mojang Synergies AB 的商标，此处仅作兼容性描述。
> 许可证：[MIT](LICENSE)（third_party 部分遵循其原始许可证）。

自研协议 bot：以原生 protocol 777 (Minecraft 26.3) 直连 Fabric 服务器，通过 MCP 让任意 LLM 操控游戏内 agent。

## 架构

```
单一 Node 服务 (默认 127.0.0.1:8767; API_HOST=0.0.0.0 对外)
├─ POST /mcp   MCP StreamableHTTP (无状态) ← LLM 客户端
├─ /webui      WebUI 控制台 + /webui-api 后端 (无鉴权, 对外开放时自行确保网络可信)
├─ REST 调试路由 (curl 直接测)
└─ 每 agent 一条 MC 连接: Fabric 握手伪装 + tick 门控
   · 世界模型 (prismarine-chunk) + 物理 (prismarine-physics) + A* 动作
   · 视觉: DDA raycast 合成 PNG (实体叠加) + 场景 JSON

token 即角色 (~/.mc-agent/tokens.json, WebUI 可增删):
  admin   → 管全部角色, 工具需传 name
  <角色名> → 调用自动绑定该角色, 掉线自动重连 (被禁用时除外);
             tools/list 按角色过滤: 无 name 参数, 不见管理项
```

## 快速开始

```bash
npm install        # postinstall 自动打 nmp patch + 26.3 数据 overlay (失败再手动跑下两行)
python3 scripts/apply_nmp_patch.py third_party/patches/nmp-entityDelta.diff node_modules/minecraft-protocol
npx tsx scripts/setup-overlay.ts
npx tsx src/http/serve.ts
python3 scripts/mcp_call.py <角色|admin> tools/call '{"name":"get_scene","arguments":{}}'
```

bot 以离线身份登录，角色名需加入服务器白名单（online-mode 服务器需在服务端放行离线登录，配套 mod 不在本仓库）。

## MCP 工具（admin 18 个；agent token 自动过滤）

| 工具 | 说明 |
|---|---|
| `get_scene` / `get_view` / `get_map` | 场景 JSON（位置/血量/背包/附近实体/反射状态/死亡信息）· 第一人称 PNG · 顶视地图 PNG |
| `say` / `read_chat` | 发言（不执行命令）· 读聊天（按类型渲染 `* A 挥手`、`A 悄悄对你说: …`，带 key/self，seq 增量） |
| `run_command` | 以角色身份执行服务器命令。**权限完全由服务器决定**，结果区分「无权限」（附可用命令列表）与「参数错误」 |
| `act` / `wait_action` / `wait_event` | 异步动作（见下）· 等动作完成（新消息可中断，动作不中止）· 空闲长轮询等消息（≤180s，比轮询 read_chat 省调用） |
| `set_policy` | 反射策略（见下） |
| `get_block` / `find_block` / `list_inventory` / `get_container` | 方块查询 · 找方块 · 库存 · 容器槽位 |
| `spawn_agent` / `kill_agent` / `list_agents` | 生命周期（admin；agent 的 kill_agent = 自己下线歇会儿） |

**消息收件箱**：别人的聊天/私聊 + 自己死亡会主动推给 agent——任何工具返回末尾附 `{inbox:{unread, latest, hint}}`；`wait_event` 挂起等待、`wait_action` 立即中断送达（~200ms）；`read_chat` 读过即消。

### act 动作（异步，返回 actionId；死亡时全部取消，detail 给死因）

| 类别 | 动作 |
|---|---|
| 移动 | `move_to{x,z,y?,tolerance?}`（自动开门/爬梯/游泳/垫高/搭桥/挖穿, 远距离分段）· `go_home` · `jump` · `stop` |
| 采集 | `collect{block,count?,radius?}`（找→走→最佳工具挖→捡）· `dig{x,y,z}`（自动换工具）· `pickup_items` |
| 建造/合成 | `place{x,y,z,item?}` · `craft{item,count?}`（3×3 自动找放工作台）· `smelt{item,count?,fuel?}`（自动找放熔炉/选燃料） |
| 物品 | `equip{item}`（工具/盔甲/盾）· `eat` · `use_item` · `select_slot` · `drop_item` |
| 交互 | `use_block` · `sleep`/`wake` · `interact_entity{entity_id,item?}`（喂食/剪毛/骑乘）· `mount`/`dismount` · `trade{entity_id,index?,times?}` |
| 战斗 | `attack{entity_id,hits?}`（自动换武器）· `shoot{entity_id,shots?,pickup?}`（弓箭自动瞄准：弹道解算+移动预判，隔墙/会误伤村民玩家时不射，贴脸改近战，打完捡回箭） |
| 容器 | `open_container` · `chest_take{slot}` · `chest_put{slot}` · `close_window` |
| 死亡 | `respawn`（仅 autoRespawn=false 时需要） |

**死亡感知**：`death_combat_event` 为主源（关死亡消息时按伤害类型+攻击者推断，重登还原死亡点）；`get_scene.last_death` 给死因/凶手/死亡物品/掉落物剩余存活秒数；聊天推送 `[你死了]/[掉落]/[已复活]`。

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
- `src/actions/` — base.ts（AsyncAction 框架）、actions.ts（移动/挖掘/容器）、tasks.ts（采集/合成/交互/交易）、hands.ts、astar.ts
- `src/world/` `src/physics/` `src/vision/` `src/game/` — 世界模型 · 物理适配 · raycast 渲染 · 物品/方块知识
- `src/http/` — serve.ts（MCP+REST+WebUI 单服务）、tokens.ts、oplog.ts、webui.html
- `third_party/` — 26.2/26.3 协议数据（minecraft-data PR #1301, MIT, 见 NOTICE.md）· `scripts/setup-overlay.ts` 可重现 patch

## 已验证能力（测试服实测）

- **移动**：开门穿屋、爬梯、游泳、搭桥、垫高、248 格远程分段，原生地形 6 条路线
- **生存链**：空背包 砍树→木板→工作台(自动放置)→木镐→石头→石镐，7 次 act 约 45 秒；熔炼自动放炉选燃料
- **反射**：僵尸近身换铁剑无伤击杀、苦力怕逃逸、自动挑牛排（不吃腐肉）、岩浆脱困 3/3、天黑回家睡觉
- **死亡**：/kill 打断动作并给死因、苦力怕/僵尸死因凶手正确、keepInventory 两态、关死亡消息可推断、死着重登还原
- **命令**：非 OP 被拒并附可用命令表；临时 op 后与 RCON 输出一致，deop 即时收回
- **消息**：两 agent `/msg`/`/me` 互通、公屏/私聊/死亡推送、wait_action 中断 <1s
- **弓箭**：静止靶 8~44 格 25/25；冲锋/斜向/横移的地面怪 17/17；幻翼 14/20；隔墙、村民挡线时拒射并说明；弹开的箭 3/3 捡回
- **盾牌**：骷髅 20s 对射 中箭 8→0；3 只僵尸围攻 挨打 33→10（击杀时间不变）；点燃苦力怕贴脸 掉血 16.7→0；斧头破盾后冷却期不举、到期自动恢复
- **战斗策略**：空闲时骷髅 6~9s 对射击杀；苦力怕远射→近了逃→点燃举盾，无伤；僵尸先射后砍无伤；LLM 赶路时骷髅出现会打断去射，僵尸只在近身时砍

## 已知限制

- 3×3 以上岩浆池中央基本必死（预防靠寻路避让）
- 只能上下载具，不能驾驶；弩不支持（只用弓）；被斧头破盾后不会主动后撤
- 与骷髅对射是"互射"而非"挡箭-还击"交替；反射射击用掉的箭需 LLM 自己 `pickup_items` 捡（自己射出、插在地上的箭也算）
- 下界/末地高度仍按主世界解析；第一人称图为语义调色板，无贴图
