let activeDialog = null;

// Keep confirmation inside the renderer: native JS dialogs can leave Windows
// Electron text inputs without keyboard focus after the dialog is dismissed.
export function confirmAction(message) {
  if (activeDialog) { activeDialog.focus(); return Promise.resolve(false); }
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    activeDialog = dialog;
    dialog.className = 'action-confirm';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'action-confirm-title');
    dialog.setAttribute('aria-describedby', 'action-confirm-message');
    const title = document.createElement('h2');
    title.id = 'action-confirm-title'; title.textContent = '请确认操作';
    const content = document.createElement('p');
    content.id = 'action-confirm-message'; content.textContent = message;
    const actions = document.createElement('div'); actions.className = 'dialog-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.textContent = '取消'; cancel.autofocus = true;
    const accept = document.createElement('button');
    accept.type = 'button'; accept.className = 'primary-button'; accept.textContent = '确认';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; activeDialog = null;
      dialog.close(); dialog.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    accept.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', () => finish(false));
    actions.append(cancel, accept); dialog.append(title, content, actions);
    document.body.append(dialog);
    dialog.showModal(); cancel.focus();
  });
}
