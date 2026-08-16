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

### ref 机制

- 每次 `pilot_snapshot` 生成一代引用表：`ref-N → (role, accessible name, nth)` 定位器映射，存在 TrackedPage 上。
- 导航或新 snapshot 使旧代引用失效；`pilot_act` 拿到过期 ref 返回结构化错误："refs are stale, call pilot_snapshot again"——把重新观察的纪律编码进错误信息。
- 无障碍名缺失的元素回退到 `nth-of-role` 定位并在 snapshot 里标注，提示模型优先选有名字的元素。

## 3. 权限模型（本插件的核心卖点）

现有竞品全是"裸奔的自动化脚本"。dsh-pilot **不发明第二套权限系统**——它读取并跟随 dsh 会话自身的权限旋钮（`sandbox/mode` / `approval/policy` 持久事件，随权限预设在会话创建时固化）。

设计前提（已核实官方语义，`packages/interaction/user-approval/README.md`）：审批策略 `never`（`danger-full-access` 预设自带）的含义是**"不弹窗，需审批动作自动拒绝"**。因此域名检查不能无脑走 ask 通道——在全开权限模式下会被自动拒绝，恰好与用户意图相反。

1. **默认 `newOriginPolicy: auto`，跟随 dsh 会话权限**：
   - 会话为 `danger-full-access`（审批 `never`）→ 任何 origin **静默放行**。用户已声明全开权限，插件不再设卡。
   - 会话审批策略为 `ask` 且审批座席在场 → 新 origin 弹标准审批卡（`tools/pre-execute` 返回 `ask`，由 `user-approval` 服务）；同会话批准过的 origin 进入插件级缓存不重复问。
   - 无审批座席（纯自动化部署）→ 拒绝，与 dsh 自身"审批缺席即失败关闭"一致。
   - 显式覆盖值 `ask | deny | allow` 供需要固定行为的部署使用。
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

- **M0（可演示）**：引擎移植 + navigate/snapshot/act/wait 四件套 + 隔离 context。demo：让 agent 在本地起的表单页上完成"填表 → 提交 → 断言成功提示"。
- **M1（可发布）**：审批集成（tools/pre-execute + user-approval）、标签页、upload/download、skill、双语 README、审查工作流过一遍、e2e 实测。
- **M2（差异化拉满）**：与 dsh-preview v1.1 共享的视觉路由（截图→用户配置的视觉模型route），用于 canvas/图表类无 DOM 语义的页面兜底。

## 7. 评审决议（2026-08-16，与维护者讨论定案）

1. **origin 策略**：默认 `auto`，跟随 dsh 会话权限（danger-full-access 静默放行 / ask 弹标准审批卡 / 无座席拒绝）。维护者原则：用户在 dsh 里开了全部权限，插件不得再设卡。凭证卫生闸独立于权限模式，`allowPasswordFields` 可显式关闭。
2. **工具名**：`pilot_` 前缀，与 dsh-preview 共存；分工由各自 skill 说明。
3. **视觉路由**：维持 M2，不阻塞 M0/M1 发布。
4. **npm 发布**：与仓库转公开同步进行；scoped 名 `@n0nam2/*` 作为名字被抢时的兜底。
