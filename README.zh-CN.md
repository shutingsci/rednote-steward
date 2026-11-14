<p align="center">
  <img src="assets/branding/rednote-steward-logo-v2.png" alt="RedNote Steward 标志" width="132" />
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md"><strong>中文</strong></a>
</p>

<h1 align="center">RedNote Steward</h1>

<p align="center"><strong>在同一个本地工作区里，发布、整理和维护你的小红书账号。</strong></p>
<p align="center">照片 · 成品视频 · 历史帖子 · 发布记录</p>

RedNote Steward 把准备好的素材、账号配置、发布任务和平台结果连在一起。你可以通过 Codex、标准 MCP 客户端或 `xhs-ops` 命令行使用它。它通过 OpenCLI 复用已登录的 Chrome，并在本机保存每项任务的进度。

一组旅行照片、一季已制作完成的科普视频，或一篇旧帖的修订，都需要理清几件事：当前准备好的是哪一版、发到哪个账号、哪些已经提交、中断之后从哪里继续。Steward 把这些信息留在任务里，换一个对话或重新打开终端，也能接着处理。

<p align="center">
  <img src="assets/branding/rednote-steward-overview-v2.png" alt="照片和视频进入本地账号队列，通过 OpenCLI 与 Chrome 发布，再回读同一篇平台笔记。CLI 与 MCP 共用控制器，个人数据留在本机。" width="100%" />
</p>

## 直接这样开始

> “把这批已经做好的帖子按顺序发布，沿用各自的封面和文案，记录每篇的结果。”

> “看一下哪些还在排队、哪些已经发布，哪些中断任务需要先核对平台。”

> “检查一下这周随手发的旅行照片和帖子。保留我的语气，有必要的地方再优化；照片调整要忠于现场。”

> “先把这些新版视频与之前的帖子对应起来，再决定哪些需要发布。”

随项目安装的 Skill 帮助助手完成这些工作。账号偏好、内容判断和已有授权沿用你自己的工作区。

## 能为你做什么

| 工作 | Steward 提供的能力 |
| --- | --- |
| 准备发布 | 统一管理图文或视频内容包，包含文案、真实话题名称、可选封面与文件指纹 |
| 管理账号 | 绑定稳定账号 ID 与浏览器 profile，写入前核对身份 |
| 发布与编辑 | 新发图文/视频、原地替换旧帖视频，并配合本地任务队列、授权记录、计划时间和同账号串行执行 |
| 中断后继续 | 保存尝试记录、平台笔记 ID 与回读结果，先查清结果再执行下一次 |
| 维护历史内容 | 读取清单与指标，编辑平台支持的文字、话题及图片，整理待复查内容 |
| 组织账号资产 | 本地系列/集数目录、巡检游标、媒体来源和追加式指标历史 |
| 管理批次 | 限量执行、逐项结果、暂停/取消，以及人工发布交接 |
| 换一个客户端 | CLI 与标准 MCP Server 共用控制器和任务数据库 |

账号偏好和运维记录保存在安装代码之外，素材留在你选定的工作区。安装后按需运行，定期巡检或后台发布另行配置。

运行器会选择当前可执行的账号，一个未决任务不会挡住无关账号。同一台机器中，稳定账号 ID 或 Chrome profile 只对应一个状态 owner，多个 `XHS_OPS_HOME` 也不能绕过这一归属。

## 通过 OPL 软件中心安装

通过 OPL 软件中心或同一 CLI 管理正式 Package：

```bash
opl packages install rednote-steward --json
opl packages status --package-id rednote-steward --json
opl packages update rednote-steward --json
```

Package 发行源为 `ghcr.io/gaofeng21cn/one-person-lab-packages/rednote-steward`。
CLI 与 MCP 入口共用控制器、安装身份与用户状态。Node.js 24+ 和浏览器连接继续作为
运行依赖；开发 checkout 仅为显式覆盖，不属于软件中心发行版本。

下方 macOS 安装器读取同一 OCI 稳定版本与源码提交。软件中心和独立安装命令提供相同的 CLI、MCP Server 与助手 Skill，也使用同一个稳定更新源。

## 在 macOS 上安装

已有 Node.js 24+ 时，执行：

```bash
curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/rednote-steward/main/install.sh | bash
```

安装器会安装程序、固定版本的 OpenCLI、随项目提供的适配器和通用 Skill。检测到 Codex 时，也会注册 MCP Server。安装器会准备 Browser Bridge 扩展文件，按输出指引在 Chrome 中启用扩展并登录小红书；已经连接的会话可以继续使用。

把命令目录加入当前终端的 PATH，随后查询浏览器 profile 和账号：

```bash
export PATH="$HOME/.local/bin:$PATH"
xhs-ops opencli profile list
xhs-ops account probe --profile YOUR_PROFILE
xhs-ops account add personal --user-id YOUR_USER_ID --profile YOUR_PROFILE
xhs-ops doctor --account personal --json
```

账号 ID 使用 probe 返回的值，每个账号分别绑定自己的 profile。Doctor 显示安装来源、工具链、身份和能力证据；未测能力保留为 `unknown`。[安装说明](docs/installation.md)包含新机准备、MCP 客户端配置、升级和卸载方法。

## 发布准备好的内容

在素材旁边创建 `post.json`：

```json
{
  "schemaVersion": 1,
  "platform": "xiaohongshu",
  "account": "personal",
  "kind": "publish",
  "title": "海边的一刻",
  "body": "在这里写下自己的正文。",
  "topics": [],
  "images": ["photos/01.jpg", "photos/02.jpg"]
}
```

检查内容包，加入队列并执行：

```bash
xhs-ops inspect ./post.json
xhs-ops ingest ./post.json
xhs-ops approve TASK_ID --authorization "发布这个已准备好的内容包" --now
xhs-ops run TASK_ID
xhs-ops show TASK_ID
```

助手可以依据你对这批内容已有的授权登记任务，`approve` 命令本身无需再增加一轮口头确认。视频使用 `video` 和可选的 `cover` 字段替代 `images`。话题名称写入 `topics`，发布时由适配器选择平台候选节点。

替换旧帖视频和自定义封面时，先保存视频与文案，再对同一笔记保存封面。中途恢复会读取阶段记录，已经保存的视频无需再次上传。

如果视频已经保存，只需要修复封面，可以使用 `edit` 内容包仅提供 `cover`，系统会读取并保留原视频，不会再次上传。封面预览默认等待 120 秒；平台处理较慢时，可将 `XHS_OPS_COVER_TIMEOUT` 设为 10–600 秒。点击确认后，适配器还会单独等待最多 30 秒让封面弹窗关闭；弹窗仍未关闭时会停在封面阶段，不会继续提交标题和正文。

视频包、旧帖编辑、计划时间和中断处理见[发布与恢复说明](docs/publishing.md)。[随仓示例](examples/)使用合成素材，不包含个人账号数据或真实帖子。

## 管理准备好的批次

```bash
xhs-ops ingest-batch ./posts/one/post.json ./posts/two/post.json --batch travel-set
xhs-ops approve-batch travel-set --authorization "发布这一批已准备好的内容" --now
xhs-ops run-batch travel-set --limit 4
xhs-ops handoff TASK_ID
```

每篇内容保留自己的指纹和结果。人工完成平台操作后，可以用 `link-existing` 关联回原任务；恢复时先读已有尝试，再决定下一次提交。账号目录、指标历史、媒体来源和备份恢复见[账号运维说明](docs/operations.zh-CN.md)。

## 连接 MCP 客户端

标准 STDIO 服务入口为 `rednote-steward-mcp`：

```json
{
  "mcpServers": {
    "rednote-steward": {
      "command": "rednote-steward-mcp"
    }
  }
}
```

客户端未继承终端 PATH 时，填入已安装命令的绝对路径。CLI 与 MCP 共用账号配置和任务状态；长时间发布会返回任务 ID，随后可查询进度。

## 当前范围

本地浏览器流程面向 macOS，通过固定版本的 OpenCLI/Browser Bridge 使用已登录的 Chrome。图文发布、旧帖维护、账号读取和内容清单沿用了已有工作流。适配器已包含视频和自定义封面的处理路径，测试覆盖控制流程；真实媒体验收按具体账号和环境单独记录。平台页面变化时，适配器可能需要相应更新。

CLI、标准 MCP Server 和助手 Skill 共用一个控制器与发行版本。OPL/Codex 插件提供相同运行时、锁定依赖，以及任务、内容差异、冻结素材和平台回读的只读视图。软件中心和独立安装器都选择经过验证的 OCI 稳定版本；源码 tag 保留版本历史。没有共享 UI 的客户端可使用 `xhs-ops review TASK_ID` 或 `task_review`。内容生成和照片增强由你选用的工具完成，Steward 管理准备好的成果及其发布记录。

## 文档与开发

- [安装说明](docs/installation.md)：新用户、浏览器连接、MCP、升级和卸载。
- [发布与恢复](docs/publishing.md)：内容包、编辑、任务状态与结果核对。
- [账号运维](docs/operations.zh-CN.md)：批次、人工交接、账号目录、指标历史、媒体来源与备份。
- [架构说明](docs/architecture.md)：统一控制器、账号隔离与私人数据位置。
- [后端兼容](docs/backend-compatibility.md)：升级前的能力证据与只读比较。
- [助手 Skill](skills/rednote-steward/SKILL.md)：发布及账号维护方法。

```bash
npm ci
npm test
npm run check:package
```

## 许可

采用 [Apache License 2.0](LICENSE)。OpenCLI 等复用组件的来源见 [NOTICE](NOTICE)。
