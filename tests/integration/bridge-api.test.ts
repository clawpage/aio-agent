import { describe, expect, it } from "vitest";
import { login, startHarness } from "../helpers/harness.js";

describe("bridge model is absent on the owner's runtime", () => {
  it("does not advertise a gateway model to the owner", async () => {
    const bare = await startHarness();
    try {
      const { cookie } = await login(bare);
      const res = await bare.request("/api/models", { headers: { cookie } });
      const { models } = (await res.json()) as { models: Array<{ id: string; modelProvider?: string | null }> };
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.modelProvider)).toBe(false);
    } finally {
      await bare.shutdown();
    }
  });
});
