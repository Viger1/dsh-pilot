# dsh-pilot

[English](README.md) | 中文

**权限模型直接沿用 dsh 会话、并在网络层强制执行的浏览器自动化。**

能让 dsh agent 开浏览器的插件不少，其中多数也把页面读成无障碍树——**那是生态惯例，不是卖点**。但没有一个认真回答"agent 被允许去哪里"：它们普遍只在工具调用入口处检查一次，而这在结构上挡不住重定向、页内链接点击和前进后退。

`dsh-pilot` 从两个层面回答：策略**读取会话自身的审批状态**而非另立一套，且**由浏览器 context 上的请求拦截强制执行**——无论导航是怎么发起的，主框架请求都得过这一关。

## 实际效果

来自 headless dsh agent（DeepSeek-V4-Pro）的真实未剪辑运行：

**全自主表单流程。** 下面是 `pilot_snapshot` 对一个注册页面的真实返回——也就是 agent 看到的全部内容：

```
- heading "用户注册" [level=1] [ref=e2]
- generic [ref=e3]:
  - text: 用户名
  - textbox "用户名" [ref=e5]
  - text: 邮箱
  - textbox "邮箱" [ref=e7]
  - text: 套餐
  - combobox "套餐" [ref=e9]:
    - option "免费版" [selected]
    - option "专业版"
  - checkbox "同意服务条款" [ref=e11]
  - button "提交注册" [ref=e12]
  - button "重置" [ref=e13]
```

接下来：填 `e5` 与 `e7`、在 `e9` 上选「专业版」、勾选 `e11`、点击 `e12`、`pilot_wait` 等成功提示（5ms 命中）、截图、关标签页。零控制台错误，零手写选择器，全程没有视觉模型参与。

**权限跟随会话** —— 同一个 agent 尝试打开 `https://example.com`：
- 默认 `workspace-write` 会话下：被拒——审批链返回 `unavailable`，agent 被明确告知该请用户加什么配置；
- `danger-full-access` 会话下（用户已选择关闭弹窗、全开权限）：静默放行，没有任何多余的关卡。

这就是设计原则：**插件不发明第二套权限系统**，而是读取 dsh 会话自身的持久权限事件并照办。而且由于决策落在请求拦截器而非 pre-execute 钩子里，页面靠重定向或链接跳到别处也绕不过去。

## 安装

```sh
dsh plugin --profile web add dsh-pilot
```

自动使用已安装的 Google Chrome / Microsoft Edge；没有的话执行一次 `npx playwright install chromium` 并设 `browserChannels: [chromium]`。需要 Node `^22.19 || >=24`。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `pilot_navigate` | goto / 前进 / 后退 / 刷新、标签页。唯一的域名管控入口；决策在**网络层**强制执行（重定向、页内跳转、历史移动全覆盖）。 |
| `pilot_snapshot` | 页面读成带 `[ref=e12]` 标记的无障碍树，ref 绑定真实元素——shadow DOM 与同源 iframe（`f1e3`）都覆盖。 |
| `pilot_act` | 按 ref 执行 click / type / press / hover / select / check / uncheck / **upload**。报告动作引发的控制台错误与是否发生导航。 |
| `pilot_wait` | 等待选择器 / 文本 / URL 片段 / network idle——超时返回 `satisfied: false`，不搞盲目重试。 |
| `pilot_screenshot` | 视口或全页 PNG 存入工作区，给人看。 |
| `pilot_close` | 用完关标签页。 |

ref 来自 Playwright 引擎绑定的无障碍快照，因此快照顺序永远不会误导操作，过期 ref 会被拒绝并提示重新快照。这一机制是 agent 浏览器工具的**通行做法**，并非本插件首创——它带来的维护代价见[已知限制](#已知限制)。

## 权限模型

1. **`localhost` 永远可用**——前端测试零配置。
2. **`allowedOrigins`** 预授权已知安全的域名。
3. **其余跟随 dsh 会话**（默认 `newOriginPolicy: auto`）：
   - 会话审批策略为 `ask` → 标准 dsh 审批卡向用户请求，每个 origin 问一次；
   - 会话为 `danger-full-access`（审批策略 `never`）→ 静默放行——用户既已选择全开权限，插件不再设卡；
   - 无审批通道（无人值守自动化）→ 失败关闭。
4. **网络层围栏**：决策通过浏览器 context 的请求拦截强制执行，重定向、页内链接、前进后退都绕不过入口门。弹窗（`window.open` / `target=_blank`）一律即刻关闭。
5. **凭证卫生（独立于权限模式）**：向密码框输入默认拒绝，除非部署显式设 `allowPasswordFields: true`——dsh 本体从不让凭证明文进模型上下文，本插件同样。上传仅限工作区文件；下载落入 `downloadDir`。
6. **页面内容是数据不是指令**——内置技能反复强调这一条。

## 配置

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
    waitMaxMs: 60000
    snapshotMaxChars: 24000
    maxTabs: 8
    allowedOrigins: []
    newOriginPolicy: auto       # auto | ask | deny | allow
    allowPasswordFields: false
    profileDir: ''              # 设路径可保留登录态（理解风险后再开）
    screenshotDir: .dsh-pilot
    downloadDir: .dsh-pilot/downloads
    maxConsoleMessages: 100
    registerSkill: true
```

`profileDir` 是显式 opt-in 的持久浏览器 profile——**该 profile 里所有已登录的站点都将可被 agent 操作**。留空则每次运行全新隔离。

## 已知限制

- 批准过的 origin 在插件实例生命周期内累积，并在同一 dsh 进程的会话间共享（共享一个浏览器 context）。
- canvas 渲染的内容没有无障碍语义；`pilot_screenshot` 可以给人看，"截图→视觉模型"路由在路线图上。
- 无头渲染与桌面浏览器有差异（指针锁定、部分 GPU 路径、系统对话框）。
- **ref 机制有一半依赖 Playwright 内部 API。** `ariaSnapshot({ mode: 'ai' })` 是公开且有文档的，但把 ref 还原成定位器的 `aria-ref=` 选择器引擎没有文档，相关的 `Locator.ariaRef()` 已在 Playwright 1.60 被移除。因此 `playwright-core` 锁在 `~1.62.0`，每次小版本升级都要针对 shadow DOM 与 iframe 用例重新验证。请把这当成持续的维护成本，而不是已经稳固的地基。
- **名字不唯一。** [guo6x/dsh-pilot](https://github.com/guo6x/dsh-pilot) 是同领域另一个更早的插件，经 `github:guo6x/dsh-pilot` 安装；本仓库对应的是 npm 包 `dsh-pilot`。提 issue 前请先确认你装的是哪一个。

## 同系插件

| 插件 | 给 agent 的能力 |
| --- | --- |
| [dsh-preview](https://github.com/Viger1/dsh-preview) | 👁 眼睛——验证自己写的页面：打开、读取、截图、自检 |
| **dsh-pilot**（本仓库） | ✋ 手——按无障碍 ref 操作任意页面，带原生权限模型 |
| [dsh-review](https://github.com/Viger1/dsh-review) | 🔍 判断力——找出缺陷，并在报告前逐条尝试推翻它 |
| [dsh-design](https://github.com/Viger1/dsh-design) | 🎨 品味——先约束选择，再实测结果有没有守住 |

三者均可独立安装、可共存。设计依据与里程碑见 [DESIGN.md](DESIGN.md)。

## 本地开发

```sh
git clone https://github.com/Viger1/dsh-pilot.git && cd dsh-pilot
corepack pnpm install
corepack pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-pilot
```

## 协议

[MIT](LICENSE)
