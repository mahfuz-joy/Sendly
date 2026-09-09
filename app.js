/* Minimal UI wiring + a tiny PeerJS send/receive flow.
   - Creates a short 6-digit code for display (for UX)
   - Embeds Peer id in the share URL so the receiver can connect
   - Sends files in 64KB slices with basic backpressure
   - Reconstructs and downloads file on receiver side

   IMPORTANT: This is a demo. In production, use a proper signaling server
   (or map short-codes to peer ids on a server) and add encryption/auth.
*/

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
    const first = v.querySelector('button, [tabindex], input');
    if(first) first.focus();
  };

  // Buttons & inputs
  const btnSend = document.getElementById('btn-send-files');
  const btnReceive = document.getElementById('btn-receive-files');
  const hiddenFile = document.getElementById('hidden-file-input');
  const codeEl = document.getElementById('display-code');
  const qrTarget = document.getElementById('qrcode');
  const sendQueuePreview = document.getElementById('send-queue-preview');

  btnSend.addEventListener('click', ()=> hiddenFile.click());
  btnReceive.addEventListener('click', ()=> show(views.receive));

  let currentPeer = null;
  let currentConn = null;
  let currentFiles = [];

  // Helper: generate 6-digit code (for UI only)
  function makeCode(){
    return Math.floor(100000 + Math.random()*900000).toString();
  }

  // Show toast
  const toastEl = document.getElementById('toast');
  let toastTimer;
  function showToast(msg, ms=2500){
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{ toastEl.style.opacity = '0'; }, ms);
  }

  // Draw QR when code/URL changes
  function updateQR(text){
    if(typeof QRCode === 'undefined' || !qrTarget) return;
    try{
      qrTarget.innerHTML = '';
      new QRCode(qrTarget, { text, width:160, height:160 });
    }catch(e){ /* ignore */ }
  }

  // Preview files in UI
  function previewFiles(files){
    sendQueuePreview.innerHTML = '';
    files.forEach((f,i)=>{
      const li = document.createElement('div');
      li.className = 'queue-item';
      li.textContent = `${f.name} • ${Math.round(f.size/1024)} KB`;
      sendQueuePreview.appendChild(li);
    });
  }

  // ----------- SENDER FLOW -----------
  hiddenFile.addEventListener('change', async (e)=>{
    const files = Array.from(e.target.files || []);
    if(!files.length) return;
    currentFiles = files;
    previewFiles(files);
    show(views.send);
    codeEl.textContent = 'GENERATING';

    // create Peer
    const shortCode = makeCode();
    // create a Peer (no explicit id so server assigns one)
    const peer = new Peer(undefined, {
      // Optionally, configure PeerServer here if needed:
      // host: 'your-peer-server.example.com', port: 9000, path: '/myapp'
    });
    currentPeer = peer;

    peer.on('open', (id)=>{
      // embed both code and peer id in link so receiver can connect
      codeEl.textContent = shortCode;
      const shareUrl = location.origin + location.pathname + '#code=' + shortCode + '&peer=' + encodeURIComponent(id);
      // update QR with shareUrl
      updateQR(shareUrl);

      // update "Copy link" button to copy the shareUrl
      const btnCopy = document.getElementById('btn-copy-link');
      if(btnCopy){
        btnCopy.onclick = async () => {
          try{
            await navigator.clipboard.writeText(shareUrl);
            showToast('Link copied to clipboard');
          }catch(err){
            showToast('Copy failed');
          }
        };
      }

      // handle incoming connection from receiver
      peer.on('connection', conn => {
        currentConn = conn;
        showToast('Receiver connected');
        handleOutgoingConnection(conn, files);
      });
    });

    peer.on('error', (err)=>{
      console.error('Peer error', err);
      showToast('Peer error: ' + (err && err.type) || 'unknown');
      codeEl.textContent = 'ERROR';
    });

    // When user cancels transfer
    const cancelBtn = document.getElementById('btn-cancel-send');
    if(cancelBtn) cancelBtn.onclick = () => {
      if(currentConn) currentConn.close();
      if(currentPeer) currentPeer.destroy();
      currentPeer = null;
      currentConn = null;
      show(views.home);
    };
  });

  // Send files over connection with simple protocol: first send metadata, then chunks
  async function handleOutgoingConnection(conn, files){
    conn.on('data', d => {
      // simple control messages from receiver (optional)
      // e.g., { type: 'readyFor', fileIndex: 0 }
      console.log('sender got remote data', d);
    });

    conn.on('close', ()=> {
      showToast('Connection closed');
    });

    conn.on('error', err => {
      console.error('Connection error', err);
      showToast('Connection error');
    });

    // When connection opens, send metadata
    conn.on('open', async () => {
      // send file list metadata
      const meta = files.map(f => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }));
      conn.send({ type: 'file-list', files: meta });

      // send files one by one
      for(let i=0;i<files.length;i++){
        const file = files[i];
        // send per-file header
        conn.send({ type: 'file-start', index: i, name: file.name, size: file.size });
        await sendFileInSlices(conn, file, (sent, total) => {
          // update progress UI
          const percent = Math.round((sent/total)*100);
          document.getElementById('transfer-status').textContent = `Sending ${file.name}`;
          document.getElementById('transfer-percentage').textContent = percent + '%';
          document.getElementById('progress-bar-fill').style.width = percent + '%';
        });
        conn.send({ type: 'file-end', index: i });
      }
      conn.send({ type: 'all-done' });
      showToast('All files sent');
      // show completion UI
      document.getElementById('completion-box').classList.remove('hidden');
      document.getElementById('completion-actions').classList.remove('hidden');
    });
  }

  // Slice & send with backpressure awareness
  async function sendFileInSlices(conn, file, onprogress){
    const chunkSize = 64 * 1024; // 64KB
    let offset = 0;
    while(offset < file.size){
      const slice = file.slice(offset, offset + chunkSize);
      const arrayBuffer = await slice.arrayBuffer();
      // send binary chunk (wrapped with a small header object to identify binary)
      // PeerJS will send ArrayBuffer directly; to mix signal messages we send raw ArrayBuffer and rely on control msgs for framing
      conn.send(arrayBuffer);
      offset += arrayBuffer.byteLength;

      if(onprogress) onprogress(offset, file.size);

      // basic backpressure: wait while bufferedAmount is large
      await waitForBufferedAmountLow(conn);
    }
  }

  // Wait until conn.bufferedAmount is below a threshold
  function waitForBufferedAmountLow(conn, threshold = 2 * 1024 * 1024){ // 2MB
    return new Promise(resolve => {
      const check = () => {
        try {
          if(!conn || conn.open === false) return resolve();
          const buffered = conn.peerConnection ?
            // in some PeerJS versions bufferedAmount exposed on DataConnection
            (conn._dc && conn._dc.bufferedAmount || 0) :
            (conn.bufferedAmount || 0);
          if(buffered <= threshold) return resolve();
          // otherwise poll until less
          setTimeout(check, 150);
        } catch (e) {
          // fallback resolve
          resolve();
        }
      };
      check();
    });
  }

  // ----------- RECEIVER FLOW -----------
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
      } else {
        // allow pasting full share link that contains peer id
        // try to extract peer param
        try {
          const u = new URL(txt);
          const peer = u.searchParams.get('peer') || (() => {
            const h = u.hash || '';
            const m = h.match(/peer=([^&]+)/);
            return m && decodeURIComponent(m[1]);
          })();
          if(peer){
            // connect immediately using peer id
            connectToPeerReceiver(peer);
          }
        } catch (err){}
      }
    });
  });

  function getOTP(){ return otpInputs.map(i=>i.value||'').join(''); }
  function updateConnectButton(){
    const btn = document.getElementById('btn-connect');
    btn.disabled = getOTP().length !== 6;
  }

  // Manual connect button (if the user entered a code). Note: by itself the 6-digit code can't be resolved to a peer id unless the link/QR contains peer id
  document.getElementById('btn-connect').addEventListener('click', ()=>{
    // try to parse peer id from URL hash (in case they scanned a full link)
    // fallback: ask the user to paste the full share link (we can't resolve just 6-digit code without a mapping server)
    showToast('Please paste the shared link (recommended) or scan the QR — 6-digit code alone will not work here without a discovery server.');
  });

  // If the current page was opened with #peer=..., auto connect (scan via QR, share link)
  (function tryAutoConnectFromHash(){
    const h = location.hash || '';
    if(!h) return;
    const m = h.match(/peer=([^&]+)/);
    if(m && m[1]){
      const peerId = decodeURIComponent(m[1]);
      // if code param exists too you can display it
      const codeMatch = h.match(/code=([^&]+)/);
      if(codeMatch) codeEl.textContent = codeMatch[1];
      updateQR(location.href);
      // connect as receiver
      connectToPeerReceiver(peerId);
    }
  })();

  // Receiver: create a Peer and connect to senderPeerId
  function connectToPeerReceiver(senderPeerId){
    show(views.transfer);
    document.getElementById('transfer-status').textContent = 'Connecting…';
    const peer = new Peer();
    peer.on('open', id => {
      showToast('Connecting to sender...');
      const conn = peer.connect(senderPeerId, { reliable: true });
      conn.on('open', () => {
        document.getElementById('transfer-status').textContent = 'Connected — waiting for file list';
      });

      const receivedFiles = [];
      let currentFileBuffers = [];
      let expectedFileMeta = null;
      let receivedBytesForCurrent = 0;

      conn.on('data', data => {
        // data may be control objects or ArrayBuffer chunks
        if(data && typeof data === 'object' && ! (data instanceof ArrayBuffer) ){
          if(data.type === 'file-list'){
            // show file list to user (you could prompt to accept)
            // For now, auto-accept
            document.getElementById('transfer-status').textContent = `Incoming ${data.files.length} file(s)`;
          } else if(data.type === 'file-start'){
            expectedFileMeta = { index: data.index, name: data.name, size: data.size };
            currentFileBuffers = [];
            receivedBytesForCurrent = 0;
            // update UI
            document.getElementById('meta-filename').textContent = data.name;
            document.getElementById('meta-filesize').textContent = Math.round(data.size/1024) + ' KB';
            document.getElementById('transfer-status').textContent = 'Receiving ' + data.name;
          } else if(data.type === 'file-end'){
            // finalize file
            const blob = new Blob(currentFileBuffers, { type: 'application/octet-stream' });
            downloadBlob(blob, expectedFileMeta.name);
            expectedFileMeta = null;
            currentFileBuffers = [];
            showToast('File received');
          } else if(data.type === 'all-done'){
            document.getElementById('completion-box').classList.remove('hidden');
            document.getElementById('completion-actions').classList.remove('hidden');
            document.getElementById('transfer-status').textContent = 'All done';
          }
        } else if(data instanceof ArrayBuffer){
          // binary chunk — append
          currentFileBuffers.push(new Blob([data]));
          receivedBytesForCurrent += data.byteLength;
          // update progress
          if(expectedFileMeta){
            const percent = Math.round((receivedBytesForCurrent / expectedFileMeta.size) * 100);
            document.getElementById('transfer-percentage').textContent = percent + '%';
            document.getElementById('progress-bar-fill').style.width = percent + '%';
            document.getElementById('transfer-speed').textContent = ''; // could calculate speed
          }
        } else {
          // unknown payload
          console.log('receiver got:', data);
        }
      });

      conn.on('close', ()=> {
        showToast('Sender disconnected');
      });

      conn.on('error', err => {
        console.error('Receiver connection error', err);
        showToast('Connection error');
      });
    });

    peer.on('error', err => {
      console.error('Receiver peer error', err);
      showToast('Peer error');
    });

    // Set cancel button for receiver
    const cancelBtn = document.getElementById('btn-cancel-receive');
    if(cancelBtn) cancelBtn.onclick = () => {
      if(peer) peer.destroy();
      show(views.home);
    };
  }

  // simple download helper
  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 60000);
  }

  // Basic copy link handler default (in case no peer link created)
  const btnCopy = document.getElementById('btn-copy-link');
  if(btnCopy) btnCopy.addEventListener('click', async ()=>{
    try{
      await navigator.clipboard.writeText(location.href);
      showToast('Link copied to clipboard');
    }catch(err){
      showToast('Copy failed');
    }
  });

  // Service worker registration (optional)
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }

  // expose debug helpers
  window._sendly = { show, views, showToast, connectToPeerReceiver };
});
