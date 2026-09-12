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

// ===== 유튜브 IFrame API 비동기 로드 =====
// 주의: 이 스크립트를 index.html에 <script src="...">로 정적으로 넣으면 안 된다.
// 그러면 이 요청이 응답 없이 지연될 때(방화벽/보안 프로그램 등) 브라우저가 그 뒤에 오는
// renderer.js 자체를 실행하지 못해 앱의 모든 버튼이 먹통이 된다. 반드시 동적으로,
// 논블로킹으로 삽입해야 나머지 UI 로직이 네트워크 상태와 무관하게 항상 살아있다.
(function loadYoutubeIframeApi() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
})();

// ===== 유튜브 플레이어 =====
function extractVideoId(input) {
  input = input.trim();
  // 순수 11자 영상 ID를 붙여넣은 경우
  if (/^[\w-]{11}$/.test(input)) return input;

  // URL 형태는 URL 파서로 안전하게 분해 (파라미터 순서, shorts/live 등 형태 차이에 영향 안 받도록)
  try {
    const withProtocol = /^https?:\/\//.test(input) ? input : `https://${input}`;
    const url = new URL(withProtocol);
    const host = url.hostname.replace(/^www\.|^m\./, '');

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id && /^[\w-]{11}$/.test(id)) return id;
    }

    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') {
        const id = url.searchParams.get('v');
        if (id && /^[\w-]{11}$/.test(id)) return id;
      }
      const segMatch = url.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
      if (segMatch) return segMatch[2];
    }
  } catch (e) {
    // URL로 해석 안 되면 아래 정규식 fallback으로 진행
  }

  // 마지막 fallback: 문자열 어디에든 11자 영상 ID 패턴이 있으면 사용
  const fallback = input.match(/([\w-]{11})(?:[?&#]|$)/);
  if (fallback) return fallback[1];

  return null;
}

let pendingVideoId = null;
let ytApiFailed = false;

// iframe_api 스크립트가 아예 못 뜨는 경우(인터넷 끊김/방화벽/유튜브 차단 등)를 대비해
// 일정 시간 안에 API가 준비되지 않으면 명확한 에러를 보여준다. 이게 없으면
// "불러오기"를 눌러도 pendingVideoId만 쌓이고 아무 반응이 없는 것처럼 보인다.
setTimeout(() => {
  if (typeof YT === 'undefined' || !YT.Player) {
    ytApiFailed = true;
    console.warn('YouTube IFrame API가 로드되지 않았습니다 (네트워크/방화벽 문제일 수 있음).');
  }
}, 6000);

function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '220',
    width: '390',
    videoId: pendingVideoId || undefined,
    playerVars: { autoplay: 0 },
    events: {
      onReady: () => {
        player.setVolume(settings.quietVolume);
        pendingVideoId = null;
      },
    },
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

document.getElementById('loadYt').addEventListener('click', () => {
  const raw = document.getElementById('ytUrl').value;
  const id = extractVideoId(raw);
  if (!id) return alert('유효한 유튜브 URL 또는 영상 ID가 아닙니다.\n예: https://www.youtube.com/watch?v=xxxxxxxxxxx');

  if (player && typeof player.loadVideoById === 'function') {
    player.loadVideoById(id);
  } else if (ytApiFailed) {
    alert('유튜브 플레이어를 불러오지 못했습니다.\n인터넷 연결 또는 방화벽/보안 프로그램이 youtube.com 접속을 막고 있는지 확인해주세요.');
  } else {
    pendingVideoId = id;
    alert('유튜브 플레이어를 준비 중입니다. 잠시 후 자동으로 불러올게요.');
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
