// Express 4 不會自動把 async handler 裡的 rejected promise 轉送到錯誤處理 middleware，
// 沒接住的話請求會直接卡住沒有回應。用這個包一層即可。
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
