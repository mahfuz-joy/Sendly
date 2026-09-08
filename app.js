// Optimized Peer configuration with Google STUN servers for direct local routing
const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

let peer = null;
let activeConnection = null;
let selectedFile = null;

// Optimal chunk size for WebRTC DataChannel (64 KB)
const CHUNK_SIZE = 64 * 1024; 

// Speed calculation variables
let startTime = 0;
let lastUpdate = 0;
let lastBytes = 0;

function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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
  if (!peer) initReceiverPeer();
}

// --- SEND FLOW ---
function onFilePicked(event) {
  const file = event.target.files[0];
  if (!file) return;
  selectedFile = file;

  const code = generateSixDigitCode();
  const peerId = 'sendly-' + code;

  if (peer) peer.destroy();

  peer = new Peer(peerId, PEER_CONFIG);

  peer.on('open', () => {
    document.getElementById('display-code').innerText = code;
    showView('view-send');

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

  peer.on('connection', (conn) => {
    activeConnection = conn;
    activeConnection.on('open', () => {
      startHighSpeedStream(selectedFile);
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
  peer = new Peer(PEER_CONFIG);
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
  updateProgress(0, 'Connecting directly...');

  if (!peer) peer = new Peer(PEER_CONFIG);

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
    updateProgress(0, 'Connected! Waiting for transfer...');
  });

  activeConnection.on('data', (data) => {
    const now = performance.now();

    if (data.type === 'meta') {
      meta = data;
      receivedChunks = [];
      receivedBytes = 0;
      startTime = now;
      lastUpdate = now;
      lastBytes = 0;
      updateProgress(0, 'Starting download...');
    } else if (data.type === 'chunk') {
      receivedChunks.push(data.chunk);
      receivedBytes += data.chunk.byteLength;

      // Speed calculation every 300ms
      if (now - lastUpdate > 300) {
        calculateSpeed(receivedBytes, meta.size, now);
        lastUpdate = now;
        lastBytes = receivedBytes;
      }

      const progress = Math.min(100, Math.round((receivedBytes / meta.size) * 100));
      updateProgress(progress, 'Receiving...');

      if (receivedBytes >= meta.size) {
        updateProgress(100, 'Saving file to device...');
        document.getElementById('transfer-speed').innerText = 'Complete';
        document.getElementById('transfer-eta').innerText = '';

        const blob = new Blob(receivedChunks, { type: meta.fileType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = meta.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        updateProgress(100, 'Transfer Complete!');
      }
    }
  });
}

// Ultra Fast Stream with Flow Control
async function startHighSpeedStream(file) {
  showProgress();
  updateProgress(0, 'Reading file...');

  activeConnection.send({
    type: 'meta',
    name: file.name,
    size: file.size,
    fileType: file.type
  });

  const channel = activeConnection.dataChannel;
  channel.binaryType = 'arraybuffer';
  
  // Backpressure watermark to prevent memory choking
  channel.bufferedAmountLowThreshold = 256 * 1024; // 256 KB buffer

  let offset = 0;
  startTime = performance.now();
  lastUpdate = startTime;
  lastBytes = 0;

  function pushNextChunks() {
    while (offset < file.size) {
      // Pause if buffer is getting full
      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          pushNextChunks();
        };
        return;
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      slice.arrayBuffer().then(buffer => {
        if (channel.readyState === 'open') {
          channel.send(buffer);
        }
      });

      offset += CHUNK_SIZE;

      const now = performance.now();
      if (now - lastUpdate > 300) {
        calculateSpeed(offset, file.size, now);
        lastUpdate = now;
        lastBytes = offset;
      }

      const progress = Math.min(100, Math.round((offset / file.size) * 100));
      updateProgress(progress, 'Sending...');
    }

    updateProgress(100, 'Sent Successfully!');
    document.getElementById('transfer-speed').innerText = 'Complete';
    document.getElementById('transfer-eta').innerText = '';
  }

  pushNextChunks();
}

// Speed & ETA Formatter
function calculateSpeed(currentBytes, totalBytes, now) {
  const timeDiff = (now - lastUpdate) / 1000;
  const bytesDiff = currentBytes - lastBytes;
  const speedBps = bytesDiff / timeDiff; // Bytes per second

  let speedText = '';
  if (speedBps > 1024 * 1024) {
    speedText = (speedBps / (1024 * 1024)).toFixed(1) + ' MB/s';
  } else {
    speedText = (speedBps / 1024).toFixed(0) + ' KB/s';
  }

  const remainingBytes = totalBytes - currentBytes;
  const remainingSeconds = speedBps > 0 ? Math.round(remainingBytes / speedBps) : 0;
  const etaText = remainingSeconds > 0 ? `ETA: ${remainingSeconds}s` : 'ETA: calculating...';

  document.getElementById('transfer-speed').innerText = speedText;
  document.getElementById('transfer-eta').innerText = etaText;
}

function showProgress() {
  document.getElementById('progress-box').classList.remove('hidden');
}

function updateProgress(percent, label) {
  document.getElementById('progress-bar-fill').style.width = percent + '%';
  document.getElementById('transfer-percentage').innerText = percent + '%';
  document.getElementById('transfer-status').innerText = label;
}

// Auto connect parameter handler
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
