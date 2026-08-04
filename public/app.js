// All filters run on-device via Canvas 2D pixel math and native compositing.
// No network calls, no accounts, no cost — but also no generative reshaping
// (a photo can be color-graded/painterly-ized, not redrawn as a character).

const MAX_DIM = 1100;

// ---------- low-level canvas helpers ----------

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

function mapPixels(canvas, fn) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imgData = ctx.getImageData(0, 0, width, height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b, a] = fn(d[i], d[i + 1], d[i + 2], d[i + 3]);
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }
  ctx.putImageData(imgData, 0, 0);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, h + 1 / 3) * 255,
    hueToRgb(p, q, h) * 255,
    hueToRgb(p, q, h - 1 / 3) * 255,
  ];
}

function adjustSaturation(canvas, factor) {
  mapPixels(canvas, (r, g, b, a) => {
    const [h, s, l] = rgbToHsl(r, g, b);
    const [nr, ng, nb] = hslToRgb(h, Math.min(1, s * factor), l);
    return [clamp(nr), clamp(ng), clamp(nb), a];
  });
}

function adjustContrast(canvas, amount) {
  const factor = (259 * (amount + 255)) / (255 * (259 - amount));
  mapPixels(canvas, (r, g, b, a) => [
    clamp(factor * (r - 128) + 128),
    clamp(factor * (g - 128) + 128),
    clamp(factor * (b - 128) + 128),
    a,
  ]);
}

function shiftColor(canvas, dr, dg, db) {
  mapPixels(canvas, (r, g, b, a) => [clamp(r + dr), clamp(g + dg), clamp(b + db), a]);
}

function grayscale(canvas) {
  mapPixels(canvas, (r, g, b, a) => {
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    return [l, l, l, a];
  });
}

function posterize(canvas, levels) {
  const step = 255 / (levels - 1);
  mapPixels(canvas, (r, g, b, a) => [
    Math.round(r / step) * step,
    Math.round(g / step) * step,
    Math.round(b / step) * step,
    a,
  ]);
}

function applyVignette(canvas, strength = 0.3) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const grad = ctx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.3,
    width / 2, height / 2, Math.max(width, height) * 0.75
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function applyBloom(canvas, { blur = 20, threshold = 180, opacity = 0.5, blend = 'screen' } = {}) {
  const { width, height } = canvas;
  const bright = cloneCanvas(canvas);
  mapPixels(bright, (r, g, b, a) => {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum < threshold ? [0, 0, 0, a] : [r, g, b, a];
  });
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = blend;
  ctx.drawImage(bright, 0, 0, width, height);
  ctx.restore();
}

function sobelEdges(canvas, threshold = 50) {
  const { width, height } = canvas;
  const src = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    gray[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }
  const out = new ImageData(width, height);
  const od = out.data;
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sx = 0, sy = 0, k = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const val = gray[(y + ky) * width + (x + kx)];
          sx += val * gx[k];
          sy += val * gy[k];
          k++;
        }
      }
      const mag = Math.sqrt(sx * sx + sy * sy);
      const idx = (y * width + x) * 4;
      const isEdge = mag > threshold;
      od[idx] = od[idx + 1] = od[idx + 2] = 0;
      od[idx + 3] = isEdge ? 255 : 0;
    }
  }
  return out;
}

// ---------- filters ----------

const FILTERS = {
  vintage: {
    label: 'Vintage Sepia', emoji: '🎞️',
    apply(canvas) {
      mapPixels(canvas, (r, g, b, a) => {
        const tr = 0.393 * r + 0.769 * g + 0.189 * b;
        const tg = 0.349 * r + 0.686 * g + 0.168 * b;
        const tb = 0.272 * r + 0.534 * g + 0.131 * b;
        return [clamp(tr * 0.75 + r * 0.25), clamp(tg * 0.75 + g * 0.25), clamp(tb * 0.75 + b * 0.25), a];
      });
      adjustContrast(canvas, -8);
      applyVignette(canvas, 0.28);
    },
  },
  bw: {
    label: 'Classic B&W', emoji: '⚪',
    apply(canvas) { grayscale(canvas); adjustContrast(canvas, 12); },
  },
  noir: {
    label: 'Noir', emoji: '🕶️',
    apply(canvas) { grayscale(canvas); adjustContrast(canvas, 45); applyVignette(canvas, 0.42); },
  },
  vivid: {
    label: 'Vivid', emoji: '🌈',
    apply(canvas) { adjustSaturation(canvas, 1.55); adjustContrast(canvas, 15); },
  },
  warm: {
    label: 'Golden Warm', emoji: '☀️',
    apply(canvas) { shiftColor(canvas, 18, 6, -14); adjustSaturation(canvas, 1.1); },
  },
  cool: {
    label: 'Cool Blue', emoji: '❄️',
    apply(canvas) { shiftColor(canvas, -14, 2, 22); adjustSaturation(canvas, 1.05); },
  },
  faded: {
    label: 'Faded Matte', emoji: '🌫️',
    apply(canvas) {
      adjustContrast(canvas, -25);
      adjustSaturation(canvas, 0.8);
      mapPixels(canvas, (r, g, b, a) => [
        clamp(r * 0.92 + 235 * 0.08), clamp(g * 0.92 + 230 * 0.08), clamp(b * 0.92 + 220 * 0.08), a,
      ]);
    },
  },
  cinematic: {
    label: 'Cinematic', emoji: '🎬',
    apply(canvas) {
      mapPixels(canvas, (r, g, b, a) => {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        return lum > 128 ? [clamp(r + 16), clamp(g + 6), clamp(b - 8), a] : [clamp(r - 8), clamp(g + 2), clamp(b + 16), a];
      });
      adjustContrast(canvas, 18);
      adjustSaturation(canvas, 1.15);
    },
  },
  neon: {
    label: 'Neon Cyberpunk', emoji: '🌆',
    apply(canvas) {
      adjustSaturation(canvas, 1.6);
      shiftColor(canvas, -6, 0, 18);
      adjustContrast(canvas, 20);
      applyBloom(canvas, { blur: 18, threshold: 170, opacity: 0.5, blend: 'screen' });
      applyVignette(canvas, 0.4);
    },
  },
  animeGlow: {
    label: 'Anime Sky Glow', emoji: '🌅',
    apply(canvas) {
      mapPixels(canvas, (r, g, b, a) => {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        return lum > 140 ? [clamp(r + 18), clamp(g + 8), clamp(b - 4), a] : [clamp(r - 4), clamp(g + 2), clamp(b + 18), a];
      });
      adjustSaturation(canvas, 1.35);
      adjustContrast(canvas, 12);
      applyBloom(canvas, { blur: 24, threshold: 150, opacity: 0.4, blend: 'screen' });
      applyVignette(canvas, 0.2);
    },
  },
  popart: {
    label: 'Comic Pop Art', emoji: '💥',
    apply(canvas) {
      const edgeSrc = cloneCanvas(canvas);
      adjustSaturation(canvas, 1.6);
      adjustContrast(canvas, 20);
      posterize(canvas, 4);
      const edgeData = sobelEdges(edgeSrc, 50);
      const edgeCanvas = document.createElement('canvas');
      edgeCanvas.width = canvas.width;
      edgeCanvas.height = canvas.height;
      edgeCanvas.getContext('2d').putImageData(edgeData, 0, 0);
      canvas.getContext('2d').drawImage(edgeCanvas, 0, 0);
    },
  },
  sketch: {
    label: 'Pencil Sketch', emoji: '✏️',
    apply(canvas) {
      grayscale(canvas);
      const inv = cloneCanvas(canvas);
      mapPixels(inv, (r, g, b, a) => [255 - r, 255 - g, 255 - b, a]);
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.filter = 'blur(8px)';
      ctx.globalCompositeOperation = 'color-dodge';
      ctx.drawImage(inv, 0, 0);
      ctx.restore();
    },
  },
  pixelart: {
    label: 'Pixel Art', emoji: '👾',
    apply(canvas) {
      const { width, height } = canvas;
      const blockSize = Math.max(4, Math.round(Math.min(width, height) / 64));
      const smallW = Math.max(1, Math.round(width / blockSize));
      const smallH = Math.max(1, Math.round(height / blockSize));
      const small = document.createElement('canvas');
      small.width = smallW; small.height = smallH;
      const sctx = small.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(canvas, 0, 0, smallW, smallH);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(small, 0, 0, smallW, smallH, 0, 0, width, height);
      posterize(canvas, 5);
      adjustSaturation(canvas, 1.2);
    },
  },
  claymation: {
    label: 'Claymation', emoji: '🧱',
    apply(canvas) {
      const blurred = cloneCanvas(canvas);
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.filter = 'blur(2.5px)';
      ctx.drawImage(blurred, 0, 0);
      ctx.restore();
      posterize(canvas, 7);
      shiftColor(canvas, 8, 4, -4);
      adjustContrast(canvas, 8);
    },
  },
};

// ---------- app wiring ----------

const dropzone = document.getElementById('dropzone');
const dropzoneEmpty = document.getElementById('dropzone-empty');
const fileInput = document.getElementById('file-input');
const previewImg = document.getElementById('preview-img');
const changePhotoBtn = document.getElementById('change-photo-btn');
const stylesSection = document.getElementById('styles-section');
const stylesGrid = document.getElementById('styles-grid');
const resultsSection = document.getElementById('results-section');
const resultsGrid = document.getElementById('results-grid');
const toast = document.getElementById('toast');

let sourceCanvas = null;
let toastTimer = null;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function loadStyles() {
  stylesGrid.innerHTML = '';
  for (const [key, { label, emoji }] of Object.entries(FILTERS)) {
    const btn = document.createElement('button');
    btn.className = 'style-btn';
    btn.dataset.style = key;
    btn.innerHTML = `<span class="emoji">${emoji}</span><span>${label}</span>`;
    btn.addEventListener('click', () => applyFilter(key, label));
    stylesGrid.appendChild(btn);
  }
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
changePhotoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.value = '';
  fileInput.click();
});

function loadFileToCanvas(file, maxDim = MAX_DIM) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(img.src);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function handleFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file.');
    return;
  }

  try {
    sourceCanvas = await loadFileToCanvas(file);
  } catch {
    showToast('Could not read that image. Try a different file.');
    return;
  }

  previewImg.src = sourceCanvas.toDataURL('image/jpeg', 0.92);
  previewImg.hidden = false;
  dropzoneEmpty.hidden = true;
  changePhotoBtn.hidden = false;
  stylesSection.hidden = false;
  resultsSection.hidden = true;
  resultsGrid.innerHTML = '';
}

function applyFilter(styleKey, label) {
  if (!sourceCanvas) return;

  resultsSection.hidden = false;
  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-placeholder" style="aspect-ratio:1/1;">
      <div class="spinner"></div>
    </div>
    <div class="result-body"><strong>${label}</strong></div>
  `;
  resultsGrid.prepend(card);

  const styleBtn = stylesGrid.querySelector(`[data-style="${styleKey}"]`);
  if (styleBtn) styleBtn.disabled = true;

  // Let the placeholder paint before the (synchronous, occasionally heavy) filter work runs.
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const working = cloneCanvas(sourceCanvas);
        FILTERS[styleKey].apply(working);
        const dataUrl = working.toDataURL('image/jpeg', 0.92);

        card.innerHTML = `
          <img src="${dataUrl}" alt="${label} styled result" />
          <div class="result-body">
            <strong>${label}</strong>
            <button class="primary download-btn">Download</button>
          </div>
        `;
        card.querySelector('.download-btn').addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = `${styleKey}-${Date.now()}.jpg`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
      } catch (err) {
        console.error(err);
        card.remove();
        showToast('Something went wrong applying that filter.');
      } finally {
        if (styleBtn) styleBtn.disabled = false;
      }
    }, 0);
  });
}

loadStyles();
