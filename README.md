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
pnpm install       # postinstall 自动打 nmp patch + 26.3 数据 overlay (失败再手动跑下两行)
python3 scripts/apply_nmp_patch.py third_party/patches/nmp-entityDelta.diff node_modules/minecraft-protocol
pnpm exec tsx scripts/setup-overlay.ts
pnpm exec tsx src/http/serve.ts
python3 scripts/mcp_call.py <角色|admin> tools/call '{"name":"get_scene","arguments":{}}'
```

bot 以离线身份登录，角色名需加入服务器白名单（online-mode 服务器需在服务端放行离线登录，配套 mod 不在本仓库）。

工具/动作/脚本/反射层/实测结果等详设见 [docs/DESIGN.md](docs/DESIGN.md)。
