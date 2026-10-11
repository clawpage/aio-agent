const form = document.querySelector('#support-form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  const status = document.querySelector('#status');
  status.textContent = '提交中 / Submitting…';
  const headers = {'content-type':'application/json'};
  const csrf = document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('pa_csrf='));
  if(csrf) headers['x-csrf-token']=decodeURIComponent(csrf.slice('pa_csrf='.length));
  try {
    const response = await fetch('/api/support/requests', {method:'POST', headers, body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '暂时无法提交，请稍后再试 / Unable to submit, please try later');
    status.textContent = '请求已收到，等待管理员核验。请保留请求编号 / Received for administrator verification. Reference: '+data.id;
    form.reset();
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});