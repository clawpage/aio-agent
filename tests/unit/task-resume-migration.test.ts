import {expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDb} from '../../src/control/db.js';

it('adds executor references to old databases without changing task history, idempotently',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-resume-migration-'));
  const file=path.join(dir,'test.sqlite');
  try {
    const old=openDb(file);
    // A database from before the column never had the index over it either.
    old.exec("DROP INDEX idx_tasks_execution");
    old.exec("ALTER TABLE tasks DROP COLUMN execution_conversation_id");
    old.exec("INSERT INTO conversations(id,owner_id,title,created_at,updated_at) VALUES('conv','owner','Task',1,1)");
    old.exec("INSERT INTO tasks(id,client_message_id,conversation_id,title,input_text,status,result,created_at,completed_at) VALUES('task','message','conv','Task','Original input','completed','Original result',1,2)");
    old.close();
    for(let i=0;i<2;i++){
      const current=openDb(file);
      expect(current.prepare('SELECT execution_conversation_id,conversation_id,result,status FROM tasks').get()).toMatchObject({execution_conversation_id:null,conversation_id:'conv',result:'Original result',status:'completed'});
      expect(current.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      current.close();
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
