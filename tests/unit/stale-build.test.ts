import { expect, it } from "vitest";
import { behindSince } from "../../src/ui/src/staleBuild";

it("counts from the first time this build was found behind", () => {
  const first = { build: "index-A", since: 1000 };
  expect(behindSince(null, "index-A", 1000)).toEqual(first);
  // Found behind again later (the same newer build or a newer one still): the first time stands.
  expect(behindSince(first, "index-A", 5000)).toEqual(first);
  // Another build of the page starts its own count; so does a time kept from a clock set ahead.
  expect(behindSince(first, "index-B", 5000)).toEqual({ build: "index-B", since: 5000 });
  expect(behindSince({ build: "index-A", since: 9000 }, "index-A", 5000)).toEqual({ build: "index-A", since: 5000 });
});
