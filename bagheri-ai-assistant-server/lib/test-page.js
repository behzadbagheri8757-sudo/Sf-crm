'use strict';
/* Optional same-origin test page (served only when ENABLE_TEST_PAGE=true) so the assistant can be
   tried from a phone without touching the CRM. No external assets; replies are rendered with
   textContent only (model output is never interpreted as HTML or code). */

const HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>تست دستیار باقری</title>
<style>
  :root{color-scheme:light dark;--bg:#f5f7fa;--card:#fff;--text:#1b2230;--muted:#6b7482;--line:#e3e7ee;--pri:#0070d2;--me:#e8f2fd}
  @media (prefers-color-scheme:dark){:root{--bg:#0a0b0e;--card:#181a1f;--text:#eef1f6;--muted:#9aa3b2;--line:#2a2d34;--pri:#4aa3ff;--me:#16283d}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 -apple-system,system-ui,"Vazirmatn",sans-serif;padding:max(16px,env(safe-area-inset-top)) 16px 24px}
  h1{font-size:1.1rem;margin:0 0 4px}
  .note{color:var(--muted);font-size:.8rem;margin:0 0 14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
  label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:6px}
  input[type=password],textarea{width:100%;border:1px solid var(--line);border-radius:12px;padding:12px;font:inherit;background:transparent;color:inherit}
  textarea{min-height:88px;resize:vertical}
  button{min-height:48px;border:0;border-radius:12px;background:var(--pri);color:#fff;font:inherit;font-weight:600;padding:0 18px;width:100%;margin-top:10px}
  button[disabled]{opacity:.5}
  .row{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:.8rem;color:var(--muted)}
  .msg{border-radius:12px;padding:10px 12px;margin:8px 0;white-space:pre-wrap;word-break:break-word}
  .msg.me{background:var(--me)} .msg.bot{border:1px solid var(--line)} .msg.err{border:1px solid #c0392b;color:#c0392b}
</style>
</head>
<body>
<h1>تست دستیار فروش باقری</h1>
<p class="note">این نسخه به داده‌های CRM وصل نیست و فقط گفت‌وگوی خواندنی است.</p>
<div class="card">
  <label for="token">توکن دسترسی (ASSISTANT_ACCESS_TOKEN)</label>
  <input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
  <div class="row"><input id="remember" type="checkbox"><span>ذخیرهٔ توکن روی همین دستگاه</span></div>
</div>
<div id="log"></div>
<div class="card">
  <label for="msg">پیام</label>
  <textarea id="msg" maxlength="2000" placeholder="مثلاً: برای ویزیت یک سوپرمارکت که می‌گوید «موجودی دارم» چه بگویم؟"></textarea>
  <button id="send" type="button">ارسال</button>
</div>
<script src="/test.js"></script>
</body>
</html>`;

const JS = `(function(){
  'use strict';
  var tokenEl=document.getElementById('token'), rememberEl=document.getElementById('remember');
  var msgEl=document.getElementById('msg'), sendEl=document.getElementById('send'), logEl=document.getElementById('log');
  var history=[];
  try{var saved=localStorage.getItem('bagheri_ai_token'); if(saved){tokenEl.value=saved; rememberEl.checked=true;}}catch(e){}
  function add(cls,text){var d=document.createElement('div'); d.className='msg '+cls; d.textContent=text; logEl.appendChild(d); d.scrollIntoView({block:'nearest'});}
  async function send(){
    var text=msgEl.value.trim(); if(!text) return;
    var token=tokenEl.value.trim();
    try{ if(rememberEl.checked) localStorage.setItem('bagheri_ai_token',token); else localStorage.removeItem('bagheri_ai_token'); }catch(e){}
    add('me',text); msgEl.value=''; sendEl.disabled=true;
    try{
      var res=await fetch('/api/assistant/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({message:text,history:history.slice(-10)})});
      var data=null; try{data=await res.json();}catch(e){}
      if(res.ok&&data&&data.ok){ add('bot',data.reply); history.push({role:'user',content:text},{role:'assistant',content:data.reply}); history=history.slice(-10); }
      else{ add('err',(data&&data.error&&data.error.message)||('خطا ('+res.status+')')); }
    }catch(e){ add('err','ارتباط با سرور برقرار نشد.'); }
    sendEl.disabled=false;
  }
  sendEl.addEventListener('click',send);
})();`;

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

module.exports = { HTML, JS, PAGE_CSP };
