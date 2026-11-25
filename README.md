# herdr-fremtind

A Fremtind-themed [Herdr](https://herdr.dev) layout built from the Jøkul design system's colour tokens, plus two panel mods. See [RECIPE.md](RECIPE.md) for how the layout is built.

| Path | What it is |
| --- | --- |
| `layouts/fremtind.json`, `themes/fremtind-{lys,mork}.json`, `mods/fremtind-chrome/` | The layout, its light and dark themes, and the sidebar chrome |
| [`mods/jira/`](mods/jira/README.md) | A Jira board panel. Clicking an issue opens a worktree and starts an agent on it |
| [`mods/dev-servers/`](mods/dev-servers/README.md) | A panel listing running bazel and pnpm dev servers, with restart and kill |

## Logo files (not included)

This repo doesn't include the Fremtind wordmark and symbol, because they're Fremtind trademarks. `fremtind-chrome` expects two files:

- `mods/fremtind-chrome/fremtind-wordmark.svg`: Jøkul's `<Logo />`
- `mods/fremtind-chrome/fremtind-symbol.svg`: Jøkul's `<Logo isSymbol centered={false} />`

Render them from [`@fremtind/jokul`](https://github.com/fremtind/jokul). Strip the titles and classes, and set `fill` and `stroke` to `currentColor` so Herdr can tint them. See RECIPE.md for details. `layouts/fremtind.svg` (the layout picker preview) is optional.

## Install

```sh
cp -Rn layouts mods themes ~/.config/herdr-app/
herdr-app check ~/.config/herdr-app/mods/fremtind-chrome
herdr-app do layout.switch '{"name":"fremtind"}'
```

`ctrl-shift-l` cycles back to your other layouts.
