export class FlagClient {
  constructor({ baseUrl, token, environment = 'development', timeoutMs = 2000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token; this.environment = environment; this.timeoutMs = timeoutMs;
  }
  async evaluate(key, context, fallbackValue = false) {
    try {
      const response = await fetch(`${this.baseUrl}/api/flags/${encodeURIComponent(key)}/evaluate?environment=${encodeURIComponent(this.environment)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(context), signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) throw new Error(`Flag API returned ${response.status}`);
      return await response.json();
    } catch { return { key, environment: this.environment, value: fallbackValue, reason: 'unavailable' }; }
  }
}
