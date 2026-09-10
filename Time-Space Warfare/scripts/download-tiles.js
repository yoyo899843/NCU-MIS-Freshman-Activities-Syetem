// 一次性下載校園範圍的地圖 tile 圖磚，供 public/tiles/ 自行 host 使用。
// 不是 app 執行期間會跑的程式，是活動籌備期間手動執行一次的工具。
//
// 圖磚來源用 CARTO 的免費 basemap（底圖資料仍是 OpenStreetMap 貢獻者提供，
// CARTO 只是重新算圖後提供的免費 tile 服務）。
// 沒有用 OpenStreetMap 官方的 tile.openstreetmap.org——那是設計給互動地圖
// 即時載入用的，官方使用政策明確不允許這樣整批爬圖磚下載，會被封鎖
// （已經實際測試踩到：整批下載回來的圖全部是同一張「Access blocked」警告圖）。
//
// 用法：
//   node scripts/download-tiles.js

const fs = require('fs');
const path = require('path');

// 從 src/campusBounds.js 讀，不要在這裡再抄一份座標。
//
// 這個範圍同時決定三件事：抓哪些圖磚、玩家地圖能拖到哪、以及後台新增交摺點時
// 座標的有效範圍。抄成三份的話，改場地時漏改任何一份都會壞掉，而且壞的方式很
// 安靜（例如圖磚抓新的、驗證還用舊的，於是新場地的點全被擋下來）。
const { CAMPUS_BOUNDS: BBOX } = require('../src/campusBounds');

const ZOOM_RANGE = [15, 19]; // [minZoom, maxZoom]
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'tiles');
const DELAY_MS = 300; // 禮貌性延遲
const USER_AGENT = 'NCUMIS-Camp-MapPrep/1.0 (one-time offline map prep for small campus event)';
const TILE_URL_TEMPLATE = 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';

function lngLatToTile(lng, lat, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadTile(z, x, y) {
  const dir = path.join(OUTPUT_DIR, String(z), String(x));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${y}.png`);

  if (fs.existsSync(filePath)) {
    console.log(`skip (exists): ${z}/${x}/${y}`);
    return;
  }

  const url = TILE_URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok || !contentType.startsWith('image/')) {
    throw new Error(`failed to fetch ${url}: HTTP ${res.status}, content-type ${contentType}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  console.log(`saved: ${z}/${x}/${y} (${buffer.length} bytes)`);
}

async function main() {
  const [minZoom, maxZoom] = ZOOM_RANGE;
  let total = 0;

  for (let z = minZoom; z <= maxZoom; z++) {
    const topLeft = lngLatToTile(BBOX.minLng, BBOX.maxLat, z);
    const bottomRight = lngLatToTile(BBOX.maxLng, BBOX.minLat, z);

    for (let x = topLeft.x; x <= bottomRight.x; x++) {
      for (let y = topLeft.y; y <= bottomRight.y; y++) {
        await downloadTile(z, x, y);
        total++;
        await sleep(DELAY_MS);
      }
    }
  }

  console.log(`完成，共處理 ${total} 張圖磚。`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
