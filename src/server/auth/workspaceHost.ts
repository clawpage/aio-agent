import {createHash} from 'node:crypto';
import type {Config} from '../config.js';
export const userNamespace=(id:string)=>createHash('sha256').update(id).digest('hex').slice(0,20);
export function memberWorkspaceHost(cfg:Config,id:string):string {
 const [label,...domain]=cfg.workspaceHost.split('.');
 return `${label.slice(0,40)}-${userNamespace(id)}.${domain.join('.')}`;
}
export function workspaceConfig(cfg:Config,id:string):Config {
 const host=memberWorkspaceHost(cfg,id);
 return {...cfg,memberRuntime:true,workspaceHost:host,allowedHosts:[...cfg.allowedHosts,host],workspaceOrigins:[`https://${host}`]};
}
