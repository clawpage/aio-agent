import {createHash} from 'node:crypto';
import type {Config} from '../config.js';
export const userNamespace=(id:string)=>createHash('sha256').update(id).digest('hex').slice(0,20);
/**
 * Every account's workspace shares the one companion origin; a path prefix names
 * the account by username (`/u/<username>`), like the console's own addresses, so
 * no per-account DNS record is needed. Container and volume names keep using
 * `userNamespace`: renaming them would orphan existing data.
 */
export const workspacePrefix=(username:string)=>`/u/${username}`;
/**
 * `/u/<username>` (or, for links made before, `/u/<namespace>`) at the start of a
 * request URL, followed by `/`, `?` or the end.
 */
export const WORKSPACE_PREFIX=/^\/u\/([A-Za-z0-9_-]{2,40})(?=[/?]|$)/;
export function workspaceConfig(cfg:Config):Config {
 return {...cfg,memberRuntime:true};
}
