# Orca Git Graph 实施说明与开发历程

## 1. 开发历程回顾 (Development History)

### 阶段一：目标架构与 MVP 原型构建 (Phase 1)
- **目标背景**：将 VS Code 社区经典扩展 Git Graph (mhutchie 1.30.0) 改造成 Orca 插件，仅用于个人本地使用（原 LICENSE 禁止发布衍生作品）。
- **技术选型与架构确立**：
  - 进程模型：采用 Orca `execution: trusted-worker`，Worker 入口为 `src/worker.ts`。
  - 前端复用：直接复用原版编译产物 `out.min.js` 与 `out.min.css`，在 HTML 页面注入 `acquireVsCodeApi()` shim，通过 `orca.plugin.request('msg', ...)` 与 Worker 通信，响应回传通过 `window.dispatchEvent(new MessageEvent('message', { data }))` 灌入前端。
  - 数据源实现：采用 Node 内置 `node:child_process.execFile` 与 `node:path`，零 npm 外部依赖，安全可靠。
  - 只读功能闭环：完成初始状态加载、提交图渲染、分支与标签、作者/时间/Hash 展示、提交详情与文件改动列表、分支与远程过滤。

### 阶段二：实测问题定位与首轮修复 (Fix Round 1)
- **深色主题配色对齐**：排查发现默认深色背景下文字颜色缺失，补全 `--vscode-*` 映射到 Orca 的 `--orca-*` 主题变量，给 `body` 显式设置颜色与背景。
- **仓库聚焦与多 Worktree 匹配算法**：原有的聚焦匹配过粗，重构为结合 `workspace.readContext` 的 `displayName` 与 `branch` 双重精准匹配（优先 `worktree` 类型），并通过 `git rev-parse --show-toplevel` 严密过滤非 Git 目录。
- **非 Git 目录友好兜底**：在 workspace 不是 Git 仓库时渲染友好提示页（"当前 workspace 不是 Git 仓库"），避免前端白屏崩溃。
- **测试覆盖**：在 `src/worker.test.ts` 中补充非 Git 目录和同名 workspace 匹配用例。

### 阶段三：全量 Git 写操作实现与输入安全防护 (Phase 2)
- **写操作功能对齐**：
  - 分支管理：`checkoutBranch`、`checkoutCommit`（分离头指针与 `alwaysAcceptCheckoutCommit` 记忆）、`createBranch`、`deleteBranch`（本地与批量远程删除）、`renameBranch`、`fetch`/`fetchIntoLocalBranch`、`pullBranch`、`pushBranch`（多 remote 支持）。
  - 标签管理：`addTag`（轻量与附注标签、自动推送远程）、`deleteTag`、`pushTag`。
  - 提交管理：`cherrypickCommit`、`revertCommit`、`resetToCommit`（soft/mixed/hard）、`dropCommit`、`merge`、`rebase`。
  - 贮藏与未提交变更：`pushStash`、`applyStash`、`popStash`、`dropStash`、`branchFromStash`、`cleanUntrackedFiles`、`resetUncommitted`。
- **安全与防护机制**：
  - 全量采用参数数组化 `execFile`，杜绝任何 shell 字符串拼接注入。
  - 封装 `validateRefName` 拦截以 `-` 开头的分支/标签名，防止参数劫持。
  - 响应结构与原版 100% 格式对齐（`error: null` / `errors: [null, ...]`, 原样保留 stderr）。
- **自动化测试**：引入 `os.tmpdir()` 临时仓库测试框架，覆盖各类写操作用例。

### 阶段四：侧边栏窄屏痛点与编辑器标签页突破 (Phase 3)
- **问题分析**：侧边栏 panel 宽度受限（326~694px），四列（Description/Date/Author/Commit）与工具栏严重拥挤。
- **双路线探索**：
  - **方案 A（编辑器标签页 Custom Editor）**：在 manifest 声明 `contributes.customEditors`（`.gitgraph` 后缀）与 `contributes.newFiles`，通过 + 菜单或命令面板以全宽标签页打开；接入 `window.orca.document.session` 保持干净文档不弹保存提示。
  - **方案 B（窄屏响应式兜底）**：在 560px 阈值下隐藏 Author/Commit 列、压缩 Date 列、折叠 Controls、CDV 详情改为垂直堆叠。
- **方案决策**：实测表明方案 A（编辑器标签页）视觉开阔、操作自然，完全解决窄屏问题，因此侧边栏面板从 manifest 中正式移除。

### 阶段五：仓库整理、冗余剔除与结构定型 (Cleanup)
- **移除侧边栏专用代码**：从 HTML 中移除窄屏媒体查询、ResizeObserver、body.narrow、CDV 垂直堆叠样式及 Worker 中仅用于截屏控制的临时分支。
- **目录规范化**：将 `panel/` 重命名为 `editor/`，manifest `customEditors.entry` 同步调整为 `editor/index.html`。
- **精简源码**：清理未引用的辅助协议文件（`src/protocol.ts`）。
- **版权合规与剥离 vendor/**：将原版 `vendor/LICENSE` 拷贝保留至 `editor/LICENSE-git-graph`，彻底删除开发期参考的 `vendor/` 目录。
- **过程文件清理**：清理所有临时日志（`agy-run*.log`, `watch.log`）及过程规划文档（`BRIEF.md`, `FIX1.md`, `PHASE2.md`, `PHASE3.md`, `CLEANUP.md`）。

### 阶段六：Git 操作逻辑精细化修复与状态持久化 (Logic Fixes & Persistence)
- **暂存区判断修复**：`areStagedChanges` 补充 `--cached` 参数与空分支/SHA-256 仓库（`git diff --cached --name-only`）兜底，避免将未暂存的工作区改动误判为暂存变动，同时兼容 SHA-1 与 SHA-256 初始空分支。
- **远程编辑功能补全**：实现 `editRemote`，支持远程重命名（`git remote rename`）、抓取地址变更（`set-url`）及推送地址增删改（`--push --add` / `--push` / `--push --delete`），包含远程名称前后端防御性校验及 `--unset-all` 兜底。
- **用户配置操作闭环**：完整实现 `editUserDetails` 与 `deleteUserDetails`，响应结构严格对齐前端 `errors: [null, ...]` 期望格式；针对 `git config --unset` 返回 code 5（配置键不存在）进行静默容错（视为成功返回 null），避免弹窗报错并保证配置自动重载。
- **国际化环境隔离**：所有 Git 子进程执行注入 `LC_ALL: 'en_US.UTF-8'`、`LANG: 'en_US.UTF-8'` 与 `LANGUAGE: 'en_US.UTF-8'`，避免非英文 locale 下解析与正则匹配异常。
- **贮藏选择器修正**：`gitFormatStash` 由 `%gD`（`refs/stash@{0}`）修正为 `%gd`（`stash@{0}`），保证与前端贮藏选择器及 Git 交互契约一致。
- **仓库与视图配置状态持久化**：接入 `orca.storage`，使 `setRepoState`（CDV 高度/分隔栏比例、列宽与隐藏远端等）、`globalViewState` 以及 `workspaceViewState` 在热重载及多会话间完整持久化与无缝恢复。

---

## 2. 核心架构与功能清单

### 2.1 架构设计
- **前端环境 (`editor/`)**：
  - 基于 mhutchie/vscode-git-graph 1.30.0 编译的前端产物 `out.min.js` 与 `out.min.css`。
  - `editor/index.html` 注入 `acquireVsCodeApi()` shim，通过 `orca.plugin.request('msg', ...)` 与 Worker 双向通信。
  - 通过 `window.orca.document.session` 处理自定义编辑器生命周期，保持文档未修改状态。
  - 完整适配 Orca 的 `--orca-*` 主题 CSS 变量。
- **Worker 进程 (`src/worker.ts`)**：
  - 运行于 `trusted-worker` 独立 Node 进程。
  - 基于 `DataSource` 直接调用宿主机 Git 命令并解析回传。
  - 监听 `workspace.changed` 事件，实时更新多仓库列表。
  - 管理视图与全局配置持久化。

### 2.2 支持的 Git 操作
1. **分支操作 (Branch Operations)**
   - `checkoutBranch`：支持切换本地分支与检出远程分支（`-b branch remoteBranch`），支持 `pullAfterwards` 链式拉取。
   - `checkoutCommit`：检出指定提交并支持分离头指针（detached HEAD）；完整实现 `alwaysAcceptCheckoutCommit` 状态记忆与持久化。
   - `createBranch`：支持从指定 commit 创建分支，支持 `checkout` 与 `force` 参数组合。
   - `deleteBranch`：支持本地强制删除（`-D` / `--delete --force`）与可选的批量删除远端分支（`deleteOnRemotes`）。
   - `deleteRemoteBranch`：删除远端分支并在远端已被删除时自动清理本地 remote tracking branch。
   - `renameBranch`：重命名分支（`branch -m`）。
   - `fetch` / `fetchIntoLocalBranch`：远端抓取，支持 `--prune` / `--prune-tags` 与单分支拉取更新。
   - `pullBranch`：支持 `--squash`、`--no-ff`，若指定 squash 则在合并后自动执行 squash commit。
   - `pushBranch`：支持推送到多个远程（`pushBranchToMultipleRemotes`），支持 `--set-upstream` 与模式（如 `force-with-lease`）。

2. **标签操作 (Tag Operations)**
   - `addTag`：支持轻量标签（type 1）与带批注签名的附注标签（type 2，附带 message），支持 `force` 与创建后自动推送至远程（`pushToRemote`）。
   - `deleteTag`：删除本地标签，可选同时删除远端标签（`deleteOnRemote`）。
   - `pushTag`：支持推送到单个或多个远程仓库。

3. **提交与合并操作 (Commit & Merge Operations)**
   - `cherrypickCommit`：支持 `-x` 记录来源、`-m parentIndex` 指定父节点及 `--no-commit` 暂存模式。
   - `revertCommit`：支持还原指定提交（`revert --no-edit`）及合并提交的父节点选择。
   - `resetToCommit`：支持 soft / mixed / hard 三种重置模式。
   - `dropCommit`：使用 `git rebase --onto commit^ commit` 快速丢弃指定提交。
   - `merge`：支持 fast-forward / `--no-ff` / `--squash` / `--no-commit`，并在 squash 暂存变动存在时自动生成提交。
   - `rebase`：支持常规衍合与 `--ignore-date`；交互式衍合环境检测提示。

4. **贮藏与工作区清理 (Stash & Uncommitted Operations)**
   - `pushStash`：支持贮藏附加说明文本与 `--include-untracked` 选项。
   - `applyStash`：应用贮藏，支持 `--index` 恢复暂存区索引。
   - `popStash`：弹出贮藏并从列表中移除。
   - `dropStash`：丢弃指定贮藏项（`stash@{n}`）。
   - `branchFromStash`：从指定贮藏项检出新分支。
   - `cleanUntrackedFiles`：清理未跟踪文件与目录（`git clean -f -d`）。
   - `resetUncommitted`：重置未提交变更（`git reset --mixed/--hard HEAD`）。

5. **安全与参数防护 (Security & Input Sanitization)**
   - 所有 Git 调用均使用 `child_process.execFile`，参数完全数组化，严禁拼接 shell 字符串。
   - 封装 `validateRefName` 校验分支与标签名，严禁以 `-` 开头被误解析为命令行选项；对 commit hash 进行合法性校验。
   - 响应结构与原版 100% 对齐（成功返回 `error: null` 或 `errors: [null, ...]`, 失败原样携带 git stderr）。
   - 未新增额外 capability（如 clipboard），使用原生 pbcopy 管道支持剪贴板辅助功能。

6. **测试与质量保障**
   - 17 项自动化单元测试（位于 `src/worker.test.ts`），利用 `os.tmpdir()` 临时仓库完整覆盖上述各类写操作及输入防御校验，测试全部通过（`orca plugin test .` exit 0）。
   - 静态检查 `orca plugin validate . --json` 与 `orca plugin check . --json` 均顺利通过，无 error / warning。

---

## 3. 已知缺口与未来规划 (Known Gaps & Future Work)

1. **Diff 视图深入**：目前点击文件详情通过 Orca 内置能力 `editor.open` 打开文件，未来待 Orca 开放 side-by-side diff 视图后可接入完整对比视图。
2. **交互式衍合 (Interactive Rebase)**：交互式 rebase 依赖终端交互输入，目前已提示非交互环境限制，未来可接入 Orca terminal 会话。
3. **远程头像 (Avatars)**：因离线和无网络沙箱约束，头像拉取服务保持静默关闭。
