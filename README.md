# dsh-pilot

**Hands for your DeepSeek Harness agent — autonomous browser operation with a native permission model.**

Sibling of [dsh-preview](https://github.com/Viger1/dsh-preview) (the eyes). Status: **M0 complete** — aria-ref snapshot/act mechanism, six tools, network-layer origin fence, popup containment, password guard, bundled skill; see [DESIGN.md](DESIGN.md) for the reviewed design and milestones.

## Family

| Plugin | What it gives your agent |
| --- | --- |
| [dsh-preview](https://github.com/Viger1/dsh-preview) | 👁 Eyes — verify what it builds: open, read, screenshot, self-check |
| **dsh-pilot** (this repo) | ✋ Hands — operate any page by accessibility refs, with a network-layer origin fence |

## Planned surface

- `pilot_navigate` — URLs, history, tabs; the single origin-gated entry point
- `pilot_snapshot` — the page as a numbered accessibility-ref tree (`ref-1 button "登录"`), so a text-only model operates pages without vision or CSS-selector guessing
- `pilot_act` — click / type / press / hover / select / drag / upload by ref
- `pilot_wait` — selector / text / URL / network-idle conditions
- `pilot_screenshot`, `pilot_close`

## The differentiator

Origin-level approval wired natively into dsh's permission seam (`tools/pre-execute` → `user-approval`), hard guards for password fields and file transfer, isolated browser context by default. Not another bare automation script.

## License

MIT © Viger1
