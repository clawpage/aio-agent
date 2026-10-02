import type { Server } from "node:http";

export interface EdgeCompatibility {
  ok: boolean;
  ui: { api: number | null; version: string | null };
  control: { version: string; api: number; apiMin: number } | null;
  error?: string;
}

export function createEdge(opts: { dist: string; control: string; workspaceOrigin?: string; log?: (msg: string, detail?: unknown) => void }): {
  server: Server;
  compatible(): Promise<EdgeCompatibility>;
};
