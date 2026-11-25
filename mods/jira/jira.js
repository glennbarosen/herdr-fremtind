// Jira access and helpers for the panel.
import { exec, home, readTextFile, spaces, panes, focused } from "herdr";

export const CONFIG_PATH = () => `${home()}/.config/herdr-jira.json`;
export const KEYCHAIN_SERVICE = "herdr-jira";
export const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

// { site, email, boards: [id | {id, name}], command?: ["ccl"], setup?: ["direnv allow", ...],
//   jql?: "project = RF" (ANDed onto every board's query), createStatus?: "Ready for development" }
// The API token comes from the macOS Keychain (service "herdr-jira"), else `token` in the file.
export async function loadConfig() {
  const text = await readTextFile(CONFIG_PATH());
  if (text === null) throw new Error(`No config: create ${tilde(CONFIG_PATH())}`);
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { throw new Error(`${tilde(CONFIG_PATH())}: ${e}`); }
  if (!cfg.site || !cfg.email) throw new Error(`${tilde(CONFIG_PATH())} needs "site" and "email".`);
  cfg.site = cfg.site.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(cfg.site)) cfg.site = `https://${cfg.site}`;
  cfg.boards = (cfg.boards ?? []).map((b) => (typeof b === "object" ? b : { id: b }));
  let token = cfg.token;
  if (!token) {
    try {
      const r = await exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", cfg.email, "-w"]);
      if (r.code === 0) token = r.stdout.trim();
    } catch {}
  }
  if (!token) throw new Error(`No API token. Run: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${cfg.email} -w`);
  cfg.auth = `Basic ${base64(`${cfg.email}:${token}`)}`;
  delete cfg.token;
  return cfg;
}

export async function api(cfg, path, method = "GET", body) {
  const headers = { Authorization: cfg.auth, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${cfg.site}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) {
    let msg = "";
    try {
      const j = await r.json();
      msg = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join(" ") || j.message || "";
    } catch {}
    throw new Error(`Jira ${r.status}${msg ? `: ${msg}` : ""}`);
  }
  const text = await r.text(); // 204 No Content for assign
  return text ? JSON.parse(text) : null;
}

// Creates an issue in the project's backlog (no sprint), assigned to `assignee` if given.
// Type: the config's "issueType", else Task, else the project's first non-subtask type.
export async function createIssue(cfg, project, summary, assignee) {
  const meta = await api(cfg, `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`);
  const types = (meta.values ?? meta.issueTypes ?? []).filter((t) => !t.subtask);
  const want = (cfg.issueType ?? "Task").toLowerCase();
  const type = types.find((t) => t.name.toLowerCase() === want) ?? types.find((t) => /^(task|oppgave)$/i.test(t.name)) ?? types[0];
  if (!type) throw new Error(`No issue types available in ${project}`);
  const made = await api(cfg, "/rest/api/2/issue", "POST", { fields: { project: { key: project }, summary, issuetype: { id: type.id } } });
  // Assigning separately works even when the create screen has no assignee field.
  if (assignee) await api(cfg, `/rest/api/2/issue/${made.key}/assignee`, "PUT", { accountId: assignee }).catch(() => {});
  if (cfg.createStatus) await moveTo(cfg, made.key, cfg.createStatus).catch(() => {});
  return { key: made.key, summary, type: type.name };
}

// The issue's description as plain text (Jira wiki markup), "" if it has none.
export async function issueDescription(cfg, key) {
  const i = await api(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=description`);
  return String(i?.fields?.description ?? "").trim();
}

// Moves an issue to the status with this name (or id), if the workflow has a transition to it.
export async function moveTo(cfg, key, status) {
  const want = String(status).toLowerCase();
  const { transitions = [] } = await api(cfg, `/rest/api/2/issue/${key}/transitions`);
  const t = transitions.find((t) => t.to?.name?.toLowerCase() === want || t.to?.id === String(status)) ?? transitions.find((t) => t.name.toLowerCase() === want);
  if (!t) throw new Error(`${key}: no transition to "${status}"`);
  await api(cfg, `/rest/api/2/issue/${key}/transitions`, "POST", { transition: { id: t.id } });
}

const FIELDS = "summary,status,assignee,issuetype,priority,updated";

// A board's issues grouped into its columns: { board, sprint, columns: [{ name, issues }] }.
// Scrum boards show the active sprint; kanban boards show open issues and those done in 14 days.
export async function loadBoard(cfg, boardId) {
  const [board, conf] = await Promise.all([api(cfg, `/rest/agile/1.0/board/${boardId}`), api(cfg, `/rest/agile/1.0/board/${boardId}/configuration`)]);
  let sprint = null;
  let path = `/rest/agile/1.0/board/${boardId}/issue`;
  let jql = "statusCategory != Done OR resolved >= -14d";
  if (board.type === "scrum") {
    const s = await api(cfg, `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    sprint = s.values?.[0] ?? null;
    if (sprint) { path = `/rest/agile/1.0/board/${boardId}/sprint/${sprint.id}/issue`; jql = ""; }
  }
  if (cfg.jql) jql = jql ? `(${cfg.jql}) AND (${jql})` : cfg.jql;
  const issues = [];
  for (let start = 0; start < 300; start += 100) {
    const q = `?fields=${FIELDS}&maxResults=100&startAt=${start}${jql ? `&jql=${encodeURIComponent(jql)}` : ""}`;
    const page = await api(cfg, path + q);
    issues.push(...(page.issues ?? []).map(simplify));
    if (start + 100 >= (page.total ?? 0)) break;
  }
  const columns = (conf.columnConfig?.columns ?? []).map((c) => ({ name: c.name, statuses: new Set((c.statuses ?? []).map((s) => s.id)), issues: [] }));
  const rest = { name: "Other", statuses: new Set(), issues: [] };
  for (const i of issues) (columns.find((c) => c.statuses.has(i.statusId)) ?? rest).issues.push(i);
  if (rest.issues.length) columns.push(rest);
  return { board: { id: board.id, name: board.name, type: board.type, project: board.location?.projectKey }, sprint, columns: columns.filter((c) => c.issues.length) };
}

function simplify(i) {
  const f = i.fields ?? {};
  return {
    key: i.key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    statusId: f.status?.id,
    category: f.status?.statusCategory?.key, // new | indeterminate | done
    type: f.issuetype?.name ?? "",
    subtask: Boolean(f.issuetype?.subtask),
    priority: f.priority?.name ?? "",
    assignee: f.assignee ? { id: f.assignee.accountId, name: f.assignee.displayName } : null,
    updated: f.updated,
  };
}

export async function myself(cfg) {
  const me = await api(cfg, "/rest/api/2/myself");
  return me.accountId;
}

export const issueUrl = (cfg, key) => `${cfg.site}/browse/${key}`;
// RF-7815 + "Migrate to Jøkul v5!" -> RF-7815-migrate-to-jokul-v5
export function branchFor(key, summary, max = 50) {
  let s = summary.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a");
  try { s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch {}
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > max) s = s.slice(0, max).replace(/-[^-]*$/, "") || s.slice(0, max);
  return s ? `${key}-${s}` : key;
}

// Branch names belonging to an issue: "RF-12" or "RF-12-anything" (never "RF-123").
export const isIssueBranch = (branch, key) => branch === key || branch.startsWith(`${key}-`) || branch.startsWith(`${key}_`) || branch.startsWith(`${key}.`);

// The folder to start a worktree from: the focused terminal's, else one in the shown tab, else
// any in the space, preferring terminals inside a git repo (a branch), then the space's folder.
export function placeOf(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  const here = panes().filter((p) => tabs.has(p.tab) && p.terminal && p.cwd);
  const f = focused();
  const rank = (p) => (p.terminal === f?.terminal ? 0 : 4) + (p.tab === f?.tab ? 0 : 2) + (p.branch ? 0 : 1);
  const best = here.sort((a, b) => rank(a) - rank(b))[0];
  return (f?.space === s.id && f?.terminal && f?.cwd) || best?.cwd || s.folder || null;
}

// Local spaces whose terminals sit on a branch of this issue.
export function spacesFor(key) {
  const tabs = new Set(panes().filter((p) => p.branch && isIssueBranch(p.branch, key)).map((p) => p.tab));
  return tabs.size ? spaces().filter((s) => !s.machine && (s.tabs ?? []).some((t) => tabs.has(t.id))) : [];
}
