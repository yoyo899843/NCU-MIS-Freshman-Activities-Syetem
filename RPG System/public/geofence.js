// GPS 圍籬：持續追蹤裝置目前的 GPS 位置，離開活動範圍就顯示提示。
// 做法跟 Time-Space Warfare 的 public/geofence.js 完全一樣。
//
// 範圍是使用者提供的實際活動 bounding box，外加約 100 公尺緩衝——純粹是容忍
// 消費級 GPS 常見的定位飄移（原本的範圍只有 330~375 公尺見方，跟手機 GPS
// 誤差同一個量級，很容易在邊界附近被誤判成範圍外）。
//
// 這裡刻意不是直接取「zoom 15 圖磚網格的真實邊界」（範圍會變成 1.1km x
// 2.2km）——這個範圍是「地圖有沒有圖可以看」的問題，跟「玩家算不算在遊戲
// 範圍內」是兩件不同的事，所以 public/map.html 的地圖可視範圍（BOUNDS）
// 現在改成拉大到整個圖磚範圍，但這裡的遊戲範圍刻意維持原本較小、貼近真實
// 活動範圍的設定，兩者不用再保持一致、各自獨立調整即可。
const CAMPUS_BOUNDS = {
  minLat: 25.017908,
  maxLat: 25.022659,
  minLng: 121.936015,
  maxLng: 121.941720
};

// GPS 訊號在範圍邊界附近常會跳動（誤差可能有幾十公尺），連續判定超過 OUT_OF_BOUNDS_LIMIT
// 次都在範圍外才顯示提示，避免單次飄移誤判。
const OUT_OF_BOUNDS_LIMIT = 3;

function isWithinCampus(lat, lng) {
  return (
    lat >= CAMPUS_BOUNDS.minLat && lat <= CAMPUS_BOUNDS.maxLat &&
    lng >= CAMPUS_BOUNDS.minLng && lng <= CAMPUS_BOUNDS.maxLng
  );
}

// 有些頁面（例如 map.html）自己有一條 position:absolute、top:8px 的 .top-bar，
// 跟這個 banner 一樣是 fixed/absolute 在畫面最上方，banner 顯示時會直接疊住蓋
// 掉 .top-bar 裡的連結/文字。banner 顯示/隱藏時動態把 .top-bar 往下推開／還原，
// 沒有 .top-bar 的頁面這裡就是無害的 no-op。
function repositionTopBar(banner) {
  const visible = banner.style.display !== 'none';
  document.querySelectorAll('.top-bar').forEach(el => {
    el.style.top = visible ? `${banner.offsetHeight + 8}px` : '8px';
  });
}

function showBanner(banner, text) {
  banner.textContent = text;
  banner.style.display = '';
  repositionTopBar(banner);
}

function hideBanner(banner) {
  banner.style.display = 'none';
  repositionTopBar(banner);
}

// onUpdate(lat, lng) 會在每次收到「範圍內」的定位時呼叫。
function startGeofence(onUpdate) {
  const banner = document.createElement('div');
  banner.id = 'geofenceBanner';
  banner.style.cssText =
    'display:none;position:fixed;top:0;left:0;right:0;z-index:2000;' +
    'background:#c00;color:#fff;padding:8px 12px;font-size:0.9rem;text-align:center';
  document.body.prepend(banner);

  if (!navigator.geolocation) {
    showBanner(banner, '此裝置不支援 GPS 定位，部分功能可能無法正常運作。');
    return;
  }

  let outOfBoundsStreak = 0;

  navigator.geolocation.watchPosition(
    pos => {
      const { latitude, longitude } = pos.coords;

      if (isWithinCampus(latitude, longitude)) {
        outOfBoundsStreak = 0;
        hideBanner(banner);
        onUpdate?.(latitude, longitude);
        return;
      }

      outOfBoundsStreak += 1;
      if (outOfBoundsStreak >= OUT_OF_BOUNDS_LIMIT) {
        showBanner(banner, '你的位置不在活動範圍，玩不了這個遊戲喔~~');
      } else {
        showBanner(banner, '正在確認你的位置是否在活動範圍內...');
      }
    },
    err => {
      showBanner(banner, '無法取得 GPS 定位（' + err.message + '），請確認已允許定位權限。');
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}
