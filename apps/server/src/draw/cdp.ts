/**
 * Minimal dependency-free CDP client (Bun WebSocket). Loopback only; it never reads cookies,
 * tokens or request headers, and only ever drives tabs it opened itself.
 */
export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface CdpMessage {
  id?: number;
  error?: { message: string };
  result?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** No single CDP round trip (incl. an awaited in-page fetch) may hang the owner lock. */
export const CDP_CALL_TIMEOUT_MS = 30_000;

export async function cdpReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (message) => {
      const msg = JSON.parse(String(message.data)) as CdpMessage;
      if (msg.id === undefined) return;
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error.message));
      else waiting.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error('cdp: socket closed'));
      this.pending.clear();
    };
  }

  /** The endpoint is built here from a port number, never taken from caller-supplied URLs. */
  static async connect(port: number): Promise<Cdp> {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    const version = (await res.json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    const opened = Promise.withResolvers<void>();
    ws.onopen = () => opened.resolve();
    ws.onerror = () => opened.reject(new Error('cdp: websocket error'));
    await opened.promise;
    return new Cdp(ws);
  }

  /** CDP replies are trusted protocol JSON; the caller asserts the result shape. */
  send<T = Record<string, never>>(method: string, params: object = {}, sessionId?: string) {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`cdp: ${method} timed out after ${CDP_CALL_TIMEOUT_MS} ms`));
    }, CDP_CALL_TIMEOUT_MS);
    this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return promise as Promise<T>;
  }

  close() {
    this.ws.close();
  }

  /** Open a NEW tab owned by us and attach; pre-existing tabs are never touched. */
  async openPage(url: string): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    return new Page(this, sessionId, targetId);
  }
}

export class Page {
  constructor(
    private readonly cdp: Cdp,
    private readonly sessionId: string,
    private readonly targetId: string,
  ) {}

  send<T = Record<string, never>>(method: string, params: object = {}) {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  /** Evaluate in the page; the caller asserts the JSON-serialisable result type. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(
        `eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result.value as T;
  }

  async navigate(url: string) {
    await this.send('Page.navigate', { url });
  }

  async screenshot(path: string) {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    await Bun.write(path, Buffer.from(r.data, 'base64'));
  }

  /** DOM.setFileInputFiles on the nth node matching selector; Chrome fires input+change, no OS dialog. */
  async setFiles(selector: string, files: readonly string[], index = 0) {
    const { root } = await this.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await this.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector,
    });
    const nodeId = nodeIds[index];
    if (!nodeId) throw new Error(`setFiles: no node #${index} for ${selector}`);
    await this.send('DOM.setFileInputFiles', { nodeId, files });
  }

  /** Text insertion at the focused element (equivalent to a paste). */
  async insertText(text: string) {
    await this.send('Input.insertText', { text });
  }

  async close() {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
  }
}
