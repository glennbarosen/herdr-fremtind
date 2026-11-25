// Jira board panel. Props: { board?: id | [ids] } (else the config's boards).
// Click an issue: a new space, in the active space's folder, running `ccl --worktree <KEY-slug> "<description message>"`.
// The panel folds into a 44px drawer rail (the ⇥ in the header) and unfolds from it.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { props, theme, run, exec, spaces, shared, setShared, notify, layout } from "herdr";
import { loadConfig, loadBoard, myself, createIssue, issueDescription, issueUrl, spacesFor, placeOf, branchFor, tilde, CONFIG_PATH } from "./jira.js";

const REFRESH_MS = 120_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const icon = (name, size = 15) => svg(`mods/jira/${name}.svg`).size(size).flex_none();

// Jøkul alert backgrounds (--jkl-color-background-alert-*), with granitt text on top.
const isDark = (hex) => {
  const n = parseInt(String(hex ?? "#ffffff").slice(1, 7), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
};
const alerts = (t) => isDark(t.background)
  ? { neutral: "#e0dbd4", info: "#a9a9ca", success: "#94b79b", warning: "#decc8d", error: "#de9e9e" }
  : { neutral: "#e0dbd4", info: "#d3d3f6", success: "#acd3b5", warning: "#efdd9e", error: "#f6b3b3" };
const ON_ALERT = "#1b1917";
const tag = (label, bg) => div().flex_none().h(18).px(6).flex().items_center().rounded(4).bg(bg)
  .text_size(10.5).font_semibold().text_color(ON_ALERT).child(label);

// The drawer: the layout node holding this mod. Folded is a width under 160px, like the sidebar's
// rail, so dragging its edge narrow folds it too. The open width is kept to unfold back to.
const RAIL_PX = 44;
const OPEN_PX = 360;
// The node holding this mod that sits in a row: the block itself, or a column it's stacked in
// with other cards (the fremtind layout's "side"), so folding narrows the whole column.
function dockOf(node, pred, inRow = false, outer = null) {
  if (!node || typeof node !== "object") return null;
  const here = inRow ? node : outer;
  if (pred(node)) return here ?? node;
  for (const child of node.children ?? []) {
    const found = dockOf(child, pred, node.type === "row", here);
    if (found) return found;
  }
  return null;
}
const dock = () => dockOf(layout(), (n) => n.content?.mod === "jira");
const folded = () => (dock()?.size?.px ?? Infinity) < 160;
function toggleDrawer() {
  const n = dock();
  if (!n) return;
  const wasFolded = folded();
  if (!wasFolded && n.size?.px) setShared(`drawer.${n.id}.width`, n.size.px);
  run("layout.resize", { id: n.id, px: wasFolded ? (shared(`drawer.${n.id}.width`) ?? OPEN_PX) : RAIL_PX });
}

const typeColor = (t, i) => {
  const n = i.type.toLowerCase();
  if (i.subtask) return t.dim;
  if (n.includes("bug") || n.includes("feil")) return t.ansi1;
  if (n.includes("story") || n.includes("historie")) return t.ansi2;
  if (n.includes("epic")) return t.ansi5;
  if (n.includes("spike")) return t.ansi3;
  return t.ansi4;
};
const initials = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

class Panel {
  // Columns start open if listed in the config's "openColumns" (or all, without it), until clicked.
  columnFolded(name) {
    if (this.folds.has(name)) return this.folds.get(name);
    const open = this.cfg?.openColumns;
    return Array.isArray(open) ? !open.some((o) => String(o).toLowerCase() === name.toLowerCase()) : false;
  }

  init(cx) {
    this.cfg = null;
    this.data = null;
    this.error = "";
    this.loading = false;
    this.me = null;
    this.filter = "";
    this.folds = new Map(); // column name -> folded, once the user has clicked it
    this.input = InputState.new({ placeholder: "Filter: key, text, @person" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    // New issue: a one-line summary field shown by the header's +.
    this.creating = false; // field shown
    this.saving = false;
    this.createError = "";
    this.newInput = InputState.new({ placeholder: "New issue summary, ↵ to create" });
    this.newInput.on("change", (_e, cx) => { this.createError = ""; cx.notify(); });
    this.newInput.on("submit", (_e, cx) => this.create(cx));
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // Board ids from props, else the config file.
  boards() {
    const p = props()?.board;
    if (p !== undefined && p !== null) return (Array.isArray(p) ? p : [p]).map((b) => (typeof b === "object" ? b : { id: b }));
    return this.cfg?.boards ?? [];
  }
  boardId() {
    const list = this.boards();
    if (!list.length) return null;
    const chosen = shared("jira.board");
    return (list.find((b) => String(b.id) === String(chosen)) ?? list[0]).id;
  }
  opt(name, fallback) {
    const v = shared(`jira.${name}`);
    return v === undefined || v === null ? fallback : v;
  }

  refresh(cx) {
    // One asked for mid-load (e.g. right after creating an issue) runs once the current one ends.
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.cfg = await loadConfig();
        if (!this.me) this.me = await myself(this.cfg).catch(() => null);
        const id = this.boardId();
        if (id === null) throw new Error(`No board: add "boards": [<id>] to ${tilde(CONFIG_PATH())} or give the block props {"board": <id>}`);
        this.data = await loadBoard(this.cfg, id);
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
      if (this.again) { this.again = false; this.refresh(cx); }
    });
  }

  nextBoard(cx) {
    const list = this.boards();
    if (list.length < 2) return this.refresh(cx);
    const i = list.findIndex((b) => String(b.id) === String(this.boardId()));
    setShared("jira.board", list[(i + 1) % list.length].id);
    this.data = null;
    this.refresh(cx);
  }

  // An issue already being worked on (a space on its branch, or named after it) is gone to;
  // otherwise a new space starts the sandboxed Claude on a worktree branch for it, with the
  // issue's description as its first message.
  pick(issue, cx) {
    const open = spacesFor(issue.key).concat(spaces().filter((s) => s.named && s.name === issue.key));
    if (open.length) return run("space.select", { id: open[0].id });
    if (this.starting) return;
    this.starting = issue.key;
    const active = spaces().find((s) => s.active);
    const folder = active && !active.machine ? placeOf(active) : null;
    cx.spawn(async () => {
      const description = this.cfg ? await issueDescription(this.cfg, issue.key).catch(() => "") : "";
      // Through an interactive zsh so .zshrc (aliases, functions, PATH) is loaded before the
      // command runs; then a normal shell stays when it exits. Branch names are [A-Za-z0-9-] only.
      // The branch goes in as $1 and the message as $2, so neither needs quoting. The message
      // follows `--` because the ccs launchers hand their arguments to cplt, which only passes
      // what comes after `--` on to the agent and rejects anything else that isn't a cplt flag
      // or subcommand.
      // The worktree is made here (not by `ccl --worktree`) so the setup steps can run in it
      // before Claude starts: <repo>/.claude/worktrees/<branch>, on the branch if it exists,
      // else a new branch off the default branch; an existing worktree is reused as is. The
      // setup steps are chained with && but Claude starts even if one fails; if the worktree
      // can't be made, nothing starts and the shell stays in the original folder.
      const command = (this.cfg?.command ?? ["ccl"]).join(" ");
      const setup = (this.cfg?.setup ?? ["direnv allow", "bazel run //tools:bazel_env"]).join(" && ");
      const worktree = [
        `root=$(git rev-parse --show-toplevel) && wt="$root/.claude/worktrees/$1" &&`,
        `{ [ -d "$wt" ] || { base=$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); base=\${base#origin/};`,
        `if git -C "$root" show-ref -q --verify "refs/heads/$1"; then git -C "$root" worktree add "$wt" "$1";`,
        `else git -C "$root" worktree add -b "$1" "$wt" "\${base:-HEAD}"; fi; }; } && cd "$wt"`,
      ].join(" ");
      const start = `${setup ? `{ ${setup}; }; ` : ""}${command}${description ? ` -- "$2"` : ""}`;
      const argv = ["zsh", "-ic", `if ${worktree}; then ${start}; fi; exec zsh -i`, "zsh",
        branchFor(issue.key, issue.summary), ...(description ? [`This is the issue description: ${description}`] : [])];
      run("space.new", { name: issue.key, argv, ...(folder ? { folder } : {}) });
      this.starting = null;
    });
  }

  toggleCreate(cx) {
    this.creating = !this.creating;
    this.createError = "";
    if (this.creating) cx.timer.after(30, () => this.newInput.focus());
    cx.notify();
  }

  // Backlog issue in the board's project, assigned to me (moved to "createStatus" if set). Not
  // started: the list refreshes so it's there to click.
  create(cx) {
    const summary = this.newInput.value().trim();
    if (this.saving || !summary) return;
    const project = this.data?.board?.project;
    if (!this.cfg || !project) { this.createError = "The board hasn't loaded (or has no project)."; return cx.notify(); }
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const issue = await createIssue(this.cfg, project, summary, this.me);
        this.newInput.set_value("");
        this.creating = false;
        notify({ title: `Created ${issue.key}`, body: summary, level: "success", timeout: 4000 });
        // It's assigned to me, so the Unassigned view would hide it.
        if (this.opt("who", "unassigned") === "unassigned") setShared("jira.who", "mine");
        this.refresh(cx);
      } catch (e) {
        this.createError = String(e?.message ?? e);
      }
      this.saving = false;
      cx.notify();
    });
  }

  browse(issue) {
    if (this.cfg) exec("open", [issueUrl(this.cfg, issue.key)]);
  }

  visible(issues) {
    const who = this.opt("who", "unassigned"), hideDone = this.opt("hideDone", true);
    const words = this.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return issues.filter((i) => {
      if (who === "mine" && (!i.assignee || i.assignee.id !== this.me)) return false;
      if (who === "unassigned" && i.assignee) return false;
      if (hideDone && i.category === "done") return false;
      return words.every((w) => w.startsWith("@")
        ? (i.assignee?.name ?? "unassigned").toLowerCase().includes(w.slice(1))
        : `${i.key} ${i.summary} ${i.type}`.toLowerCase().includes(w));
    });
  }

  // Jøkul filter chip: a pill with a hairline border; pressed, it fills with the action colour.
  chip(t, id, label, on, click) {
    return div().id(id).h(26).px(12).flex().items_center().rounded(13).text_size(12).font_weight(500).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border)
      .text_color(on ? t.accent_foreground : t.foreground)
      .when(on, (e) => e.bg(t.accent))
      .when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { click(cx); cx.notify(); }).child(label);
  }

  iconButton(t, id, name, tip, action, on = false) {
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => action(cx)).child(icon(name));
  }

  row(t, i, a) {
    const open = spacesFor(i.key).length > 0;
    const done = i.category === "done";
    const urgent = Boolean(i.priority) && /high|critical|blocker|highest/i.test(i.priority);
    const mine = i.assignee && i.assignee.id === this.me;
    return h_flex().id(`issue-${i.key}`).min_h(48).flex_none().px(10).py(6).gap(10).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(i, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.browse(i); })
      .child(div().w(3).h(28).flex_none().rounded(2).bg(typeColor(t, i)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(13).text_color(done ? t.dim : t.foreground).child(i.summary))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_none().font_semibold().child(i.key))
          .child(div().flex_none().text_color(t.dim).child("·"))
          .child(div().truncate().child(i.type))
          .when(urgent, (e) => e.child(tag(i.priority, a.error)))
          .when(done, (e) => e.child(tag("Done", a.success)))
          .when(open, (e) => e.child(tag("Open", a.info)))))
      .child(div().flex_none().size(24).rounded_full().flex().items_center().justify_center().text_size(9.5).font_semibold()
        .when(Boolean(i.assignee), (e) => e.bg(mine ? t.solid : a.neutral).text_color(mine ? t.solid_foreground : ON_ALERT))
        .when(!i.assignee, (e) => e.border_1().border_color(t.border).text_color(t.dim))
        .tooltip(i.assignee ? i.assignee.name : "Unassigned")
        .child(i.assignee ? initials(i.assignee.name) : "–"));
  }

  // Folded: a 44px rail with the board icon, my open issues and refresh.
  rail(t, a) {
    const d = this.data;
    const all = (d?.columns ?? []).flatMap((c) => c.issues).filter((i) => i.category !== "done");
    const mine = all.filter((i) => i.assignee && i.assignee.id === this.me).length;
    const free = all.filter((i) => !i.assignee).length;
    const count = (id, n, bg, tip) => div().id(id).min_w(24).h(20).px(5).flex().items_center().justify_center().rounded(10)
      .bg(bg).text_size(10.5).font_semibold().text_color(ON_ALERT).tooltip(tip).child(String(n));
    return v_flex().id("jira-rail").size_full().rounded(7).bg(t.surface).text_color(t.foreground).items_center().pt(8).pb(8).gap(8)
      .child(this.iconButton(t, "jira-unfold", "panel-right-open", "Open Jira", () => toggleDrawer()))
      .child(div().w(20).h(1).bg(t.border))
      .child(div().id("jira-rail-board").size(28).flex().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(t.foreground).hover((s) => s.bg(t.hover)).tooltip(d ? d.board.name : "Jira")
        .on_click(() => toggleDrawer()).child(icon("square-kanban", 17)))
      .when(Boolean(d), (e) => e
        .child(count("jira-rail-mine", mine, a.neutral, `${mine} assigned to you`))
        .child(count("jira-rail-free", free, a.info, `${free} unassigned`)))
      .when(Boolean(this.error), (e) => e.child(div().id("jira-rail-error").size(8).rounded_full().bg(t.blocked).tooltip(this.error)))
      .child(div().flex_1())
      .when(this.loading, (e) => e.child(div().text_color(t.dim).frames(SPINNER, 90)))
      .when(!this.loading, (e) => e.child(this.iconButton(t, "jira-rail-refresh", "rotate-cw", "Refresh", (cx) => this.refresh(cx))));
  }

  render(cx) {
    const t = theme();
    const a = alerts(t);
    if (folded()) return this.rail(t, a);
    const d = this.data;
    const boards = this.boards();
    const title = d ? d.board.name : this.boardId() !== null ? `Board ${this.boardId()}` : "Jira";
    const sub = d ? (d.sprint ? d.sprint.name : d.board.type === "kanban" ? "Kanban" : "No active sprint") : "";
    const columns = (d?.columns ?? []).map((c) => ({ ...c, shown: this.visible(c.issues) }));
    const total = columns.reduce((n, c) => n + c.shown.length, 0);

    const list = [];
    for (const c of columns) {
      if (!c.shown.length) continue;
      const folded = this.columnFolded(c.name);
      list.push(h_flex().id(`col-${c.name}`).h(32).flex_none().px(10).mt(list.length ? 10 : 4).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.folds.set(c.name, !folded); cx.notify(); })
        .child(div().text_color(t.muted).child(icon(folded ? "chevron-right" : "chevron-down", 14)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(c.name.charAt(0).toUpperCase() + c.name.slice(1).toLowerCase()))
        .child(tag(String(c.shown.length), a.neutral)));
      if (!folded) for (const i of c.shown) list.push(this.row(t, i, a));
    }

    const field = (id, state, border, extra) => h_flex().id(id).h(36).px(10).gap(8).items_center().rounded(3)
      .border_1().border_color(border).bg(t.input).cursor_text()
      .child(div().flex_1().min_w(0).h_full().child(Input.new(state).h_full().w_full().text_size(13).text_color(t.foreground)))
      .when(Boolean(extra), (e) => e.child(extra));

    return v_flex().id("jira").size_full().min_h(0).rounded(7).bg(t.surface).text_color(t.foreground).text_size(13)
      // Header: board (click to switch), sprint below; new, refresh, fold.
      .child(h_flex().h(52).flex_none().pl(16).pr(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().id("jira-board").gap(4).items_center().cursor_pointer()
            .when(boards.length > 1, (e) => e.tooltip(`Switch board (${boards.length})`))
            .on_click((_e, cx) => this.nextBoard(cx))
            .child(div().text_size(14).font_semibold().truncate().child(title))
            .when(boards.length > 1, (e) => e.child(div().text_color(t.muted).child(icon("chevron-down", 13)))))
          .when(Boolean(sub), (e) => e.child(div().text_size(11.5).text_color(t.muted).truncate().child(sub))))
        .child(this.iconButton(t, "jira-new", "plus", "New issue", (cx) => this.toggleCreate(cx), this.creating))
        .child(this.loading
          ? div().size(28).flex_none().flex().items_center().justify_center().text_color(t.muted).frames(SPINNER, 90)
          : this.iconButton(t, "jira-refresh", "rotate-cw", "Refresh", (cx) => this.refresh(cx)))
        .when(Boolean(dock()), (e) => e.child(this.iconButton(t, "jira-fold", "panel-right-close", "Fold into drawer", () => toggleDrawer()))))
      .when(this.creating, (e) => e.child(v_flex().flex_none().px(16).pt(12).gap(6)
        .child(field("jira-new-field", this.newInput, t.accent, this.saving ? div().text_color(t.dim).frames(SPINNER, 90) : null)
          .on_key_down((ev, cx) => { if (ev.key === "escape") { cx.stop_propagation(); this.toggleCreate(cx); } }))
        .child(div().text_size(11).text_color(this.createError ? t.blocked : t.muted)
          .child(this.createError || `Backlog of ${d?.board?.project ?? "the board's project"}, assigned to you · Esc cancels`))))
      .child(v_flex().flex_none().px(16).pt(12).pb(10).gap(10)
        .child(field("jira-filter", this.input, t.muted, null).child(div().text_color(t.muted).child(icon("search", 15))))
        .child(h_flex().gap(6).flex_wrap()
          .children([["all", "All"], ["mine", "Mine"], ["unassigned", "Unassigned"]].map(([v, label]) =>
            this.chip(t, `chip-${v}`, label, this.opt("who", "unassigned") === v, () => setShared("jira.who", v))))
          .child(this.chip(t, "chip-done", "Hide done", this.opt("hideDone", true), () => setShared("jira.hideDone", !this.opt("hideDone", true))))))
      .child(div().flex_1().min_h(0).relative().border_t(1).border_color(t.border)
        .child(v_flex().id("jira-list").absolute().inset_0().overflow_y_scroll().px(6).pt(4).pb(10)
          .children(list)
          .when(Boolean(this.error), (e) => e.child(div().m(10).p(12).rounded(4).bg(a.error).text_color(ON_ALERT).text_size(12).child(this.error)))
          .when(!this.error && d && !total, (e) => e.child(div().p(16).text_color(t.muted).child("No matching issues")))
          .when(!this.error && !d, (e) => e.child(div().p(16).text_color(t.muted).child("Loading board…"))))
        .child(Scrollbar.vertical("jira-list").absolute().inset_0()))
      .child(h_flex().h(30).flex_none().px(16).gap(6).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child("Click: start in a new space · Right-click: open in Jira"))
        .when(Boolean(d), (e) => e.child(div().flex_none().text_color(t.muted).child(`${total} issues`))));
  }
}

export default class Jira extends View {
  init(_props, cx) {
    this.panel = new Panel();
    this.panel.init(cx);
  }
  render(cx) {
    return this.panel.render(cx);
  }
}
