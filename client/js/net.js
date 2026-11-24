// WebSocket client with automatic reconnection and resumable session token.
// The server keeps the player slot; on reconnect we re-JOIN with our token and
// receive a fresh GAME_INIT of the identical authoritative world.

export class Net {
  constructor(handlers) {
    this.h = handlers; // { onMessage, onOpen, onClose }
    this.ws = null;
    this.closedByUs = false;
    this.backoff = 400;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.closedByUs = false;
    this.ws = new WebSocket(`${proto}//${location.host}`);
    this.ws.onopen = () => { this.backoff = 400; this.h.onOpen?.(); };
    this.ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      this.h.onMessage(data);
    };
    this.ws.onclose = () => { if (!this.closedByUs) this.h.onClose?.(); };
    this.ws.onerror = () => {};
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}
