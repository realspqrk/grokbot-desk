// Colour maths for the design tokens (Node and test code): #rrggbb and
// oklch(L C H) to sRGB through Björn Ottosson's OKLab matrices, chroma
// reduced at fixed L and H when outside sRGB, and the WCAG 2.x contrast ratio.
// Mirrors core/colour.py; tests check both against the same vectors.

const OKLCH = /^oklch\(\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:deg)?\s*\)$/i;
const EPSILON = 1e-4;

const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const decode = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function linearOklch(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}
const fits = (rgb) => rgb.every((c) => c >= -EPSILON && c <= 1 + EPSILON);

export function oklchToSrgb(l, c, h) {
  let linear = linearOklch(l, c, h);
  if (!fits(linear)) {
    let low = 0;
    let high = c;
    for (let i = 0; i < 40; i += 1) {
      const middle = (low + high) / 2;
      if (fits(linearOklch(l, middle, h))) low = middle;
      else high = middle;
    }
    linear = linearOklch(l, low, h);
  }
  return linear.map((x) => encode(Math.min(1, Math.max(0, x))));
}

/** sRGB floats 0-1 of an opaque #rrggbb or oklch(L C H). */
export function parseColor(text) {
  const value = String(text).trim();
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  const m = value.match(OKLCH);
  if (!m) throw new Error('expected #rrggbb or oklch(L C H), got ' + text);
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const c = Number(m[3]);
  const h = Number(m[4]);
  if (![l, c, h].every(Number.isFinite)) throw new Error('oklch() component is not a finite number: ' + text);
  if (!(l >= 0 && l <= 1) || c < 0) throw new Error('oklch() out of range: ' + text);
  return oklchToSrgb(l, c, h);
}

export function toHex(rgb) {
  return '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, '0')).join('');
}

export function luminance(value) {
  const [r, g, b] = (typeof value === 'string' ? parseColor(value) : value).map(decode);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
