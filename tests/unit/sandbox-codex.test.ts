import { describe, expect, it } from "vitest";
import { parseCodexVersion } from "../../src/control/docker/sandbox.js";

describe("sandbox Codex CLI version parsing", () => {
  it("reads the version from real `codex --version` output", () => {
    expect(parseCodexVersion("codex-cli 0.156.1\n")).toBe("0.156.1");
    expect(parseCodexVersion("codex-cli 0.139.0")).toBe("0.139.0");
  });

  it("does not accept a longer version as a prefix match", () => {
    // The pinned version must be compared exactly: 0.156.10 is a different build.
    expect(parseCodexVersion("codex-cli 0.156.10")).not.toBe("0.156.1");
  });

  it("returns null for output that is not a version banner", () => {
    expect(parseCodexVersion("")).toBeNull();
    expect(parseCodexVersion("bash: /home/gem/.codex/tools/codex-0.156.1/...: No such file or directory")).toBeNull();
  });
});
