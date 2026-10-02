import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDb} from '../../src/control/db.js';
import {ensureOwner,createMember,authenticateUser,getUser} from '../../src/control/auth/owner.js';
import {hashPassword} from '../../src/control/auth/passwords.js';
import {Logger} from '../../src/common/logger.js';
import {SessionStore} from '../../src/control/auth/sessions.js';
it('migrates an existing owner without changing password or live sessions and never bootstraps over a member',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-user-migration-'));const file=path.join(dir,'db.sqlite');
 const old=new DatabaseSync(file);old.exec('CREATE TABLE owners (id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,password_params TEXT NOT NULL,created_at INTEGER NOT NULL)');
 const rec=await hashPassword('existing-owner-password');old.prepare('INSERT INTO owners VALUES (?,?,?,?,?,?)').run('owner_1','owner',rec.hash,rec.salt,rec.params,1);old.close();
 let db=openDb(file);
 try {
  const sessions=new SessionStore(db,3600000,60000);const live=sessions.create('owner_1','primary');
  expect(getUser(db,'owner_1')?.role).toBe('owner');
  const user=await createMember(db,'yzmy','member-password-123');
  await ensureOwner(db,{password:'replacement-not-used',secretPath:path.join(dir,'owner.txt'),log:new Logger('error',undefined,false)});
  expect(await authenticateUser(db,'owner','existing-owner-password')).toMatchObject({role:'owner'});
  expect(await authenticateUser(db,'yzmy','member-password-123')).toMatchObject({id:user.id,role:'member'});
  db.close();db=openDb(file);
  expect(new SessionStore(db,3600000,60000).resolve('primary',live.token)?.ownerId).toBe('owner_1');
  expect(getUser(db,user.id)?.role).toBe('member');
  await expect(createMember(db,'yzmy','another-password-123')).rejects.toThrow();
  expect(await authenticateUser(db,'yzmy','member-password-123')).not.toBeNull();
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
