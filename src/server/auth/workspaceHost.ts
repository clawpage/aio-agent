import {createHash} from 'node:crypto';
import type {Config} from '../config.js';
export const userNamespace=(id:string)=>createHash('sha256').update(id).digest('hex').slice(0,20);
/**
 * Member workspaces share the one companion origin; a path prefix names the
 * account (`/u/<namespace>`), so no per-account DNS record is needed.
 */
export const memberWorkspacePrefix=(id:string)=>`/u/${userNamespace(id)}`;
/** `/u/<namespace>` at the start of a request URL, followed by `/`, `?` or the end. */
export const MEMBER_WORKSPACE_PREFIX=/^\/u\/([0-9a-f]{20})(?=[/?]|$)/;
export function workspaceConfig(cfg:Config):Config {
 return {...cfg,memberRuntime:true};
}
