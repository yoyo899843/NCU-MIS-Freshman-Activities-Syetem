// 玩家 GPS 圍籬：持續追蹤裝置目前的 GPS 位置，離開校園範圍就導回首頁。
// 校園範圍跟 scripts/download-tiles.js 下載圖磚時用的是同一個 bounding box，
// 兩邊要改要一起改。

const CAMPUS_BOUNDS = {
  minLat: 24.964764,
  maxLat: 24.972425,
  minLng: 121.184735,
  maxLng: 121.197936
};

// GPS 訊號在校園邊界附近常會跳動（誤差可能有幾十公尺），連續判定超過 OUT_OF_BOUNDS_LIMIT
// 次都在範圍外才真的導回首頁，避免單次飄移誤判把人踢出去。
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

// onUpdate(lat, lng) 會在每次收到「校園範圍內」的定位時呼叫，
// 之後要做隊友即時定位廣播（team:<teamId> room）可以接在這裡。
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
        showBanner(banner, '你的位置不在學校範圍，玩不了這個遊戲喔~~');
      } else {
        showBanner(banner, '正在確認你的位置是否在校園範圍內...');
      }
    },
    err => {
      showBanner(banner, '無法取得 GPS 定位（' + err.message + '），請確認已允許定位權限。');
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}
