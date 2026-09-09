/* Minimal UI wiring and OTP helpers.
   TODO: integrate PeerJS flows, signaling, STUN/TURN configs, proper encryption/hashing. */

document.addEventListener('DOMContentLoaded', ()=> {
  const views = {
    home: document.getElementById('view-home'),
    send: document.getElementById('view-send'),
    receive: document.getElementById('view-receive'),
    transfer: document.getElementById('view-transfer'),
  };

  const show = (v) => {
    Object.values(views).forEach(el=>{
      const is = el === v;
      el.classList.toggle('hidden', !is);
      el.setAttribute('aria-hidden', !is);
    });
    // move focus to the first focusable element in view
    const first = v.querySelector('button, [tabindex], input');
    if(first) first.focus();
  };

  // Buttons
  const btnSend = document.getElementById('btn-send-files');
  const btnReceive = document.getElementById('btn-receive-files');
  const hiddenFile = document.getElementById('hidden-file-input');

  btnSend.addEventListener('click', ()=> {
    hiddenFile.click();
  });

  hiddenFile.addEventListener('change', (e)=>{
    const files = Array.from(e.target.files || []);
    if(files.length) {
      // TODO: populate send queue UI and create a share code / start PeerJS host
      show(views.send);
      document.getElementById('display-code').textContent = 'GENERATING';

      // preview files
      const list = document.getElementById('send-queue-preview');
      list.innerHTML = '';
      files.forEach((f, i)=>{
        const li = document.createElement('div');
        li.className = 'queue-item';
        li.textContent = `${f.name} • ${Math.round(f.size/1024)} KB`;
        list.appendChild(li);
      });
    }
  });

  btnReceive.addEventListener('click', ()=> show(views.receive));

  // OTP interactions (auto-focus and paste)
  const otpInputs = Array.from(document.querySelectorAll('.otp-input'));
  otpInputs.forEach((input, idx)=>{
    input.addEventListener('input', (e)=>{
      input.value = input.value.replace(/[^0-9]/g,'').slice(0,1);
      if(input.value && otpInputs[idx+1]) otpInputs[idx+1].focus();
      updateConnectButton();
    });
    input.addEventListener('keydown', (e)=>{
      if(e.key === 'Backspace' && !input.value && otpInputs[idx-1]) {
        otpInputs[idx-1].focus();
      }
    });
    input.addEventListener('paste', (e)=>{
      e.preventDefault();
      const txt = (e.clipboardData || window.clipboardData).getData('text').trim();
      if(/^\d{6}$/.test(txt)){
        otpInputs.forEach((el,i)=> el.value = txt[i]);
        updateConnectButton();
      }
    });
  });

  function getOTP(){ return otpInputs.map(i=>i.value||'').join(''); }
  function updateConnectButton(){
    const btn = document.getElementById('btn-connect');
    btn.disabled = getOTP().length !== 6;
  }

  // Basic copy link
  const btnCopy = document.getElementById('btn-copy-link');
  btnCopy && btnCopy.addEventListener('click', async ()=>{
    try{
      await navigator.clipboard.writeText(location.href);
      showToast('Link copied to clipboard');
    }catch(err){
      showToast('Copy failed');
    }
  });

  // Toast helper
  const toastEl = document.getElementById('toast');
  let toastTimer;
  function showToast(msg, ms=2500){
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{ toastEl.style.opacity = '0'; }, ms);
  }

  // Service worker registration (optional)
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{
      // registration failed silently
    });
  }

  // Generate QR code when display-code changes (if QR lib is loaded)
  const codeEl = document.getElementById('display-code');
  const qrTarget = document.getElementById('qrcode');
  const obs = new MutationObserver(()=>{
    if(typeof QRCode !== 'undefined' && qrTarget){
      qrTarget.innerHTML = '';
      try{ new QRCode(qrTarget, { text: location.href + '#code=' + codeEl.textContent, width:160, height:160 }); }catch(e){}
    }
  });
  obs.observe(codeEl, { childList:true, characterData:true, subtree:true });

  // Placeholder for PeerJS integration (TODO)
  // const peer = new Peer(...);

  // Expose show for debugging
  window._sendly = { show, views, showToast };
});
