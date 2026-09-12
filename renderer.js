// ===== 기본값 (오케이 실제 스크린샷에서 측정한 값) =====
// 좌하단 "플레이어 변경" 스펙테이터 UI 박스 위치 (480x270 미리보기 캔버스 기준)
// 원본 1920x1080에서 x:110~290, y:800~850 영역을 480x270 비율로 환산한 값
const DEFAULT_REGION = { x: 27, y: 200, w: 45, h: 12 };
const DEFAULT_DEAD_COLOR = { r: 34, g: 45, b: 40 };   // 죽었을 때 (어두운 반투명 박스)
const DEFAULT_ALIVE_COLOR = { r: 63, g: 97, b: 110 }; // 살아있을 때 (그 자리엔 게임 배경)

// ===== 전역 상태 =====
let mediaStream = null;
let videoEl = null;
let previewCanvas = document.getElementById('preview');
let previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
let overlayCanvas = document.getElementById('overlay');
let overlayCtx = overlayCanvas.getContext('2d');

let region = { ...DEFAULT_REGION };
let aliveColor = { ...DEFAULT_ALIVE_COLOR };
let deadColor = { ...DEFAULT_DEAD_COLOR };

let currentState = 'ALIVE';
let pendingState = null;
let pendingCount = 0;

let detectionEnabled = false;
let captureTimer = null;

let player = null; // YT.Player
let fadeInterval = null;

let settings = {
  quietVolume: 20,
  loudVolume: 80,
  fadeDuration: 800,
  confirmFrames: 3,
};

// ===== 화면 소스 목록 =====
async function loadSources() {
  const sources = await window.electronAPI.getScreenSources();
  const select = document.getElementById('sourceSelect');
  select.innerHTML = '';
  sources.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
  if (sources.length > 0) {
    startCapture(sources[0].id);
  }
}

document.getElementById('refreshSources').addEventListener('click', loadSources);
document.getElementById('sourceSelect').addEventListener('change', (e) => {
  startCapture(e.target.value);
});

// ===== 화면 캡처 시작 =====
async function startCapture(sourceId) {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
    });
  } catch (err) {
    console.error('화면 캡처 실패:', err);
    return;
  }

  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.muted = true;
  }
  videoEl.srcObject = mediaStream;
  await videoEl.play();

  // 캡처 원본 비율을 유지하면서 480x270 미리보기에 맞춤 (좌표계는 항상 480x270)
  drawLoop();
  setTimeout(drawPersistedRegionBox, 300);
}

function drawLoop() {
  if (videoEl && videoEl.readyState >= 2) {
    previewCtx.drawImage(videoEl, 0, 0, previewCanvas.width, previewCanvas.height);
  }
  requestAnimationFrame(drawLoop);
}

// ===== 영역 드래그 선택 =====
let dragging = false;
let dragStart = null;

overlayCanvas.addEventListener('mousedown', (e) => {
  const rect = overlayCanvas.getBoundingClientRect();
  dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  dragging = true;
});

overlayCanvas.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = overlayCanvas.getBoundingClientRect();
  const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  drawSelectionBox(dragStart, cur);
});

overlayCanvas.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const rect = overlayCanvas.getBoundingClientRect();
  const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const x = Math.min(dragStart.x, end.x);
  const y = Math.min(dragStart.y, end.y);
  const w = Math.abs(end.x - dragStart.x);
  const h = Math.abs(end.y - dragStart.y);
  if (w > 4 && h > 4) {
    region = { x, y, w, h };
  }
});

function drawSelectionBox(start, end) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.strokeStyle = '#e8a33d';
  overlayCtx.lineWidth = 2;
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  overlayCtx.strokeRect(x, y, w, h);
}

function drawPersistedRegionBox() {
  if (!region) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.strokeStyle = '#6fa373';
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(region.x, region.y, region.w, region.h);
}

// ===== 영역 평균 색상 계산 =====
function getRegionAverageColor() {
  if (!region) return null;
  const { x, y, w, h } = region;
  const data = previewCtx.getImageData(x, y, w, h).data;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  return { r: r / count, g: g / count, b: b / count };
}

function colorDistance(c1, c2) {
  return Math.sqrt((c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2);
}

// ===== 캘리브레이션 =====
document.getElementById('calibAlive').addEventListener('click', () => {
  const c = getRegionAverageColor();
  if (!c) return alert('먼저 감지 영역을 드래그로 지정하세요.');
  aliveColor = c;
  drawPersistedRegionBox();
});

document.getElementById('calibDead').addEventListener('click', () => {
  const c = getRegionAverageColor();
  if (!c) return alert('먼저 감지 영역을 드래그로 지정하세요.');
  deadColor = c;
  drawPersistedRegionBox();
});

document.getElementById('resetDefaults').addEventListener('click', () => {
  region = { ...DEFAULT_REGION };
  aliveColor = { ...DEFAULT_ALIVE_COLOR };
  deadColor = { ...DEFAULT_DEAD_COLOR };
  drawPersistedRegionBox();
});

// ===== 감지 루프 =====
function detectTick() {
  if (!detectionEnabled || !region || !aliveColor || !deadColor) return;

  const avg = getRegionAverageColor();
  if (!avg) return;

  const distAlive = colorDistance(avg, aliveColor);
  const distDead = colorDistance(avg, deadColor);
  const detected = distDead < distAlive ? 'DEAD' : 'ALIVE';

  document.getElementById('debugColor').textContent =
    `RGB(${avg.r.toFixed(0)}, ${avg.g.toFixed(0)}, ${avg.b.toFixed(0)}) | dAlive=${distAlive.toFixed(1)} dDead=${distDead.toFixed(1)}`;

  if (detected === pendingState) {
    pendingCount++;
  } else {
    pendingState = detected;
    pendingCount = 1;
  }

  if (pendingCount >= settings.confirmFrames && detected !== currentState) {
    currentState = detected;
    onStateChange(currentState);
  }
}

function onStateChange(state) {
  const label = document.getElementById('stateLabel');
  label.textContent = state;
  const readout = document.getElementById('ledReadout');
  readout.classList.remove('is-alive', 'is-dead');
  readout.classList.add(state === 'DEAD' ? 'is-dead' : 'is-alive');

  const target = state === 'DEAD' ? settings.loudVolume : settings.quietVolume;
  fadeVolumeTo(target, settings.fadeDuration);
}

document.getElementById('detectionToggle').addEventListener('change', (e) => {
  detectionEnabled = e.target.checked;
  if (detectionEnabled) {
    if (!region || !aliveColor || !deadColor) {
      alert('감지 영역 지정 + 살아있을 때/죽었을 때 캘리브레이션을 먼저 완료하세요.');
      e.target.checked = false;
      detectionEnabled = false;
      return;
    }
    captureTimer = setInterval(detectTick, 400);
  } else {
    clearInterval(captureTimer);
  }
});

// ===== 유튜브 플레이어 =====
function extractVideoId(input) {
  input = input.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  if (/^[\w-]{11}$/.test(input)) return input;
  return null;
}

let pendingVideoId = null;

function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '220',
    width: '390',
    videoId: pendingVideoId || undefined,
    playerVars: { autoplay: 0 },
    events: {
      onReady: () => {
        player.setVolume(settings.quietVolume);
      },
    },
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

document.getElementById('loadYt').addEventListener('click', () => {
  const raw = document.getElementById('ytUrl').value;
  const id = extractVideoId(raw);
  if (!id) return alert('유효한 유튜브 URL 또는 영상 ID가 아닙니다.');

  if (player && typeof player.loadVideoById === 'function') {
    player.loadVideoById(id);
  } else {
    pendingVideoId = id;
  }
});

function fadeVolumeTo(target, durationMs) {
  if (!player || typeof player.setVolume !== 'function') return;
  clearInterval(fadeInterval);
  const start = player.getVolume();
  const steps = 20;
  const stepTime = durationMs / steps;
  let i = 0;
  fadeInterval = setInterval(() => {
    i++;
    const v = start + (target - start) * (i / steps);
    player.setVolume(Math.max(0, Math.min(100, Math.round(v))));
    if (i >= steps) clearInterval(fadeInterval);
  }, stepTime);
}

// ===== 설정 슬라이더 바인딩 =====
function bindSlider(id, labelId, settingKey, isInt = true) {
  const el = document.getElementById(id);
  const label = document.getElementById(labelId);
  el.addEventListener('input', () => {
    const v = isInt ? parseInt(el.value, 10) : parseFloat(el.value);
    settings[settingKey] = v;
    label.textContent = v;
  });
}
bindSlider('quietVolume', 'quietVal', 'quietVolume');
bindSlider('loudVolume', 'loudVal', 'loudVolume');
bindSlider('fadeDuration', 'fadeVal', 'fadeDuration');
bindSlider('confirmFrames', 'confirmVal', 'confirmFrames');

// ===== 초기화 =====
loadSources();
