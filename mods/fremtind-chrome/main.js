import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// The brand block is 46px; on the macOS rail the traffic lights fill that, so it
// grows to fit the symbol below them. Driven by size, so it follows every fold.
const BRAND_PX = 46;
const RAIL_BRAND_PX = 80;
const brandHeight = () => find(layout(), "brand")?.size?.px ?? BRAND_PX;
function syncBrandHeight() {
  if (!find(layout(), "brand")) return;
  const lights = window()?.platform === "macos" && !window()?.fullscreen;
  const want = narrow() && lights ? RAIL_BRAND_PX : BRAND_PX;
  if (brandHeight() !== want) run("layout.resize", { id: "brand", px: want });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/fremtind-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      const ready = div().size(6).rounded_full().bg(t.accent);
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    const lights = window()?.platform === "macos" && !window()?.fullscreen;
    if (collapsed) {
      // The rail has no room for a toggle beside the symbol, so the symbol unfolds the sidebar.
      const symbol = div().id("sidebar-toggle").h(30).w(36).flex().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(t.foreground).hover(s => s.bg(t.hover)).tooltip("Expand sidebar")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(toggleSidebar)
        .child(svg("mods/fremtind-chrome/fremtind-symbol.svg").w(29).h(16));
      // With traffic lights the header grows (syncBrandHeight) and the symbol sits below them.
      const room = !lights || brandHeight() >= RAIL_BRAND_PX;
      return v_flex().id("brand-root").on_size_change(syncBrandHeight).size_full().bg(t.chrome).items_center()
        .when(lights, el => el.justify_end().pb(10))
        .when(!lights, el => el.justify_center())
        .when(room, el => el.child(symbol));
    }
    return h_flex().id("brand-root").on_size_change(syncBrandHeight).size_full().bg(t.chrome).pl(14).pr(10).gap(4).items_center().text_size(13.5)
      .when(lights, el => el.pl(76))
      .child(h_flex().flex_1().items_center().child(svg("mods/fremtind-chrome/fremtind-wordmark.svg").w(82).h(17).text_color(t.foreground)))
      .child(this.button("search", svg("mods/fremtind-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" })))
      .child(this.button("sidebar-toggle", svg("mods/fremtind-chrome/sidebar.svg").size(15), toggleSidebar));
  }
}
