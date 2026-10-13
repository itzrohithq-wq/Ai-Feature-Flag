"""Dependency-free Python runtime client. Provider/tool execution stays app-owned."""
import json
import time
from urllib.request import Request, urlopen
from urllib.parse import quote, urlencode
from urllib.error import HTTPError

class RuntimeErrorResponse(Exception):
    def __init__(self, status, error):
        super().__init__(error.get('message', 'Runtime request failed'))
        self.status, self.code = status, error.get('code')

class RuntimeClient:
    def __init__(self, base_url, token, environment='development', timeout=10):
        self.base_url, self.token = base_url.rstrip('/'), token
        self.environment, self.timeout = environment, timeout

    def request(self, path, method='GET', body=None):
        url = self.base_url + '/api/runtime/' + path + '?' + urlencode({'environment': self.environment})
        headers = {'Authorization': 'Bearer ' + self.token}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body).encode()
        try:
            with urlopen(Request(url, data=data, headers=headers, method=method), timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            raise RuntimeErrorResponse(error.code, json.load(error).get('error', {})) from error

    def resolve(self, key, context, variables=None):
        return self.request('configs/' + quote(key, safe='') + '/resolve', 'POST', {'context': context, 'variables': variables or {}})

    def outcome(self, trace_id, metrics, **evaluation):
        return self.request('outcomes', 'POST', {'traceId': trace_id, 'metrics': metrics, **evaluation})

    def _attempt(self, resolved, input_text, executor, expected=None, llm_judge=None):
        started = time.monotonic()
        completion, error, judge_error = {}, None, None
        try:
            completion = executor(resolved['configuration'], input_text)
            if not isinstance(completion, dict) or not isinstance(completion.get('output'), str):
                raise ValueError('Executor must return output text')
        except Exception as cause:
            error = str(cause)
            completion = {}
        metrics = {'success': error is None, 'latencyMs': (time.monotonic() - started) * 1000}
        for name in ('inputTokens', 'outputTokens', 'costUsd', 'quality', 'reward', 'satisfaction', 'firstTokenMs'):
            if name in completion:
                metrics[name] = completion[name]
        event = {}
        judges = resolved.get('judges') or ([resolved['judge']] if resolved.get('judge') else [])
        if not error and resolved.get('sampled') and judges:
            try:
                judgments = {}
                for judge in judges:
                    if judge['type'] == 'llm':
                        if llm_judge is None:
                            raise ValueError('Provide llm_judge for attached LLM judges')
                        judgments[judge['key']] = llm_judge(judge, input_text, completion['output'], expected)
                event = {'input': input_text, 'output': completion['output'], 'expected': expected, 'judgements': judgments}
                if (resolved.get('judge') or {}).get('type') == 'llm':
                    event['judgement'] = judgments[resolved['judge']['key']]
            except Exception as cause:
                judge_error = str(cause)
                event = {}
        telemetry, telemetry_error = None, None
        try:
            telemetry = self.outcome(resolved['traceId'], metrics, **event)
            metrics = telemetry.get('metrics', metrics)
        except Exception as cause:
            telemetry_error = str(cause)
        return {'output': completion.get('output'), 'traceId': resolved['traceId'], 'metrics': metrics, 'telemetry': telemetry, 'error': error, 'judgeError': judge_error, 'telemetryError': telemetry_error}

    def execute(self, key, context, input_text, executor, variables=None, expected=None, llm_judge=None):
        resolved = self.resolve(key, context, variables)
        first = self._attempt(resolved, input_text, executor, expected, llm_judge)
        attempts = [first]
        retry = resolved.get('retry')
        if retry and not first['telemetryError'] and (first['error'] or first['metrics'].get('quality', 1) < retry['minQuality']):
            try:
                next_config = self.request('configs/' + quote(key, safe='') + '/retry', 'POST', {'traceId': first['traceId'], 'variables': variables or {}})
                attempts.append(self._attempt(next_config, input_text, executor, expected, llm_judge))
            except Exception as cause:
                first['retryError'] = str(cause)
        return {**attempts[-1], 'attempts': attempts}

    def execute_graph(self, key, context, input_text, executor, variables=None, select_edge=None):
        graph = self.request('graphs/' + quote(key, safe='') + '/resolve', 'POST', {'context': context, 'variables': variables or {}})
        node_id, current_input, visits = graph['root'], input_text, []
        for step in range(graph['maxSteps']):
            node = next(n for n in graph['nodes'] if n['id'] == node_id)
            resolved = node['resolved'] if step == 0 else self.request('graphs/' + quote(key, safe='') + '/visit', 'POST', {'graphTraceId': graph['traceId'], 'nodeId': node_id})
            result = self._attempt(resolved, current_input, executor)
            visits.append({'node': node_id, **result})
            edges = [e for e in graph['edges'] if e['from'] == node_id]
            if result['error'] or not edges:
                return {'status': 'failed' if result['error'] else 'succeeded', 'output': result['output'], 'visits': visits, 'traceId': graph['traceId']}
            destination = select_edge(node_id, edges, result['output'], visits) if select_edge else edges[0]['to']
            if destination is None:
                return {'status': 'succeeded', 'output': result['output'], 'visits': visits, 'traceId': graph['traceId']}
            if not any(e['to'] == destination for e in edges):
                raise ValueError('Selected handoff is not an edge in this graph')
            node_id, current_input = destination, result['output']
        return {'status': 'step_limit', 'output': visits[-1]['output'], 'visits': visits, 'traceId': graph['traceId']}

    def watch(self, key):
        url = self.base_url + '/api/runtime/configs/' + quote(key, safe='') + '/watch?' + urlencode({'environment': self.environment})
        request = Request(url, headers={'Authorization': 'Bearer ' + self.token})
        with urlopen(request, timeout=self.timeout) as response:
            for line in response:
                if line.startswith(b'data: '):
                    yield json.loads(line[6:])

    def cache_snapshot(self, trusted_public_key, tenant):
        import base64
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        snapshot = self.request('snapshot')
        load_pem_public_key(trusted_public_key.encode()).verify(base64.b64decode(snapshot['signature']), snapshot['payload'].encode())
        payload = json.loads(snapshot['payload'])
        if payload['tenant'] != tenant or payload['environment'] != self.environment or payload['expiresAt'] <= time.time() * 1000:
            raise ValueError('Snapshot scope or expiry is invalid')
        self._snapshot = payload
        return payload

    def resolve_with_fallback(self, key, context, variables=None):
        import copy
        import re
        try:
            return self.resolve(key, context, variables)
        except Exception as error:
            if isinstance(error, RuntimeErrorResponse) and error.status < 500:
                raise
            snapshot = getattr(self, '_snapshot', None)
            if not snapshot or snapshot['expiresAt'] <= time.time() * 1000:
                raise
            config = next((c for c in snapshot['configs'] if c['key'] == key), None)
            if not config or not isinstance(context.get('userId'), str) or not context['userId']:
                raise
            candidate = copy.deepcopy(next(v for v in config['variations'] if v['id'] == config['defaultVariation']))
            def customize(value):
                if isinstance(value, str):
                    def replace(match):
                        name = match.group(1)
                        if name not in (variables or {}):
                            raise ValueError('Missing cached prompt variable: ' + name)
                        return str(variables[name])
                    return re.sub(r'{{([a-zA-Z0-9_]+)}}', replace, value)
                if isinstance(value, list):
                    return [customize(item) for item in value]
                if isinstance(value, dict):
                    return {name: customize(item) for name, item in value.items()}
                return value
            return {'key': key, 'version': config['version'], 'variation': config['defaultVariation'], 'configuration': customize(candidate), 'mode': config['mode'], 'offline': True, 'reason': 'cached-safe-default', 'traceId': None, 'sampled': False, 'judges': [], 'expiresAt': snapshot['expiresAt']}

    def enqueue_evaluation(self, config, dataset, judge, allow_provider_calls=False):
        return self.request('jobs', 'POST', {'config': config, 'dataset': dataset, 'judge': judge, 'allowProviderCalls': allow_provider_calls})

    def job(self, job_id):
        return self.request('jobs/' + quote(job_id, safe=''))

    def ingest_spans(self, resource_spans):
        return self.request('traces', 'POST', {'resourceSpans': resource_spans})

