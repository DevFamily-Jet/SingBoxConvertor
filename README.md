# Sing-box 订阅动态转换与托管中心

[![Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![Sing-box](https://img.shields.io/badge/Sing--box-1.14%20%2F%201.15%20%2F%201.17+-blue)](https://sing-box.sagernet.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

本项目是一个高性能、生产级的 **Sing-box 订阅转换与托管服务**，同时支持 **Cloudflare Workers 边缘云端部署** 与 **本地 Python 模拟运行**。

通过 KV 持久化绑定，客户端仅需配置一次专属订阅链接，机场后端无论如何更换域名或节点，所有终端（Windows、macOS、iOS、Android、软路由）均可实现无感自动同步更新。

---

## ✨ 核心特性

### 1. 订阅持久化与无感同步
- **端点固定**：为每个订阅生成永久端点（如 `https://your-worker.workers.dev/sub/my-sub` 或本地 `http://127.0.0.1:8787/sub/my-sub`）。
- **一键更新**：机场源站更换域名或订阅地址失效时，仅需在 Web 控制台修改一次，全设备自动同步，无需逐个客户端重新导入。

### 2. 跨版本全面兼容（Sing-box 1.14 / 1.15 / 1.17+ 平滑支持）
- **TUN 协议栈自适应**：
  - 遵循 Sing-box 官方迁移规范，完全移除了已在 1.15 弃用并在 1.17 即将移除的 TUN `stack` 选项。
  - **1.14 核心**：缺省安全采用默认系统协议栈，语法校验 `Code 0` 零错误。
  - **1.15+ 核心**：自动激活 sing-tun 官方全新自研的高性能原生 TCP/IP 协议栈，彻底消除 `"stack option in TUN has been deprecated"` 废弃警告。

### 3. DNS 架构深度加固与防断连机制
- **远端 DNS 采用 TCP 传输 (`tcp://8.8.8.8`)**：
  - 传统 `udp://8.8.8.8` 在 WebSocket / Cloudflare CDN 等代理节点中无法稳定转发 UDP 53，极易引发 `(exchange6: read destination: EOF)` 严重解析失败。
  - 升级为 TCP 传输后，100% 兼容所有类型的机场节点（包括 CDN / WS / TLS 节点），彻底根除丢包与断流。
- **Apple CDN 与国内直连域名精准解析**：
  - 在 `dns.rules` 中将苹果官方测速网络服务（`mensura.cdn-apple.com`、`apple.com`）以及 `geosite-cn` 集合精准定向至阿里直连 DNS (`223.5.5.5`)，完美支持客户端内置 NetworkQuality 测速工具，实现国内边缘节点毫秒级直连。
- **FakeIP + 本地持久缓存**：
  - 客户端日常请求在本地纳秒级直接返回 FakeIP (`198.18.x.x`)，网络请求 0 延迟等待；
  - 开启 `cache_file` 数据库持久化缓存，查过的域名免去二次向外发包。

### 4. 极致稳健与防断连降级保护 (Crash Prevention)
- **双重缓存回退**：若远端机场源站因网络抖动或维护瞬时超时，服务自动以 `200 OK` 回退提供上一份成功生成的健康配置缓存，保障客户端网络不中断。
- **安全协议防御**：严禁向客户端输出含有 `error` 字段的 JSON 错误数据，彻底杜绝 Sing-box 客户端在更新配置时因报 `decode config: error: json: unknown field "error"` 而破坏现有工作 Profile 导致全线断连的缺陷。

### 5. 网络分流与链路深度调优
- **GitHub 路由独立修复**：显式将 `github.com`、`githubusercontent.com` 等所有 GitHub 域名及其静态资源强制定向至代理，杜绝国内直连 SNI 阻断。
- **ECH 循环互锁根除**：强制将 `cloudflare-ech.com` 的 DNS 查询定向至阿里直连 DNS（`223.5.5.5`）并直连出站，彻底打破 ECH 与代理握手之间的死锁与 15.9s 超时。
- **Google 遥测服务分流**：将 `gvt1.com`、`gvt2.com`、`gcp.gvt2.com` 明确指定走代理，避免直连超时拖慢网络响应。
- **WebSocket 0-RTT 性能加速**：自动识别 `path` 含 `ed=` 的 WebSocket 节点，注入 `max_early_data: 2048` 与 `Sec-WebSocket-Protocol` 头部，建连降低 1 个 RTT（减少 200~300ms 握手耗时）。
- **测速防假死与平滑切换**：
  - 自动测速目标采用 Google 官方全球边缘探测源 `http://www.gstatic.com/generate_204`，根除 Cloudflare 80 端口 HTTP 400 导致的“无延迟”假死误判。
  - 采用 `interrupt_exist_connections: false`，节点测速切换时维持现有活动长连接，绝不闪断。

### 6. 内置 Metacubexd 现代化 Web 控制面板
- **开箱即用 Web 仪表盘**：配置内置 `experimental.clash_api`，自动挂载最新一代 MetaCubeX 官方开源的 [Metacubexd](https://github.com/MetaCubeX/metacubexd) 仪表盘。
- **直连控制**：客户端运行后，浏览器直接打开 `http://127.0.0.1:9090` 或 `http://127.0.0.1:9090/ui` 即可直接进入图形化控制中心，享受动态速率曲线、一键测速、节点无感切换与连接会话排查。

### 7. 广泛的协议与订阅格式兼容
- **代理协议**：Trojan、VLESS (Reality / Vision)、VMess、Shadowsocks、Hysteria 2、TUIC。
- **订阅源格式**：Base64 编码订阅流、SIP002 纯文本链接列表、Clash / Clash.Meta / Mihomo YAML 复杂格式。

### 8. 现代化 Web 管理面板
- 开箱即用深色模式 UI，支持在线订阅管理、别名配置、一键复制、拦截规则配置（自定义域名/IP/应用包名黑名单）。

---

## 💻 本地运行与调试 (Windows / macOS / Linux)

本项目自带本地开发服务器 `dev_cf_server.py`，无需安装复杂的本地模拟器即可获得与 Cloudflare Worker 完全一致的体验：

### 1. 启动本地服务
```bash
python dev_cf_server.py
```
* **控制台面板**：打开浏览器访问 `http://127.0.0.1:8787` 即可进入管理后台。
* **数据安全隔离**：本地订阅元数据存储在系统用户目录（Windows `%LOCALAPPDATA%\singbox_converter_dev_kv.json`），完全独立于项目工程目录，**杜绝误提交至 Git 或上传至云端**。
* **调试文件留存**：转换生成的最终 Sing-box 配置保存在 Windows 临时目录（`%TEMP%\singbox_<id>.json`），随时可供人工查看或使用 `sing-box check` 校验。
* **客户端自动同步**：支持检测并自动同步更新本地 Sing-box 客户端（SFW）正在使用的 Profile 文件。

---

## ☁️ Cloudflare Workers 云端部署

### 方式一：Web 网页端 1 分钟零代码部署（推荐）

1. **登录控制台**：登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. **创建 KV 命名空间**：
   - 依次点击：`存储和数据库 (Storage & Databases)` -> `KV`。
   - 点击 **创建命名空间**，名称输入：`SUB_KV`。
3. **创建 Worker**：
   - 依次点击：`计算 (Workers & Pages)` -> `创建应用程序` -> `创建 Worker`。
   - 自定义名称后点击 **部署**。
4. **绑定 KV**：
   - 进入创建好的 Worker，进入 `设置 (Settings)` -> `变量与密钥 (Variables and Secrets)` -> `KV 命名空间绑定`。
   - 点击 **添加绑定**：
     - **变量名称**：严格填写 `SUB_KV`
     - **KV 命名空间**：选择刚才创建的 `SUB_KV`
5. **部署代码**：
   - 点击右上角 **编辑代码 (Edit code)**。
   - 将本项目 `src/index.js` 的**全部代码**复制粘贴替换原有内容，点击右上角 **部署 (Deploy)**。
6. **完成**：访问分配的 `https://<你的Worker>.workers.dev` 即可使用。

---

### 方式二：使用 Wrangler CLI 命令行部署

```bash
# 1. 登录 Cloudflare 账户
npx wrangler login

# 2. 创建 KV 命名空间
npx wrangler kv:namespace create "SUB_KV"
# 将命令行输出的 binding 与 id 更新到 wrangler.toml 中

# 3. 快速部署
npx wrangler deploy
```

---

## 📡 接口与路由说明

| 路径 | 方法 | 功能描述 |
| :--- | :--- | :--- |
| `/` | `GET` | 访问 Web 可视化管理面板 |
| `/sub/:id` | `GET` | 客户端订阅输出链接（如 `/sub/99`） |
| `/convert?url=<URL>` | `GET` | 单次动态转换（不写入 KV 存储） |
| `/api/list` | `GET` | 获取当前所有托管的订阅列表 |
| `/api/create` | `POST` | 创建或绑定新订阅 |
| `/api/update` | `POST` | 更新已有订阅信息或规则 |
| `/api/delete` | `POST` | 删除指定订阅 |

### 订阅可选 URL 查询参数
* `?version=1.14`（默认）或 `?version=1.15`：指定输出的 Sing-box 规范版本。
* `?tun=false`：关闭默认包含的 TUN 虚拟网卡入站（仅保留 mixed 混合代理端口 2080）。

---

## 🔒 安全与隐私

- 本地持久化数据自动存储在系统级用户数据目录（`%LOCALAPPDATA%`），绝不包含在代码仓库中。
- 项目内置完善的 `.gitignore`，有效防止任何临时配置文件、本地数据库、Python 缓存及个人订阅凭据泄露。
