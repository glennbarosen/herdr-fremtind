// Finding, stopping and restarting local dev servers: bazel-run JVM backends (Java/Kotlin) and
// pnpm frontends. Everything comes from `ps` and `lsof`, so it sees servers started anywhere: a
// Herdr terminal, another terminal app, or an agent's background task.
import { exec, home, readTextFile } from "herdr";

export const CONFIG_PATH = () => `${home()}/.config/herdr-dev-servers.json`;
export const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p);

// { restart?: { "<//bazel:target | folder>": "command run in the folder instead of the derived one" },
//   hide?: ["regex on the command line", ...] }
export async function loadConfig() {
  const text = await readTextFile(CONFIG_PATH()).catch(() => null);
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw new Error(`${tilde(CONFIG_PATH())}: ${e}`); }
}

// JVMs that are tooling, not something being developed.
const JVM_TOOLING = /A-server\.jar|BazelServer|--persistent_worker|GradleDaemon|GradleWrapperMain|KotlinCompileDaemon|kotlin-daemon|jdtls|kotlin-language-server|JetBrains|IntelliJ|\.app\/Contents\/|sonarlint|maven\.home|MavenWrapperMain/;
const PNPM = /(^|\/)pnpm(\.c?js)?$/;
const DEVISH = /\b(dev|start|serve|preview|storybook|watch)\b/;
// <output base>/execroot/<repo>/bazel-out/<config>/bin/<package>/<name>.runfiles
const RUNFILES = /^(.*)\/execroot\/[^/]+\/bazel-out\/[^/]+\/bin\/(.+)\/([^/]+)\.runfiles(?:\/|$)/;
const BAZEL_BIN = /\/execroot\/[^/]+\/bazel-out\//;

function parsePs(text) {
  const procs = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) procs.set(+m[1], { pid: +m[1], ppid: +m[2], etime: m[3], cmd: m[4] });
  }
  for (const p of procs.values()) p.children = [];
  for (const p of procs.values()) procs.get(p.ppid)?.children.push(p.pid);
  return procs;
}

export async function processTable() {
  const r = await exec("ps", ["-axww", "-o", "pid=,ppid=,etime=,command="]);
  if (r.code !== 0) throw new Error(`ps: ${r.stderr.trim() || r.code}`);
  return parsePs(r.stdout);
}

export function descendants(procs, pid) {
  const out = [];
  const walk = (p) => { for (const c of procs.get(p)?.children ?? []) { out.push(c); walk(c); } };
  walk(pid);
  return out;
}

// lsof -F output: "p<pid>" starts a process, then "f<fd>" / "n<name>" lines.
function parseLsof(text, onName) {
  let pid = null, fd = null;
  for (const line of text.split("\n")) {
    const k = line[0], v = line.slice(1);
    if (k === "p") pid = +v;
    else if (k === "f") fd = v;
    else if (k === "n" && pid !== null) onName(pid, fd, v);
  }
}

async function listening() {
  const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).catch(() => null);
  const ports = new Map();
  parseLsof(r?.stdout ?? "", (pid, _fd, name) => {
    const port = +name.slice(name.lastIndexOf(":") + 1);
    if (!port) return;
    if (!ports.has(pid)) ports.set(pid, new Set());
    ports.get(pid).add(port);
  });
  return ports;
}

// cwd and stdout (a log file when started in the background) for these pids.
async function folders(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const r = await exec("lsof", ["-nP", "-a", "-p", pids.join(","), "-d", "cwd,1", "-Ffn"]).catch(() => null);
  parseLsof(r?.stdout ?? "", (pid, fd, name) => {
    const o = out.get(pid) ?? {};
    if (fd === "cwd") o.cwd = name;
    else if (fd === "1" && name.startsWith("/") && !name.startsWith("/dev/")) o.log = name;
    out.set(pid, o);
  });
  return out;
}

const workspaces = new Map(); // bazel output base -> workspace folder (its DO_NOT_BUILD_HERE)
async function workspaceOf(outputBase) {
  if (!workspaces.has(outputBase)) {
    const text = await readTextFile(`${outputBase}/DO_NOT_BUILD_HERE`).catch(() => null);
    workspaces.set(outputBase, text ? text.trim() : null);
  }
  return workspaces.get(outputBase);
}

async function packageName(dir) {
  const text = await readTextFile(`${dir}/package.json`).catch(() => null);
  try { return text ? JSON.parse(text).name ?? null : null; } catch { return null; }
}

const GENERIC = /^(app|main|server|service|bin|run|backend|application)$/i;
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// The worktree (or repo) a folder belongs to, for the row's second line.
export function placeLabel(dir) {
  if (!dir) return "";
  const wt = /\/\.claude\/worktrees\/([^/]+)/.exec(dir) ?? /\/\.herdr\/worktrees\/[^/]+\/([^/]+)/.exec(dir);
  if (wt) return wt[1];
  const git = /\/git\/([^/]+)/.exec(dir);
  return git ? git[1] : tilde(dir);
}

// Climbs from a JVM to the process that started it for this run: the bazel launcher script, and
// the `bazel run` client if it stayed (it usually execs the binary). Stops before the shell.
function jvmRoot(procs, p) {
  let root = p;
  for (;;) {
    const parent = procs.get(root.ppid);
    if (!parent || !(BAZEL_BIN.test(parent.cmd) || /\.runfiles/.test(parent.cmd) || /\bbazel(isk)?\b.*\srun\s/.test(parent.cmd))) return root;
    root = parent;
  }
}

function pnpmArgs(cmd) {
  const words = cmd.split(/\s+/);
  const i = words.slice(0, 3).findIndex((w) => PNPM.test(w));
  return i < 0 ? null : words.slice(i + 1);
}

// Every dev server running now:
// { key, kind: "backend" | "frontend", name, detail, folder, place, pid, pids, ports, etime, log, command }
export async function scan(cfg = {}) {
  const [procs, ports] = await Promise.all([processTable(), listening()]);
  const hide = (cfg.hide ?? []).map((h) => new RegExp(h));
  const hidden = (p) => hide.some((h) => h.test(p.cmd));

  const jvms = [...procs.values()].filter((p) => /^(\S*\/)?java\s/.test(p.cmd) && !JVM_TOOLING.test(p.cmd) && !hidden(p));
  const pnpmRoots = [...procs.values()].filter((p) => {
    if (!pnpmArgs(p.cmd) || hidden(p)) return false;
    for (let a = procs.get(p.ppid); a; a = procs.get(a.ppid)) if (pnpmArgs(a.cmd)) return false;
    return true;
  });
  const info = await folders([...jvms, ...pnpmRoots].map((p) => p.pid));
  const portsOf = (pids) => [...new Set(pids.flatMap((pid) => [...(ports.get(pid) ?? [])]))].sort((a, b) => a - b);

  const found = [];
  for (const p of jvms) {
    const { cwd, log } = info.get(p.pid) ?? {};
    const own = portsOf([p.pid]);
    const m = RUNFILES.exec(cwd ?? "") ?? RUNFILES.exec(p.cmd);
    if (!m && !own.length) continue; // a JVM that isn't a bazel binary and serves nothing
    const root = jvmRoot(procs, p);
    const pids = [root.pid, ...descendants(procs, root.pid)];
    if (m) {
      const [, outputBase, pkg, bin] = m;
      const target = `//${pkg}:${bin}`;
      const folder = await workspaceOf(outputBase);
      found.push({
        key: `bazel ${target} ${folder ?? outputBase}`, kind: "backend",
        name: GENERIC.test(bin) ? pkg.split("/").pop() : bin, detail: target,
        folder, place: placeLabel(folder ?? cwd), pid: root.pid, pids, ports: portsOf(pids), etime: p.etime, log,
        command: cfg.restart?.[target] ?? cfg.restart?.[folder] ?? `bazel run ${target}`,
        restartable: Boolean(folder),
      });
    } else {
      const main = /-jar\s+(\S+)/.exec(p.cmd)?.[1]?.split("/").pop() ?? p.cmd.split(/\s+/).filter((w) => !w.startsWith("-")).pop();
      found.push({
        key: `jvm ${p.pid}`, kind: "backend", name: main ?? "java", detail: "java", folder: cwd,
        place: placeLabel(cwd), pid: root.pid, pids, ports: portsOf(pids), etime: p.etime, log,
        command: cfg.restart?.[cwd] ?? null, restartable: Boolean(cfg.restart?.[cwd]),
      });
    }
  }

  for (const p of pnpmRoots) {
    const args = pnpmArgs(p.cmd);
    const pids = [p.pid, ...descendants(procs, p.pid)];
    const served = portsOf(pids);
    if (!served.length && !DEVISH.test(args.join(" "))) continue; // installs, one-off scripts
    const { cwd, log } = info.get(p.pid) ?? {};
    const fi = args.findIndex((a) => a === "--filter" || a === "-F");
    const filter = fi >= 0 ? args[fi + 1] : (/^--filter=(.+)/.exec(args.find((a) => a.startsWith("--filter=")) ?? "")?.[1] ?? null);
    const name = filter ?? (cwd ? (await packageName(cwd)) ?? cwd.split("/").pop() : "pnpm");
    const command = `pnpm ${args.map(quote).join(" ")}`.trim();
    found.push({
      key: `pnpm ${cwd} ${args.join(" ")}`, kind: "frontend", name, detail: command, folder: cwd,
      place: placeLabel(cwd), pid: p.pid, pids, ports: served, etime: p.etime, log,
      command: cfg.restart?.[cwd] ?? command, restartable: Boolean(cwd),
    });
  }
  return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

// SIGTERM to the whole tree (looked up again now, so new children go too, and a reused pid
// doesn't), SIGKILL whatever is still there after `graceMs`.
export async function stop(task, graceMs = 8000) {
  const procs = await processTable();
  const root = procs.get(task.pid);
  if (!root) return;
  const pids = [...new Set([task.pid, ...descendants(procs, task.pid), ...task.pids.filter((p) => procs.has(p))])];
  const list = pids.join(" ");
  const tries = Math.ceil(graceMs / 100);
  const script = `kill -TERM ${list} 2>/dev/null; i=0; while [ $i -lt ${tries} ]; do alive=; for p in ${list}; do kill -0 $p 2>/dev/null && alive=1; done; [ -z "$alive" ] && exit 0; sleep 0.1; i=$((i+1)); done; kill -KILL ${list} 2>/dev/null; exit 0`;
  await exec("sh", ["-c", script], { timeout: graceMs + 5000 });
}

// ps etime ([[dd-]hh:]mm:ss) -> "3d", "2h 5m", "12m", "40s"
export function uptime(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime ?? "");
  if (!m) return "";
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => +(x ?? 0));
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${min}m`;
  if (min) return `${min}m`;
  return `${s}s`;
}
