# Fremtind

A Fremtind-branded take on Herdr's default layout. It has warm off-white and granite surfaces from the Jøkul design system and the Fremtind wordmark at the top of the sidebar. It follows the system's light/dark appearance.

![Fremtind](preview.png)

## What you see

- **Sidebar (left, 268px, `chrome`):** the Fremtind wordmark (82×17px, tinted `foreground`) in a 46px header, with search and sidebar-toggle buttons. Below it are the spaces and agents lists, and a 69px footer with Settings and Add machine.
- **Work area:** a 42px tab bar of pills, then the active tab's panes as cards. The cards are 12px apart and 12px in from the edges, with 8px corners (Jøkul `border-radius-s`), a 1px `border` and a 2px `accent` border on the focused pane. Each pane has a 30px header. Files and Changes panels sit on the right (hidden by default), and a 28px status bar sits at the bottom.
- **Light (`fremtind-lys`):** canvas and chrome `#F3F0ED`, panes `#FFFFFF`, borders `#C8C5C3`, text `#0E0D0C` / muted `#636060`, accent `#0E0D0C`, hover `#EBE6E0`, selected `#E4DFD8`.
- **Dark (`fremtind-mork`):** canvas and chrome `#0E0D0C`, panes `#262221`, raised/borders `#3C3434`, text `#F3F0ED` / muted `#C8C5C3`, accent `#F3F0ED`.
- **Fonts:** Geist for the UI and JetBrains Mono for terminals (both ship with Herdr), with 16px terminal padding.

## How it behaves

- Agent status uses Jøkul's semantic colours. Light: working `#4646D1` (info), blocked `#B32424` (error), done `#24753A` (success), idle `#636060`. Dark: `#9A9AEB`, `#F38C8C`, `#81E49C`, `#8F8B89`.
- Everything else behaves like Herdr's `main` layout. Below 160px the sidebar folds to a rail. The wordmark becomes the F symbol (29×16px), which unfolds the sidebar when clicked. On macOS outside fullscreen, the traffic lights fill the rail header, so the `brand` block grows from 46px to 80px while the rail is folded, with the symbol below the lights. It goes back to 46px when the sidebar unfolds.

## Built from

- `layouts/fremtind.json`: Herdr's `main` layout tree, with the root set to `"theme": {"light": "fremtind-lys", "dark": "fremtind-mork"}`. Both `workspace-chrome` blocks (header and `footer: true`) point to `fremtind-chrome`.
- `mods/fremtind-chrome/`: a clone of the shipped `workspace-chrome`, with the Herdr logo and name replaced by `svg("mods/fremtind-chrome/fremtind-wordmark.svg")`. The collapsed rail uses `fremtind-symbol.svg` (the F symbol).
- `themes/fremtind-lys.json`, `themes/fremtind-mork.json`: colours from the `--jkl-color-*` tokens in `@fremtind/jokul` (`styles/theme/_color-scheme.scss`).
- The logo SVGs are rendered from Jøkul's `Logo` component (`<Logo />` and `<Logo isSymbol centered={false} />`). Titles and classes are stripped, and fill/stroke are `currentColor` so Herdr can tint them.

## Watch out

- Jøkul has no terminal colours. The ANSI palettes are derived from the semantic colours. Light yellow is darkened to `#9A5A07` so it's readable on white, and magenta and cyan aren't Jøkul tokens.
- Jøkul's brand font is Inter, but it ships only as `.woff2`, which Herdr can't load. Install Inter and set `"ui_font": "Inter"` for the real thing.
- The F lines in the wordmark are strokes (`stroke-width: 8`), not fills. Keep `stroke="currentColor"` on the SVG or the F disappears.
- The themes need to be copied into `themes/`; the layout doesn't carry them.

## Done when

- `herdr-app check mods/fremtind-chrome` passes, and no `layouts/layout.error` appears.
- `layout.switch {"name": "fremtind"}` shows the black wordmark on `#F3F0ED` in light mode and a light wordmark on `#0E0D0C` in dark mode.
- The focused pane has a 2px near-black (light) or off-white (dark) border, and a blocked agent shows `#B32424`.
