import { inflateSync } from 'node:zlib';

export const CALM_THRESHOLDS = Object.freeze({
  // Provisional owner amendments are documented in docs/calm-checker-limits.md.
  itemInteractiveMax: 3,
  iconControlMaxPx: 32,
  fontSizeMax: 3,
  fontWeightMax: 2,
  boxAncestorMax: 1,
  colorSaturationMin: 20,
  colorLightnessMin: 10,
  colorLightnessMax: 90,
  accentHueTolerance: 15,
  statusViewportAreaMax: 0.005,
  itemGapMinPx: 16,
  readingWidthMaxCh: 72,
  backgroundRatioMin: 0.45,
  backgroundChannelTolerance: 2,
  aboveFoldInteractiveMax: 12,
  socialMockupMinPx: 480,
  motionMaxMs: 200,
});

export function focusedControlFacts() {
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) {
    return { focused: false, copy_control: false, visible: false };
  }
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const parseColor = (value) => {
    const match = String(value || '').match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/u,
    );
    return match ? {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    } : null;
  };
  const composite = (foreground, background) => {
    if (!foreground || foreground.a <= 0) return background;
    const alpha = foreground.a + background.a * (1 - foreground.a);
    return {
      r: (foreground.r * foreground.a
        + background.r * background.a * (1 - foreground.a)) / alpha,
      g: (foreground.g * foreground.a
        + background.g * background.a * (1 - foreground.a)) / alpha,
      b: (foreground.b * foreground.a
        + background.b * background.a * (1 - foreground.a)) / alpha,
      a: alpha,
    };
  };
  const backgroundChain = [];
  for (let current = element.parentElement; current; current = current.parentElement) {
    backgroundChain.push(current);
  }
  let outlineBackground = { r: 255, g: 255, b: 255, a: 1 };
  for (const current of backgroundChain.reverse()) {
    outlineBackground = composite(
      parseColor(getComputedStyle(current).backgroundColor),
      outlineBackground,
    );
  }
  const relativeLuminance = (color) => {
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r)
      + 0.7152 * channel(color.g)
      + 0.0722 * channel(color.b);
  };
  const contrastRatio = (left, right) => {
    const bright = Math.max(relativeLuminance(left), relativeLuminance(right));
    const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
    return (bright + 0.05) / (dark + 0.05);
  };
  let effectiveOpacity = 1;
  let ancestorsVisible = true;
  let painted = rect.width > 0 && rect.height > 0;
  let paintedLeft = rect.left;
  let paintedTop = rect.top;
  let paintedRight = rect.right;
  let paintedBottom = rect.bottom;
  for (let current = element; current; current = current.parentElement) {
    const currentStyle = getComputedStyle(current);
    effectiveOpacity *= Number.parseFloat(currentStyle.opacity || '1');
    if (
      currentStyle.display === 'none'
      || ['hidden', 'collapse'].includes(currentStyle.visibility)
    ) {
      ancestorsVisible = false;
      break;
    }
    const clipsX = ['hidden', 'clip'].includes(currentStyle.overflowX);
    const clipsY = ['hidden', 'clip'].includes(currentStyle.overflowY);
    if (clipsX || clipsY) {
      const clip = current.getBoundingClientRect();
      if (clipsX) {
        paintedLeft = Math.max(paintedLeft, clip.left);
        paintedRight = Math.min(paintedRight, clip.right);
      }
      if (clipsY) {
        paintedTop = Math.max(paintedTop, clip.top);
        paintedBottom = Math.min(paintedBottom, clip.bottom);
      }
      painted = painted && paintedRight > paintedLeft && paintedBottom > paintedTop;
    }
  }
  const inViewport = paintedRight > 0 && paintedBottom > 0
    && paintedLeft < innerWidth && paintedTop < innerHeight;
  const copyControl = Boolean(element.closest(
    'rs-copy,[data-copy-id],[data-rs-copy]',
  ));
  const outline = parseColor(style.outlineColor);
  const paintedOutline = outline
    ? composite({ ...outline, a: outline.a * effectiveOpacity }, outlineBackground)
    : null;
  const outlineContrast = paintedOutline
    ? contrastRatio(paintedOutline, outlineBackground)
    : 0;
  return {
    focused: true,
    copy_control: copyControl,
    visible: painted
      && ancestorsVisible
      && effectiveOpacity > 0.05
      && inViewport,
    opacity: effectiveOpacity,
    identity: element.dataset?.rsTabAuditId || element.id || element.getAttribute('aria-label')
      || element.textContent?.trim().slice(0, 80) || element.tagName,
    key: element.dataset?.rsTabAuditKey || null,
    tag: element.tagName,
    outline_width: Number.parseFloat(style.outlineWidth) || 0,
    outline_style: style.outlineStyle,
    outline_color: style.outlineColor,
    outline_contrast: outlineContrast,
    outline_visible: Boolean(
      outline
      && outline.a * effectiveOpacity > 0.05
      && outlineContrast >= 3,
    ),
  };
}

async function settledFocusedControl(page, timeout = CALM_THRESHOLDS.motionMaxMs + 50) {
  const deadline = Date.now() + timeout;
  let current;
  do {
    current = await page.evaluate(focusedControlFacts);
    if (
      current
      && current.visible
      && current.outline_width >= 2
      && current.outline_style !== 'none'
      && current.outline_visible
    ) return current;
    if (Date.now() < deadline) {
      if (page.waitForTimeout) await page.waitForTimeout(10);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } while (Date.now() < deadline);
  return current;
}

async function auditCopyFocusState(page, stateIndex) {
  const setup = await page.evaluate((auditState) => {
    const openedDetails = [...document.querySelectorAll('details:not([open])')]
      .filter((details) => details.querySelector(
        'rs-copy button,[data-copy-id] button,button[data-copy-id],[data-rs-copy]',
      ));
    openedDetails.forEach((details) => {
      details.dataset.rsCalmTemporarilyOpened = '1';
      details.open = true;
    });
    const controls = [...document.querySelectorAll(
      'rs-copy button,[data-copy-id] button,button[data-copy-id],[data-rs-copy]',
    )].filter((element) => {
      if (element.closest('[inert]') || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && !['hidden', 'collapse'].includes(style.visibility);
    });
    const identities = controls.map((element, index) => {
      element.dataset.rsCalmCopyId = `copy-${auditState}-${index}`;
      return `copy-${auditState}-${index}`;
    });
    const focusableSelector = 'button,input,select,textarea,a[href],summary,[tabindex]';
    const candidates = [...document.querySelectorAll(focusableSelector)]
      .filter((element) => {
        if (element.disabled || element.closest('[inert]') || element.tabIndex < 0) return false;
        const closed = element.closest('details:not([open])');
        if (closed && !(element.tagName === 'SUMMARY' && element.parentElement === closed)) {
          return false;
        }
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && !['hidden', 'collapse'].includes(style.visibility)
          && element.getClientRects().length > 0;
      });
    const groupSelector = '[role=radiogroup],[role=toolbar],[role=tablist]';
    const groupMembers = new Map();
    for (const element of candidates) {
      const group = element.closest(groupSelector);
      if (!group) continue;
      if (!groupMembers.has(group)) groupMembers.set(group, []);
      groupMembers.get(group).push(element);
    }
    const rovingGroups = new Set(
      [...groupMembers].filter(([, members]) => (
        members.length > 1
        && members.filter((element) => element.tabIndex === 0).length === 1
        && members.every((element) => element.tabIndex <= 0)
      )).map(([group]) => group),
    );
    const keys = new Set();
    for (const element of candidates.filter((candidate) => candidate.tabIndex >= 0)) {
      const nativeRadio = element.matches('input[type=radio][name]')
        ? `radio:${element.form?.id || 'no-form'}:${element.name}`
        : null;
      const roving = element.closest(groupSelector);
      keys.add(nativeRadio || (
        roving && rovingGroups.has(roving)
          ? `group:${roving.id || [...document.querySelectorAll(groupSelector)].indexOf(roving)}`
          : `control:${candidates.indexOf(element)}`
      ));
    }
    return {
      identities,
      openedDetails: openedDetails.length,
      tabStops: keys.size,
    };
  }, stateIndex);
  const controls = [];
  const remaining = new Set(setup.identities);
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.body.tabIndex = -1;
    document.body.focus();
  });
  const captureFocusedCopy = async () => {
    const current = await settledFocusedControl(page);
    const calmId = await page.evaluate(
      () => document.activeElement?.dataset?.rsCalmCopyId || null,
    );
    if (!calmId || !remaining.has(calmId)) return;
    controls.push({
      selector: `[data-rs-calm-copy-id="${calmId}"]`,
      expected_identity: calmId,
      actual_identity: calmId,
      ...current,
    });
    remaining.delete(calmId);
  };
  const maxStops = setup.tabStops + 1;
  for (let index = 0; index < maxStops && remaining.size; index += 1) {
    await page.keyboard.press('Tab');
    await captureFocusedCopy();
    const rovingMembers = await page.evaluate(() => {
      const groupSelector = '[role=radiogroup],[role=toolbar],[role=tablist]';
      const group = document.activeElement?.closest?.(groupSelector);
      if (!group) return 0;
      const members = [...group.querySelectorAll(
        'button,input,select,textarea,a[href],summary,[tabindex]',
      )].filter((element) => element.closest(groupSelector) === group);
      return members.length > 1
        && members.filter((element) => element.tabIndex === 0).length === 1
        && members.every((element) => element.tabIndex <= 0)
        ? members.length
        : 0;
    });
    for (let step = 0; step < rovingMembers && remaining.size; step += 1) {
      await page.keyboard.press('ArrowRight');
      await captureFocusedCopy();
    }
  }
  for (const identity of remaining) {
    controls.push({
      selector: `[data-rs-calm-copy-id="${identity}"]`,
      expected_identity: identity,
      actual_identity: null,
      focused: false,
      copy_control: true,
      visible: false,
    });
  }
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.body.removeAttribute('tabindex');
    for (const details of document.querySelectorAll('[data-rs-calm-temporarily-opened]')) {
      details.open = false;
      delete details.dataset.rsCalmTemporarilyOpened;
    }
  });
  return {
    pass: controls.length === setup.identities.length
      && controls.every((item) => (
        item.focused
        && item.copy_control
        && item.visible
        && item.outline_width >= 2
        && item.outline_style !== 'none'
        && item.outline_visible
        && item.actual_identity === item.expected_identity
      )),
    controls,
  };
}

export async function auditCopyFocus(page, revealCopies = null) {
  const states = [];
  const visit = async () => {
    states.push(await auditCopyFocusState(page, states.length));
  };
  await visit();
  if (revealCopies) await revealCopies(visit);
  return {
    pass: states.every((state) => state.pass),
    controls: states.flatMap((state) => state.controls),
    states: states.length,
  };
}

export async function auditPlatformSwitching(page) {
  return page.evaluate(async (minimumWidth) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (
          style.display === 'none'
          || ['hidden', 'collapse'].includes(style.visibility)
          || Number.parseFloat(style.opacity || '1') <= 0.05
        ) return false;
      }
      return true;
    };
    const container = document.querySelector('[role=tablist]')
      || [...document.querySelectorAll('[role=group]')].find((group) => (
        group.querySelectorAll('button[aria-pressed]').length > 0
      ));
    if (!container || !visible(container)) {
      return {
        kind: null,
        controls: 0,
        stateful_controls: 0,
        reachable_controls: 0,
        single_mockup_each: false,
      };
    }
    const kind = container.getAttribute('role') === 'tablist' ? 'tablist' : 'segmented';
    const controls = kind === 'tablist'
      ? [...container.querySelectorAll('[role=tab]')]
      : [...container.querySelectorAll('button[aria-pressed]')];
    const approvalPattern = /\b(?:approved|pending|rejected|draft|freigegeben|ausstehend|abgelehnt|entwurf)\b/iu;
    const stateful = controls.filter((control) => {
      const explicit = control.getAttribute('data-rs-approval-state') || '';
      const label = [
        control.getAttribute('aria-label') || '',
        control.textContent || '',
        ...[...control.querySelectorAll('[data-rs-status]')].flatMap((status) => [
          status.getAttribute('aria-label') || '',
          status.textContent || '',
        ]),
      ].join(' ');
      return approvalPattern.test(explicit) || approvalPattern.test(label);
    });
    let reachable = 0;
    let singleMockupEach = controls.length > 0;
    for (const control of controls) {
      control.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const selected = kind === 'tablist'
        ? control.getAttribute('aria-selected') === 'true'
        : control.getAttribute('aria-pressed') === 'true';
      const mockups = [...document.querySelectorAll('[data-rs-mockup]')]
        .filter(visible)
        .filter((mockup) => mockup.getBoundingClientRect().width >= minimumWidth);
      let corresponding = mockups.length === 1;
      const controlsId = control.getAttribute('aria-controls');
      if (controlsId) {
        const target = document.getElementById(controlsId);
        corresponding = corresponding && Boolean(
          target
          && (
            target === mockups[0]
            || (target.getAttribute('role') === 'tabpanel' && target.contains(mockups[0]))
          )
        );
      }
      if (selected && corresponding) reachable += 1;
      if (!(selected && corresponding)) singleMockupEach = false;
    }
    return {
      kind,
      controls: controls.length,
      stateful_controls: stateful.length,
      reachable_controls: reachable,
      single_mockup_each: singleMockupEach,
    };
  }, CALM_THRESHOLDS.socialMockupMinPx);
}

export function calmEvaluator(options) {
  const thresholds = options.thresholds;
  const verifiedRovingGroups = new Set(options.verifiedRovingGroups || []);
  const interactiveSelector = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[role="tab"]', '[role="radio"]',
    '[role="checkbox"]', '[role="switch"]', '[role="menuitem"]',
    '[tabindex]',
  ].join(',');
  const semanticInteractiveSelector = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[role="tab"]', '[role="radio"]',
    '[role="checkbox"]', '[role="switch"]', '[role="menuitem"]',
  ].join(',');
  const elements = [...document.querySelectorAll('body *')];
  const rectOf = (element) => element.getBoundingClientRect();
  const visible = (element) => {
    const rect = rectOf(element);
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === 'none'
        || ['hidden', 'collapse'].includes(style.visibility)
        || Number.parseFloat(style.opacity || '1') <= 0.05
      ) return false;
    }
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
      innerWidth,
    );
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      innerHeight,
    );
    return rect.right > 0 && rect.bottom > 0
      && rect.left < documentWidth && rect.top < documentHeight;
  };
  const interactive = (element) => (
    element.matches(semanticInteractiveSelector)
    || (element.matches('[tabindex]') && element.tabIndex >= 0)
  );
  const focusable = (element) => (
    element.matches(interactiveSelector)
    && !element.disabled
    && element.tabIndex >= 0
  );
  const identity = (element) => {
    if (element.id) return `#${element.id}`;
    const marker = ['data-rs-primary', 'data-rs-item', 'data-rs-mockup']
      .find((name) => element.hasAttribute(name));
    if (marker) {
      const peers = [...document.querySelectorAll(`[${marker}]`)];
      return `[${marker}]:${peers.indexOf(element)}`;
    }
    const peers = [...element.parentElement?.children || []];
    return `${element.tagName.toLowerCase()}:${peers.indexOf(element)}`;
  };
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = 1;
  colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
  const parseColor = (value) => {
    const text = String(value || '').trim();
    if (!text || (!CSS.supports('color', text) && text !== 'transparent')) return null;
    const hex = String(value).trim().match(/^#([\da-f]{6})$/iu);
    if (hex) {
      return {
        r: Number.parseInt(hex[1].slice(0, 2), 16),
        g: Number.parseInt(hex[1].slice(2, 4), 16),
        b: Number.parseInt(hex[1].slice(4, 6), 16),
        a: 1,
      };
    }
    const match = String(value).match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/u,
    );
    if (match) {
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4]),
      };
    }
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = text;
    colorContext.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: alpha / 255 };
  };
  const luminance = (color) => (
    (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255
  );
  const hsl = (color) => {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: lightness * 100 };
    const delta = max - min;
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    return { h: (hue + 360) % 360, s: saturation * 100, l: lightness * 100 };
  };
  const hueDistance = (left, right) => {
    const delta = Math.abs(left - right) % 360;
    return Math.min(delta, 360 - delta);
  };
  const lab = (color) => {
    const linear = (channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    };
    const r = linear(color.r);
    const g = linear(color.g);
    const b = linear(color.b);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = (value) => (
      value > 216 / 24389
        ? Math.cbrt(value)
        : (24389 / 27 * value + 16) / 116
    );
    return {
      l: 116 * f(y) - 16,
      a: 500 * (f(x) - f(y)),
      b: 200 * (f(y) - f(z)),
    };
  };
  const deltaE2000 = (leftColor, rightColor) => {
    const left = lab(leftColor);
    const right = lab(rightColor);
    const c1 = Math.hypot(left.a, left.b);
    const c2 = Math.hypot(right.a, right.b);
    const meanC = (c1 + c2) / 2;
    const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
    const a1 = (1 + g) * left.a;
    const a2 = (1 + g) * right.a;
    const adjustedC1 = Math.hypot(a1, left.b);
    const adjustedC2 = Math.hypot(a2, right.b);
    const hue = (a, b) => {
      const degrees = Math.atan2(b, a) * 180 / Math.PI;
      return degrees >= 0 ? degrees : degrees + 360;
    };
    const h1 = hue(a1, left.b);
    const h2 = hue(a2, right.b);
    const deltaL = right.l - left.l;
    const deltaC = adjustedC2 - adjustedC1;
    let deltaHue = h2 - h1;
    if (adjustedC1 * adjustedC2 === 0) deltaHue = 0;
    else if (deltaHue > 180) deltaHue -= 360;
    else if (deltaHue < -180) deltaHue += 360;
    const deltaH = 2 * Math.sqrt(adjustedC1 * adjustedC2)
      * Math.sin(deltaHue * Math.PI / 360);
    const meanL = (left.l + right.l) / 2;
    const adjustedMeanC = (adjustedC1 + adjustedC2) / 2;
    let meanHue = h1 + h2;
    if (adjustedC1 * adjustedC2 === 0) meanHue = h1 + h2;
    else if (Math.abs(h1 - h2) <= 180) meanHue /= 2;
    else if (h1 + h2 < 360) meanHue = (h1 + h2 + 360) / 2;
    else meanHue = (h1 + h2 - 360) / 2;
    const t = 1
      - 0.17 * Math.cos((meanHue - 30) * Math.PI / 180)
      + 0.24 * Math.cos(2 * meanHue * Math.PI / 180)
      + 0.32 * Math.cos((3 * meanHue + 6) * Math.PI / 180)
      - 0.20 * Math.cos((4 * meanHue - 63) * Math.PI / 180);
    const sl = 1 + 0.015 * (meanL - 50) ** 2 / Math.sqrt(20 + (meanL - 50) ** 2);
    const sc = 1 + 0.045 * adjustedMeanC;
    const sh = 1 + 0.015 * adjustedMeanC * t;
    const rotation = 30 * Math.exp(-(((meanHue - 275) / 25) ** 2));
    const rc = 2 * Math.sqrt(
      adjustedMeanC ** 7 / (adjustedMeanC ** 7 + 25 ** 7),
    );
    const rt = -rc * Math.sin(2 * rotation * Math.PI / 180);
    return Math.sqrt(
      (deltaL / sl) ** 2
      + (deltaC / sc) ** 2
      + (deltaH / sh) ** 2
      + rt * (deltaC / sc) * (deltaH / sh),
    );
  };
  const accent = parseColor(
    getComputedStyle(document.documentElement).getPropertyValue('--rs-accent').trim(),
  );
  const sameAccent = (left, right) => Boolean(left && right
    && left.a > 0.05 && right.a > 0.05
    && deltaE2000(left, right) < 5);
  const cssColors = (value) => {
    const matches = String(value || '').match(
      /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|#[\da-f]{3,8}|\b[a-z]+\b/giu,
    ) || [];
    return matches.map(parseColor).filter(Boolean);
  };
  const gradientColor = (style) => {
    if (!style.backgroundImage || style.backgroundImage === 'none') return null;
    const colors = cssColors(style.backgroundImage).filter((color) => color.a > 0.05);
    if (!colors.length) return null;
    return {
      r: Math.round(colors.reduce((sum, color) => sum + color.r, 0) / colors.length),
      g: Math.round(colors.reduce((sum, color) => sum + color.g, 0) / colors.length),
      b: Math.round(colors.reduce((sum, color) => sum + color.b, 0) / colors.length),
      a: colors.reduce((sum, color) => sum + color.a, 0) / colors.length,
    };
  };
  const ownBackground = (style) => (
    gradientColor(style) || parseColor(style.backgroundColor)
  );
  const composite = (foreground, background) => {
    if (!foreground || foreground.a <= 0) return background;
    if (!background) return foreground;
    const alpha = foreground.a + background.a * (1 - foreground.a);
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: Math.round((
        foreground.r * foreground.a
        + background.r * background.a * (1 - foreground.a)
      ) / alpha),
      g: Math.round((
        foreground.g * foreground.a
        + background.g * background.a * (1 - foreground.a)
      ) / alpha),
      b: Math.round((
        foreground.b * foreground.a
        + background.b * background.a * (1 - foreground.a)
      ) / alpha),
      a: alpha,
    };
  };
  const effectiveBackground = (element) => {
    const chain = [];
    for (let current = element; current; current = current.parentElement) chain.push(current);
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (const current of chain.reverse()) {
      result = composite(ownBackground(getComputedStyle(current)), result);
    }
    return result;
  };
  const outsideMockup = (element) => {
    const mockup = element.closest('[data-rs-mockup]');
    return !mockup || mockup === element;
  };
  const outsideMockupText = (element) => !element.closest('[data-rs-mockup]');
  const textNodes = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.replace(/\s+/gu, ' ').trim()) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) {
        continue;
      }
      let rendered = true;
      for (let current = parent; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (
          style.display === 'none'
          || ['hidden', 'collapse'].includes(style.visibility)
          || Number.parseFloat(style.opacity || '1') <= 0.05
        ) {
          rendered = false;
          break;
        }
      }
      if (!rendered) continue;
      found.push({ node, parent });
    }
    return found;
  };

  const primaries = elements.filter((element) => (
    element.hasAttribute('data-rs-primary') && visible(element)
  ));
  const styleAccentFilled = (style) => {
    if (sameAccent(parseColor(style.backgroundColor), accent)) return true;
    if (!style.backgroundImage || style.backgroundImage === 'none') return false;
    const colors = cssColors(style.backgroundImage).filter((color) => color.a > 0.05);
    return colors.length > 0 && colors.every((color) => sameAccent(color, accent));
  };
  const pseudoPaints = (style) => {
    if (
      style.display === 'none'
      || ['hidden', 'collapse'].includes(style.visibility)
      || Number.parseFloat(style.opacity || '1') <= 0.05
    ) return false;
    const content = String(style.content || '');
    if (!['none', 'normal', '""', "''"].includes(content)) return true;
    const width = Number.parseFloat(style.width);
    const height = Number.parseFloat(style.height);
    return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  };
  const accentFilled = elements.filter((element) => {
    if (!visible(element)) return false;
    if (styleAccentFilled(getComputedStyle(element))) return true;
    return ['::before', '::after'].some((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return pseudoPaints(style) && styleAccentFilled(style);
    });
  });
  const relativeLuminance = (color) => {
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r)
      + 0.7152 * channel(color.g)
      + 0.0722 * channel(color.b);
  };
  const contrastRatio = (left, right) => {
    const bright = Math.max(relativeLuminance(left), relativeLuminance(right));
    const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
    return (bright + 0.05) / (dark + 0.05);
  };
  const disabledPrimaryElement = primaries.length === 1
    && (
      primaries[0].disabled
      || primaries[0].getAttribute('aria-disabled') === 'true'
    )
    ? primaries[0]
    : null;
  let disabledPrimary = null;
  if (disabledPrimaryElement) {
    const style = getComputedStyle(disabledPrimaryElement);
    const background = ownBackground(style);
    let effectiveOpacity = 1;
    for (
      let current = disabledPrimaryElement;
      current;
      current = current.parentElement
    ) {
      effectiveOpacity *= Number.parseFloat(getComputedStyle(current).opacity || '1');
    }
    const backdrop = effectiveBackground(disabledPrimaryElement.parentElement);
    const paintedBackground = background && backdrop
      ? composite({ ...background, a: background.a * effectiveOpacity }, backdrop)
      : null;
    const labelContrasts = [];
    const walker = document.createTreeWalker(
      disabledPrimaryElement,
      NodeFilter.SHOW_TEXT,
    );
    let labelNode;
    while ((labelNode = walker.nextNode())) {
      if (!labelNode.textContent.replace(/\s+/gu, ' ').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(labelNode);
      if (![...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) {
        continue;
      }
      const foreground = parseColor(getComputedStyle(labelNode.parentElement).color);
      let labelOpacity = 1;
      let rendered = true;
      for (
        let current = labelNode.parentElement;
        current && current !== disabledPrimaryElement;
        current = current.parentElement
      ) {
        const currentStyle = getComputedStyle(current);
        if (
          currentStyle.display === 'none'
          || ['hidden', 'collapse'].includes(currentStyle.visibility)
        ) {
          rendered = false;
          break;
        }
        labelOpacity *= Number.parseFloat(currentStyle.opacity || '1');
      }
      if (!rendered || !foreground || !background || !backdrop) continue;
      const labelOverControl = composite(
        { ...foreground, a: foreground.a * labelOpacity },
        background,
      );
      const paintedForeground = composite(
        { ...labelOverControl, a: labelOverControl.a * effectiveOpacity },
        backdrop,
      );
      if (paintedBackground && paintedForeground) {
        labelContrasts.push(contrastRatio(paintedForeground, paintedBackground));
      }
    }
    disabledPrimary = {
      opaque: Boolean(background?.a >= 0.95 && effectiveOpacity >= 0.95),
      neutral: Boolean(paintedBackground && hsl(paintedBackground).s <= 20),
      contrast: labelContrasts.length ? Math.min(...labelContrasts) : 0,
    };
    disabledPrimary.neutral_aa = disabledPrimary.opaque
      && disabledPrimary.neutral
      && disabledPrimary.contrast >= 4.5;
  }

  const accessibleName = (element) => {
    const labelledBy = String(element.getAttribute('aria-labelledby') || '')
      .split(/\s+/u)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ');
    return [
      element.getAttribute('aria-label'),
      labelledBy,
      element.getAttribute('title'),
    ].some((value) => String(value || '').trim());
  };
  const iconCopy = (element) => {
    const wrapper = element.closest('rs-copy,[data-copy-id],[data-rs-copy]');
    if (!wrapper || !accessibleName(element)) return false;
    const rect = rectOf(element);
    if (rect.width > thresholds.iconControlMaxPx || rect.height > thresholds.iconControlMaxPx) {
      return false;
    }
    const described = String(element.getAttribute('aria-describedby') || '')
      .split(/\s+/u)
      .filter(Boolean)
      .some((id) => {
        const target = document.getElementById(id);
        return target && visible(target) && String(target.innerText || target.textContent || '').trim();
      });
    const visibleValue = [...wrapper.querySelectorAll('*')].some((candidate) => (
      candidate !== element
      && !candidate.contains(element)
      && !candidate.matches(interactiveSelector)
      && visible(candidate)
      && String(candidate.innerText || candidate.textContent || '').trim()
    ));
    return described || visibleValue;
  };
  const countedControls = (controls) => {
    const keys = new Set();
    const rovingSelector = '[role=radiogroup],[role=toolbar],[role=tablist]';
    const rovingGroups = [...document.querySelectorAll(rovingSelector)];
    const counted = controls.filter((element) => !iconCopy(element));
    controls.forEach((element, index) => {
      if (iconCopy(element)) return;
      const roving = element.closest(rovingSelector);
      const roleGroup = element.closest('[role=group]');
      const segmentedMembers = roleGroup
        ? counted.filter((candidate) => candidate.closest('[role=group]') === roleGroup)
        : [];
      const segmented = segmentedMembers.length > 1
        && segmentedMembers.every((candidate) => candidate.matches('button[aria-pressed]'))
        ? roleGroup : null;
      const rovingMembers = roving
        ? counted.filter((candidate) => (
          candidate.closest('[role=radiogroup],[role=toolbar],[role=tablist]') === roving
        ))
        : [];
      const oneKeyboardEntry = rovingMembers.length > 1
        && rovingMembers.filter((candidate) => candidate.tabIndex === 0).length === 1
        && rovingMembers.every((candidate) => candidate.tabIndex <= 0);
      const rovingIdentity = roving
        ? `group-${rovingGroups.indexOf(roving)}`
        : null;
      const group = (
        oneKeyboardEntry && verifiedRovingGroups.has(rovingIdentity)
          ? roving
          : null
      ) || segmented;
      keys.add(group || element || index);
    });
    return keys.size;
  };
  const items = [...document.querySelectorAll('[data-rs-item]')]
    .filter(visible)
    .map((item) => {
      const controls = [...item.querySelectorAll(interactiveSelector)]
        .filter((element) => visible(element) && interactive(element));
      const visibleCopies = controls.filter((element) => (
        element.closest('rs-copy,[data-copy-id],[data-rs-copy]')
      ));
      return {
        identity: identity(item),
        interactive_count: countedControls(controls),
        non_icon_copy_controls: visibleCopies
          .filter((element) => !iconCopy(element))
          .map(identity),
      };
    });

  const rail = document.querySelector('.rs-rail,[data-rs-rail],nav[aria-label*="run" i]');
  const railFocusable = rail
    ? [...rail.querySelectorAll(interactiveSelector)].filter((element) => (
      focusable(element)
      && !element.closest('[inert]')
      && element.getClientRects().length > 0
      && getComputedStyle(element).display !== 'none'
      && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility)
      && !(
        element.closest('details:not([open])')
        && !(element.tagName === 'SUMMARY' && element.parentElement === element.closest('details'))
      )
    )).length
    : 0;

  const renderedTextNodes = textNodes();
  const visibleText = renderedTextNodes.filter(({ parent }) => outsideMockupText(parent));
  const paintedTextElements = new Set(visibleText.map(({ parent }) => parent));
  for (const element of elements.filter((item) => visible(item) && outsideMockupText(item))) {
    if (
      (element.matches('select') && element.selectedOptions?.[0]?.textContent?.trim())
      || (element.matches('input,textarea') && (
        String(element.value || '').trim() || String(element.placeholder || '').trim()
      ))
    ) paintedTextElements.add(element);
    for (const pseudo of ['::before', '::after']) {
      const content = getComputedStyle(element, pseudo).content;
      if (content && !['none', 'normal', '""', "''"].includes(content)) {
        paintedTextElements.add(element);
      }
    }
  }
  const fontSizes = [...new Set([...paintedTextElements].map((element) => (
    Number.parseFloat(getComputedStyle(element).fontSize)
  )).filter(Number.isFinite))].sort((a, b) => a - b);
  const fontWeights = [...new Set([...paintedTextElements].map((element) => (
    getComputedStyle(element).fontWeight
  )))].sort();

  const isBox = (element) => {
    if (!visible(element)) return false;
    if (element.hasAttribute('data-rs-mockup')) return true;
    const style = getComputedStyle(element);
    const ownColor = ownBackground(style);
    const parentColor = effectiveBackground(element.parentElement);
    const paintedOwnColor = composite(ownColor, parentColor);
    const differingBackground = ownColor?.a > 0.05
      && Math.abs(luminance(paintedOwnColor) - luminance(parentColor)) > 0.03;
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
      const color = parseColor(style[`border${side}Color`]);
      return Number.parseFloat(style[`border${side}Width`]) >= 1
        && style[`border${side}Style`] !== 'none'
        && color?.a > 0.05;
    });
    return differingBackground || border || style.boxShadow !== 'none';
  };
  const boxes = elements.filter((element) => outsideMockup(element) && isBox(element));
  const boxSet = new Set(boxes);
  const boxDepths = boxes.map((element) => {
    let ancestors = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (boxSet.has(parent)) ancestors += 1;
    }
    return { identity: identity(element), ancestors };
  });

  const accentHue = accent ? hsl(accent).h : null;
  const colorProperties = [
    'color', 'backgroundColor', 'borderTopColor', 'borderRightColor',
    'borderBottomColor', 'borderLeftColor', 'outlineColor',
  ];
  const offAccent = [];
  for (const element of elements.filter((item) => visible(item) && outsideMockupText(item))) {
    const rect = rectOf(element);
    const statusException = element.hasAttribute('data-rs-status')
      && rect.width * rect.height < innerWidth * innerHeight
        * thresholds.statusViewportAreaMax;
    if (statusException) continue;
    const style = getComputedStyle(element);
    for (const property of colorProperties) {
      const color = parseColor(style[property]);
      if (!color || color.a <= 0.05) continue;
      const value = hsl(color);
      if (
        value.s <= thresholds.colorSaturationMin
        || value.l <= thresholds.colorLightnessMin
        || value.l >= thresholds.colorLightnessMax
      ) continue;
      if (
        accentHue === null
        || (
          !sameAccent(color, accent)
          && hueDistance(value.h, accentHue) > thresholds.accentHueTolerance
        )
      ) {
        offAccent.push({
          identity: identity(element),
          property,
          hue: Math.round(value.h * 10) / 10,
        });
      }
    }
  }

  const itemGaps = [];
  for (const parent of new Set(
    [...document.querySelectorAll('[data-rs-item]')].map((item) => item.parentElement),
  )) {
    const siblings = [...parent.children]
      .filter((element) => element.hasAttribute('data-rs-item') && visible(element))
      .sort((left, right) => rectOf(left).top - rectOf(right).top);
    for (let index = 1; index < siblings.length; index += 1) {
      itemGaps.push(rectOf(siblings[index]).top - rectOf(siblings[index - 1]).bottom);
    }
  }
  const textCanvas = document.createElement('canvas');
  const textContext = textCanvas.getContext('2d');
  const blockDisplays = new Set([
    'block', 'flow-root', 'list-item', 'table-cell', 'flex', 'grid',
  ]);
  const readingBlocks = elements.filter((element) => {
    if (!visible(element) || !outsideMockup(element)) return false;
    if (element.matches('body,nav,header,footer,form,button,input,select,textarea,h1,h2,h3,h4,h5,h6,summary')) {
      return false;
    }
    if (!blockDisplays.has(getComputedStyle(element).display)) return false;
    const ownedText = renderedTextNodes
      .filter(({ node }) => {
        let owner = node.parentElement;
        while (
          owner
          && owner !== element
          && !blockDisplays.has(getComputedStyle(owner).display)
        ) owner = owner.parentElement;
        return owner === element;
      })
      .map(({ node }) => node.textContent)
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return ownedText.length >= 20;
  });
  const wideText = readingBlocks
    .map((element) => {
      const style = getComputedStyle(element);
      textContext.font = style.font;
      const ch = textContext.measureText('0').width || Number.parseFloat(style.fontSize) / 2;
      return {
        identity: identity(element),
        width: rectOf(element).width,
        max_width: thresholds.readingWidthMaxCh * ch,
      };
    })
    .filter((item) => item.width > item.max_width + 0.5);
  const pageBackground = effectiveBackground(document.body);

  const textInputTypes = new Set([
    '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
    'date', 'datetime-local', 'month', 'time', 'week',
  ]);
  const visibleInputs = [...document.querySelectorAll('input,textarea')]
    .filter((element) => (
      element.matches('textarea')
      || textInputTypes.has(String(element.getAttribute('type') || '').toLowerCase())
    ))
    .filter(visible).map(identity);
  const secondaryPattern = /\b(?:handled items?|newsletters?|kept|agent note details?|metadata|erledigte elemente?|newsletter|behalten|agentennotiz(?:en)?|metadaten)\b/iu;
  const secondaryLabels = elements.filter((element) => {
    if (!visible(element) || !element.matches('h1,h2,h3,h4,h5,h6,summary,p,[role=heading]')) {
      return false;
    }
    return secondaryPattern.test(String(element.innerText || '').replace(/\s+/gu, ' ').trim());
  });
  const openSecondary = secondaryLabels.flatMap((label) => {
    const details = label.closest('details');
    if (details) return details.open ? [identity(details)] : [];
    const section = label.closest('section,article,[role=region],div') || label.parentElement;
    const disclosure = section?.querySelector('[aria-expanded]')
      || (section?.id
        ? document.querySelector(`[aria-controls="${CSS.escape(section.id)}"]`)
        : null);
    return disclosure?.getAttribute('aria-expanded') === 'false'
      ? []
      : [identity(section || label)];
  });

  const aboveFold = elements.filter((element) => {
    if (!visible(element) || !interactive(element)) return false;
    const rect = rectOf(element);
    return rect.bottom > 0 && rect.top < innerHeight
      && rect.right > 0 && rect.left < innerWidth;
  });

  const mockups = [...document.querySelectorAll('[data-rs-mockup]')]
    .filter(visible).map((element) => ({
      identity: identity(element),
      width: rectOf(element).width,
    }));
  const tablists = [
    ...document.querySelectorAll('[role=tablist]'),
    ...[...document.querySelectorAll('[role=group]')].filter((group) => (
      group.querySelector('button[aria-pressed]')
    )),
  ].filter(visible).map((list) => {
      const tabs = [...list.querySelectorAll(
        list.getAttribute('role') === 'tablist' ? '[role=tab]' : 'button[aria-pressed]',
      )].filter(visible);
      const approvalPattern = /\b(?:approved|pending|rejected|draft|freigegeben|ausstehend|abgelehnt|entwurf)\b/iu;
      return {
        kind: list.getAttribute('role') === 'tablist' ? 'tablist' : 'segmented',
        tabs: tabs.length,
        stateful_tabs: tabs.filter((tab) => (
          (tab.hasAttribute('aria-selected') || tab.hasAttribute('aria-pressed'))
          && approvalPattern.test([
            tab.getAttribute('data-rs-approval-state') || '',
            tab.getAttribute('aria-label') || '',
            tab.textContent || '',
            ...[...tab.querySelectorAll('[data-rs-status]')].flatMap((status) => [
              status.getAttribute('aria-label') || '',
              status.textContent || '',
            ]),
          ].join(' '))
        )).length,
      };
    });

  const noisePatterns = [
    /\b(?:created|updated|erstellt|aktualisiert)\b[^\n]{0,40}(?:\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})/iu,
    /\bAlt\+\d+\b/iu,
    /\bCtrl\+/iu,
    /\b\d{8}-\d{6}-/u,
    /\bpersona\b/iu,
    /\bslug\b/iu,
    /\bshow in folder\b/iu,
    /\bbot[\s_-]?id\b/iu,
    /\b[a-z0-9]+(?:-[a-z0-9]+)*-bot\b/iu,
  ];
  const noiseBlocks = new Map();
  for (const { node, parent } of textNodes().filter(({ parent }) => !parent.closest(
      'details:not([open]),[role=tooltip],[hidden]',
    ))) {
    let block = parent;
    while (
      block.parentElement
      && block.parentElement !== document.body
      && ['inline', 'contents'].includes(getComputedStyle(block).display)
    ) block = block.parentElement;
    if (!noiseBlocks.has(block)) noiseBlocks.set(block, []);
    noiseBlocks.get(block).push(node.textContent);
  }
  const mainText = [...noiseBlocks.values()]
    .map((parts) => parts.join('').replace(/\s+/gu, ' ').trim());
  const noise = mainText.filter((text) => noisePatterns.some((pattern) => pattern.test(text)));
  const header = document.querySelector('.rs-header,header');
  const headerControls = header
    ? [...header.querySelectorAll(interactiveSelector)]
      .filter((element) => visible(element) && interactive(element)).map(identity)
    : [];
  const headerTitles = header
    ? [...header.querySelectorAll('h1,[data-rs-title],#rs-title')].filter(visible).length
    : 0;

  const parseDurations = (value) => String(value).split(',').map((part) => {
    const text = part.trim();
    return text.endsWith('ms')
      ? Number.parseFloat(text)
      : Number.parseFloat(text) * 1000;
  }).filter(Number.isFinite);
  const motion = [];
  const attention = [];
  const inspectMotionStyle = (element, style, suffix = '') => {
    const durations = [
      ...parseDurations(style.transitionDuration),
      ...parseDurations(style.animationDuration),
    ];
    if (durations.some((duration) => duration > 0)) {
      motion.push({
        identity: `${identity(element)}${suffix}`,
        max_ms: Math.max(...durations),
      });
    }
    const iterations = String(style.animationIterationCount || '')
      .split(',')
      .map((part) => part.trim())
      .map((part) => part === 'infinite' ? Infinity : Number.parseFloat(part));
    const attentionName = String(style.animationName || '')
      .split(',')
      .some((name) => /\b(?:blink|pulse|bounce|flash|attention)\b/iu.test(name.trim()));
    if (
      durations.some((duration) => duration > 0)
      && (
        attentionName
        || iterations.some((count) => count > 1)
      )
    ) {
      attention.push(`${identity(element)}${suffix}`);
    }
  };
  for (const element of elements) {
    inspectMotionStyle(element, getComputedStyle(element));
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(element, pseudo);
      if (style.content && !['none', 'normal'].includes(style.content)) {
        inspectMotionStyle(element, style, pseudo);
      }
    }
    for (const animation of element.getAnimations({ subtree: false })) {
      const timing = animation.effect?.getComputedTiming?.() || {};
      const keyframes = animation.effect?.getKeyframes?.() || [];
      const visualProperties = new Set([
        'opacity', 'transform', 'filter', 'visibility',
        'backgroundColor', 'color', 'boxShadow',
      ]);
      const changesVisualProperty = keyframes.some((frame) => (
        [...visualProperties].some((property) => Object.hasOwn(frame, property))
      ));
      const valuesReverse = [...visualProperties].some((property) => {
        const values = keyframes
          .map((frame) => frame[property])
          .filter((value) => value !== undefined);
        return values.length >= 3
          && String(values[0]) === String(values.at(-1))
          && values.some((value) => String(value) !== String(values[0]));
      });
      if (
        changesVisualProperty
        && (
          valuesReverse
          || timing.iterations === Infinity
          || Number(timing.iterations) > 1
        )
      ) attention.push(identity(element));
    }
  }

  return {
    K1: {
      primary_ids: primaries.map(identity),
      accent_fill_ids: accentFilled.map(identity),
      disabled_primary: disabledPrimary,
    },
    K2: { items },
    K3: {
      open_runs: options.openRuns,
      rail_rendered: Boolean(rail && visible(rail) && rectOf(rail).width > 0),
      rail_width: rail ? rectOf(rail).width : 0,
      focusable_descendants: railFocusable,
    },
    K4: { font_sizes: fontSizes, font_weights: fontWeights },
    K5: {
      boxes: boxDepths,
      max_box_ancestors: Math.max(0, ...boxDepths.map((item) => item.ancestors)),
    },
    K6: { accent_hue: accentHue, off_accent: offAccent },
    K7: {
      item_gaps: itemGaps,
      wide_text: wideText,
      page_background: pageBackground
        ? [pageBackground.r, pageBackground.g, pageBackground.b]
        : null,
      background_ratio: null,
      lint_pass: null,
    },
    K8: { visible_inputs: visibleInputs, open_secondary: openSecondary },
    K9: { visible_interactive_above_fold: countedControls(aboveFold) },
    K10: { mockups, tablists },
    K11: { noise, header_titles: headerTitles, header_controls: headerControls },
    K12: {
      reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      motion,
      max_ms: Math.max(0, ...motion.map((item) => item.max_ms)),
      attention,
    },
  };
}

function result(pass, reasons, raw) {
  return { pass, reasons, raw };
}

export function judgeCalmFacts(facts, options = {}) {
  const thresholds = options.thresholds || CALM_THRESHOLDS;
  const items = {};
  const set = (name, reasons) => {
    items[name] = result(reasons.length === 0, reasons, facts[name] ?? null);
  };

  const k1 = facts.K1;
  const primarySet = new Set(k1.primary_ids);
  const disabledNeutral = k1.primary_ids.length === 1
    && k1.accent_fill_ids.length === 0
    && k1.disabled_primary?.neutral_aa === true;
  set('K1', [
    ...(k1.primary_ids.length === 1 ? [] : [`K1 expected 1 visible primary, found ${k1.primary_ids.length}`]),
    ...(
      disabledNeutral
      || (
        k1.accent_fill_ids.length === 1
        && primarySet.has(k1.accent_fill_ids[0])
      )
        ? []
        : [`K1 accent-filled elements must be the sole primary: ${k1.accent_fill_ids.join(', ') || 'none'}`]
    ),
  ]);

  const k2Issues = facts.K2.items.flatMap((item) => [
    ...(item.interactive_count <= thresholds.itemInteractiveMax
      ? [] : [`${item.identity} has ${item.interactive_count} visible controls`]),
    ...item.non_icon_copy_controls.map((control) => `${control} is not hidden or icon-only`),
  ]);
  set('K2', k2Issues.map((reason) => `K2 ${reason}`));

  const k3Reasons = [];
  const k3Samples = facts.K3.samples || [facts.K3];
  for (const sample of k3Samples) {
    if (sample.open_runs === 1 && (
      sample.rail_rendered || sample.rail_width !== 0 || sample.focusable_descendants !== 0
    )) k3Reasons.push('K3 rail must not render for 1 open run');
    if (sample.open_runs >= 2 && !sample.rail_rendered) {
      k3Reasons.push(`K3 rail must render for ${sample.open_runs} open runs`);
    }
  }
  set('K3', k3Reasons);

  set('K4', [
    ...(facts.K4.font_sizes.length <= thresholds.fontSizeMax
      ? [] : [`K4 found ${facts.K4.font_sizes.length} font sizes`]),
    ...(facts.K4.font_weights.length <= thresholds.fontWeightMax
      ? [] : [`K4 found ${facts.K4.font_weights.length} font weights`]),
  ]);
  set('K5', facts.K5.max_box_ancestors <= thresholds.boxAncestorMax
    ? [] : [`K5 found ${facts.K5.max_box_ancestors} box ancestors`]);
  set('K6', facts.K6.off_accent.length
    ? [`K6 found ${facts.K6.off_accent.length} chromatic colours outside the accent cluster`]
    : []);

  const k7Reasons = [];
  if (facts.K7.lint_pass === false) k7Reasons.push('K7 calm source lint did not pass');
  if (facts.K7.item_gaps.some((gap) => gap < thresholds.itemGapMinPx)) {
    k7Reasons.push(`K7 item gap is below ${thresholds.itemGapMinPx}px`);
  }
  if (facts.K7.wide_text.length) {
    k7Reasons.push(`K7 found ${facts.K7.wide_text.length} text blocks wider than ${thresholds.readingWidthMaxCh}ch`);
  }
  if (
    facts.K7.background_ratio !== null
    && !(facts.K7.background_ratio >= thresholds.backgroundRatioMin)
  ) {
    k7Reasons.push(`K7 page-background pixels ${(100 * (facts.K7.background_ratio || 0)).toFixed(1)}% are below ${(100 * thresholds.backgroundRatioMin).toFixed(0)}%`);
  }
  set('K7', k7Reasons);
  set('K8', [
    ...(facts.K8.visible_inputs.length ? [`K8 found ${facts.K8.visible_inputs.length} visible text inputs`] : []),
    ...(facts.K8.open_secondary.length ? [`K8 found ${facts.K8.open_secondary.length} expanded secondary sections`] : []),
  ]);
  set('K9', facts.K9.measured === false
    || facts.K9.visible_interactive_above_fold <= thresholds.aboveFoldInteractiveMax
    ? [] : [`K9 found ${facts.K9.visible_interactive_above_fold} visible controls above the fold`]);

  if (options.templateId === 'synthetic-platform-preview') {
    const wide = facts.K10.mockups.filter((item) => item.width >= thresholds.socialMockupMinPx);
    const tablist = facts.K10.tablists.find((item) => item.tabs > 0);
    const interaction = facts.K10.interaction;
    set('K10', [
      ...(wide.length === 1 && facts.K10.mockups.length === 1
        ? [] : [`K10 expected one visible >=${thresholds.socialMockupMinPx}px mockup, found ${wide.length}/${facts.K10.mockups.length}`]),
      ...(tablist && tablist.stateful_tabs === tablist.tabs
        ? [] : ['K10 requires tabs or segments with approval state on every platform']),
      ...(interaction
        && interaction.controls === tablist?.tabs
        && interaction.stateful_controls === interaction.controls
        && interaction.reachable_controls === interaction.controls
        && interaction.single_mockup_each
        ? [] : ['K10 every platform control must activate one reachable mockup']),
    ]);
  } else set('K10', []);

  set('K11', [
    ...facts.K11.noise.map((text) => `K11 meta noise: ${text}`),
    ...(facts.K11.header_titles === 1 ? [] : [`K11 header has ${facts.K11.header_titles} titles`]),
    ...(facts.K11.header_controls.length <= 1 ? [] : [`K11 header has ${facts.K11.header_controls.length} controls`]),
  ]);

  const normal = facts.K12.normal || facts.K12;
  const reduced = facts.K12.reduced;
  set('K12', [
    ...(normal.max_ms <= thresholds.motionMaxMs
      ? [] : [`K12 motion lasts ${normal.max_ms}ms`]),
    ...(normal.attention.length ? [`K12 attention animations: ${normal.attention.join(', ')}`] : []),
    ...(reduced && reduced.max_ms === 0 && reduced.attention.length === 0
      ? [] : ['K12 motion remains under prefers-reduced-motion']),
  ]);

  const evidence = options.k13 || {};
  set('K13', [
    ...(evidence.keyboard === true ? [] : ['K13 requires passing C12 keyboard evidence']),
    ...(evidence.accessibility === true ? [] : ['K13 requires passing C13 accessibility evidence']),
    ...(evidence.copy_focus === true ? [] : ['K13 copy controls must become visible on keyboard focus']),
  ]);

  return {
    ok: Object.values(items).every((item) => item.pass),
    items,
  };
}

export function pngBackgroundRatio(buffer, background, tolerance = 2) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PNG input must be a Buffer');
  if (!Array.isArray(background) || background.length !== 3) {
    throw new TypeError('background must be an RGB triplet');
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('invalid PNG signature');
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`unsupported PNG format: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const packed = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    if (aboveDistance <= upperLeftDistance) return above;
    return upperLeft;
  };
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = packed[source];
    source += 1;
    for (let column = 0; column < stride; column += 1) {
      const raw = packed[source];
      source += 1;
      const destination = row * stride + column;
      const left = column >= channels ? pixels[destination - channels] : 0;
      const above = row > 0 ? pixels[destination - stride] : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[destination - stride - channels] : 0;
      let value = raw;
      if (filter === 1) value += left;
      else if (filter === 2) value += above;
      else if (filter === 3) value += Math.floor((left + above) / 2);
      else if (filter === 4) value += paeth(left, above, upperLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      pixels[destination] = value & 255;
    }
  }
  let matching = 0;
  for (let index = 0; index < pixels.length; index += channels) {
    if (
      Math.abs(pixels[index] - background[0]) <= tolerance
      && Math.abs(pixels[index + 1] - background[1]) <= tolerance
      && Math.abs(pixels[index + 2] - background[2]) <= tolerance
    ) matching += 1;
  }
  return matching / (width * height);
}
