// GPS 圍籬：持續追蹤裝置目前的 GPS 位置，離開活動範圍就顯示提示。
// 做法跟 Time-Space Warfare 的 public/geofence.js 完全一樣。
//
// 範圍是使用者提供的實際活動 bounding box，外加約 100 公尺緩衝——純粹是容忍
// 消費級 GPS 常見的定位飄移（原本的範圍只有 330~375 公尺見方，跟手機 GPS
// 誤差同一個量級，很容易在邊界附近被誤判成範圍外）。
//
// 這裡的範圍刻意跟 public/map.html 的地圖可視範圍（BOUNDS）分開算——那邊是
// 「地圖 UI 讓使用者看多廣」，這邊是「玩家算不算在遊戲範圍內」，是兩件不同
// 的事，兩者不用保持一致、各自獨立調整即可。
const CAMPUS_BOUNDS = {
  minLat: 25.017187,
  maxLat: 25.022659,
  minLng: 121.931803,
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

function showBanner(banner, text) {
  banner.textContent = text;
  banner.style.display = '';
}

function hideBanner(banner) {
  banner.style.display = 'none';
}

// onUpdate(lat, lng) 會在每次收到「範圍內」的定位時呼叫。
function startGeofence(onUpdate) {
  const banner = document.createElement('div');
  banner.id = 'geofenceBanner';
  // sticky 而不是 fixed：fixed 會脫離文件流、直接蓋住頁面最上方的東西（地圖頁的
  // .top-bar 首當其衝），原本得靠 JS 在 banner 顯示/隱藏時去推 .top-bar 的 top 值。
  // sticky 佔位置，會把後面的內容往下擠，捲動時一樣釘在最上面，那段 JS 就不用了。
  banner.style.cssText =
    'display:none;position:sticky;top:0;z-index:2000;' +
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
