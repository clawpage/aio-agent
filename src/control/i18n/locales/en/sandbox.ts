import type { sandbox as zh } from "../zh/sandbox.js";
export const sandbox: typeof zh = {
    codexInstallFailed: (version: string, output: string) => `Couldn't install the sandbox Codex CLI (@openai/codex@${version} is required): ${output}`,
    codexVerifyFailed: (expected: string, actual: string) => `The sandbox Codex CLI failed its check after installing: expected ${expected}, found ${actual}`,
    claudeInstallFailed: (version: string, output: string) => `Couldn't install the sandbox Claude Code CLI (@anthropic-ai/claude-code@${version} is required): ${output}`,
    claudeVerifyFailed: (expected: string, actual: string) => `The sandbox Claude Code CLI failed its check after installing: expected ${expected}, found ${actual}`,
    claudeConfigFailed: (output: string) => `Couldn't set up the Claude Code config directory: ${output}`,
    startFailed: "The sandbox failed to start. Please try again later.",
    node: {
        incompatible: (node: string, protocol: number | string, range: string) => `Sandbox node ${node} speaks protocol ${protocol}, outside the range ${range} this control plane supports`,
        unreachable: (node: string, error: string) => `Can't reach sandbox node ${node}: ${error}`,
        httpStatus: (node: string, status: number) => `Sandbox node ${node} returned HTTP ${status}`,
        unauthorized: "The node token is invalid",
        containerForeign: (name: string) => `The container name ${name} is taken by a container this system didn't create (it lacks the personal-agent.managed=1 label). Check it by hand, then rename or remove that container.`,
        imageMismatch: (name: string, image: string, expected: string) => `Container ${name} uses image ${image}, not the pinned image ${expected}, so it wasn't taken over automatically.`,
        volumeMissing: (name: string, volume: string, destination: string) => `Container ${name} is missing the persistent volume mount ${volume} -> ${destination}, so it wasn't taken over, to avoid losing data.`,
        sandboxMissing: (name: string) => `Sandbox ${name} doesn't exist`,
        sandboxUnmanaged: (name: string) => `Container ${name} isn't a sandbox managed by this system`,
        noWebPort: (name: string) => `Sandbox ${name} doesn't publish a web port`,
    },
};
