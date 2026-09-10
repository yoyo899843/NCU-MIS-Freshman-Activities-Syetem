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

// GeolocationCoordinates.accuracy 是座標誤差半徑（公尺，約 95% 信賴範圍）。校園
// 尺度下超過 100m 的點很可能已經落到校外道路或鄰近區域，不能拿來畫玩家位置。
// 此值必須與 src/campusBounds.js 的 MAX_LOCATION_ACCURACY_METERS 保持一致。
const MAX_LOCATION_ACCURACY_METERS = 100;

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

// onUpdate(lat, lng) 會在每次收到「校園範圍內」的定位時呼叫，
// 之後要做隊友即時定位廣播（team:<teamId> room）可以接在這裡。
function startGeofence(onUpdate, onUnavailable) {
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
      const { latitude, longitude, accuracy } = pos.coords;

      // enableHighAccuracy 只是向瀏覽器提出偏好，不保證一定使用 GPS。尤其 iPhone
      // 關閉 Safari 的「精確位置」時，仍可能回傳幾百到數千公尺的概略座標。
      // 不採用這種點，也通知地圖停止重複上傳上一個有效位置，避免舊點被誤標為現在。
      if (!Number.isFinite(accuracy) || accuracy > MAX_LOCATION_ACCURACY_METERS) {
        onUnavailable?.();
        const shown = Number.isFinite(accuracy) ? `目前約 ±${Math.round(accuracy)} 公尺` : '目前精準度未知';
        showBanner(banner,
          `定位精準度不足（${shown}；需要 ±${MAX_LOCATION_ACCURACY_METERS} 公尺內）。` +
          '請移到戶外後重試；iPhone 請確認 Safari 網站已允許「精確位置」。');
        return;
      }

      if (isWithinCampus(latitude, longitude)) {
        outOfBoundsStreak = 0;
        hideBanner(banner);
        onUpdate?.(latitude, longitude, accuracy);
        return;
      }

      // 一旦這次讀值不在活動範圍，就不要繼續把上一個有效點當成「現在」上傳。
      onUnavailable?.();
      outOfBoundsStreak += 1;
      if (outOfBoundsStreak >= OUT_OF_BOUNDS_LIMIT) {
        showBanner(banner, '你的位置不在學校範圍，玩不了這個遊戲喔~~');
      } else {
        showBanner(banner, '正在確認你的位置是否在校園範圍內...');
      }
    },
    err => {
      onUnavailable?.();
      showBanner(banner, '無法取得 GPS 定位（' + err.message + '），請確認已允許定位權限。');
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}
