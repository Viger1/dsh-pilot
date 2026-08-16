# dsh-pilot

**Hands for your DeepSeek Harness agent — autonomous browser operation with a native permission model.**

Sibling of [dsh-preview](https://github.com/Viger1/dsh-preview) (the eyes). Status: **design review** — see [DESIGN.md](DESIGN.md). Implementation starts after the design is approved.

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
