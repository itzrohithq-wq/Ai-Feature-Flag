// Database-backed temporary auth state lets a callback reach another API worker.
export class SharedState {
  constructor(operations,namespace,{encrypted=false}={}){this.ops=operations;this.db=operations.db;this.namespace=namespace;this.encrypted=encrypted;this.db.exec('CREATE TABLE IF NOT EXISTS transient_state(namespace TEXT,key TEXT,value TEXT,expiresAt INTEGER,PRIMARY KEY(namespace,key));');}
  get(key){const row=this.db.prepare('SELECT value FROM transient_state WHERE namespace=? AND key=? AND expiresAt>?').get(this.namespace,String(key),Date.now());if(!row)return undefined;return JSON.parse(this.encrypted?this.ops.unseal(row.value):row.value);}
  set(key,value){let payload=JSON.stringify(value);if(this.encrypted)payload=this.ops.seal(payload);this.db.prepare('INSERT INTO transient_state VALUES (?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,expiresAt=excluded.expiresAt').run(this.namespace,String(key),payload,value.expiresAt??value.until??Date.now()+900000);return this;}
  delete(key){return Boolean(this.db.prepare('DELETE FROM transient_state WHERE namespace=? AND key=?').run(this.namespace,String(key)).changes);}
  consume(key){return this.ops.runtime.transaction(()=>{const value=this.get(key);this.delete(key);return value;});}
  get size(){this.db.prepare('DELETE FROM transient_state WHERE expiresAt<=?').run(Date.now());return this.db.prepare('SELECT COUNT(*) AS n FROM transient_state WHERE namespace=?').get(this.namespace).n;}
  *[Symbol.iterator](){for(const row of this.db.prepare('SELECT key FROM transient_state WHERE namespace=?').all(this.namespace)){const value=this.get(row.key);if(value)yield [row.key,value];}}
}
