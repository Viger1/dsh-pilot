# dsh-pilot

English | [中文](README.zh.md)

**Hands for your DeepSeek Harness agent — autonomous browser operation with a native permission model.**

Your dsh agent can already see pages ([dsh-preview](https://github.com/Viger1/dsh-preview)); `dsh-pilot` lets it *drive* them: navigate, read any page as a numbered accessibility tree, act on elements by ref, wait for conditions, upload files, and test complete flows — all without vision, CSS-selector guessing, or a second model. Built for text-only models: the page IS text.

## What it looks like

Real, unedited runs from a headless dsh agent (DeepSeek-V4-Pro):

**Form flow, fully autonomous** — navigate → snapshot (`textbox "用户名" [ref=e5]`, `button "提交注册" [ref=e12]`, ...) → fill by ref → select an option → check a box → submit → `pilot_wait` for the success text (hit in 5ms) → screenshot → close. Zero console errors, zero selectors written.

**Permissions that follow the session** — the same agent asked to open `https://example.com`:
- under the default `workspace-write` session: refused — the approval chain answered `unavailable` and the agent was told exactly what config to request;
- under `danger-full-access` (the user opted out of prompts): opens silently, no gate in the way.

That is the design: **the plugin never invents a second permission system.** It reads the dsh session's own durable permission events and behaves accordingly.

## Install

```sh
dsh plugin --profile web add dsh-pilot
```

Uses your installed Google Chrome / Microsoft Edge automatically; otherwise run `npx playwright install chromium` once and set `browserChannels: [chromium]`. Requires Node `^22.19 || >=24`.

## Tools

| Tool | What it does |
| --- | --- |
| `pilot_navigate` | goto / back / forward / reload, tabs. The single origin-gated entry; decisions are enforced at the **network layer** (redirects, link-outs, history moves included). |
| `pilot_snapshot` | The page as an accessibility tree with `[ref=e12]` markers bound to concrete elements — shadow DOM and same-origin iframes (`f1e3`) included. |
| `pilot_act` | click / type / press / hover / select / check / uncheck / **upload** by ref. Reports console errors it caused and whether it navigated. |
| `pilot_wait` | Wait for a selector, text, URL fragment, or network idle — returns `satisfied: false` instead of blind-retry loops. |
| `pilot_screenshot` | Viewport or full-page PNG into the workspace, for the human. |
| `pilot_close` | Close tabs when done. |

Refs come from playwright's engine-bound accessibility snapshots (`aria-ref` locators — the same mechanism playwright-mcp uses in production), so snapshot order can never misdirect an action. Stale refs are refused with instructions to re-snapshot.

## The permission model

1. **`localhost` always works** — frontend testing needs no setup.
2. **`allowedOrigins`** pre-authorizes known-good origins/hostnames.
3. **Anything else follows the dsh session** (`newOriginPolicy: auto`, the default):
   - session approval policy `ask` → a standard dsh approval card asks the user once per origin;
   - session under `danger-full-access` (approval policy `never`) → silent allow — a user who opted into full access is not re-gated by a plugin;
   - no approval channel (unattended automation) → fail closed.
4. **Network-layer fence**: the decision is enforced by request interception on the browser context, so redirects, in-page link clicks, and back/forward cannot drift past the entry gate. Popups (`window.open`, `target=_blank`) are closed on arrival.
5. **Credential hygiene, independent of permission mode**: typing/pressing into password fields is refused unless the deployment sets `allowPasswordFields: true` — dsh itself never lets credential literals reach model context, and neither does this plugin. Uploads are restricted to workspace files; downloads land in `downloadDir`.
6. **Page content is data, not instructions** — the bundled skill drills this in.

## Configuration

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
    profileDir: ''              # set a path to keep logged-in state (understand the risk)
    screenshotDir: .dsh-pilot
    downloadDir: .dsh-pilot/downloads
    maxConsoleMessages: 100
    registerSkill: true
```

`profileDir` opt-in gives the agent a persistent browser profile — **everything logged in inside that profile becomes operable by the agent**. Leave empty for a fresh isolated context per run.

## Known limitations

- Approved origins accumulate for the plugin instance's lifetime and are shared across sessions of one dsh process (one shared browser context).
- Canvas-rendered content has no accessibility semantics; `pilot_screenshot` shows it to the human, and screenshot→vision-model routing is on the roadmap.
- Headless rendering differs from a desktop browser (pointer lock, some GPU paths, OS dialogs).
- playwright-core is pinned to `~1.62.0`: the ref-bearing snapshot mode is validated per minor version before upgrading.

## Family

| Plugin | What it gives your agent |
| --- | --- |
| [dsh-preview](https://github.com/Viger1/dsh-preview) | 👁 Eyes — verify what it builds: open, read, screenshot, self-check |
| **dsh-pilot** (this repo) | ✋ Hands — operate any page by accessibility refs, with a native permission model |

Both install independently and coexist. Design rationale and milestones: [DESIGN.md](DESIGN.md).

## Development

```sh
git clone https://github.com/Viger1/dsh-pilot.git && cd dsh-pilot
corepack pnpm install
corepack pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-pilot
```

## License

[MIT](LICENSE)
