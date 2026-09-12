const { app, BrowserWindow, desktopCapturer, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let mainWindow;
let localServer;
let localServerPort;

// 유튜브 iframe 플레이어는 file:// 처럼 "출처(origin)"가 없는 페이지에서는
// 보안 정책상 정상적으로 재생되지 않는다 (오류 153: 동영상 플레이어 구성 오류).
// 그래서 file://로 직접 여는 대신, 앱 안에 아주 작은 로컬 서버를 하나 띄워서
// http://127.0.0.1:포트 로 페이지를 서빙한다. 이러면 유튜브 쪽에서 정상적인
// origin으로 인식해서 문제 없이 재생된다.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startLocalServer() {
  return new Promise((resolve, reject) => {
    localServer = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const safePath = path.normalize(urlPath === '/' ? '/index.html' : urlPath);
      const filePath = path.join(__dirname, safePath);

      // 앱 폴더 바깥으로 나가는 경로 요청은 차단 (경로 탈출 방지)
      if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end();
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });

    localServer.on('error', reject);

    localServer.listen(0, '127.0.0.1', () => {
      localServerPort = localServer.address().port;
      resolve();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: '#111319',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${localServerPort}/index.html`);
}

// 렌더러에서 화면/창 목록 요청 시 처리
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// 진단용: 유튜브 로딩 문제 등을 확인할 수 있도록 개발자 도구를 바로 열어준다.
// (PC방 등에서 단축키(F12/Ctrl+Shift+I)가 막혀 있어도 앱 안 버튼으로 열 수 있게)
ipcMain.handle('open-devtools', () => {
  mainWindow?.webContents.openDevTools({ mode: 'detach' });
});

app.whenReady().then(async () => {
  await startLocalServer();
  createWindow();

  // 알트탭으로 다른 앱(인스타그램 등)을 볼 때, 게임에 포커스가 없어도
  // 감지를 즉시 껐다 켤 수 있는 전역 단축키. 창 캡처가 아니라 "전체 화면"을
  // 캡처할 수밖에 없는 상황(발로란트가 독점 전체화면일 때)에서 특히 유용하다.
  globalShortcut.register('CommandOrControl+Alt+P', () => {
    mainWindow?.webContents.send('toggle-detection-hotkey');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  localServer?.close();
  if (process.platform !== 'darwin') app.quit();
});
