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
let localAudio = null; // <audio> (로컬 파일 재생용)
let activeSource = null; // 'youtube' | 'local' | null
let fadeInterval = null;

// fadeVolumeTo 등에서 유튜브/로컬 파일 어느 쪽이 재생 중이든 동일하게
// 볼륨을 제어할 수 있도록 감싸는 래퍼.
const audioController = {
  setVolume(v) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    if (activeSource === 'youtube' && player && typeof player.setVolume === 'function') {
      player.setVolume(vol);
    } else if (activeSource === 'local' && localAudio) {
      localAudio.volume = vol / 100;
    }
  },
  getVolume() {
    if (activeSource === 'youtube' && player && typeof player.getVolume === 'function') {
      return player.getVolume();
    }
    if (activeSource === 'local' && localAudio) {
      return Math.round(localAudio.volume * 100);
    }
    return 0;
  },
};

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

let pendingVideoId = null;
let ytReady = false;        // onYouTubeIframeAPIReady가 실제로 호출됐는지
let ytApiFailed = false;
let ytScriptLoaded = false; // <script src=iframe_api> 자체가 로드는 됐는지 (실패 원인 구분용)

const ytStatusEl = document.getElementById('ytStatus');
const loadYtBtn = document.getElementById('loadYt');

function setYtStatus(text) {
  if (ytStatusEl) ytStatusEl.textContent = text;
}

function failYtLoad(reason) {
  ytApiFailed = true;
  console.error('유튜브 플레이어를 불러오지 못했습니다:', reason);

  if (pendingVideoId) {
    pendingVideoId = null;
    setYtStatus(`⚠️ 유튜브 플레이어를 불러오지 못했어요. (${reason}) 방화벽/백신/PC방 관리 프로그램이 이 프로그램의 인터넷 접속을 차단하고 있을 수 있어요.`);
    loadYtBtn.disabled = false;
  }
}

document.getElementById('openDevtoolsBtn')?.addEventListener('click', () => {
  window.electronAPI?.openDevtools?.();
});

(function loadYoutubeIframeApi() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';

  // 스크립트 파일 자체를 못 받아온 경우 (net::ERR_* 등) - 이건 아예 접속이
  // 막혔다는 뜻이라 12초씩 기다릴 필요 없이 바로 알 수 있다.
  tag.onerror = () => {
    failYtLoad('iframe_api 스크립트 자체를 불러오지 못함 - net::ERR_*');
  };

  tag.onload = () => {
    ytScriptLoaded = true;
    console.log('유튜브 iframe_api 부트스트랩 스크립트는 정상적으로 로드됐습니다.');
  };

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

// iframe_api 스크립트는 떴는데 위젯 초기화(onYouTubeIframeAPIReady)가 끝내 안 되는
// 경우를 대비해, 일정 시간 안에 API가 준비되지 않으면 명확한 에러를 보여준다.
// 이게 없으면 "불러오기"를 눌러도 pendingVideoId만 쌓이고 아무 반응이 없는 것처럼 보인다.
// 주의: iframe_api는 두 단계로 로드된다 (1. 부트스트랩 스크립트 자체가 뜨는 것,
// 2. 그 안에서 실제 플레이어 위젯 스크립트가 뜨면서 onYouTubeIframeAPIReady가 호출되는 것).
// 그래서 "YT 객체가 있는지"가 아니라 "우리 콜백이 실제로 호출됐는지(ytReady)"로만 판단해야
// 위젯이 아직 로딩 중인 정상적인 상황을 실패로 오판하지 않는다.
const YT_TIMEOUT_MS = 12000;

const ytTimeoutTimer = setTimeout(() => {
  if (!ytReady && !ytApiFailed) {
    const reason = ytScriptLoaded
      ? '부트스트랩 스크립트는 로드됐지만 위젯 초기화가 끝나지 않음 (2단계 스크립트가 차단됐을 가능성)'
      : '부트스트랩 스크립트 로드 응답이 없음 (요청이 걸린 채로 멈춤)';

    failYtLoad(reason);
  }
}, YT_TIMEOUT_MS);

function onYouTubeIframeAPIReady() {
  ytReady = true;
  clearTimeout(ytTimeoutTimer);

  player = new YT.Player('player', {
    height: '220',
    width: '390',
    videoId: pendingVideoId || undefined,
    playerVars: { autoplay: 0 },
    events: {
      onReady: () => {
        activeSource = 'youtube';
        audioController.setVolume(settings.quietVolume);

        if (pendingVideoId) {
          setYtStatus('✅ 영상을 불러왔어요.');
          loadYtBtn.disabled = false;
        }

        pendingVideoId = null;
      },
    },
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

loadYtBtn.addEventListener('click', () => {
  const raw = document.getElementById('ytUrl').value;
  const id = extractVideoId(raw);
  if (!id) return alert('유효한 유튜브 URL 또는 영상 ID가 아닙니다.\n예: https://www.youtube.com/watch?v=xxxxxxxxxxx');

  if (player && typeof player.loadVideoById === 'function') {
    player.loadVideoById(id);
    activeSource = 'youtube';
    setYtStatus('✅ 영상을 불러왔어요.');
  } else if (ytApiFailed) {
    setYtStatus('⚠️ 유튜브 플레이어를 불러오지 못했어요. 방화벽/백신/PC방 관리 프로그램이 이 프로그램의 인터넷 접속을 차단하고 있을 수 있어요. (개발자 도구 콘솔에서 자세한 이유를 확인할 수 있어요. 계속 안 되면 아래 "내 PC의 음악 파일 불러오기"를 대신 써보세요.)');
  } else {
    pendingVideoId = id;
    loadYtBtn.disabled = true;
    setYtStatus('⏳ 유튜브 플레이어를 준비 중이에요. 준비되는 대로 자동으로 불러올게요...');
  }
});

// ===== 로컬 음악 파일 재생 (유튜브 접속이 막힌 환경을 위한 대안) =====
// 학교 PC처럼 유튜브 자체가 네트워크 레벨에서 막혀있으면 iframe API가 영영 준비되지
// 않을 수 있다. 이런 경우에도 볼륨 자동 조절 기능은 쓸 수 있도록, 내 PC에 있는
// 음악 파일을 직접 골라 재생하는 경로를 별도로 둔다. 볼륨 제어는 audioController를
// 통해 유튜브 플레이어와 완전히 동일하게 동작한다.
localAudio = document.getElementById('localAudio');

const localFileInput = document.getElementById('localAudioFile');
const loadLocalFileBtn = document.getElementById('loadLocalFile');
const localAudioStatusEl = document.getElementById('localAudioStatus');

function setLocalAudioStatus(text) {
  if (localAudioStatusEl) localAudioStatusEl.textContent = text;
}

loadLocalFileBtn.addEventListener('click', () => localFileInput.click());

localFileInput.addEventListener('change', () => {
  const file = localFileInput.files && localFileInput.files[0];
  if (!file) return;

  const objectUrl = URL.createObjectURL(file);
  localAudio.src = objectUrl;
  localAudio.currentTime = 0;

  localAudio.play()
    .then(() => {
      activeSource = 'local';
      audioController.setVolume(settings.quietVolume);
      setLocalAudioStatus(`✅ "${file.name}" 재생 중이에요. (반복 재생)`);
    })
    .catch((err) => {
      console.warn('로컬 파일 재생 실패:', err);
      setLocalAudioStatus('⚠️ 파일을 재생하지 못했어요. 지원되는 오디오/영상 파일인지 확인해주세요.');
    });
});

function fadeVolumeTo(target, durationMs) {
  if (!activeSource) return;
  clearInterval(fadeInterval);
  const start = audioController.getVolume();
  const steps = 20;
  const stepTime = durationMs / steps;
  let i = 0;
  fadeInterval = setInterval(() => {
    i++;
    const v = start + (target - start) * (i / steps);
    audioController.setVolume(v);
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
