# Agent 安装指南：Orca Git Graph

你是被用户要求安装本插件的 agent。严格按下列步骤执行，遇到「需要用户决定」的地方停下并询问，不要自行跳过。

## 0. 前置条件（逐项检查，不满足就停下告诉用户）

- `orca --version` 可用且 ≥ 1.4.248（桌面版 Orca 在运行；必要时 `orca open`）。
- `git --version` 可用（插件运行时会调用系统 git）。
- 插件系统已开启：`orca plugin system on --json`。若返回 `plugin_system_disabled`，让用户在 Orca 的 Settings → Plugins 点击 “Turn on plugins”。
- 本仓库为**私有**仓库：`gh auth status` 需已登录且有权限。
- 版权提醒：本插件是 mhutchie/vscode-git-graph 的非官方移植，原许可禁止发布衍生作品，**仅限个人使用，不得公开仓库、不得上架、不得分享安装包**。不要替用户公开仓库或发布到任何目录。

## 1. 获取代码

```sh
INSTALL_DIR="$HOME/orca-plugins/orca-git-graph"
mkdir -p "$HOME/orca-plugins"
if [ -d "$INSTALL_DIR/.git" ]; then git -C "$INSTALL_DIR" pull --ff-only; else gh repo clone kongds1999/orca-git-graph "$INSTALL_DIR"; fi
```

## 2. 校验（只读，不执行插件代码）

```sh
orca plugin validate "$INSTALL_DIR" --json
```

要求 `ok: true` 且 `errors` 为空，否则停下并汇报错误。

## 3. 加载并获取授权清单

```sh
orca plugin dev load "$INSTALL_DIR" --json
```

- 若直接成功：跳到第 5 步。
- 若 exit code 为 `3`（`approval_required`）：从 `error.data` 取出授权清单和 fingerprint。

## 4. 【需要用户决定】展示授权清单并获批后再批准

把下面的授权内容原样展示给用户，**得到用户明确同意后**才能执行批准；绝不替用户批准，也绝不使用 Orca 没有给出的 fingerprint：

- 执行方式：`trusted-worker`，以用户账号权限在本机运行独立 Node 进程（用于调用系统 `git`，含 checkout / reset / push 等写操作）。
- 能力：`storage:own`、`workspace:read`、`workspace:write`、`notifications:show`。
- 贡献：一个自定义编辑器（`.gitgraph`）、一个新建文件菜单项、订阅 `workspace.changed` 事件。

用户同意后：

```sh
orca plugin dev load "$INSTALL_DIR" --approve <orca 返回的 fingerprint> --json
```

## 5. 验证安装

```sh
orca plugin list --json     # 找到 Orca Git Graph，status 应为 running 或 idle，needsReconsent 为 false
orca plugin logs local.orca-git-graph --json   # 不应有错误
```

可选：在仓库目录里 `orca plugin test "$INSTALL_DIR" --json`（会运行插件代码，仅对可信代码执行）。

## 6. 告诉用户怎么用

- 在 Orca 编辑器区域顶部点 `+` 菜单 → **Git Graph**（或命令面板新建 Git Graph），会打开一个中间区域的标签页。
- 顶部 `Repo` 下拉切换仓库，`Branches` 筛选分支；点提交行展开详情；右键分支/提交/标签使用操作菜单。
- 破坏性操作（reset --hard、drop、rebase、clean）请先在不重要的分支上试。

## 更新 / 卸载

```sh
git -C "$INSTALL_DIR" pull --ff-only && orca plugin dev reload "$INSTALL_DIR" --json   # 权限变化会再次要求批准（同第 4 步）
orca plugin dev unload "$INSTALL_DIR" --json                                          # 卸载
```

## 已知限制

仅 macOS 的「复制」依赖 `pbcopy`；不支持交互式 rebase；点击改动文件是在编辑器中打开，差异对比用 Orca 自带 diff。
