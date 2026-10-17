/**
 * The console's addresses, below the account's `/u/<username>`:
 *   (none)          main session
 *   /tasks          task list
 *   /tasks/<id>     one task's process (from the main session, the list, a schedule or the files page)
 *   /files          every file of the main session
 *   /schedules      scheduled tasks
 *   /vault          password vault
 *   /analytics      the owner's dashboard: accounts, activity, tasks and token usage
 *                   (the former `/usage` address opens it too)
 *   /gadget         the voice gadget account's conversation, read-only (owner)
 *   /settings       configuration (member: language and account privacy)
 *   /workspace      the workspace, over the main session
 * `/login` and `/register` stay outside any account; overlays such as a link's
 * browser console or a file preview do not change the address.
 */
export type AppView = "main" | "tasks" | "files" | "schedules" | "vault" | "analytics" | "gadget" | "settings";
export interface AppRoute {
  view: AppView | "detail";
  /** The task a detail address shows. */
  task?: string;
  workspace?: boolean;
}

const ACCOUNT = /^\/u\/[A-Za-z0-9_-]{2,40}(?=\/|$)/;
const PAGES: Record<string, AppView> = { tasks: "tasks", files: "files", schedules: "schedules", vault: "vault", usage: "analytics", analytics: "analytics", gadget: "gadget", settings: "settings" };
export const OWNER_VIEWS: ReadonlySet<AppRoute["view"]> = new Set(["analytics", "gadget"]);

/** What an address points at; anything unknown is the main session. */
export function parseRoute(pathname: string): AppRoute {
  const [page, id] = pathname.replace(ACCOUNT, "").split("/").filter(Boolean);
  if (page === "workspace") return { view: "main", workspace: true };
  if (page === "tasks" && id) return { view: "detail", task: decodeURIComponent(id) };
  return { view: (page && PAGES[page]) || "main" };
}

/** The address of a route in an account's console. */
export function routePath(username: string, route: AppRoute): string {
  const home = `/u/${username}`;
  if (route.workspace) return `${home}/workspace`;
  if (route.view === "detail") return `${home}/tasks/${encodeURIComponent(route.task ?? "")}`;
  return route.view === "main" ? home : `${home}/${route.view}`;
}

/** Whether an address without an account still names a console page (a shared `/tasks/...` link). */
export function namesPage(pathname: string): boolean {
  const route = parseRoute(pathname);
  return !ACCOUNT.test(pathname) && (route.view !== "main" || !!route.workspace);
}
