// Capture and upload in main. The renderer supplies only a problem description.
export function createDiagnosticController({ session, buildReport, upload, clear, now = Date.now }) {
  let pending = null;
  let inFlight = null;
  return {
    async upload(note = '') {
      if (inFlight) return inFlight;
      const active = session();
      if (!active?.username || !active?.token) throw new Error('请先完成软件授权登录，再上传日志');
      const account = active.username;
      const text = String(note || '').slice(0, 4000);
      const operation = (async () => {
        if (!pending || pending.account !== account || pending.note !== text || now() - pending.at > 30 * 60000) {
          const report = await buildReport(text, account);
          if (session()?.username !== account) throw new Error('账号已切换，请重新上传日志');
          pending = { report, account, note: text, at: now() };
        }
        const result = await upload(pending.report, active.token);
        if (!/^LOG-[A-F0-9]{24}$/.test(result?.id || '')) throw new Error('服务器未返回有效反馈编号，请重试上传');
        pending = null;
        return { id: result.id, receivedAt: result.receivedAt };
      })();
      inFlight = operation;
      try { return await operation; } finally { if (inFlight === operation) inFlight = null; }
    },
    async clear() {
      if (inFlight) throw new Error('日志正在上传，请上传结束后再清理');
      pending = null;
      await clear(session()?.username || '');
      return { cleared: true };
    },
  };
}
