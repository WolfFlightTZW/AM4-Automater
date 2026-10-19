// Existing Steam CefSharp session only. No new browser, login, cookies, or navigation URL.
export class Cdp {
  constructor(socket, timeoutMs, { operator = null, offline = false } = {}) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.sequence = 0; this.pending = new Map();this.operator=operator;this.offline=offline;
    socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      const entry = this.pending.get(message.id); if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(message.id);
      if (message.error) entry.reject(new Error('CDP_COMMAND_ERROR'));
      else entry.resolve(message.result);
    });
    for (const type of ['close', 'error']) socket.addEventListener(type, () => this.cancel('CDP_DISCONNECTED'));
  }
  static async connect(timeoutMs = 10000, operator) {
    if(!operator)throw new Error('OPERATOR_SESSION_REQUIRED');
    operator.assertCanCommit();
    const response = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error('CDP_DISCOVERY_FAILED');
    const pages = (await response.json()).filter(p => p.type === 'page' && p.title === 'AM4');
    if (pages.length !== 1) throw new Error('AM4_PAGE_MISSING_OR_AMBIGUOUS');
    const address = new URL(pages[0].webSocketDebuggerUrl);
    if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || address.port !== '9222' || address.username || address.password)
      throw new Error('NONLOCAL_CDP_REJECTED');
    const socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP_CONNECT_TIMEOUT')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')); }, { once: true });
    });
    const cdp=new Cdp(socket,timeoutMs,{operator});
    const sent=Date.now();
    try{
      const clock=await cdp.evaluate('(()=>JSON.stringify({now:Date.now()}))()','Browser clock inspection');
      operator.browserClockOffset=clock.now-(sent+Date.now())/2;
      return cdp;
    }catch(error){cdp.close();throw error;}
  }
  command(method, params) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP_DISCONNECTED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP_COMMAND_TIMEOUT')); this.close(); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('CDP_SEND_FAILED')); }
    });
  }
  async evaluate(expression,label='Inspect AM4') {
    if(!this.operator&&!this.offline)throw new Error('OPERATOR_SESSION_REQUIRED');
    const lease=this.operator?.step(label,expression,{irreversible:/DOM\.commit|source\.purchase|source\.departJs/.test(label)});
    let returned=false;
    try{
      const result = await this.command('Runtime.evaluate', { expression:lease?.expression||expression, returnByValue: true, awaitPromise: true });
      returned=true;
      if (result.exceptionDetails) {
        const error=new Error('AM4_JAVASCRIPT_EXCEPTION');
        error.rendererDescription=String(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'').split('\n')[0].replace(/(?:https?|wss?):\/\/\S+/g,'[REDACTED]').slice(0,350);
        throw error;
      }
      if (!result.result || result.result.value === undefined) throw new Error('CDP_EMPTY_VALUE');
      const value=typeof result.result.value === 'string' ? JSON.parse(result.result.value) : result.result.value;
      if(lease)this.operator.endStep({implicit:lease.implicit});return value;
    }catch(error){if(lease)try{this.operator.endStep({implicit:lease.implicit,outcome:returned?'RETURNED':'UNKNOWN'});}catch{}throw error;}
  }
  cancel(reason) { for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(reason)); } this.pending.clear(); }
  close() { this.cancel('CDP_CLOSED'); this.socket.close(); }
}
