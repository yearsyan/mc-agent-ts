# mc-agent — Minecraft 26.3 LLM Agent Bot

> **免责声明**：本仓库为非官方社区项目，与 Mojang Studios / Microsoft 无任何关联，亦未获其认可。
> 仓库不包含、也不分发任何 Minecraft 游戏代码、资源或反编译产物；
> `third_party/` 中的协议数据来自 MIT 许可的 PrismarineJS/minecraft-data（见 [third_party/NOTICE.md](third_party/NOTICE.md)）。
> "Minecraft" 是 Mojang Synergies AB 的商标，此处仅作兼容性描述。
> 许可证：[MIT](LICENSE)（third_party 部分遵循其原始许可证）。

自研协议 bot：以原生 protocol 777 (Minecraft 26.3) 直连 Fabric 服务器，通过 MCP 让任意 LLM（含 ZCode）操控游戏内 agent。

## 架构

```
单一 Node 服务 (默认 127.0.0.1:8767, API_HOST=0.0.0.0 可对外, npm run bot)
├─ POST /mcp        MCP StreamableHTTP (无状态) ← LLM 客户端直连
├─ GET  /webui      WebUI 控制台 (无鉴权): 操作日志 / 角色与 token 管理 / 退出世界
├─ /webui-api/*     WebUI 后端 (无鉴权)
├─ REST 调试路由     curl 直接测
└─ 每 agent 一条 MC 协议连接 (原生 protocol 777)
   ├─ Fabric 握手伪装 + tick 门控
   ├─ 世界模型 (prismarine-chunk) + 物理 (prismarine-physics) + A* 动作
   └─ 视觉: DDA raycast PNG (实体叠加) + 场景 JSON

token 即角色 (~/.mc-agent/tokens.json):
  admin   → 管全部角色 (16 个工具; 工具需传 name)
  <角色名> → MCP 调用自动绑定该角色, 掉线自动重连 (被禁止上线时除外)
            tools/list 按角色过滤: 不见 spawn_agent, 不需 name 参数
  角色列表 = tokens.json 的 agents 键 (默认 Agent_A / Agent_B / agent_c), 可在 WebUI 增删
```

## 快速开始

```bash
npm install                                   # 装依赖
python3 scripts/apply_nmp_patch.py third_party/patches/nmp-entityDelta.diff node_modules/minecraft-protocol
npx tsx scripts/setup-overlay.ts              # 打 26.3 数据 overlay (node_modules 内)
npx tsx src/http/serve.ts                     # 启动单一服务 (MCP + REST + WebUI)
# 浏览器打开 http://127.0.0.1:8767/webui (无鉴权; API_HOST=0.0.0.0 时对局域网开放, 自行确保网络可信)
# tokens 在 ~/.mc-agent/tokens.json (admin + 每角色一个)
python3 scripts/mcp_call.py <Agent_A|admin> tools/call '{"name":"get_scene","arguments":{}}'
```

服务器前提：`online-mode=false`（已迁移玩家数据到离线 UUID），白名单含 `Agent_A / Agent_B / agent_c`。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `spawn_agent(name)` / `kill_agent` / `list_agents` | agent 生命周期 |
| `get_scene(name)` | 位置/朝向/血量/饱食/手持/时间(昼夜)/背包汇总/脚下方块/准星指向/附近实体(类型/掉落物内容/敌对标记/方位/距离)/反射层状态 |
| `get_view(name, w, h, fov)` | 第一人称 raycast 合成 PNG |
| `get_map(name, r, s)` | 顶视地图 PNG（红点=self，红/蓝点=敌对/被动实体） |
| `read_chat(name, since)` / `say(name, text)` | 聊天收发。消息按聊天类型渲染 (`* A 挥手` / `A 悄悄对你说: …` / `[Rcon] …`), 带 `key` (翻译键或聊天类型) 与 `self` (自己发的) |
| `run_command(name, command, waitMs?)` | 以角色身份执行服务器命令 (`chat_command`, 无签名), 返回服务器回给自己的消息。**不设白名单, 权限完全由服务器决定** (bot 非 OP 时 `/seed` `/time` 等被拒, 结果附服务器下发的可用命令列表; 默认能用 `/msg` `/w` `/me` `/list` `/random` `/help` `/trigger` 等)。参数写错时 error 区分"无权限"和"参数不完整" |
| `act(name, type, ...)` | 异步动作, 见下表 |
| `set_policy(name, ...)` | 反射策略 (bot 自主执行, 见下) |
| `wait_action(name, actionId?, timeoutMs)` | 等动作完成 (不带 id = 最近一个) |
| `get_block(name, x, y, z)` | 方块查询 |

### act 动作

| 类别 | 动作 |
|---|---|
| 移动 | `move_to{x,z,y?,tolerance?}` 自动开门/爬梯子藤蔓/游泳/垫方块上升/搭桥/挖穿/挖下, 远距离按 64 格分段 · `go_home` · `jump` · `stop` |
| 采集 | `collect{block,count?,radius?}` 找→走过去(够不着就垫高, 埋着就挖进去)→用最佳工具挖→捡掉落 · `dig{x,y,z}` (自动换工具; 旁边有岩浆拒绝) · `pickup_items{radius?}` |
| 建造 | `place{x,y,z,item?\|hotbar?,face?}` |
| 合成 | `craft{item,count?}` 任意配方 (3×3 自动找/放工作台; 材料不足时列出缺什么) · `smelt{item,count?,fuel?}` 自动找/放熔炉、选燃料 |
| 物品 | `equip{item}` 工具→手, 盔甲→身上, 盾→副手 · `eat{item?}` · `use_item{item?,hold_ms?}` · `select_slot` · `drop_item` |
| 交互 | `use_block{x,y,z,item?}` 门/拉杆/按钮… · `sleep{x?,y?,z?}` / `wake` · `interact_entity{entity_id,item?}` 喂食繁殖/剪毛/骑乘 · `mount` / `dismount` · `trade{entity_id,index?,times?}` (不给 index 返回交易列表) |
| 战斗 | `attack{entity_id,hits?}` 自动换最好的武器 |
| 容器 | `open_container` · `chest_take{slot}` · `chest_put{slot}` · `close_window` |
| 死亡 | `respawn` (仅 `autoRespawn=false` 时需要; 死亡期间其他动作直接失败并提示先复活) |

### 死亡感知

- 监听 `death_combat_event` (服务器专门发给死者, 带死亡消息), `update_health≤0` 兜底; 关了 `show_death_messages` 时用最近一次 `damage_event` 的伤害类型 (配置阶段 `registry_data` 的 damage_type 表) + 攻击者推断死因。死着重新登录时用 login 包里的死亡点。
- 死亡时取消全部动作, detail 为 `死亡: <死因>`; 反射层状态清空。
- `get_scene`: `dead` (死亡界面中)、`deaths` (本次上线累计)、`last_death` (10 分钟内: 死因/凶手/翻译键/地点/维度/死时物品/`drops_despawn_in_s` 掉落物剩余存活秒数 或 `kept_inventory`)。
- `read_chat` 推送本地系统消息: `[你死了] 死因 @ 坐标` → `[掉落] N 个物品掉在死亡点…约 5 分钟后消失` / `物品已保留` → `[已复活] @ 坐标`; 服务器的死亡广播也会渲染成中文 (常见死亡翻译键)。
- 操作日志 (WebUI) 记录 `死亡 #n: 死因 @ 坐标, 掉落 N 个物品` 与复活位置, 角色卡片显示死亡次数和最近死因。

### 反射层 (`src/conn/reflex.ts`)

LLM 决策一次要数秒, 僵尸几秒就能打死人, 所以保命行为由 bot 每 tick 自主执行, LLM 只设策略 (`set_policy`, 持久化在 `~/.mc-agent/policies.json`, 重连沿用):

| 策略 | 默认 | 行为 |
|---|---|---|
| `autoEat` / `eatAt` | true / 14 | 饱食 ≤ eatAt (或掉血且 ≤17) 时挑最好的食物吃, 不打断当前动作 |
| `combat` / `fleeHealth` | defend / 8 | defend: 敌对生物进入 3.3 格自动换武器还击; 血 ≤ fleeHealth 或遇苦力怕时逃跑。flee: 见怪就跑。ignore |
| `avoidHazards` | true | 脚下岩浆/火 → 直接接管控制冲向最近的安全格; 氧气不足时上浮; 空闲泡在水里时踩水 |
| `nightShelter` / `home` | false / null | 天黑且空闲时回家 (`home: "here"` 设当前位置), 家附近有床就睡 |
| `autoRespawn` | true | 死后 0.8s 自动复活 (未生效每 2s 重试; 死亡中打开也立即生效)。false: 停在死亡界面, 等 `act respawn` |

反射层打断 LLM 的动作时会在该动作的 detail 写明原因 (如 `被反射打断: 迎战 zombie`), 每次介入都进操作日志 (类型 `反射`)。

## WebUI

`http://127.0.0.1:8767/webui`，打开即用（暂无鉴权，服务默认只绑本机；对外监听时请确保网络可信）。

- **操作日志**：每个角色的工具调用 (MCP/REST)、动作结果、上线/下线/掉线/死亡、管理操作；按角色/类型筛选，1.5s 增量刷新。
  只读查询 (get_scene/get_view/…) 默认隐藏。日志同时写入 `~/.mc-agent/logs/<角色>.jsonl`（>5MB 轮转，保留 `.1`~`.3` 三份旧文件，单角色最多约 20MB），服务重启后恢复最近 500 条/角色。
- **token 管理**：查看/复制、轮换 (旧 token 立即失效，在线角色不受影响)、新增角色 (名字需另行加入服务器白名单)、删除角色。
- **退出世界**：「退出世界」只断开连接，该角色 token 的下一次 MCP 调用会自动重连；「禁止上线」则同时阻止自动重连，直到「允许上线」。

tokens.json 新增可选字段 `disabled: [角色名]`；`agents` 仍是 `名 → token` 字符串映射，旧脚本照常可读。

## 26.3 协议要点（踩坑记录）

1. **Fabric 服务器握手**：客户端必须在配置态 `minecraft:register` 声明 `fabric:registry/sync` 频道 + brand，收到 registry sync 后回 `fabric:registry/sync/complete`，否则被踢"requires Fabric Loader"
2. **tick 门控**：26.3 服务器同 tick 收到第二个移动包即踢；必须每物理 tick 恰好一对 `position` + `client_tick_end`
3. **teleport_confirm 回显**：26.3 必须回显 x/y/z/yRot/xRot（仅 teleportId 无效）
4. **挖掘 Action 枚举移位**：26.3 新增 `CHANGE_DESTROY_DIRECTION` 插在位置 1，STOP_DESTROY 从 2 变成 **3**（发 2 = ABORT，表现为"挖不掉"）
5. **multi_block_change 新格式**：`chunkCoordinates{x,z=chunk, y=section}` + records[] = `(stateId<<12)|(lx<<8|lz<<4|ly)`（x 在高位、y 在低位）
6. **chunk_batch_received**：每批区块必须应答否则服务器停发（chunks 卡在 9）
7. **player_loaded**：26.x 新包，登录后应发送

## 目录

- `src/conn/bot.ts` — 连接/握手/tick 循环/动作调度/聊天
- `src/world/world.ts` — chunk 缓存/方块查询/实体追踪
- `src/physics/runner.ts` — prismarine-physics 适配（含传送重同步）
- `src/actions/base.ts` — 动作基类 + AsyncAction (多步异步动作, 子动作/取消传播)
- `src/actions/actions.ts` — 移动/挖掘/放置/攻击/容器; `tasks.ts` — 合成/熔炼/采集/拾取/装备/进食/交互/交易; `hands.ts` — 换手持/放方块
- `src/actions/astar.ts` — A* 寻路
- `src/conn/reflex.ts` — 反射层 (进食/战斗/逃跑/危险地形/夜间回家)
- `src/game/knowledge.ts` — 物品/方块知识 (工具速度、挖掘时间、食物、燃料、敌对生物)
- `src/vision/` — raycast 渲染 + 调色板
- `src/http/serve.ts` — 单一 HTTP 服务 (MCP + REST + webui-api)
- `src/http/tokens.ts` — token 存储 (tokens.json, 增删/轮换/禁用)
- `src/http/oplog.ts` — 操作日志 (内存 + `~/.mc-agent/logs/<角色>.jsonl`)
- `src/http/webui.html` — WebUI 单页
- `third_party/` — 26.2/26.3 数据文件 (来自 minecraft-data PR #1301 分支, MIT, 见 NOTICE.md)
- `scripts/setup-overlay.ts` — 可重现的 node_modules patch

## 已验证能力（在测试服实测）

- 移动: 开门穿屋、爬梯子、游泳过 5 格深水道、搭桥过 3 格宽深沟、原地垫高 4 格、248 格远程分段 (含从海里出发)、原生地形 6 条路线
- 采集/合成: 空背包起步 砍树→木板→木棍→工作台(自动放置)→木镐→挖进地下取石头→石镐, 7 次 act 约 45 秒; 高树干自动垫高去砍; 熔炉自动放置+选煤, 3 生铁→3 铁锭
- 反射: 僵尸近身自动换铁剑击杀不掉血; 苦力怕靠近逃到 12 格外; 饥饿时自动挑牛排吃 (不吃腐肉); 1×1 岩浆脱困 3/3; 沉到海底会浮上水面; 天黑自动回家睡觉
- 死亡: `/kill` 打断进行中的 move_to (detail `死亡: 被杀死了 (/kill)`); 苦力怕炸死 / 僵尸杀死时死因与凶手正确; keepInventory 开/关两种掉落提示; autoRespawn=false 时停在死亡界面、动作被拒、`act respawn` 复活后走回死亡点捡回物品; 关掉死亡消息时按伤害类型推断; 死着重新登录还原死亡点并自动复活
- 命令: 非 OP 时 `/seed` `/time` `/gamemode` 被服务器拒绝并列出 12 个可用命令; 临时 op 后 `/seed` 输出与 RCON 一致, deop 后命令树即时收回; 两个 agent 用 `/msg` `/w` 私聊、`/me` 动作, 双方 read_chat 格式正确
- 交互: 拉杆、白天睡觉被拒 (中文原因)、夜里睡觉到天亮、村民交易 (列表/按次数/材料不够时停)、喂两头牛繁殖出小牛、上下矿车、穿盔甲/盾进副手、箱子存取

## 寻路设计（v2）

```
move_to{x,z} → 远 (>64 格) 或目标未加载: 朝目标取中途点 (优先陆地, 不通换角度/缩短), 逐段规划
            → 目标列高度自适应(±8, 水面不选水底; tolerance=0 且给 y 时不自适应)
            → A* (二叉堆, 加权启发 ×1.5, 单次 ≤150ms): 平走/斜走(不切角)/跳1格/下落≤4/平挖/上挖/下挖/
               门(执行时开)/梯子藤蔓/游泳/垫高(仅目标更高时)/搭桥; 不挖箱子/门/床等功能方块和岩浆旁的格
            → 航点跟随 + 卡住侧移/跳 + 5s 重规划×5; 挖穿时按工具估算挖掘时间再发 STOP
```

挖掘机制关键认知：重复 START 会重置服务器端进度（之前"挖不动/假失败"的根因），所以只在预计时间 +4s 仍未破坏时才重试。

## 已知限制

- 掉进 3×3 以上岩浆池中央基本必死 (原版岩浆里移动速度 ~0.7 格/秒, 满血约 2.4 秒烧死); 预防靠寻路避开岩浆、不挖岩浆旁的方块
- 只能上/下载具, 不能驾驶 (马/船/猪需要 vehicle_move/player_input 转向)
- 远程兵 (骷髅) 只在近身时还击, 不会主动追击; 无盾牌格挡/弓箭
- 下界/末地高度仍按主世界 -64..320 解析
- 第一人称图有实体叠加（敌对红/被动蓝/物品黄），但无贴图细节（语义调色板）
