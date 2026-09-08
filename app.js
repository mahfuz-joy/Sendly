let peer = null;
let activeConnection = null;
let selectedFile = null;
const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk for high speed

// Generate a random 6-digit numeric string
function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Navigation helpers
function showView(viewId) {
  ['view-home', 'view-send', 'view-receive'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById(viewId).classList.remove('hidden');
}

function goHome() {
  showView('view-home');
  selectedFile = null;
}

function openReceiveView() {
  showView('view-receive');
  setupOtpInputs();
  // Initialize peer with a random ID if not ready
  if (!peer) initReceiverPeer();
}

// --- SEND FLOW ---
function onFilePicked(event) {
  const file = event.target.files[0];
  if (!file) return;
  selectedFile = file;

  const code = generateSixDigitCode();
  const peerId = 'sendly-' + code;

  // Destroy old peer instance if exists
  if (peer) peer.destroy();

  peer = new Peer(peerId);

  peer.on('open', () => {
    document.getElementById('display-code').innerText = code;
    showView('view-send');

    // Generate QR Code
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = '';
    const shareUrl = `${window.location.origin}${window.location.pathname}?code=${code}`;
    new QRCode(qrContainer, {
      text: shareUrl,
      width: 160,
      height: 160,
      colorDark: '#000000',
      colorLight: '#ffffff'
    });
  });

  // When receiver connects to this sender
  peer.on('connection', (conn) => {
    activeConnection = conn;
    activeConnection.on('open', () => {
      startStreamingFile(selectedFile);
    });
  });
}

function copyShareLink() {
  const code = document.getElementById('display-code').innerText;
  const shareUrl = `${window.location.origin}${window.location.pathname}?code=${code}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    alert('Share link copied to clipboard!');
  });
}

// --- RECEIVE FLOW ---
function initReceiverPeer() {
  peer = new Peer();
}

function setupOtpInputs() {
  const inputs = document.querySelectorAll('.otp-input');
  inputs.forEach((input, idx) => {
    input.value = '';
    input.oninput = (e) => {
      if (e.target.value.length === 1 && idx < inputs.length - 1) {
        inputs[idx + 1].focus();
      }
      checkOtpFilled();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) {
        inputs[idx - 1].focus();
      }
    };
  });
  inputs[0].focus();
}

function checkOtpFilled() {
  const inputs = document.querySelectorAll('.otp-input');
  let fullCode = '';
  inputs.forEach(i => fullCode += i.value);
  const connectBtn = document.getElementById('btn-connect');
  connectBtn.disabled = fullCode.length !== 6;
}

function connectWithCode(customCode = null) {
  let targetCode = customCode;
  if (!targetCode) {
    const inputs = document.querySelectorAll('.otp-input');
    targetCode = '';
    inputs.forEach(i => targetCode += i.value);
  }

  if (targetCode.length !== 6) return;

  const targetPeerId = 'sendly-' + targetCode;
  showProgress();
  updateProgress(0, 'Connecting to sender...');

  if (!peer) peer = new Peer();

  peer.on('open', () => {
    makeCall(targetPeerId);
  });

  if (peer.id) {
    makeCall(targetPeerId);
  }
}

function makeCall(targetPeerId) {
  activeConnection = peer.connect(targetPeerId, { reliable: true });

  let receivedChunks = [];
  let meta = null;
  let receivedBytes = 0;

  activeConnection.on('open', () => {
    updateProgress(0, 'Connected! Waiting for file...');
  });

  activeConnection.on('data', (data) => {
    if (data.type === 'meta') {
      meta = data;
      receivedChunks = [];
      receivedBytes = 0;
      updateProgress(0, 'Receiving...');
    } else if (data.type === 'chunk') {
      receivedChunks.push(data.chunk);
      receivedBytes += data.chunk.byteLength;

      const progress = Math.min(100, Math.round((receivedBytes / meta.size) * 100));
      updateProgress(progress, 'Receiving...');

      if (receivedBytes >= meta.size) {
        updateProgress(100, 'Saving file...');
        const blob = new Blob(receivedChunks, { type: meta.fileType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = meta.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        updateProgress(100, 'Download Complete!');
      }
    }
  });
}

// Optimized File Sender with Backpressure Handling
function startStreamingFile(file) {
  showProgress();
  updateProgress(0, 'Sending details...');

  activeConnection.send({
    type: 'meta',
    name: file.name,
    size: file.size,
    fileType: file.type
  });

  let offset = 0;
  const channel = activeConnection.dataChannel;
  channel.bufferedAmountLowThreshold = 64 * 1024;

  function pushChunk() {
    while (offset < file.size) {
      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          pushChunk();
        };
        return;
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();

      reader.onload = (e) => {
        activeConnection.send({
          type: 'chunk',
          chunk: e.target.result
        });
      };

      reader.readAsArrayBuffer(slice);
      offset += CHUNK_SIZE;

      const progress = Math.min(100, Math.round((offset / file.size) * 100));
      updateProgress(progress, 'Sending...');
    }
    updateProgress(100, 'Sent Successfully!');
  }

  pushChunk();
}

function showProgress() {
  document.getElementById('progress-box').classList.remove('hidden');
}

function updateProgress(percent, label) {
  document.getElementById('progress-bar-fill').style.width = percent + '%';
  document.getElementById('transfer-percentage').innerText = percent + '%';
  document.getElementById('transfer-status').innerText = label;
}

// Auto connect if URL has ?code=123456
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const autoCode = urlParams.get('code');
  if (autoCode && autoCode.length === 6) {
    openReceiveView();
    const inputs = document.querySelectorAll('.otp-input');
    autoCode.split('').forEach((digit, idx) => {
      if (inputs[idx]) inputs[idx].value = digit;
    });
    connectWithCode(autoCode);
  }
});
