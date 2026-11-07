export function installBulkLicenseEditor({ api, refresh, message }) {
  const $ = id => document.getElementById(id);
  let plan = null, busy = false;
  const names = { extend: '延长授权', reduce: '减少授权天数', pause: '停用授权' };
  const clear = () => { plan = null; $('bulkLicensePreview').hidden = true; $('bulkLicenseConfirm').disabled = true; };
  const update = () => {
    clear();
    $('bulkLicenseDaysField').hidden = $('bulkLicenseAction').value === 'pause';
    $('bulkLicenseDays').disabled = $('bulkLicenseAction').value === 'pause';
  };
  $('bulkLicenseAction').onchange = update;
  $('bulkLicenseDays').oninput = clear;
  $('bulkLicenseForm').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    busy = true; clear(); $('bulkLicensePreviewButton').disabled = true;
    $('bulkLicenseAction').disabled = true; $('bulkLicenseDays').disabled = true;
    try {
      plan = await api('/api/admin/licenses/bulk-preview', { method: 'POST', body: JSON.stringify({ action: $('bulkLicenseAction').value, days: Number($('bulkLicenseDays').value) }) });
      $('bulkLicensePreview').textContent = `将为所有 ${plan.count} 个正常有效授权账号${names[plan.action]}${plan.action === 'pause' ? '' : ` ${plan.days} 天`}。${plan.willExpire ? `其中 ${plan.willExpire} 个账号调整后将立即到期。` : ''}过期、停用、注销、删除的账号不受影响。`;
      $('bulkLicensePreview').hidden = false; $('bulkLicenseConfirm').disabled = !plan.count;
    } catch (error) { message(error.message); }
    finally {
      busy = false; $('bulkLicensePreviewButton').disabled = false;
      $('bulkLicenseAction').disabled = false; $('bulkLicenseDays').disabled = $('bulkLicenseAction').value === 'pause';
    }
  };
  $('bulkLicenseConfirm').onclick = async () => {
    if (busy || !plan) return;
    busy = true; $('bulkLicenseConfirm').disabled = true;
    $('bulkLicenseAction').disabled = true; $('bulkLicenseDays').disabled = true;
    try {
      const result = await api('/api/admin/licenses/bulk', { method: 'POST', body: JSON.stringify({ token: plan.token }) });
      clear(); await refresh(); message(`批量操作完成：实际${names[result.action]} ${result.changed} 个账号。`, true);
    } catch (error) { message(error.message); $('bulkLicenseConfirm').disabled = false; }
    finally { busy = false; $('bulkLicenseAction').disabled = false; $('bulkLicenseDays').disabled = $('bulkLicenseAction').value === 'pause'; }
  };
  update();
}
