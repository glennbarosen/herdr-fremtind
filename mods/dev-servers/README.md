# dev-servers

A panel listing the dev servers running on this machine, grouped into **Backends** (JVMs started with `bazel run`: Java and Kotlin) and **Frontends** (`pnpm` scripts), with restart and kill per server. It finds them with `ps` and `lsof`, so it sees servers wherever they were started: a Herdr terminal, another terminal app, or an agent's background task. It refreshes every 8 seconds.

- **Row:** the server's name (the bazel package for a generic binary name like `app`, the `--filter` or `package.json` name for pnpm), the worktree or repo it runs from, its listening ports, and how long it has run. *Starting* means it doesn't listen on a port yet. *Herdr* means it runs in a tab Restart opened. Hover for the target or command, folder and pid.
- **Click a row:** goes to its `▶ <name>` tab if Restart started it. Otherwise it opens the server's output (its stdout file, e.g. a Claude background task's) in a `log: <name>` tab with `tail -F`.
- **:port:** opens `http://localhost:<port>` in the browser.
- **↻ Restart:** stops the process tree, then runs the command again in the server's folder, in a background tab `▶ <name>` of the space working in that folder (a space with a terminal inside the worktree, else the repo's, else the shown one). An earlier `▶` tab for it is closed first. The command is `bazel run //<package>:<name>` from the workspace the binary was built in (read from the output base's `DO_NOT_BUILD_HERE`), or the same `pnpm …` arguments in the same folder. It runs via `zsh -ic`, so `.zshrc` is loaded, and a shell stays when it exits.
- **■ Kill:** click twice (the second click within 3 seconds). It sends SIGTERM to the whole process tree (the bazel launcher and the JVM, or pnpm and everything under it) and SIGKILL to whatever is still there after 8 seconds.
- **Strip or panel:** in the fremtind layout it's a strip that opens on hover (see below). As a full panel, the panel icon in the header folds it into a 44px rail with counts of backends and frontends; click the rail's top icon to unfold it.

Left out: the bazel server and workers, Gradle and Kotlin daemons, IDEs and language servers, JVMs that aren't bazel binaries and listen on no port, and pnpm commands that listen on no port and aren't `dev`/`start`/`serve`/`preview`/`storybook`/`watch` (installs, one-off scripts).

## Config (optional)

`~/.config/herdr-dev-servers.json`:

```json
{
  "restart": {
    "//apps/distribusjon-bm/radgiverklienter-skade/rks-salgsflyt-backend:app": "bazel run //apps/distribusjon-bm/radgiverklienter-skade/rks-salgsflyt-backend:app -- --spring.profiles.active=local",
    "/Users/me/git/some-app": "pnpm dev --port 3001"
  },
  "hide": ["some-sidecar\\.jar"]
}
```

- `restart`: the command to restart with instead of the derived one, by bazel target or folder. `ps` doesn't show the flags `bazel run` got or what came after `--`, so add a target here if it needs them. A JVM that isn't a bazel binary can only be restarted with an entry for its folder.
- `hide`: regexes on the command line of processes to leave out.

## Install

```sh
cp -R ~/git/herdr-fremtind/mods/dev-servers ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/dev-servers
```

In the `fremtind` layout it's a 48px strip under jira, in a `side` column that stays put. The strip shows the count and one icon per server (a server for backends, a monitor for frontends), green once it listens on a port and amber while it starts or restarts. Rest the pointer on it and a card with every server opens above it; it closes a moment after the pointer leaves both. Folding jira folds the column, and the strip shrinks to the icon and the count. The strip is the block's props `{"mode": "strip"}`:

```json
{ "id": "side", "type": "column", "gap": 12, "resizable": false, "size": { "px": 360 }, "min": 44, "children": [
  { "id": "jira", "type": "block", "size": { "weight": 1 }, "content": { "mod": "jira" } },
  { "id": "dev-servers", "type": "block", "size": { "px": 48 }, "content": { "mod": "dev-servers", "props": { "mode": "strip" } } }
] }
```

Without props (where Herdr first docks it in other layouts, on the right), it's a full panel grouped into Backends and Frontends, with a fold-to-rail button like jira's.

## Watch out

- The restarted backend uses your normal bazel output base. A server an agent started inside a sandbox (an output base ending in `-sandbox`) may rebuild the first time it's restarted from here.
- A server started in a Herdr terminal by hand gets a new `▶` tab on restart; its old terminal stays at the prompt.
