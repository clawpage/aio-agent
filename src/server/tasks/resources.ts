import path from "node:path";

export interface PathClaim { mode: "read" | "write"; path: string }
export function pathClaim(resource: string): PathClaim | null {
    const m = /^(read|write):(.+)$/.exec(resource);
    return m ? { mode: m[1] as PathClaim["mode"], path: m[2]! } : null;
}
export function within(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent.replace(/\/$/, "") + "/");
}
/** Reject ambiguous paths, rather than guessing what a shell would expand. */
export function normalizeResource(resource: unknown, root: string): string | null {
    if (resource === "browser" || resource === "workspace") return resource;
    if (typeof resource !== "string") return null;
    const c = pathClaim(resource);
    if (!c || !c.path.startsWith("/") || /[\x00-\x1f\x7f\\*?\[\]{}$~]/.test(c.path) || c.path.split("/").includes("..")) return null;
    const target = path.posix.normalize(c.path).replace(/\/$/, "") || "/";
    if (!within(root, target)) return null;
    return `${c.mode}:${target}`;
}
export function resourcesConflict(a: string[], b: string[]): boolean {
    if (a.includes("all") || b.includes("all")) return true;
    return a.some(x => b.some(y => {
        // Each task drives its own tabs; the shared browser itself is never exclusive.
        if (x === "browser" || y === "browser") return false;
        // Legacy workspace claims remain conservative; do not silently narrow active work.
        if (x === "workspace" || y === "workspace") return true;
        const p = pathClaim(x), q = pathClaim(y);
        if (!p || !q) return true;
        return (p.mode === "write" || q.mode === "write") && (within(p.path, q.path) || within(q.path, p.path));
    }));
}
export interface ResourceSandbox {
    execInSandbox(argv: string[], opts?: { timeoutMs?: number; stdin?: string }): Promise<{ code: number; stdout: string }>;
}
/** Preserve lexical AND real paths: aliases and deletions of alias parents must conflict. */
export async function resolveResources(resources: string[], root: string, sandbox: ResourceSandbox): Promise<string[]> {
    const claims = resources.map(pathClaim).filter((p): p is PathClaim => p !== null);
    if (!claims.length) return resources;
    try {
        const result = await sandbox.execInSandbox(["python3", "-c",
            "import json,os,sys\ndef resolve(p):\n try: return os.path.realpath(p,strict=True)\n except FileNotFoundError: return os.path.realpath(p,strict=False)\nprint(json.dumps([resolve(p) for p in json.load(sys.stdin)]))"],
            { stdin: JSON.stringify(claims.map(c => c.path)), timeoutMs: 15_000 });
        const real: unknown = JSON.parse(result.stdout);
        if (result.code !== 0 || !Array.isArray(real) || real.length !== claims.length) throw new Error("unresolved");
        const aliases = real.map((p, i) => typeof p === "string" ? normalizeResource(`${claims[i]!.mode}:${p}`, root) : null);
        if (aliases.some(p => p === null)) throw new Error("outside workspace");
        return [...new Set([...resources, ...aliases as string[]])];
    } catch {
        // An unavailable resolver or outside-root symlink must never grant unsafe concurrency.
        return [...new Set([...resources, "workspace"])];
    }
}
