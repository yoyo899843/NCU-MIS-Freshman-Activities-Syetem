// 一次性下載校園範圍的 OpenStreetMap tile 圖磚，供 public/tiles/ 自行 host 使用。
// 不是 app 執行期間會跑的程式，是活動籌備期間手動執行一次的工具。
//
// 用法：
//   node scripts/download-tiles.js

const fs = require('fs');
const path = require('path');

const BBOX = {
  minLat: 24.964764,
  maxLat: 24.972425,
  minLng: 121.184735,
  maxLng: 121.197936
};

const ZOOM_RANGE = [15, 19]; // [minZoom, maxZoom]
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'tiles');
const DELAY_MS = 250; // 禮貌性延遲，避免對 OSM 公用 tile server 造成負擔
const USER_AGENT = 'NCUMIS-Camp-TileDownloader/1.0 (one-time offline map prep)';

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

  const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  console.log(`saved: ${z}/${x}/${y}`);
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
