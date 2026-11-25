# jira

A panel showing one Jira board's issues, grouped by the board's columns. Scrum boards show the active sprint; kanban boards show open issues plus anything resolved in the last 14 days.

- **Click an issue:** opens a new space named after the issue key, in the current space's folder, creating a git worktree `<repo>/.claude/worktrees/RF-7815-migrate-jokul-v5` on a branch of that name (off the default branch, or the existing branch; an existing worktree is reused), running `direnv allow && bazel run //tools:bazel_env` in it, then
  `ccl -- "This is the issue description: …"`, so Claude starts with the issue's description as its first message (left out if the issue has none). The branch name is the key plus a slug of the summary (æøå → ae/o/a, cut to about 50 characters). If a space for that issue already exists (a terminal on an `RF-7815-…` branch, or a space named `RF-7815`), it switches to that space instead.
- **Right-click:** opens the issue in the browser.
- **Header:** click the board name to switch between your configured boards. ↻ refreshes the list; it also refreshes by itself every 2 minutes.
- **Drawer:** the panel icon in the header folds Jira into a 44px rail showing the board icon, counts for *assigned to you* and *unassigned*, and refresh. Click the rail's top icon or the board icon to unfold it to the width it had. Dragging its edge below 160px also folds it. In the `fremtind` layout it's the `jira` card beside the panes, in the `side` column above the `dev-servers` strip; folding narrows the whole column.
- **Filter:** type text or an issue key, or `@name` to match the assignee. Switch between **All / Mine / Unassigned** (Unassigned by default) and toggle **Hide done**.
- **New issue (+ in the header):** type a summary and press ↵. It's created in the board project's backlog with type Task (or `"issueType"` from the config), assigned to you, and moved to `"createStatus"` if set. Nothing starts: the list refreshes (switching from *Unassigned* to *Mine* so it shows) and you click it when you're ready. Esc cancels. Backlog issues don't show in a scrum board's sprint view until they're added to a sprint.

## Setup

1. Create `~/.config/herdr-jira.json`:

   ```json
   {
     "site": "https://fremtind.atlassian.net",
     "email": "you@fremtind.no",
     "boards": [{ "id": 1234 }, { "id": 5678 }]
   }
   ```

   Optional: `"jql": "project = RF"` narrows every board to issues that also match this JQL (useful when a board's filter spans several projects). `"createStatus": "Ready for development"` moves new issues to that status (name or id) right after they're created. `"openColumns": ["Klar til utvikling", "Utvikling"]` starts only those board columns expanded (by column name); the rest start folded. Without it, all columns start expanded.

   Optional: `"command": ["ccl"]` changes what runs in the worktree. `--` and the description message are appended as one quoted argument (`cplt` only hands what follows `--` to the agent), and it runs via `zsh -ic` so aliases and functions from `.zshrc` work. `"setup": ["direnv allow", "bazel run //tools:bazel_env"]` changes the steps run in the new worktree before it (chained with `&&`; the command starts even if one fails; `[]` skips setup).

2. Create a Jira API token at https://id.atlassian.com/manage-profile/security/api-tokens (**Create API token**, not the scoped kind), copy it, and store it in the Keychain from the clipboard. Use the same email as in the config:

   ```sh
   security add-generic-password -U -s herdr-jira -a you@fremtind.no -w "$(pbpaste)"
   ```

   Don't paste it at `security`'s interactive `-w` prompt: that prompt cuts input off at 128 characters, and Atlassian tokens are longer (about 190), so Jira answers 401. Check the stored length with
   `security find-generic-password -s herdr-jira -a you@fremtind.no -w | awk '{print length($0)}'`.

3. Install and check:

   ```sh
   cp -R ~/git/herdr-fremtind/mods/jira ~/.config/herdr-app/mods/
   herdr-app check ~/.config/herdr-app/mods/jira
   ```

   The first time Herdr sees the mod, it docks it on the right.

## A specific board per block

Props override the config's boards, so you can pin a board in a layout or open one as a pane:

```json
{ "id": "jira", "type": "block", "content": { "mod": "jira", "props": { "board": 1234 } } }
```

```sh
herdr-app do pane.split '{"direction": "right", "mod": "jira", "props": {"board": 1234}}'
```

`"board": [1234, 5678]` gives that block its own set of boards to switch between.

The board id is the number in the board URL: `.../jira/software/c/projects/RF/boards/1234`.
