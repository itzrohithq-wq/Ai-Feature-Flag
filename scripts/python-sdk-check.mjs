import {spawn} from 'node:child_process';import {createApp} from '../src/server.js';import {Store} from '../src/store.js';
if(!process.env.PYTHON_EXECUTABLE)throw new Error('Set PYTHON_EXECUTABLE to your Python 3 interpreter.');
const store=new Store(),app=createApp({store,credentials:[{tenant:'fixture',actor:'tester',role:'owner',token:'python-test-token'}]});const runtime=app.operations.runtime;runtime.save('fixture','development','tester','judges',{key:'judge',type:'exact'},0);runtime.save('fixture','development','tester','configs',{key:'support',mode:'completion',enabled:true,defaultVariation:'baseline',judge:'judge',variations:[{id:'baseline',provider:'custom',model:'fixture',weight:100,messages:[{role:'system',content:'Help'}]}]},0);await new Promise(r=>app.listen(0,'127.0.0.1',r));
runtime.save('fixture','development','tester','configs',{key:'graph-agent',mode:'agent',enabled:true,defaultVariation:'base',variations:[{id:'base',provider:'custom',model:'fixture',weight:100,instructions:'Help'}]},0);runtime.save('fixture','development','tester','graphs',{key:'network',root:'entry',maxSteps:2,nodes:[{id:'entry',config:'graph-agent'}],edges:[]},0);runtime.save('fixture','development','tester','configs',{key:'retry-support',mode:'completion',enabled:true,defaultVariation:'base',retry:{variation:'backup',minQuality:.8},variations:[{id:'base',provider:'custom',model:'fail-first',weight:100,messages:[{role:'system',content:'Help'}]},{id:'backup',provider:'custom',model:'fixture',weight:0,messages:[{role:'system',content:'Help'}]}]},0);const publicKey=runtime.snapshot('fixture','development').publicKey;try{const script=`from sdk.python.control_studio import RuntimeClient, RuntimeErrorResponse
client=RuntimeClient('http://127.0.0.1:${app.address().port}', 'python-test-token')
result=client.execute('support', {'userId':'python-user'}, 'question', lambda config, text: {'output':'yes'}, expected='yes')
assert result['metrics']['quality'] == 1
assert client.outcome(result['traceId'], {'success':True})['duplicate']
try:
    RuntimeClient(client.base_url, 'bad-token').resolve('support', {'userId':'user'})
    raise AssertionError('Unauthorized token accepted')
except RuntimeErrorResponse as error:
    assert error.status == 401
def retry_executor(config, text):
    if config['model'] == 'fail-first':
        raise ValueError('Synthetic provider failure')
    return {'output':'recovered'}
retried=client.execute('retry-support', {'userId':'retry-user'}, 'question', retry_executor)
assert retried['output'] == 'recovered' and len(retried['attempts']) == 2
assert retried['attempts'][0]['metrics']['success'] is False
graph=client.execute_graph('network', {'userId':'graph-user'}, 'question', lambda config, text: {'output':'graph answer'})
assert graph['status'] == 'succeeded' and graph['output'] == 'graph answer'
snapshot=client.cache_snapshot(${JSON.stringify(publicKey)}, 'fixture')
assert snapshot['tenant'] == 'fixture'
original=client.request
def unavailable(*args, **kwargs):
    raise OSError('Synthetic outage')
client.request=unavailable
assert client.resolve_with_fallback('support', {'userId':'cache-user'})['offline']
def unauthorized(*args, **kwargs):
    raise RuntimeErrorResponse(401, {'message':'Denied'})
client.request=unauthorized
try:
    client.resolve_with_fallback('support', {'userId':'cache-user'})
    raise AssertionError('Cached data masked authorization')
except RuntimeErrorResponse:
    pass
client.request=original
print('Python SDK HTTP execution, evaluation, retries, graphs, signed cache and authorization passed.')`;
await new Promise((resolve,reject)=>{const child=spawn(process.env.PYTHON_EXECUTABLE,['-c',script],{stdio:'inherit',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Python SDK check exited ${code}`)));});}finally{await new Promise(r=>app.close(r));store.close();}
