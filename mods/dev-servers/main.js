// Dev servers panel: the bazel-run JVM backends and pnpm frontends running on this machine, with
// restart and kill per server. Restart stops the process tree and runs the command again in a
// background tab ("▶ <name>") of the space working in that folder, replacing an earlier one.
// The panel folds into a 44px drawer rail (the ⇥ in the header) and unfolds from it, like jira.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, HoverCard } from "gpui-base";
import { theme, run, exec, spaces, panes, shared, setShared, notify, layout, checking, props } from "herdr";
import { loadConfig, scan, stop, uptime, tilde } from "./procs.js";

const MOD = "dev-servers";
const REFRESH_MS = 8_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const icon = (name, size = 15) => svg(`mods/${MOD}/${name}.svg`).size(size).flex_none();

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

// The drawer: the layout node holding this mod. Folded is a width under 160px.
const RAIL_PX = 44;
const OPEN_PX = 340;
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
const dock = () => dockOf(layout(), (n) => n.content?.mod === MOD);
const folded = () => (dock()?.size?.px ?? Infinity) < 160;
function toggleDrawer() {
  const n = dock();
  if (!n) return;
  const wasFolded = folded();
  if (!wasFolded && n.size?.px) setShared(`drawer.${n.id}.width`, n.size.px);
  run("layout.resize", { id: n.id, px: wasFolded ? (shared(`drawer.${n.id}.width`) ?? OPEN_PX) : RAIL_PX });
}

const GROUPS = [["backend", "Backends", "server"], ["frontend", "Frontends", "monitor"]];
const tabName = (task) => `▶ ${task.name}`;
const logTabName = (task) => `log: ${task.name}`;

// The local space working in this folder: one with a terminal inside it (its worktree's space)
// beats one in a folder above it (the repo's); else the shown space.
function spaceFor(folder) {
  let best = null, score = -1;
  for (const s of spaces().filter((s) => !s.machine)) {
    const tabs = new Set((s.tabs ?? []).map((t) => t.id));
    const dirs = [s.folder, ...panes().filter((p) => tabs.has(p.tab) && p.cwd).map((p) => p.cwd)].filter(Boolean);
    for (const d of dirs) {
      const n = folder && (d === folder || d.startsWith(`${folder}/`)) ? 10_000 + (s.active ? 1 : 0)
        : folder && folder.startsWith(`${d}/`) ? d.length : -1;
      if (n > score) { score = n; best = s; }
    }
  }
  return best ?? spaces().find((s) => s.active) ?? null;
}

// A tab with this name, in the preferred space first.
function findTab(name, prefer) {
  const local = spaces().filter((s) => !s.machine);
  const ordered = prefer ? [prefer, ...local.filter((s) => s.id !== prefer.id)] : local;
  for (const s of ordered) {
    const t = (s.tabs ?? []).find((t) => t.name === name);
    if (t) return { space: s, tab: t };
  }
  return null;
}
const goTo = ({ space, tab }) => { run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); };

class Panel {
  init(cx) {
    this.cfg = {};
    this.tasks = null;
    this.error = "";
    this.loading = false;
    this.busy = new Map(); // task key -> "Stopping…" | "Restarting…"
    this.armed = null; // task key whose kill button asks for a second click
    this.folds = new Map(); // group -> folded
    if (checking()) { this.tasks = []; return; }
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.cfg = await loadConfig();
        this.tasks = await scan(this.cfg);
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
      if (this.again) { this.again = false; this.refresh(cx); }
    });
  }

  // Its "▶" tab if Restart started it, else its log file (a background task's output) in a tab.
  show(task) {
    const space = spaceFor(task.folder);
    const own = findTab(tabName(task), space);
    if (own) return goTo(own);
    const log = findTab(logTabName(task), space);
    if (log) return goTo(log);
    if (!task.log) return notify({ title: task.name, body: "Not started from Herdr and no log file to show.", level: "info", timeout: 4000 });
    run("tab.new", { name: logTabName(task), ...(space ? { space: space.id } : {}), argv: ["tail", "-n", "300", "-F", task.log] });
  }

  kill(task, cx) {
    if (this.busy.has(task.key)) return;
    if (this.armed !== task.key) {
      this.armed = task.key;
      cx.timer.after(3000, (cx) => { if (this.armed === task.key) { this.armed = null; cx.notify(); } });
      return cx.notify();
    }
    this.armed = null;
    this.busy.set(task.key, "Stopping…");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await stop(task);
        notify({ title: `Stopped ${task.name}`, level: "success", timeout: 3000 });
      } catch (e) {
        notify({ title: `Couldn't stop ${task.name}`, body: String(e?.message ?? e), level: "error", timeout: 6000 });
      }
      this.busy.delete(task.key);
      this.refresh(cx);
    });
  }

  restart(task, cx) {
    if (this.busy.has(task.key)) return;
    if (!task.restartable || !task.command) {
      return notify({ title: `Can't restart ${task.name}`, body: `Its folder or command is unknown; add it under "restart" in ${tilde("~/.config/herdr-dev-servers.json")}.`, level: "warning", timeout: 6000 });
    }
    this.busy.set(task.key, "Restarting…");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await stop(task);
        const space = spaceFor(task.folder);
        const old = findTab(tabName(task), space);
        if (old) run("tab.close", { id: old.tab.id });
        // An interactive zsh, so .zshrc (PATH, aliases, direnv) is loaded; a shell stays after it
        // exits, to read what happened. The folder goes in as $1, so it needs no quoting.
        run("tab.new", {
          name: tabName(task), folder: task.folder, focus: false, ...(space ? { space: space.id } : {}),
          argv: ["zsh", "-ic", `cd "$1" && ${task.command}; exec zsh -i`, "zsh", task.folder],
        });
        notify({ title: `Restarting ${task.name}`, body: `${task.command} in tab "${tabName(task)}"`, level: "success", timeout: 4000 });
      } catch (e) {
        notify({ title: `Couldn't restart ${task.name}`, body: String(e?.message ?? e), level: "error", timeout: 6000 });
      }
      this.busy.delete(task.key);
      cx.timer.after(1500, (cx) => this.refresh(cx));
      cx.notify();
    });
  }

  iconButton(t, id, name, tip, action, color) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(color ?? t.muted).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground)).tooltip(tip)
      .on_click((ev, cx) => { cx.stop_propagation(); action(cx); }).child(icon(name, 14));
  }

  row(t, task, a) {
    const busy = this.busy.get(task.key);
    const armed = this.armed === task.key;
    const started = Boolean(findTab(tabName(task), null));
    return h_flex().id(`task-${task.key}`).min_h(48).flex_none().px(10).py(6).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`${task.detail}\n${tilde(task.folder ?? "")}\npid ${task.pid}`)
      .on_click(() => this.show(task))
      .child(div().w(3).h(28).flex_none().rounded(2).bg(task.kind === "backend" ? t.ansi4 : t.ansi2))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(13).text_color(busy ? t.dim : t.foreground).child(task.name))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
          .child(div().truncate().child(task.place || task.detail))
          .children(task.ports.slice(0, 3).map((port) => div().id(`port-${task.key}-${port}`).cursor_pointer()
            .tooltip(`Open http://localhost:${port}`)
            .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [`http://localhost:${port}`]); })
            .child(tag(`:${port}`, a.info))))
          .when(!task.ports.length && !busy, (e) => e.child(tag("Starting", a.warning)))
          .when(started, (e) => e.child(tag("Herdr", a.neutral)))
          .child(div().flex_none().text_color(t.dim).child(uptime(task.etime)))))
      .when(Boolean(busy), (e) => e.child(h_flex().flex_none().gap(6).items_center().text_size(11).text_color(t.muted)
        .child(div().frames(SPINNER, 90)).child(busy)))
      .when(!busy, (e) => e
        .child(this.iconButton(t, `restart-${task.key}`, "rotate-cw", task.restartable ? `Restart: ${task.command}` : "Restart (command unknown)", (cx) => this.restart(task, cx), task.restartable ? null : t.dim))
        .child(armed
          ? div().id(`kill-${task.key}`).h(26).px(8).flex_none().flex().items_center().rounded(6).cursor_pointer()
            .bg(a.error).text_color(ON_ALERT).text_size(11).font_semibold().tooltip("Click again to kill")
            .on_click((_e, cx) => { cx.stop_propagation(); this.kill(task, cx); }).child("Kill?")
          : this.iconButton(t, `kill-${task.key}`, "square", "Kill", (cx) => this.kill(task, cx))));
  }

  // Folded: a 44px rail with counts per kind and refresh.
  rail(t, a) {
    const count = (kind) => (this.tasks ?? []).filter((x) => x.kind === kind).length;
    const badge = (id, n, bg, tip) => div().id(id).min_w(24).h(20).px(5).flex().items_center().justify_center().rounded(10)
      .bg(bg).text_size(10.5).font_semibold().text_color(ON_ALERT).tooltip(tip).child(String(n));
    return v_flex().id("dev-rail").size_full().rounded(7).bg(t.surface).text_color(t.foreground).items_center().pt(8).pb(8).gap(8)
      .child(this.iconButton(t, "dev-unfold", "panel-right-open", "Open dev servers", () => toggleDrawer()))
      .child(div().w(20).h(1).bg(t.border))
      .child(div().text_color(t.foreground).child(icon("server", 17)))
      .when(Boolean(this.tasks), (e) => e
        .child(badge("dev-rail-be", count("backend"), a.info, `${count("backend")} backends`))
        .child(badge("dev-rail-fe", count("frontend"), a.success, `${count("frontend")} frontends`)))
      .when(Boolean(this.error), (e) => e.child(div().id("dev-rail-error").size(8).rounded_full().bg(t.blocked).tooltip(this.error)))
      .child(div().flex_1())
      .when(this.loading, (e) => e.child(div().text_color(t.dim).frames(SPINNER, 90)))
      .when(!this.loading, (e) => e.child(this.iconButton(t, "dev-rail-refresh", "rotate-cw", "Refresh", (cx) => this.refresh(cx))));
  }

  // The full list as a compact card: each row starts with a 44px cell for the kind's icon, green
  // once it listens on a port, amber while starting or busy. Shown by the strip on hover.
  card(t, a) {
    const tasks = this.tasks ?? [];
    const line = (id, cells) => h_flex().id(id).flex_none().items_center().children(cells);
    const cell = (child) => div().w(RAIL_PX).flex_none().flex().items_center().justify_center().child(child);
    const ROW = 48, MAX_ROWS = 8;

    const header = line("dev-card-header", [
      cell(this.loading ? div().text_color(t.dim).frames(SPINNER, 90)
        : div().text_color(this.error ? t.blocked : tasks.length ? t.foreground : t.dim).child(icon("server", 17))),
      v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13).font_semibold().truncate().child("Dev servers"))
        .child(div().text_size(11).text_color(this.error ? t.blocked : t.muted).truncate()
          .child(this.error || (this.tasks ? GROUPS.map(([kind, label]) => `${tasks.filter((x) => x.kind === kind).length} ${label.toLowerCase()}`).join(" · ") : "Looking…"))),
      div().pr(8).child(this.iconButton(t, "dev-card-refresh", "rotate-cw", "Refresh", (cx) => this.refresh(cx))),
    ]).h(44);

    const rows = tasks.map((task) => {
      const busy = this.busy.get(task.key);
      const armed = this.armed === task.key;
      const color = busy || !task.ports.length ? t.working : t.done;
      const actions = busy
        ? [h_flex().gap(6).items_center().text_size(11).text_color(t.muted).child(div().frames(SPINNER, 90)).child(busy)]
        : [this.iconButton(t, `restart-${task.key}`, "rotate-cw", task.restartable ? `Restart: ${task.command}` : "Restart (command unknown)", (cx) => this.restart(task, cx), task.restartable ? null : t.dim),
          armed
            ? div().id(`kill-${task.key}`).h(26).px(8).flex_none().flex().items_center().rounded(6).cursor_pointer()
              .bg(a.error).text_color(ON_ALERT).text_size(11).font_semibold().tooltip("Click again to kill")
              .on_click((_e, cx) => { cx.stop_propagation(); this.kill(task, cx); }).child("Kill?")
            : this.iconButton(t, `kill-${task.key}`, "square", "Kill", (cx) => this.kill(task, cx))];
      return line(`task-${task.key}`, [
        cell(div().text_color(color).tooltip(`${task.name}${task.ports.length ? ` :${task.ports.join(" :")}` : " (starting)"}`)
          .child(icon(task.kind === "backend" ? "server" : "monitor", 16))),
        v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(13).text_color(busy ? t.dim : t.foreground).child(task.name))
          .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
            .child(div().truncate().child(task.place || task.detail))
            .children(task.ports.slice(0, 2).map((port) => div().id(`port-${task.key}-${port}`).cursor_pointer()
              .tooltip(`Open http://localhost:${port}`)
              .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [`http://localhost:${port}`]); })
              .child(tag(`:${port}`, a.info))))
            .child(div().flex_none().text_color(t.dim).child(uptime(task.etime)))),
        h_flex().flex_none().gap(2).px(8).items_center().children(actions),
      ]).h(ROW).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`${task.detail}\n${tilde(task.folder ?? "")}\npid ${task.pid}`)
        .on_click(() => this.show(task));
    });

    const body = rows.length > MAX_ROWS
      ? div().h(ROW * MAX_ROWS).relative()
        .child(v_flex().id("dev-card-list").absolute().inset_0().overflow_y_scroll().children(rows))
        .child(Scrollbar.vertical("dev-card-list").absolute().inset_0())
      : v_flex().children(rows);
    return v_flex().id("dev-card").w(360).text_color(t.foreground).text_size(13)
      .bg(t.popover ?? t.surface).border_1().border_color(t.border).rounded(8).shadow_lg().overflow_hidden()
      .child(header)
      .when(rows.length > 0, (e) => e.child(div().h(1).bg(t.border)).child(body));
  }

  // A layout slot a few rows tall (props {mode: "strip"}, under jira in the fremtind layout): the
  // count and one icon per server; resting the pointer on it opens the card above it. Narrower than
  // 160px (its column folded) it's just the icon and the count.
  strip(t, a) {
    const tasks = this.tasks ?? [];
    const narrow = (this.width ?? Infinity) < 160;
    const dot = (task) => div().flex_none().text_color(this.busy.has(task.key) || !task.ports.length ? t.working : t.done)
      .child(icon(task.kind === "backend" ? "server" : "monitor", 14));
    const count = div().flex_none().min_w(22).h(18).px(5).flex().items_center().justify_center().rounded(9)
      .bg(tasks.length ? a.info : a.neutral).text_size(10.5).font_semibold().text_color(ON_ALERT).child(String(tasks.length));
    const lead = this.loading && !this.tasks ? div().text_color(t.dim).frames(SPINNER, 90)
      : div().text_color(this.error ? t.blocked : t.muted).child(icon("server", 16));
    const trigger = (narrow
      ? v_flex().gap(4).items_center().justify_center().child(lead).child(count)
      : h_flex().px(14).gap(10).items_center()
        .child(lead)
        .child(div().flex_none().text_size(13).font_semibold().child("Dev servers"))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden().children(tasks.slice(0, 10).map(dot)))
        .child(count))
      .id("dev-strip").w_full().h(narrow ? 44 : 40).rounded(6).cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover));
    // The hover card's wrapper doesn't stretch, so the root centres it (and the row in it) vertically.
    return div().id("dev-strip-root").size_full().flex().flex_col().justify_center().px(narrow ? 0 : 2)
      .rounded(7).bg(t.surface).overflow_hidden()
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(HoverCard.new("dev-hover").anchor("bottom_right").open_delay(120).close_delay(350)
        .trigger(trigger).content(this.card(t, a)));
  }

  render(cx) {
    const t = theme();
    const a = alerts(t);
    if (props()?.mode === "strip") return this.strip(t, a);
    if (folded()) return this.rail(t, a);
    const tasks = this.tasks ?? [];
    const counts = GROUPS.map(([kind, label]) => `${tasks.filter((x) => x.kind === kind).length} ${label.toLowerCase()}`).join(" · ");

    const list = [];
    for (const [kind, label, iconName] of GROUPS) {
      const shown = tasks.filter((x) => x.kind === kind);
      if (!shown.length) continue;
      const isFolded = this.folds.get(kind) ?? false;
      list.push(h_flex().id(`group-${kind}`).h(32).flex_none().px(10).mt(list.length ? 10 : 4).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.folds.set(kind, !isFolded); cx.notify(); })
        .child(div().text_color(t.muted).child(icon(isFolded ? "chevron-right" : "chevron-down", 14)))
        .child(div().text_color(t.muted).child(icon(iconName, 14)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(label))
        .child(tag(String(shown.length), a.neutral)));
      if (!isFolded) for (const task of shown) list.push(this.row(t, task, a));
    }

    return v_flex().id("dev-servers").size_full().min_h(0).rounded(7).bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().h(52).flex_none().pl(16).pr(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(14).font_semibold().truncate().child("Dev servers"))
          .when(Boolean(this.tasks), (e) => e.child(div().text_size(11.5).text_color(t.muted).truncate().child(counts))))
        .child(this.loading
          ? div().size(28).flex_none().flex().items_center().justify_center().text_color(t.muted).frames(SPINNER, 90)
          : this.iconButton(t, "dev-refresh", "rotate-cw", "Refresh", (cx) => this.refresh(cx)))
        .when(Boolean(dock()), (e) => e.child(this.iconButton(t, "dev-fold", "panel-right-close", "Fold into drawer", () => toggleDrawer()))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("dev-list").absolute().inset_0().overflow_y_scroll().px(6).pt(4).pb(10)
          .children(list)
          .when(Boolean(this.error), (e) => e.child(div().m(10).p(12).rounded(4).bg(a.error).text_color(ON_ALERT).text_size(12).child(this.error)))
          .when(!this.error && this.tasks && !tasks.length, (e) => e.child(div().p(16).text_color(t.muted).child("Nothing running: no bazel-run JVMs or pnpm dev servers.")))
          .when(!this.error && !this.tasks, (e) => e.child(div().p(16).text_color(t.muted).child("Looking for servers…"))))
        .child(Scrollbar.vertical("dev-list").absolute().inset_0()))
      .child(h_flex().h(30).flex_none().px(16).gap(6).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child("Click: output · ↻ restart · ■ kill · :port opens it")));
  }
}

export default class DevServers extends View {
  init(_props, cx) {
    this.panel = new Panel();
    this.panel.init(cx);
  }
  render(cx) {
    return this.panel.render(cx);
  }
}
