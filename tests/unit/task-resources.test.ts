import { describe, expect, it } from "vitest";
import { claimsConflict, normalizeResource, resourcesConflict, resolveResources } from "../../src/control/tasks/resources.js";
import { parsePlan } from "../../src/control/tasks/planning.js";
const root="/home/gem/workspace", w=(p:string)=>`write:${root}/${p}`, r=(p:string)=>`read:${root}/${p}`;
describe("scoped resources",()=>{
 it("allows independent writes and shared reads, serializes overlap in either direction",()=>{
  expect(resourcesConflict([w("projects/a")],[w("projects/b")])).toBe(false);
  expect(resourcesConflict([r("projects/a")],[r("projects/a/src")])).toBe(false);
  for(const [a,b] of [[w("projects/a"),r("projects/a/src")],[r("projects/a"),w("projects/a/src")],[w("projects/a"),w("projects/a")]]){
   expect(resourcesConflict([a!],[b!])).toBe(true);expect(resourcesConflict([b!],[a!])).toBe(true);
  }
  expect(resourcesConflict([w("projects/a")],[w("projects/ab")])).toBe(false);
  expect(resourcesConflict([w("tasks")],[w("tasks/one")])).toBe(true);
  expect(resourcesConflict(["workspace"],[r("projects/a")])).toBe(true);
  expect(resourcesConflict(["browser"],[w("projects/a")])).toBe(false);
  // Tasks drive their own tabs: two browser tasks never wait on each other.
  expect(resourcesConflict(["browser"],["browser"])).toBe(false);
 });
 it("a declared workspace claim waits for what other tasks declared, not for their own directories",()=>{
  const task=(id:string,...declared:string[])=>({declared,own:[w(`tasks/${id}`)]});
  const install=task("install","workspace");
  for(const other of [task("chat"),task("research","browser"),{declared:[],own:[w("tasks/doc"),r("uploads/photo.jpg")]}]){
   expect(claimsConflict(install,other)).toBe(false);expect(claimsConflict(other,install)).toBe(false);
  }
  for(const other of [task("install2","workspace"),task("edit",w("projects/a")),task("read",r("projects/a")),task("sweep",`write:${root}`),{declared:["all"],own:[]}]){
   expect(claimsConflict(install,other)).toBe(true);expect(claimsConflict(other,install)).toBe(true);
  }
  // Path claims keep their rules, own directories included; the resolver's fallback among own claims waits for everything.
  expect(claimsConflict(task("a",w("tasks")),task("b"))).toBe(true);
  expect(claimsConflict(task("a",w("projects/a")),task("b",w("projects/b")))).toBe(false);
  expect(claimsConflict({declared:[],own:[w("tasks/a"),"workspace"]},task("chat"))).toBe(true);
 });
 it("normalizes harmless spelling and rejects ambiguous or outside-root paths",()=>{
  expect(normalizeResource(w("projects//a/./"),root)).toBe(w("projects/a"));
  for(const value of [w("../secret"),w("a/../b"),w("*"),"write:relative","write:/etc","write:/home/gem/workspace-other/a",{},"write:/"])
   expect(normalizeResource(value,root)).toBeNull();
  const parsed=parsePlan(JSON.stringify({title:"x",related:[],dependencies:[],resources:[w("projects//a/"),r("input.md")],ownedResources:["browser"]}),[],null);
  expect(parsed?.resources).toEqual([w("projects/a"),r("input.md")]);expect(parsed?.ownedResources).toBeUndefined();
 });
 it("preserves real and lexical paths, failing conservatively on outside symlinks or resolver failure",async()=>{
  const sandbox={execInSandbox:async()=>({code:0,stdout:JSON.stringify([root+"/projects/real"])})};
  const claims=await resolveResources([w("alias")],root,sandbox);
  expect(claims).toEqual([w("alias"),w("projects/real")]);
  expect(resourcesConflict(claims,[r("projects/real/report.md")])).toBe(true);
  expect(await resolveResources([w("alias")],root,{execInSandbox:async()=>({code:0,stdout:'["/etc"]'})})).toContain("workspace");
  expect(await resolveResources([w("alias")],root,{execInSandbox:async()=>{throw Error("offline");}})).toContain("workspace");
 });
});
