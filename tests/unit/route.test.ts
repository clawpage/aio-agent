import { describe, expect, it } from "vitest";
import { namesPage, parseRoute, routePath } from "../../src/ui/src/route.js";

describe("console addresses", () => {
  it("reads each page from the address below the account", () => {
    expect(parseRoute("/u/owner")).toEqual({ view: "main" });
    expect(parseRoute("/u/owner/")).toEqual({ view: "main" });
    expect(parseRoute("/u/owner/tasks")).toEqual({ view: "tasks" });
    expect(parseRoute("/u/owner/tasks/task_1a")).toEqual({ view: "detail", task: "task_1a" });
    expect(parseRoute("/u/cr/schedules")).toEqual({ view: "schedules" });
    expect(parseRoute("/u/cr/vault")).toEqual({ view: "vault" });
    expect(parseRoute("/u/owner/usage")).toEqual({ view: "usage" });
    expect(parseRoute("/u/owner/settings")).toEqual({ view: "settings" });
    expect(parseRoute("/u/owner/workspace")).toEqual({ view: "main", workspace: true });
    expect(parseRoute("/u/owner/whatever/else")).toEqual({ view: "main" });
  });

  it("writes the address of every page, and reads it back the same", () => {
    const routes = [{ view: "main" }, { view: "tasks" }, { view: "detail", task: "task 1/x" }, { view: "schedules" }, { view: "vault" }, { view: "usage" }, { view: "settings" }, { view: "main", workspace: true }] as const;
    for (const route of routes) expect(parseRoute(routePath("alice", route))).toEqual(route);
    expect(routePath("alice", { view: "main" })).toBe("/u/alice");
    expect(routePath("alice", { view: "detail", task: "task_9" })).toBe("/u/alice/tasks/task_9");
  });

  it("keeps a page named by an address without the account; the root, login and register name none", () => {
    expect(namesPage("/tasks/task_1")).toBe(true);
    expect(namesPage("/schedules")).toBe(true);
    expect(namesPage("/workspace")).toBe(true);
    for (const plain of ["/", "/login", "/register", "/u/owner/tasks"]) expect(namesPage(plain)).toBe(false);
  });
});
