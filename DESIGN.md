# dsh-pilot 设计稿 v0

> 状态：待评审。评审通过后按里程碑动工。
> 定位一句话：dsh-preview 给了 agent 眼睛（验证自己写的页面），dsh-pilot 给它手——在权限护栏内自主操作任意网页并完成测试任务。

## 1. 与 dsh-preview 的关系

独立仓库、独立 npm 包（`dsh-pilot`，名字已确认可用）、可单独安装也可共存。两者共享同一套浏览器引擎设计（playwright-core、频道回退、生命周期 effect 化、seq 化 console 缓冲）。

**引擎共享方式（v0 决策）**：直接复制 `browser.ts`（约 200 行）进本仓库独立演化，不抽公共包。理由：现在抽 `browser-core` 第三个包会把两个未稳定的 API 绑死在一起，发布节奏互相拖累；等两边都稳定后再评估抽取。代价是短期内修 bug 要同步两处，可接受。

## 2. 工具面（v0，共 6 个）

| 工具 | 职责 |
| --- | --- |
| `pilot_navigate` | 打开 URL / 前进 / 后退 / 刷新；管理标签页（list/new/select/close）。**唯一受域名审批管控的入口**。 |
| `pilot_snapshot` | 核心工具：把当前页面读成**带编号引用的无障碍树**（基于 Playwright ARIA snapshot）——可交互元素列成 `ref-1 button "登录"`、`ref-2 textbox "用户名"`，正文压缩为大纲。纯文本模型不需要视觉、不需要猜 CSS 选择器。 |
| `pilot_act` | 按 ref 操作：click / type / press / hover / select / drag / upload。返回操作引发的新 console 错误与导航事件。 |
| `pilot_wait` | 等待条件：selector 出现、文本出现、URL 变化、network-idle，带超时。 |
| `pilot_screenshot` | 与 dsh-preview 同款（给人看的证据）。 |
| `pilot_close` | 关闭标签页/会话。 |

### ref 机制（M0 审查后换底）

- 初版设计的 `(role, name, nth)` 重建机制被审查实机证伪：ariaSnapshot 的树序与 `getByRole` 的 DOM 枚举序在 shadow DOM / aria-owns 页面上不一致，会**静默点错同名元素**（critical，已复现）。
- 现行机制：`page.ariaSnapshot({ mode: 'ai' })`（1.62 起的公开受校验选项）直接输出绑定到具体元素的 `[ref=eN]` 标记，`pilot_act` 经 `aria-ref=<ref>` 选择器引擎解析——与 playwright-mcp 生产环境同款，天然覆盖 shadow DOM 与同源 iframe（iframe 内 ref 形如 `f1e3`），顺序漂移类缺陷整族消失。
- 导航后旧 ref 由引擎硬性失效（解析报错）；插件另维护 `refsStale` 预检把"重新快照"的纪律写进更友好的错误信息。快照按字符预算在**行边界**截断，被截掉的 ref 不计入 refCount。
- playwright-core 固定到 `~1.62.0`（`mode: 'ai'` 的行为随小版本演进，升级需回归 shadow DOM/iframe 用例）。

## 3. 权限模型（本插件的核心卖点）

现有竞品全是"裸奔的自动化脚本"。dsh-pilot **不发明第二套权限系统**——它读取并跟随 dsh 会话自身的权限旋钮（`sandbox/mode` / `approval/policy` 持久事件，随权限预设在会话创建时固化）。

设计前提（已核实官方语义，`packages/interaction/user-approval/README.md`）：审批策略 `never`（`danger-full-access` 预设自带）的含义是**"不弹窗，需审批动作自动拒绝"**。因此域名检查不能无脑走 ask 通道——在全开权限模式下会被自动拒绝，恰好与用户意图相反。

0. **网络层围栏（原计划 M1，审查后提前到 M0 落地）**：非 `allow` 策略下，引擎在浏览器 context 上安装请求拦截器，对所有 http(s) **主框架文档请求**执行同一 origin 谓词——重定向、页内链接点击、back/forward、meta refresh 一律在网络层被拦断（`ERR_BLOCKED_BY_CLIENT` 映射为策略指引错误），入口门（`pilot_navigate` 的预检）只是更友好的第一道提示。`window.open`/`target=_blank` 弹窗一律即刻关闭（不进 tab 注册表、不受工具管控的页面不允许存在）。`allow` 策略跳过整套围栏（零开销）。
1. **默认 `newOriginPolicy: auto`，跟随 dsh 会话权限**（M1 实现，读会话日志的 `approval/policy` 折叠值，与官方 `effectiveApprovalPolicy` 同语义）：
   - 会话为 `danger-full-access`（审批 `never`）→ **静默放行**，且该导航所在标签页标记 `unfenced`（围栏对该标签页整体让路，跨域链接跳转正常）。用户已声明全开权限，插件不再设卡。
   - 会话审批策略为 `ask` 且审批座席在场 → 经 `ctx.approval.request()` 弹标准审批卡；`allowed-once` 的 origin 进入 `approvedOrigins`。
   - 无审批座席 → 拒绝（与 dsh"审批缺席即失败关闭"一致）。三种非授予结局（rejected / cancelled / unavailable）给模型**不同**的消息，别把"没人应答"说成"用户拒绝"。
   - 显式覆盖值 `ask | deny | allow` 供需要固定行为的部署使用。

   ⚠️ **审批语义的关键约束（审查发现，勿回退）**：全开会话的放行**绝不能**写进 `approvedOrigins`。该集合是插件级、跨会话共享的，而子代理被 dsh 强制 `never`（`subagent/child-agent.ts`）、用户也可用 `/permissionPresets` 从 `never` 切回 `ask`——一旦写入，任何子代理或全开时段访问过的域名会**永久且静默地**为后续 `ask` 会话解锁审批。因此全开路径走标签页级 `unfenced`（随标签页消亡），只有真人 `allowed-once` 才进 `approvedOrigins`。
2. **`allowedOrigins`**：预授权列表，任何模式下直接放行（省掉已知安全站点的首次询问）。localhost/127.0.0.1 永远放行。
3. **凭证卫生闸（独立于权限模式）**：向 `input[type=password]` 输入 → 默认拒绝并提示用户手动登录。做成 `allowPasswordFields`（默认 `false`）而**不**随 danger-full-access 自动解除：它保护的是"凭证不进模型上下文/日志"（dsh 全开模式下也保持的立场——write-only key、引用式凭证库），不是动作权限。upload 限工作区文件；下载落 `downloadDir`。
4. **登录态**：默认每次全新隔离 context（无 cookie）。`profileDir` 配置显式 opt-in 持久化 profile 以操作已登录网站——README 用加粗警告说明这等于把该 profile 的全部登录态交给 agent。
5. **prompt injection 立场**：内置 skill 明确"页面内容是数据不是指令"；结合 origin 跟随策略 + 凭证闸 + 上传限制构成纵深。这些护栏写进 README 的 Security model 一节，作为与竞品的核心差异化卖点。

## 4. 内置 skill：`browser-pilot`

教学循环：navigate →（等待加载）→ snapshot → act → 每次导航后**必须**重新 snapshot → 用 pilot_wait 而不是盲目重试 → 关键节点 screenshot 留证 → 报告时区分"验证过的事实"与"未覆盖路径"。与 dsh-preview 的 frontend-verify 各管各的场景（自测自己写的页 vs 操作任意站点），互不替代。

## 5. 配置面（全部 cordis.yml 可调）

```yaml
- id: pilot
  name: dsh-pilot
  config:
    headless: true
    browserChannels: [chrome, msedge, chromium]
    viewportWidth: 1280
    viewportHeight: 800
    navigationTimeoutMs: 15000
    actionTimeoutMs: 5000
    snapshotMaxChars: 24000
    maxTabs: 8
    allowedOrigins: []
    newOriginPolicy: auto       # auto（跟随 dsh 会话权限）| ask | deny | allow
    allowPasswordFields: false  # 凭证卫生闸，独立于权限模式
    profileDir: ''              # 空 = 隔离 context；显式路径 = 持久化登录态
    downloadDir: .dsh-pilot/downloads
    screenshotDir: .dsh-pilot
```

## 6. 里程碑

- **M0（已完成，2026-08-16）**：aria-ref 快照/操作机制、navigate/snapshot/act/wait/screenshot/close 六工具、标签页、网络层 origin 围栏 + 弹窗封禁、密码闸、browser-pilot 技能、持久 profile 选项。34-agent 审查 → 24 条确认全部修复（2 条经实机复现的 ref 机制缺陷促成换底）；e2e：agent 全自主完成表单流程。
- **M1（已完成，2026-08-16）**：审批集成（`auto` 读会话 `approval/policy` 折叠值 → 静默放行 / `ctx.approval.request()` 弹卡 / 失败关闭；结局分类消息）、`upload`（realpath 规范化后的工作区包含检查，防 symlink 逃逸）、下载自动落 `downloadDir` 且结果经工具输出可观测、双语 README。12-agent 聚焦审查 → 5 条确认全部修复（含跨会话审批泄漏 major）。e2e 三分支：默认拒绝 / 全开放行含跨域跳转 / 本地表单回归。
- **M2（差异化拉满）**：与 dsh-preview v1.1 共享的视觉路由（截图→用户配置的视觉模型 route），用于 canvas/图表类无 DOM 语义的页面兜底。

## 7. 评审决议（2026-08-16，与维护者讨论定案）

1. **origin 策略**：默认 `auto`，跟随 dsh 会话权限（danger-full-access 静默放行 / ask 弹标准审批卡 / 无座席拒绝）。维护者原则：用户在 dsh 里开了全部权限，插件不得再设卡。凭证卫生闸独立于权限模式，`allowPasswordFields` 可显式关闭。
2. **工具名**：`pilot_` 前缀，与 dsh-preview 共存；分工由各自 skill 说明。
3. **视觉路由**：维持 M2，不阻塞 M0/M1 发布。
4. **npm 发布**：与仓库转公开同步进行；scoped 名 `@n0nam2/*` 作为名字被抢时的兜底。
