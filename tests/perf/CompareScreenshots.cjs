const fs = require("fs");
const { createCanvas, loadImage } = require("canvas");

async function compareImages(imgPathA, imgPathB) {
  const [imgA, imgB] = await Promise.all([
    loadImage(imgPathA),
    loadImage(imgPathB),
  ]);

  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw new Error(
      `Dimension mismatch: ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`,
    );
  }

  const w = imgA.width;
  const h = imgA.height;
  const cA = createCanvas(w, h);
  const cB = createCanvas(w, h);
  const ctxA = cA.getContext("2d");
  const ctxB = cB.getContext("2d");

  ctxA.drawImage(imgA, 0, 0);
  ctxB.drawImage(imgB, 0, 0);

  const dataA = ctxA.getImageData(0, 0, w, h).data;
  const dataB = ctxB.getImageData(0, 0, w, h).data;

  const totalPixels = w * h;
  let exactMatchPixels = 0;
  let withinTolerancePixels = 0;
  let sumSquaredDiff = 0;
  let maxChannelDiff = 0;

  for (let i = 0; i < dataA.length; i += 4) {
    const dr = Math.abs(dataA[i] - dataB[i]);
    const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
    const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
    const da = Math.abs(dataA[i + 3] - dataB[i + 3]);

    const maxD = Math.max(dr, dg, db, da);
    if (maxD === 0) exactMatchPixels++;
    if (maxD <= 4) withinTolerancePixels++;
    if (maxD > maxChannelDiff) maxChannelDiff = maxD;

    sumSquaredDiff += dr * dr + dg * dg + db * db;
  }

  const rmsDiff = Math.sqrt(sumSquaredDiff / (totalPixels * 3));
  const result = {
    width: w,
    height: h,
    totalPixels,
    exactMatchPct: Number(((exactMatchPixels / totalPixels) * 100).toFixed(4)),
    withinTolerancePct: Number(
      ((withinTolerancePixels / totalPixels) * 100).toFixed(4),
    ),
    rmsDiff: Number(rmsDiff.toFixed(4)),
    maxChannelDiff,
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB || !fs.existsSync(fileA) || !fs.existsSync(fileB)) {
  console.error("Usage: node CompareScreenshots.cjs <imageA.png> <imageB.png>");
  process.exit(1);
}

compareImages(fileA, fileB).catch((err) => {
  console.error("Comparison failed:", err);
  process.exit(1);
});
