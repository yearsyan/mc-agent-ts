# mc-agent — Minecraft 26.3 LLM Agent Bot

> **免责声明**：本仓库为非官方社区项目，与 Mojang Studios / Microsoft 无任何关联，亦未获其认可。
> 仓库不包含、也不分发任何 Minecraft 游戏代码、资源或反编译产物；
> `third_party/` 中的协议数据来自 MIT 许可的 PrismarineJS/minecraft-data（见 [third_party/NOTICE.md](third_party/NOTICE.md)）。
> "Minecraft" 是 Mojang Synergies AB 的商标，此处仅作兼容性描述。
> 许可证：[MIT](LICENSE)（third_party 部分遵循其原始许可证）。

自研协议 bot：以原生 protocol 777 (Minecraft 26.3) 直连 Fabric 服务器，通过 MCP 让任意 LLM（含 ZCode）操控游戏内 agent。

## 架构

```
单一 Node 服务 (127.0.0.1:8767, npm run bot)
├─ POST /mcp        MCP StreamableHTTP (无状态) ← LLM 客户端直连
├─ /webui-api/*     手动运维 (admin token): POST /webui-api/agents/<名>/offline
├─ REST 调试路由     curl 直接测
└─ 每 agent 一条 MC 协议连接 (原生 protocol 777)
   ├─ Fabric 握手伪装 + tick 门控
   ├─ 世界模型 (prismarine-chunk) + 物理 (prismarine-physics) + A* 动作
   └─ 视觉: DDA raycast PNG (实体叠加) + 场景 JSON

token 即角色 (~/.mc-agent/tokens.json):
  admin   → 管全部角色 (工具需传 name)
  Agent_A / Agent_B / agent_c → MCP 调用自动绑定该角色, 掉线自动重连
```

## 快速开始

```bash
npm install                                   # 装依赖
python3 scripts/apply_nmp_patch.py third_party/patches/nmp-entityDelta.diff node_modules/minecraft-protocol
npx tsx scripts/setup-overlay.ts              # 打 26.3 数据 overlay (node_modules 内)
npx tsx src/http/serve.ts                     # 启动单一服务 (MCP + REST + webui-api)
# tokens 在 ~/.mc-agent/tokens.json (admin + 每角色一个)
python3 scripts/mcp_call.py <Agent_A|admin> tools/call '{"name":"get_scene","arguments":{}}'
```

服务器前提：`online-mode=false`（已迁移玩家数据到离线 UUID），白名单含 `Agent_A / Agent_B / agent_c`。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `spawn_agent(name)` / `kill_agent` / `list_agents` | agent 生命周期 |
| `get_scene(name)` | 位置/朝向/血量/脚下方块/准星指向/附近实体(类型/方位/距离) |
| `get_view(name, w, h, fov)` | 第一人称 raycast 合成 PNG |
| `get_map(name, r, s)` | 顶视地图 PNG（红点=self，红/蓝点=敌对/被动实体） |
| `read_chat(name, since)` / `say(name, text)` | 聊天收发 |
| `act(name, type, ...)` | move_to{x,z} / dig{x,y,z} / place / attack{entity_id} / jump / stop（异步） |
| `wait_action(name, actionId?, timeoutMs)` | 等动作完成 |
| `get_block(name, x, y, z)` | 方块查询 |

## 26.3 协议要点（踩坑记录）

1. **Fabric 服务器握手**：客户端必须在配置态 `minecraft:register` 声明 `fabric:registry/sync` 频道 + brand，收到 registry sync 后回 `fabric:registry/sync/complete`，否则被踢"requires Fabric Loader"
2. **tick 门控**：26.3 服务器同 tick 收到第二个移动包即踢；必须每物理 tick 恰好一对 `position` + `client_tick_end`
3. **teleport_confirm 回显**：26.3 必须回显 x/y/z/yRot/xRot（仅 teleportId 无效）
4. **挖掘 Action 枚举移位**：26.3 新增 `CHANGE_DESTROY_DIRECTION` 插在位置 1，STOP_DESTROY 从 2 变成 **3**（发 2 = ABORT，表现为"挖不掉"）
5. **multi_block_change 新格式**：`chunkCoordinates{x,z=chunk, y=section}` + records[] = `(stateId<<12)|(ly<<8|lz<<4|lx)`
6. **chunk_batch_received**：每批区块必须应答否则服务器停发（chunks 卡在 9）
7. **player_loaded**：26.x 新包，登录后应发送

## 目录

- `src/conn/bot.ts` — 连接/握手/tick 循环/动作调度/聊天
- `src/world/world.ts` — chunk 缓存/方块查询/实体追踪
- `src/physics/runner.ts` — prismarine-physics 适配（含传送重同步）
- `src/actions/` — 动作系统 + A* 寻路
- `src/vision/` — raycast 渲染 + 调色板
- `src/http/serve.ts` — HTTP API
- `src/mcp/server.ts` — MCP stdio
- `third_party/` — 26.2/26.3 数据文件 (来自 minecraft-data PR #1301 分支, MIT, 见 NOTICE.md)
- `scripts/setup-overlay.ts` — 可重现的 node_modules patch

## 已验证能力（全部实测通过）

移动/A*寻路（含挖穿模式+目标高度自适应）、挖掘（长挖掘心跳维持）、放置、攻击（26.3 独立 attack 包）、
库存跟踪、箱子存取、2×2 合成、掉落物拾取、聊天收发、第一人称/俯视视觉、场景 JSON、自动复活。
端到端演示：砍树→拾取 4 原木→存箱→聊天汇报 ✓

## 寻路设计（v2）

```
move_to{x,z} → 目标列高度自适应(±8) → A*(邻居: 平走/斜走/跳1格/下落≤4/平挖穿2格/楼梯上挖3格/浅水深1)
            → 航点跟随(到达半径1.6/终点2.0, 航点跳跃跳过, 卡墙跳, 侧移脱困, 5s重规划×4)
            → 挖穿航点: 每格只发一次 block_dig START(重发会重置服务器进度!), 乐观更新本地模型
```

原生地形实测 25-30 格 3/3 成功。挖掘机制关键认知：**26.x 服务器在最后一次 START 后 ~2 秒由 tick 自动完成破坏**，客户端 STOP 只是加速确认；重复 START 会重置进度（这是之前"挖不动/假失败"的根因）。

## 已知限制

- 垂直断崖 >2 格且无楼梯空间时仍会失败（后续可加垫方块 pillar-up）
- 第一人称图有实体叠加（敌对红/被动蓝/物品黄），但无贴图细节（语义调色板）
- 挂机会被怪打死（有自动复活）；调试时可 `difficulty peaceful`
- M4 的 eat/drop_item 动作已实现未逐一实测
- 自残式深坑（测试挖掘造成）等极端地形需要多次重规划或失败
