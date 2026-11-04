# AGENTS.md — 给 AI 编码代理的项目须知

自研协议 bot：原生 Minecraft 26.3 (protocol 777) 直连 Fabric 服务器，Node 单服务同时提供 MCP / REST / WebUI，让 LLM 操控游戏内 agent。TypeScript ESM（`"type": "module"`，相对导入必须带 `.js` 后缀），strict 模式，Node ≥ 22。

## 常用命令

```bash
pnpm install         # postinstall 自动: nmp patch + 26.3 数据 overlay (失败不影响安装, 可重跑)
pnpm start           # 启动服务 (tsx src/http/serve.ts, 默认 127.0.0.1:8767)
pnpm smoke           # 冒烟: Agent_A 自动上线→场景→挖掘→说话 (需先在 tokens.json 配好角色)
pnpm build           # tsc + 拷贝 webui.html → dist/
pnpm stop            # 停掉已启动的服务
pnpm exec tsc --noEmit  # 类型检查 (改完代码先跑这个)
python3 scripts/mcp_call.py <角色|admin> tools/call '{"name":"get_scene","arguments":{}}'  # 手动调 MCP 工具
```

无单元测试框架。验证 = `tsc --noEmit` 通过 + smoke 脚本 + 连测试服实测（能力详设见 [docs/DESIGN.md](docs/DESIGN.md)）。

## 运行前提

- 需要可达的 Fabric 26.3 测试服；bot 以离线身份登录，角色名要在服务器白名单里
- 配置目录 `~/.mc-agent/`（`MC_AGENT_HOME` 环境变量可覆盖）：`tokens.json`（角色↔token）、`policies.json`（反射策略持久化）、`logs/`（操作日志 JSONL）
- token 即角色：admin 管全部角色（工具需传 name）；普通角色 token 自动绑定该角色，tools/list 按角色过滤

## 架构速览

- `src/conn/` — bot.ts（连接/tick 门控/动作调度/聊天/死亡）、reflex.ts（反射层，每 tick 保命行为）、inventory.ts
- `src/actions/` — base.ts（Action/AsyncAction 框架）、actions.ts / tasks.ts / combat.ts / script.ts（各动作实现）、hands.ts、astar.ts
- `src/http/serve.ts` — 单一入口：MCP StreamableHTTP + REST 调试路由 + WebUI；MCP 工具的注册与角色过滤都在这里
- `src/world/` 世界模型 · `src/physics/` 物理适配 · `src/vision/` DDA raycast 渲染 PNG · `src/game/` 物品知识与箭弹道

## 关键约定

- **包管理只用 pnpm**（配置在 `pnpm-workspace.yaml`，锁文件 `pnpm-lock.yaml`）；不引入 npm/package-lock.json。装依赖、跑命令统一 `pnpm install` / `pnpm <script>` / `pnpm exec <bin>`。
- **node_modules 是打过补丁的**：minecraft-protocol 被 `third_party/patches/nmp-entityDelta.diff` patch，minecraft-data 被 `scripts/setup-overlay.ts` overlay 26.3 数据。绝不手改 node_modules——协议数据的修正应落到 third_party/（可被 setup 脚本重现），升级依赖后要重跑 patch。pnpm 重跑 patch/overlay 时对已应用部分打 WARN 属正常（幂等重入）。
- **新动作继承 Action/AsyncAction**（`src/actions/base.ts`）：Action 是每 tick 驱动 `step()` 的状态机；AsyncAction 用 async run() 写多步流程，支持子动作与取消传播。主动作互斥（新动作顶掉旧的）；死亡取消全部动作并在 detail 给死因。
- **反射层可打断 LLM 动作**：reflex.ts 按 set_policy 策略每 tick 自主执行（逃生 > 战斗 > 进食 > 回家），接管时在动作 detail 注明原因。给 LLM 加新能力时考虑是否也要加对应反射策略。
- **别阻塞事件循环**：tick 门控是硬约束；渲染已分段让出循环（640×360 渲染 tick 延迟 ≤22ms），新增长耗时逻辑（渲染/寻路/扫描）也要分段或限流。
- **MCP 工具三件套**：在 serve.ts `tool(...)` 注册 → handler 实现 → 需要的话加入 `QUERY_TOOLS`（只读集）。工具返回末尾统一附 `{inbox:...}` 消息收件箱提示。
- **中文注释与文档**：代码注释、commit message、README/DESIGN 均用中文；commit message 风格参照 git log（一句话概括改动）。
- **改能力同步文档**：新增/变更 MCP 工具、act 动作、反射策略时，同步更新 `docs/DESIGN.md` 对应表格。
- WebUI 与 REST 无鉴权，默认只绑 127.0.0.1；`API_HOST=0.0.0.0` 对外时由使用者自行保证网络安全。

## 许可

MIT；`third_party/` 协议数据来自 MIT 许可的 minecraft-data（见 third_party/NOTICE.md），仓库不含任何 Minecraft 官方代码/资源。
