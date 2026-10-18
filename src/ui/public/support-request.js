// The public support form (account-deletion.html) has one form per language; policy-lang.js sets
// the page's language, which picks these messages and is sent so the server answers in it too.
const MESSAGES = {
  en: { sending: 'Submitting…', failed: 'Unable to submit right now. Please try again later.', received: 'Request received and waiting for administrator verification. Please keep your request reference: ' },
  es: { sending: 'Enviando…', failed: 'No se ha podido enviar. Inténtalo de nuevo más tarde.', received: 'Solicitud recibida; queda pendiente de verificación por el administrador. Guarda la referencia de tu solicitud: ' },
  'zh-CN': { sending: '提交中…', failed: '暂时无法提交，请稍后再试', received: '请求已收到，等待管理员核验。请保留请求编号：' },
  'zh-TW': { sending: '提交中…', failed: '暫時無法提交，請稍後再試', received: '請求已收到，等待管理員核驗。請保留請求編號：' },
};
for (const form of document.querySelectorAll('.support-form')) form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  const locale = Object.hasOwn(MESSAGES, document.documentElement.lang) ? document.documentElement.lang : 'en';
  const text = MESSAGES[locale];
  const status = form.querySelector('.status');
  status.textContent = text.sending;
  const headers = {'content-type':'application/json', 'x-aio-locale':locale};
  const csrf = document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('pa_csrf='));
  if(csrf) headers['x-csrf-token']=decodeURIComponent(csrf.slice('pa_csrf='.length));
  let message = text.failed;
  try {
    const response = await fetch('/api/support/requests', {method:'POST', headers, body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { if (data.message) message = data.message; throw new Error(message); }
    status.textContent = text.received + data.id;
    form.reset();
  } catch { status.textContent = message; }
  finally { button.disabled = false; }
});
