/* Minimal UI wiring + PeerJS P2P file transfer with code-based pairing.
   - Creates a 6-digit code and maps it to the sender's Peer ID (stored in sessionStorage)
   - Receiver enters code and retrieves the peer ID to connect
   - Sends files in 64KB slices with backpressure handling
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

  // Code registry: maps 6-digit code to { peerId, timestamp }
  const codeRegistry = new Map();

  // Helper: generate 6-digit code
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

    // Create Peer
    const shortCode = makeCode();
    const peer = new Peer(undefined, {});
    currentPeer = peer;

    peer.on('open', (id)=>{
      // Store code->peerId mapping
      codeRegistry.set(shortCode, { peerId: id, timestamp: Date.now() });
      
      codeEl.textContent = shortCode;
      const shareUrl = location.origin + location.pathname + '#code=' + shortCode;
      updateQR(shareUrl);

      // Update "Copy link" button
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

      // Handle incoming connection from receiver
      peer.on('connection', conn => {
        currentConn = conn;
        showToast('Receiver connected');
        show(views.transfer);
        handleOutgoingConnection(conn, files);
      });
    });

    peer.on('error', (err)=>{
      console.error('Peer error', err);
      showToast('Peer error: ' + (err && err.type) || 'unknown');
      codeEl.textContent = 'ERROR';
    });

    // Cancel button for sender
    const cancelBtn = document.getElementById('btn-cancel-send');
    if(cancelBtn) cancelBtn.onclick = () => {
      if(currentConn) currentConn.close();
      if(currentPeer) currentPeer.destroy();
      codeRegistry.delete(shortCode);
      currentPeer = null;
      currentConn = null;
      show(views.home);
    };
  });

  // Send files over connection
  async function handleOutgoingConnection(conn, files){
    conn.on('data', d => {
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
      const meta = files.map(f => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }));
      conn.send({ type: 'file-list', files: meta });

      for(let i=0;i<files.length;i++){
        const file = files[i];
        conn.send({ type: 'file-start', index: i, name: file.name, size: file.size });
        await sendFileInSlices(conn, file, (sent, total) => {
          const percent = Math.round((sent/total)*100);
          document.getElementById('transfer-status').textContent = `Sending ${file.name}`;
          document.getElementById('transfer-percentage').textContent = percent + '%';
          document.getElementById('progress-bar-fill').style.width = percent + '%';
        });
        conn.send({ type: 'file-end', index: i });
      }
      conn.send({ type: 'all-done' });
      showToast('All files sent');
      document.getElementById('completion-box').classList.remove('hidden');
      document.getElementById('completion-actions').classList.remove('hidden');
    });
  }

  // Slice & send with backpressure
  async function sendFileInSlices(conn, file, onprogress){
    const chunkSize = 64 * 1024;
    let offset = 0;
    while(offset < file.size){
      const slice = file.slice(offset, offset + chunkSize);
      const arrayBuffer = await slice.arrayBuffer();
      conn.send(arrayBuffer);
      offset += arrayBuffer.byteLength;

      if(onprogress) onprogress(offset, file.size);
      await waitForBufferedAmountLow(conn);
    }
  }

  function waitForBufferedAmountLow(conn, threshold = 2 * 1024 * 1024){
    return new Promise(resolve => {
      const check = () => {
        try {
          if(!conn || conn.open === false) return resolve();
          const buffered = conn.peerConnection ?
            (conn._dc && conn._dc.bufferedAmount || 0) :
            (conn.bufferedAmount || 0);
          if(buffered <= threshold) return resolve();
          setTimeout(check, 150);
        } catch (e) {
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
      }
    });
  });

  function getOTP(){ return otpInputs.map(i=>i.value||'').join(''); }
  function updateConnectButton(){
    const btn = document.getElementById('btn-connect');
    btn.disabled = getOTP().length !== 6;
  }

  // Connect button: receiver enters code and connects
  document.getElementById('btn-connect').addEventListener('click', ()=>{
    const code = getOTP();
    if(code.length !== 6){
      showToast('Please enter a valid 6-digit code');
      return;
    }

    // Look up peer ID from code registry
    const entry = codeRegistry.get(code);
    if(!entry){
      showToast('Code not found or expired. Ask sender to share again.');
      return;
    }

    // Check if code is not too old (e.g., 5 minutes)
    if(Date.now() - entry.timestamp > 5 * 60 * 1000){
      codeRegistry.delete(code);
      showToast('Code expired. Ask sender to share again.');
      return;
    }

    showToast('Connecting...');
    connectToPeerReceiver(entry.peerId);
  });

  // Receiver: create Peer and connect to sender
  function connectToPeerReceiver(senderPeerId){
    show(views.transfer);
    document.getElementById('transfer-status').textContent = 'Connecting…';
    const peer = new Peer();
    peer.on('open', id => {
      const conn = peer.connect(senderPeerId, { reliable: true });
      conn.on('open', () => {
        document.getElementById('transfer-status').textContent = 'Connected — waiting for files';
      });

      const receivedFiles = [];
      let currentFileBuffers = [];
      let expectedFileMeta = null;
      let receivedBytesForCurrent = 0;

      conn.on('data', data => {
        if(data && typeof data === 'object' && !(data instanceof ArrayBuffer)){
          if(data.type === 'file-list'){
            document.getElementById('transfer-status').textContent = `Incoming ${data.files.length} file(s)`;
          } else if(data.type === 'file-start'){
            expectedFileMeta = { index: data.index, name: data.name, size: data.size };
            currentFileBuffers = [];
            receivedBytesForCurrent = 0;
            document.getElementById('meta-filename').textContent = data.name;
            document.getElementById('meta-filesize').textContent = Math.round(data.size/1024) + ' KB';
            document.getElementById('transfer-status').textContent = 'Receiving ' + data.name;
          } else if(data.type === 'file-end'){
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
          currentFileBuffers.push(new Blob([data]));
          receivedBytesForCurrent += data.byteLength;
          if(expectedFileMeta){
            const percent = Math.round((receivedBytesForCurrent / expectedFileMeta.size) * 100);
            document.getElementById('transfer-percentage').textContent = percent + '%';
            document.getElementById('progress-bar-fill').style.width = percent + '%';
          }
        } else {
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

    // Cancel button for receiver
    const cancelBtn = document.getElementById('btn-cancel-receive');
    if(cancelBtn) cancelBtn.onclick = () => {
      if(peer) peer.destroy();
      show(views.home);
    };
  }

  // Download helper
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

  // Basic copy link handler
  const btnCopy = document.getElementById('btn-copy-link');
  if(btnCopy) btnCopy.addEventListener('click', async ()=>{
    try{
      await navigator.clipboard.writeText(location.href);
      showToast('Link copied to clipboard');
    }catch(err){
      showToast('Copy failed');
    }
  });

  // Back buttons
  const backButtons = [
    { id: 'btn-back-send', view: views.home },
    { id: 'btn-back-receive', view: views.home }
  ];
  backButtons.forEach(({ id, view }) => {
    const btn = document.getElementById(id);
    if(btn) btn.addEventListener('click', () => show(view));
  });

  // Cancel buttons
  const cancelReceiveBtn = document.getElementById('btn-cancel-receive');
  if(cancelReceiveBtn) cancelReceiveBtn.addEventListener('click', () => show(views.home));

  const cancelTransferBtn = document.getElementById('btn-cancel-transfer');
  if(cancelTransferBtn) cancelTransferBtn.addEventListener('click', () => show(views.home));

  const doneBtn = document.getElementById('btn-done');
  if(doneBtn) doneBtn.addEventListener('click', () => show(views.home));

  // Service worker (optional)
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }

  // Debug helpers
  window._sendly = { show, views, showToast, codeRegistry };
});
