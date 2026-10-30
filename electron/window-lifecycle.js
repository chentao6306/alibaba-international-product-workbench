const requestGates = new WeakMap();

export const isWindowAlive = window => Boolean(window && !window.isDestroyed()
  && window.webContents && !window.webContents.isDestroyed());

// webRequest belongs to the Session, which outlives its BrowserWindow. Never
// dereference a window inside this callback: requests can finish after close.
export function installWorkbenchRequestGate(window, { port, gate }) {
  const contents = window.webContents;
  const senderId = contents.id;
  const session = contents.session;
  let registrations = requestGates.get(session);
  if (!registrations) { registrations = new Map(); requestGates.set(session, registrations); }
  const registration = { port, gate };
  registrations.set(senderId, registration);
  session.webRequest.onBeforeSendHeaders({ urls: [...new Set([...registrations.values()]
    .map(item => `http://127.0.0.1:${item.port}/api/*`))] }, (details, callback) => {
    const current = registrations.get(details.webContentsId);
    if (current && details.url.startsWith(`http://127.0.0.1:${current.port}/api/`)) {
      details.requestHeaders['X-Kua-Yipu-Gate'] = current.gate;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  const remove = () => {
    if (registrations.get(senderId) === registration) registrations.delete(senderId);
  };
  contents.once('destroyed', remove);
  window.once('closed', remove);
}

export function showWindowWhenReady(window) {
  window.once('ready-to-show', () => { if (isWindowAlive(window)) window.show(); });
}
