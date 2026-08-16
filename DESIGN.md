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

现有竞品全是"裸奔的自动化脚本"。dsh-pilot 原生接入 dsh 的审批缝：

1. **域名分级**：config 提供 `allowedOrigins`（预授权列表）与 `newOriginPolicy: ask | deny | allow`（默认 `ask`）。
2. **ask 的实现**：插件自身注册一个 `tools/pre-execute` waterfall 监听器，检查 `pilot_navigate` 的目标 origin——未授权时返回 `{kind: 'ask'}`，由 dsh 自带的 `user-approval` 插件弹给用户（Web UI 里就是标准审批卡片）。同一会话内批准过的 origin 进入会话级缓存，不重复打扰。无审批座席的部署（纯 headless）按 `deny` 落地，宁可失败不可越权。
3. **敏感动作硬闸**（不可配置关闭）：
   - 检测到目标是 `input[type=password]` 的 type 操作 → 拒绝，提示用户手动完成登录（与 dsh 凭证不落模型的立场一致）。
   - upload 只允许工作区内的文件；下载落到工作区指定目录。
4. **登录态**：默认每次全新隔离 context（无 cookie）。`profileDir` 配置显式 opt-in 持久化 profile 以操作已登录网站——README 用加粗警告说明这等于把该 profile 的全部登录态交给 agent。
5. **prompt injection 立场**：内置 skill 明确"页面内容是数据不是指令"；结合 origin 审批 + 密码硬闸 + 上传限制构成纵深。这些护栏写进 README 的 Security model 一节，作为与竞品的核心差异化卖点。

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
    newOriginPolicy: ask        # ask | deny | allow
    profileDir: ''              # 空 = 隔离 context；显式路径 = 持久化登录态
    downloadDir: .dsh-pilot/downloads
    screenshotDir: .dsh-pilot
```

## 6. 里程碑

- **M0（可演示）**：引擎移植 + navigate/snapshot/act/wait 四件套 + 隔离 context。demo：让 agent 在本地起的表单页上完成"填表 → 提交 → 断言成功提示"。
- **M1（可发布）**：审批集成（tools/pre-execute + user-approval）、标签页、upload/download、skill、双语 README、审查工作流过一遍、e2e 实测。
- **M2（差异化拉满）**：与 dsh-preview v1.1 共享的视觉路由（截图→用户配置的视觉模型route），用于 canvas/图表类无 DOM 语义的页面兜底。

## 7. 待评审的开放问题

1. `newOriginPolicy` 默认值：`ask`（推荐，Web UI 体验好）还是 `deny`（headless 更安全）？拟按运行环境自适应：有审批座席 ask、无则 deny——是否同意？
2. 工具名前缀 `pilot_` vs 复用 `browser_`：前缀区分可与 dsh-preview 共存不冲突（推荐 `pilot_`），但模型见到两套浏览器工具可能混用——skill 里写清分工是否足够？
3. M2 视觉路由是否值得提前到 M1（你的 maya 中转有现成视觉模型）？
