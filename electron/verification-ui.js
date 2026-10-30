const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
window.verification.onStatus((message) => { status.textContent = message; });
refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  try { await window.verification.refresh(); }
  catch (error) { status.textContent = error.message; }
  finally { setTimeout(() => { refresh.disabled = false; }, 500); }
});
document.querySelector('#pause').addEventListener('click', () => window.verification.pause().catch((error) => { status.textContent = error.message; }));
