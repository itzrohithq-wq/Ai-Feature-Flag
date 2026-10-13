import { randomBytes, randomUUID } from 'node:crypto';

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const fail = (status, detail, scimType) => { throw Object.assign(new Error(detail), {status, scimType}); };
const fields = ['userName', 'externalId', 'displayName', 'active', 'roles'];

// A deliberately restricted Users profile: provisioning never grants an admin role.
export class Scim {
  discovery(type,id){
    const resource={schemas:['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],id:'User',name:'User',endpoint:'/Users',schema:USER_SCHEMA,description:'Restricted reader Users provisioning profile.'};
    const schema={schemas:['urn:ietf:params:scim:schemas:core:2.0:Schema'],id:USER_SCHEMA,name:'User',description:'Supported User attributes for Control studio.',attributes:[{name:'userName',type:'string',multiValued:false,required:true,caseExact:false,mutability:'readWrite',returned:'default',uniqueness:'server'},{name:'displayName',type:'string',multiValued:false,required:false,mutability:'readWrite',returned:'default'},{name:'active',type:'boolean',multiValued:false,required:false,mutability:'readWrite',returned:'default'},{name:'externalId',type:'string',multiValued:false,required:false,caseExact:true,mutability:'readWrite',returned:'default',uniqueness:'server'},{name:'roles',type:'complex',multiValued:true,required:false,mutability:'readWrite',returned:'default',subAttributes:[{name:'value',type:'string',multiValued:false,required:true,canonicalValues:['reader'],mutability:'readWrite',returned:'default'}]}]};
    const groupSchema={schemas:schema.schemas,id:'urn:ietf:params:scim:schemas:core:2.0:Group',name:'Group',description:'User membership groups; membership does not grant application roles.',attributes:[{name:'displayName',type:'string',multiValued:false,required:true,mutability:'readWrite',returned:'default',uniqueness:'server'},{name:'externalId',type:'string',multiValued:false,required:false,mutability:'readWrite',returned:'default'},{name:'members',type:'complex',multiValued:true,required:false,mutability:'readWrite',returned:'default',subAttributes:[{name:'value',type:'string',required:true,multiValued:false,mutability:'immutable',returned:'default'},{name:'type',type:'string',multiValued:false,canonicalValues:['User'],mutability:'immutable',returned:'default'},{name:'$ref',type:'reference',referenceTypes:['User'],multiValued:false,mutability:'readOnly',returned:'default'}]}]};
    const groupResource={schemas:resource.schemas,id:'Group',name:'Group',endpoint:'/Groups',schema:groupSchema.id};
    const documents=type==='Schemas'?[schema,groupSchema]:[resource,groupResource],document=id?documents.find(item=>item.id===id):documents[0];
    if(id){if(!document)fail(404,'Discovery resource not found.');return document;}
    return {schemas:[LIST_SCHEMA],totalResults:documents.length,startIndex:1,itemsPerPage:documents.length,Resources:documents};
  }
  constructor(access) {
    this.access = access; this.ops = access.ops; this.db = access.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS scim_users (
      id TEXT PRIMARY KEY REFERENCES platform_users(id), tenant TEXT NOT NULL,
      externalId TEXT, displayName TEXT, created TEXT NOT NULL, modified TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS scim_external_id ON scim_users(tenant,externalId) WHERE externalId IS NOT NULL AND deleted=0;`);
  }
  authorize(identity) {
    if (!['owner','admin'].includes(identity.role)) fail(403, 'Administrator access is required.');
    if (identity.policy && (!identity.policy.resources.includes('*') || ['development','staging','production'].some(environment=>!identity.policy.environments.includes(environment)))) fail(403, 'A full-workspace administrator credential is required.');
  }
  row(tenant, id) {
    const row = this.db.prepare('SELECT u.*,s.externalId,s.displayName,s.created,s.modified,s.version FROM platform_users u JOIN scim_users s ON s.id=u.id WHERE s.tenant=? AND s.id=? AND s.deleted=0').get(tenant,id);
    if (!row) fail(404, 'Provisioned user not found.');
    return row;
  }
  document(row) {
    return {schemas:[USER_SCHEMA],id:row.id,userName:row.actor,active:!row.disabled,
      ...(row.externalId ? {externalId:row.externalId} : {}), ...(row.displayName ? {displayName:row.displayName} : {}),
      roles:[{value:row.role}],meta:{resourceType:'User',created:row.created,lastModified:row.modified,location:`/scim/v2/Users/${row.id}`,version:`W/"${row.version}"`}};
  }
  get(identity,id) { this.authorize(identity); return this.document(this.row(identity.tenant,id)); }
  validate(input, replacing = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400,'Supply a User object.','invalidSyntax');
    if (input.schemas && (!Array.isArray(input.schemas) || !input.schemas.includes(USER_SCHEMA) || input.schemas.some(s=>s!==USER_SCHEMA))) fail(400,'Only the core User schema is supported.','invalidValue');
    for (const key of Object.keys(input)) if (![...fields,'schemas','id','meta'].includes(key)) fail(400,`Unsupported attribute: ${key}.`,'invalidValue');
    const result = {};
    if (replacing || input.userName !== undefined) {
      if (typeof input.userName !== 'string' || !/^[a-zA-Z0-9@._-]{2,128}$/.test(input.userName)) fail(400,'userName requires 2–128 ASCII letters, digits, @, dot, underscore or hyphen.','invalidValue');
      result.userName = input.userName.toLowerCase();
    }
    for (const key of ['externalId','displayName']) if (replacing || input[key] !== undefined) {
      if (input[key] != null && (typeof input[key] !== 'string' || input[key].length>256)) fail(400,`${key} must be a string of at most 256 characters.`,'invalidValue');
      result[key] = input[key] || null;
    }
    if (replacing || input.active !== undefined) {
      if (input.active !== undefined && typeof input.active !== 'boolean') fail(400,'active must be a Boolean.','invalidValue');
      result.active = input.active ?? true;
    }
    if (input.roles !== undefined && (!Array.isArray(input.roles) || input.roles.length!==1 || input.roles[0]?.value!=='reader')) fail(400,'Provisioning supports the reader role only. Administrators manage elevated roles separately.','invalidValue');
    return result;
  }
  unique(tenant,input,id='') {
    if (this.db.prepare('SELECT id FROM platform_users WHERE tenant=? AND lower(actor)=? AND id<>?').get(tenant,input.userName,id)) fail(409,'userName already exists.','uniqueness');
    if (input.externalId && this.db.prepare('SELECT id FROM scim_users WHERE tenant=? AND externalId=? AND id<>? AND deleted=0').get(tenant,input.externalId,id)) fail(409,'externalId already exists.','uniqueness');
  }
  async create(identity,input) {
    this.authorize(identity); const value=this.validate(input,true);
    // No initial password is supplied or disclosed to the provisioning client.
    const password=await this.access.password(randomBytes(48).toString('hex'));
    return this.ops.runtime.transaction(()=>{
      this.unique(identity.tenant,value); const id=randomUUID(),now=new Date().toISOString();
      this.db.prepare('INSERT INTO platform_users(id,tenant,actor,role,password,disabled) VALUES (?,?,?,?,?,?)').run(id,identity.tenant,value.userName,'reader',password,value.active?0:1);
      this.db.prepare('INSERT INTO scim_users(id,tenant,externalId,displayName,created,modified) VALUES (?,?,?,?,?,?)').run(id,identity.tenant,value.externalId,value.displayName,now,now);
      this.ops.audit(identity,'scim_user_created',id); return this.document(this.row(identity.tenant,id));
    });
  }
  list(identity,params) {
    this.authorize(identity);
    const integer=(key,defaultValue,min,max)=>{const raw=params.get(key);if(raw===null)return defaultValue;if(!/^\d+$/.test(raw))fail(400,`Invalid ${key}.`,'invalidValue');const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,`Invalid ${key}.`,'invalidValue');return value;};
    const startIndex=integer('startIndex',1,1,2147483647),count=integer('count',100,0,200);
    for(const key of params.keys())if(!['startIndex','count','filter','environment'].includes(key))fail(400,`Unsupported query parameter: ${key}.`,'invalidValue');
    let condition='s.tenant=? AND s.deleted=0';const values=[identity.tenant];
    if(params.has('filter')){
      const match=/^(userName|externalId|id|active)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)$/i.exec(params.get('filter'));
      if(!match)fail(400,'Supported filters are userName, externalId, id or active eq a single value.','invalidFilter');
      const key=match[1].toLowerCase();let value;try{value=JSON.parse(match[2]);}catch{fail(400,'Invalid filter value.','invalidFilter');}
      if(key==='active'){if(typeof value!=='boolean')fail(400,'active filter requires a Boolean.','invalidFilter');condition+=' AND u.disabled=?';values.push(value?0:1);}
      else {if(typeof value!=='string'||value.length>256)fail(400,'Filter requires a bounded string.','invalidFilter');condition+=` AND ${ {username:'lower(u.actor)',externalid:'s.externalId',id:'s.id'}[key]}=?`;values.push(key==='username'?value.toLowerCase():value);}
    }
    const totalResults=this.db.prepare(`SELECT count(*) AS n FROM platform_users u JOIN scim_users s ON s.id=u.id WHERE ${condition}`).get(...values).n;
    const rows=this.db.prepare(`SELECT u.*,s.externalId,s.displayName,s.created,s.modified,s.version FROM platform_users u JOIN scim_users s ON s.id=u.id WHERE ${condition} ORDER BY s.created,s.id LIMIT ? OFFSET ?`).all(...values,count,startIndex-1);
    return {schemas:[LIST_SCHEMA],totalResults,startIndex,itemsPerPage:rows.length,Resources:rows.map(row=>this.document(row))};
  }
  mutate(identity,id,input,{patch=false,ifMatch}={}) {
    this.authorize(identity);
    return this.ops.runtime.transaction(()=>{
      const row=this.row(identity.tenant,id);if(ifMatch && ifMatch!==`W/"${row.version}"` && ifMatch!=='*')fail(412,'User version changed. Read the current resource before retrying.');
      let value;
      if(patch){
        if(!Array.isArray(input.schemas)||input.schemas.length!==1||input.schemas[0]!==PATCH_SCHEMA||!Array.isArray(input.Operations)||!input.Operations.length||input.Operations.length>20)fail(400,'Supply PatchOp schemas and 1–20 Operations.','invalidSyntax');
        value={userName:row.actor,externalId:row.externalId,displayName:row.displayName,active:!row.disabled};
        for(const operation of input.Operations){
          const op=String(operation?.op).toLowerCase(),path=operation?.path;
          if(!['add','replace','remove'].includes(op))fail(400,'Unsupported patch operation.','invalidSyntax');
          if(path===undefined && op!=='remove'){Object.assign(value,this.validate(operation.value));continue;}
          const key=fields.find(f=>f.toLowerCase()===String(path).toLowerCase());if(!key)fail(400,'Unsupported patch path.','invalidPath');
          if(op==='remove'){if(!['externalId','displayName'].includes(key))fail(400,'Required attributes cannot be removed.','mutability');value[key]=null;}
          else Object.assign(value,this.validate({[key]:operation.value}));
        }
      } else value=this.validate(input,true);
      this.unique(identity.tenant,value,id);
      if(row.actor===identity.actor && (!value.active||value.userName!==row.actor))fail(409,'Provisioning cannot rename or deactivate its own administrator.');
      const revoke=row.actor!==value.userName || (!value.active&&!row.disabled);
      this.db.prepare('UPDATE platform_users SET actor=?,disabled=? WHERE tenant=? AND id=?').run(value.userName,value.active?0:1,identity.tenant,id);
      this.db.prepare('UPDATE scim_users SET externalId=?,displayName=?,modified=?,version=version+1 WHERE id=?').run(value.externalId,value.displayName,new Date().toISOString(),id);
      if(revoke)this.db.prepare('UPDATE platform_tokens SET revoked=1 WHERE tenant=? AND actor=?').run(identity.tenant,row.actor);
      this.ops.audit(identity,'scim_user_updated',id);return this.document(this.row(identity.tenant,id));
    });
  }
  remove(identity,id,ifMatch) {
    this.authorize(identity);return this.ops.runtime.transaction(()=>{
      const row=this.row(identity.tenant,id);if(ifMatch&&ifMatch!==`W/"${row.version}"`&&ifMatch!=='*')fail(412,'User version changed.');
      if(row.actor===identity.actor)fail(409,'Provisioning cannot remove its own administrator.');
      this.db.prepare('UPDATE platform_users SET disabled=1 WHERE tenant=? AND id=?').run(identity.tenant,id);
      this.db.prepare('UPDATE platform_tokens SET revoked=1 WHERE tenant=? AND actor=?').run(identity.tenant,row.actor);
      this.db.prepare('UPDATE scim_users SET deleted=1,version=version+1,modified=? WHERE id=?').run(new Date().toISOString(),id);
      this.ops.audit(identity,'scim_user_deleted',id);
    });
  }
}
