import { describe, expect, it } from "vitest";
import { normalizeResource, resourcesConflict, resolveResources } from "../../src/server/tasks/resources.js";
import { parsePlan } from "../../src/server/tasks/planning.js";
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
  expect(resourcesConflict(["browser"],["browser"])).toBe(true);
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
