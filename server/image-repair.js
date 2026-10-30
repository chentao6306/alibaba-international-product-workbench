// Copy a matching background patch, preserving texture and all pixels outside
// the selection. Never stretch a product-edge pixel across the repair area.
import sharp from 'sharp';

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;

export async function textureRepair(data, info, mask, sample) {
  const { width, height, channels } = info;
  let donor;
  if (sample != null) {
    if (![sample.x, sample.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('请在图片上选择有效的背景取样点');
    donor = { x: clamp(Math.round(sample.x * width - mask.width / 2), 0, width - mask.width),
      y: clamp(Math.round(sample.y * height - mask.height / 2), 0, height - mask.height), width: mask.width, height: mask.height };
    if (overlaps(donor, mask)) throw new Error('背景取样区域不能与水印区域重叠，请选择旁边的干净背景');
  } else {
    const scale = Math.min(1, 384 / Math.max(width, height));
    const sw = Math.max(1, Math.round(width * scale)), sh = Math.max(1, Math.round(height * scale));
    const small = await sharp(data, { raw: info }).resize(sw, sh, { fit: 'fill' }).raw().toBuffer();
    const m = { x: Math.floor(mask.x * sw / width), y: Math.floor(mask.y * sh / height),
      width: Math.max(1, Math.ceil(mask.width * sw / width)), height: Math.max(1, Math.ceil(mask.height * sh / height)) };
    const border = [];
    for (let i = 0; i < 12; i++) {
      const x = Math.floor(i * (m.width - 1) / 11), y = Math.floor(i * (m.height - 1) / 11);
      if (m.y > 0) border.push([x, -1]);
      if (m.y + m.height < sh) border.push([x, m.height]);
      if (m.x > 0) border.push([-1, y]);
      if (m.x + m.width < sw) border.push([m.width, y]);
    }
    const pixel = (x, y, c) => small[(clamp(y, 0, sh - 1) * sw + clamp(x, 0, sw - 1)) * channels + c];
    const background = [0, 1, 2].map(c => median(border.map(([x, y]) => pixel(m.x + x, m.y + y, c))));
    const step = Math.max(1, Math.floor(Math.min(m.width, m.height) / 8));
    let best = Infinity;
    const score = (x, y) => {
      const candidate = { x, y, width: m.width, height: m.height };
      // Leave a margin so resized mask colours cannot leak into the sample.
      if (overlaps(candidate, { x: m.x - 2, y: m.y - 2, width: m.width + 4, height: m.height + 4 })) return;
      const distance = Math.hypot(x - m.x, y - m.y);
      const differences = border.map(([dx, dy]) => [0, 1, 2].reduce((sum, c) => sum + Math.abs(pixel(m.x + dx, m.y + dy, c) - pixel(x + dx, y + dy, c)), 0) / 3).sort((a, b) => a - b);
      // A product may abut one side of the watermark. Discard that side's
      // outliers instead of using the dark product as background paint.
      const retained = differences.slice(0, Math.max(1, Math.floor(differences.length * 0.72)));
      let contrast = 0, peak = 0, edge = 0;
      for (let iy = 0; iy < 12; iy++) for (let ix = 0; ix < 12; ix++) {
        const sx = x + Math.floor(ix * (m.width - 1) / 11), sy = y + Math.floor(iy * (m.height - 1) / 11);
        const delta = [0, 1, 2].reduce((sum, c) => sum + Math.abs(pixel(sx, sy, c) - background[c]), 0) / 3;
        contrast += delta; peak = Math.max(peak, delta);
        for (const [px, py] of [[ix - 1, iy], [ix, iy - 1]]) if (px >= 0 && py >= 0) {
          const nx = x + Math.floor(px * (m.width - 1) / 11), ny = y + Math.floor(py * (m.height - 1) / 11);
          edge = Math.max(edge, [0, 1, 2].reduce((sum, c) => sum + Math.abs(pixel(sx, sy, c) - pixel(nx, ny, c)), 0) / 3);
        }
      }
      const cost = retained.reduce((sum, value) => sum + value, 0) / retained.length + contrast / 144 * 0.45
        + Math.max(0, peak - 50) * 2 + Math.max(0, edge - 12) * 2 + distance / Math.max(sw, sh) * 3;
      if (cost < best) { best = cost; donor = candidate; }
    };
    for (let y = 0; y <= sh - m.height; y += step) {
      if (y % (step * 12) === 0) await new Promise(resolve => setImmediate(resolve));
      for (let x = 0; x <= sw - m.width; x += step) score(x, y);
    }
    if (!donor) throw new Error('没有找到足够的背景区域，请缩小水印框或手动选择背景取样点');
    const coarse = { ...donor };
    for (let y = Math.max(0, coarse.y - step); y <= Math.min(sh - m.height, coarse.y + step); y++)
      for (let x = Math.max(0, coarse.x - step); x <= Math.min(sw - m.width, coarse.x + step); x++) score(x, y);
    donor = { x: clamp(Math.round(donor.x * width / sw), 0, width - mask.width),
      y: clamp(Math.round(donor.y * height / sh), 0, height - mask.height), width: mask.width, height: mask.height };
    if (overlaps(donor, mask)) throw new Error('背景区域与水印太近，请手动选择背景取样点');
  }
  const result = Buffer.from(data);
  // Match the local lighting with a robust plane, excluding nearby product
  // edges. This changes colour gently while retaining donor texture.
  const samples = [];
  for (let i = 0; i < 24; i++) {
    const x = Math.round(i * (mask.width - 1) / 23), y = Math.round(i * (mask.height - 1) / 23);
    for (const [dx, dy] of [[x, -1], [x, mask.height], [-1, y], [mask.width, y]]) {
      const tx = mask.x + dx, ty = mask.y + dy, sx = donor.x + dx, sy = donor.y + dy;
      if (Math.min(tx, ty, sx, sy) < 0 || tx >= width || sx >= width || ty >= height || sy >= height) continue;
      samples.push({ xy: [1, dx / mask.width, dy / mask.height], delta: [0, 1, 2].map(c => data[(ty * width + tx) * channels + c] - data[(sy * width + sx) * channels + c]) });
    }
  }
  const planes = [0, 1, 2].map(c => {
    let fit = [median(samples.map(s => s.delta[c])), 0, 0];
    for (let iteration = 0; iteration < 4; iteration++) {
      const ranked = samples.map(s => ({ ...s, residual: Math.abs(s.delta[c] - s.xy.reduce((sum, v, i) => sum + v * fit[i], 0)) }))
        .sort((a, b) => a.residual - b.residual).slice(0, Math.max(3, Math.floor(samples.length * 0.7)));
      const matrix = Array.from({ length: 3 }, (_, i) => [0, 1, 2].map(j => ranked.reduce((sum, s) => sum + s.xy[i] * s.xy[j], 0))
        .concat(ranked.reduce((sum, s) => sum + s.xy[i] * s.delta[c], 0)));
      let valid = true;
      for (let i = 0; i < 3; i++) {
        let pivot = i;
        for (let j = i + 1; j < 3; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
        [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
        const scale = matrix[i][i];
        if (Math.abs(scale) < 1e-8) { valid = false; break; }
        matrix[i] = matrix[i].map(v => v / scale);
        for (let j = 0; j < 3; j++) if (j !== i) {
          const scale = matrix[j][i]; matrix[j] = matrix[j].map((v, k) => v - scale * matrix[i][k]);
        }
      }
      if (valid) fit = matrix.map(row => row[3]);
    }
    return fit;
  });
  const gw = Math.max(3, Math.min(48, mask.width + 2)), gh = Math.max(3, Math.min(48, mask.height + 2));
  const lighting = new Float32Array(gw * gh * 3);
  if (!sample) {
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const dx = Math.round(gx / (gw - 1) * (mask.width + 1)) - 1;
      const dy = Math.round(gy / (gh - 1) * (mask.height + 1)) - 1;
      const tx = clamp(mask.x + dx, 0, width - 1), ty = clamp(mask.y + dy, 0, height - 1);
      const sx = clamp(donor.x + dx, 0, width - 1), sy = clamp(donor.y + dy, 0, height - 1);
      const plane = planes.map(([a, b, d]) => clamp(a + b * dx / mask.width + d * dy / mask.height, -48, 48));
      const delta = plane.map((_, c) => data[(ty * width + tx) * channels + c] - data[(sy * width + sx) * channels + c]);
      const edge = gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1;
      const background = delta.every((value, c) => Math.abs(value - plane[c]) <= 32);
      for (let c = 0; c < 3; c++) lighting[(gy * gw + gx) * 3 + c] = edge && background ? delta[c] : plane[c];
    }
    for (let iteration = 0; iteration < 140; iteration++) {
      if (iteration % 20 === 0) await new Promise(resolve => setImmediate(resolve));
      for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) for (let c = 0; c < 3; c++) {
        const at = (y * gw + x) * 3 + c;
        lighting[at] += 1.5 * ((lighting[at - 3] + lighting[at + 3] + lighting[at - gw * 3] + lighting[at + gw * 3]) / 4 - lighting[at]);
      }
    }
  }
  for (let y = 0; y < mask.height; y++) {
    if (y % 32 === 0) await new Promise(resolve => setImmediate(resolve));
    const from = ((donor.y + y) * width + donor.x) * channels;
    const to = ((mask.y + y) * width + mask.x) * channels;
    data.copy(result, to, from, from + mask.width * channels);
    for (let x = 0; x < mask.width; x++) for (let c = 0; c < Math.min(3, channels); c++) {
      const gx = (x + 1) / (mask.width + 1) * (gw - 1), gy = (y + 1) / (mask.height + 1) * (gh - 1);
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const at = (iy * gw + ix) * 3 + c;
      const offset = sample ? 0 : (lighting[at] * (1 - fx) + lighting[at + 3] * fx) * (1 - fy)
        + (lighting[at + gw * 3] * (1 - fx) + lighting[at + gw * 3 + 3] * fx) * fy;
      result[to + x * channels + c] = clamp(Math.round(result[to + x * channels + c] + offset), 0, 255);
    }
  }
  return result;
}
