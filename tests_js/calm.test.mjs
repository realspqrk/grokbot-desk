import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { calmPage } from './fixtures/calm/pages.mjs';
import {
  CALM_THRESHOLDS,
  auditCopyFocus,
  calmEvaluator,
  focusedControlFacts,
  judgeCalmFacts,
  pngBackgroundRatio,
} from '../tools/calm.mjs';
import * as calmTools from '../tools/calm.mjs';
import {
  browserChannel,
  loadChromium,
  ROOT,
} from '../tools/dev/rs-server.mjs';

const chromium = await loadChromium();
const skip = chromium ? false : 'playwright-core not found (set RS_PLAYWRIGHT_CORE)';

describe('C16 calm synthetic pages', { skip }, () => {
  let browser;

  before(async () => {
    browser = await chromium.launch({ channel: browserChannel(), headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  async function evaluatePage(page, html, openRuns, verifiedRovingGroups = []) {
    await page.setContent(html);
    await page.evaluate(() => {
      document.activeElement?.blur();
      document.body.focus();
    });
    return page.evaluate(calmEvaluator, {
      thresholds: CALM_THRESHOLDS,
      templateId: 'synthetic-platform-preview',
      openRuns,
      verifiedRovingGroups,
    });
  }

  async function measure(cluttered = null) {
    const context = await browser.newContext({
      viewport: { width: 1500, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    try {
      const facts = await evaluatePage(page, calmPage({ cluttered, runCount: 1 }), 1);
      const screenshot = await page.screenshot({ type: 'png' });
      facts.K7.background_ratio = pngBackgroundRatio(
        screenshot,
        facts.K7.page_background,
        CALM_THRESHOLDS.backgroundChannelTolerance,
      );

      const threeRuns = await evaluatePage(
        page,
        calmPage({ cluttered, runCount: 3 }),
        3,
      );
      facts.K3 = { samples: [facts.K3, threeRuns.K3] };

      await page.setViewportSize({ width: 1280, height: 720 });
      const small = await evaluatePage(
        page,
        calmPage({ cluttered, runCount: 1 }),
        1,
      );
      facts.K9 = small.K9;

      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await page.evaluate(calmEvaluator, {
        thresholds: CALM_THRESHOLDS,
        templateId: 'synthetic-platform-preview',
        openRuns: 1,
      });
      facts.K12 = { normal: facts.K12, reduced: reduced.K12 };
      if (typeof calmTools.auditPlatformSwitching === 'function') {
        facts.K10.interaction = await calmTools.auditPlatformSwitching(page);
      }
      facts.K7.lint_pass = true;
      return facts;
    } finally {
      await context.close();
    }
  }

  async function judgeHtml(html, {
    templateId = 'synthetic-platform-preview',
    viewport = { width: 1500, height: 1000 },
    theme = 'light',
    screenshot = false,
    verifiedRovingGroups = [],
  } = {}) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    try {
      const one = await evaluatePage(
        page,
        html,
        1,
        verifiedRovingGroups,
      );
      const facts = structuredClone(one);
      facts.K3 = {
        samples: [
          one.K3,
          {
            open_runs: 3,
            rail_rendered: true,
            rail_width: 180,
            focusable_descendants: 1,
          },
        ],
      };
      if (screenshot) {
        facts.K7.background_ratio = pngBackgroundRatio(
          await page.screenshot({ type: 'png' }),
          facts.K7.page_background,
          CALM_THRESHOLDS.backgroundChannelTolerance,
        );
      }
      if (typeof calmTools.auditPlatformSwitching === 'function') {
        facts.K10.interaction = await calmTools.auditPlatformSwitching(page);
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await page.evaluate(calmEvaluator, {
        thresholds: CALM_THRESHOLDS,
        templateId,
        openRuns: 1,
      });
      facts.K12 = { normal: one.K12, reduced: reduced.K12 };
      facts.K7.lint_pass = true;
      return {
        facts,
        judged: judgeCalmFacts(facts, {
          templateId,
          k13: passingEvidence,
        }),
        page,
        context,
      };
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  const passingEvidence = {
    keyboard: true,
    accessibility: true,
    copy_focus: true,
  };

  test('review finding 1: visible native and role controls count independently of tabindex', async () => {
    for (const controls of [
      Array.from({ length: 15 }, (_, index) => (
        `<button tabindex="-1">Action ${index}</button>`
      )).join(''),
      Array.from({ length: 15 }, (_, index) => (
        `<span role="button">Action ${index}</span>`
      )).join(''),
    ]) {
      const html = calmPage().replace(
        'First decision item</p>',
        `First decision item</p>${controls}`,
      );
      const result = await judgeHtml(html, { viewport: { width: 1280, height: 720 } });
      try {
        assert.equal(result.judged.items.K2.pass, false);
        assert.equal(result.judged.items.K9.pass, false);
      } finally {
        await result.context.close();
      }
    }
  });

  test('review finding 2: calm orchestration retains and judges one-run and three-run scenes', async () => {
    const baseline = await measure();
    const one = structuredClone(baseline);
    const three = structuredClone(baseline);
    one.K3 = { open_runs: 1, rail_rendered: false, rail_width: 0, focusable_descendants: 0 };
    three.K3 = { open_runs: 3, rail_rendered: true, rail_width: 180, focusable_descendants: 1 };
    one.K9 = { measured: true, visible_interactive_above_fold: 11 };
    three.K9 = { measured: true, visible_interactive_above_fold: 14 };
    three.K13 = { copy_focus: { pass: true }, keyboard: false, accessibility: false };
    one.K13 = { copy_focus: { pass: true }, keyboard: true, accessibility: true };

    const source = readFileSync(path.join(ROOT, 'tools/e2e.mjs'), 'utf8');
    const scope = {
      CALM_THRESHOLDS,
      judgeCalmFacts,
      requestedTemplate: 'synthetic-platform-preview',
      calmFixtureCases: () => [{ fixture: 'golden', manifest: { id: 'synthetic-platform-preview' } }],
      withHarness: (callback) => callback({}),
      calmScene: async (_browser, _server, _testCase, scene) => (
        structuredClone(scene.openRuns === 1 ? one : three)
      ),
      coverageReport: () => ({}),
    };
    vm.createContext(scope);
    vm.runInContext(
      source.slice(
        source.indexOf('async function calmMode('),
        source.indexOf('async function timeMode('),
      ),
      scope,
    );
    const result = await scope.calmMode();
    assert.equal(result.scenes.length, 8);
    assert.equal(result.items.K9.pass, false);
    assert.equal(result.items.K13.pass, false);
    assert.deepEqual(
      [...new Set(result.items.K9.raw.map((item) => item.open_runs))],
      [1, 3],
    );
  });

  test('review finding 3: a constant accent gradient is an accent-filled action', async () => {
    const html = calmPage().replace(
      'Second decision item</p>',
      'Second decision item</p><button style="background-image:linear-gradient(#336699,#336699);color:white">Another accent action</button>',
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K1.pass, false);
      assert.equal(result.facts.K1.accent_fill_ids.length, 2);
    } finally {
      await result.context.close();
    }
  });

  test('review finding 4: native select labels contribute rendered typography', async () => {
    const controls = [11, 12, 13, 14]
      .map((size) => `<select style="font-size:${size}px"><option>Choice</option></select>`)
      .join('');
    const result = await judgeHtml(calmPage().replace('</main>', `</main>${controls}`));
    try {
      assert.equal(result.judged.items.K4.pass, false);
      assert.deepEqual(result.facts.K4.font_sizes.slice(0, 4), [11, 12, 13, 14]);
    } finally {
      await result.context.close();
    }
  });

  test('review finding 5: modern CSS colors and alpha are normalized for hue checks', async () => {
    for (const color of [
      'color(srgb 0.8 0.1 0.4)',
      'oklch(60% 0.2 20)',
      'oklch(60% 0.2 20 / 0.5)',
    ]) {
      const html = calmPage().replace(
        'Second decision item</p>',
        `Second decision item</p><p style="color:${color}">Second hue</p>`,
      );
      const result = await judgeHtml(html);
      try {
        assert.equal(result.judged.items.K6.pass, false, color);
      } finally {
        await result.context.close();
      }
    }
  });

  test('review finding 6: unmarked rendered reading blocks enforce 72ch', async () => {
    const html = calmPage().replace(
      'Second decision item</p>',
      `Second decision item</p><div style="width:1200px">${'Long reading text '.repeat(60)}</div>`,
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K7.pass, false);
      assert.equal(result.facts.K7.wide_text.length > 0, true);
    } finally {
      await result.context.close();
    }
  });

  test('review finding 8: named secondary content requires disclosure while checkboxes and primary details remain valid', async () => {
    const exposed = calmPage().replace(
      'Second decision item</p>',
      'Second decision item</p><section><h2 style="font:inherit">Handled items</h2><p>Newsletter details</p></section>',
    );
    const exposedResult = await judgeHtml(exposed);
    try {
      assert.equal(exposedResult.judged.items.K8.pass, false);
    } finally {
      await exposedResult.context.close();
    }

    const valid = calmPage()
      .replace('Second decision item</p>', 'Second decision item</p><label><input type="checkbox">Approve</label>')
      .replace(
        '<details><summary>Handled items</summary><p>Hidden details</p></details>',
        '<details open><summary>Current decision</summary><p>Primary content</p></details><details><summary>Handled items</summary><p>Hidden details</p></details>',
      );
    const validResult = await judgeHtml(valid);
    try {
      assert.equal(validResult.judged.items.K8.pass, true);
    } finally {
      await validResult.context.close();
    }
  });

  test('review finding 9: platform controls expose approval state and activate one reachable mockup each', async () => {
    assert.equal(typeof calmTools.auditPlatformSwitching, 'function');
    const missingState = calmPage()
      .replace('data-rs-status aria-label="Approved"', 'aria-label="Platform"')
      .replace('data-rs-status aria-label="Pending"', 'aria-label="Platform"');
    const missingResult = await judgeHtml(missingState);
    try {
      assert.equal(missingResult.judged.items.K10.pass, false);
    } finally {
      await missingResult.context.close();
    }

    const segmented = calmPage()
      .replace('role="tablist"', 'role="group" aria-label="Platforms"')
      .replace('role="tab" aria-selected="true"', 'aria-pressed="true" data-rs-approval-state="approved"')
      .replace('role="tab" aria-selected="false"', 'aria-pressed="false" data-rs-approval-state="pending"');
    const segmentedResult = await judgeHtml(segmented);
    try {
      assert.equal(segmentedResult.judged.items.K10.pass, true);
      assert.equal(segmentedResult.facts.K10.interaction.reachable_controls, 2);
    } finally {
      await segmentedResult.context.close();
    }
  });

  test('review finding 10: adjacent inline nodes are normalized before meta-noise matching', async () => {
    const html = calmPage().replace(
      'Second decision item',
      '<span>Ctrl</span><span>+</span><span>K</span> <span>Created </span><span>2026-10-08 12:30</span> <span>20261008</span><span>-120000-run</span>',
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K11.pass, false);
      assert.equal(result.facts.K11.noise.length > 0, true);
    } finally {
      await result.context.close();
    }
  });

  test('review finding 11: repeated attention effects and pseudo-element motion fail quiet motion', async () => {
    const cases = [
      calmPage()
        .replace('</style>', '@keyframes attention { from {opacity:1} to {opacity:0} } .flash {animation:attention 150ms infinite alternate} @media(prefers-reduced-motion:reduce){.flash{animation:none}}</style>')
        .replace('Second decision item</p>', 'Second decision item</p><span class="flash">New</span>'),
      calmPage()
        .replace('</style>', '@keyframes spin { to {transform:rotate(360deg)} } .moving::after {content:"Loading";display:inline-block;animation:spin 2s infinite} @media(prefers-reduced-motion:reduce){.moving::after{animation:none}}</style>')
        .replace('Second decision item</p>', 'Second decision item</p><span class="moving"></span>'),
    ];
    for (const html of cases) {
      const result = await judgeHtml(html);
      try {
        assert.equal(result.judged.items.K12.pass, false);
      } finally {
        await result.context.close();
      }
    }
  });

  test('review finding 12: copy focus audit requires real Tab reachability, identity, and effective visibility', async () => {
    for (const html of [
      calmPage().replace(
        '<button data-copy-id="item-copy"',
        '<button tabindex="-1" data-copy-id="item-copy"',
      ).replace('.copy { opacity: 0;', '.copy { opacity: 1;'),
      calmPage()
        .replace('<button data-copy-id="item-copy"', '<span style="opacity:0"><button data-copy-id="item-copy"')
        .replace('aria-label="Copy item">C</button>', 'aria-label="Copy item">C</button></span>'),
    ]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      try {
        await page.setContent(html);
        const audit = await auditCopyFocus(page);
        assert.equal(audit.pass, false);
      } finally {
        await context.close();
      }
    }
  });

  test('review finding 12: general Tab audit applies effective visibility checks', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await page.setContent(
        calmPage({ cluttered: 'K13' }).replace(
          '<details><summary>Handled items</summary><p>Hidden details</p></details>',
          '',
        ),
      );
      const source = readFileSync(path.join(ROOT, 'tools/e2e.mjs'), 'utf8');
      const scope = {
        CALM_THRESHOLDS,
        clearTimeout,
        focusedControlFacts,
        settleShortAnimations: calmTools.settleShortAnimations,
        setTimeout,
      };
      vm.createContext(scope);
      vm.runInContext(
        source.slice(
          source.indexOf('async function focusedControl('),
          source.indexOf('async function runStep('),
        ) + source.slice(
          source.indexOf('async function waitForTabAuditReady('),
          source.indexOf('function validateKeyboardSteps('),
        ),
        scope,
      );
      await assert.rejects(scope.tabAudit(page), /hidden on keyboard focus/i);
    } finally {
      await context.close();
    }
  });

  test('review finding 14: transparent wrappers do not invent nested boxes', async () => {
    const html = calmPage().replace(
      'Second decision item</p>',
      'Second decision item</p><div style="background:transparent"><div style="background:#f5f5f0"><div style="background:transparent"><div style="background:#f5f5f0"><div style="background:transparent"><div style="background:#f5f5f0">No visible boundary</div></div></div></div></div></div>',
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K5.pass, true);
    } finally {
      await result.context.close();
    }
  });

  test('review finding 15: transparent body resolves the painted root canvas in light and dark', async () => {
    for (const [theme, background] of [['light', '#f5f5f0'], ['dark', '#202020']]) {
      const html = calmPage()
        .replace('background: #f5f5f0;', `background: ${background};`)
        .replace('<body>', '<body style="background:transparent">');
      const result = await judgeHtml(html, { theme, screenshot: true });
      try {
        assert.equal(result.facts.K7.background_ratio >= CALM_THRESHOLDS.backgroundRatioMin, true);
      } finally {
        await result.context.close();
      }
    }
  });

  test('round 2 finding 2: display contents text contributes typography and meta noise', async () => {
    const html = calmPage().replace(
      'Second decision item</p>',
      `Second decision item</p>
       <p><span style="display:contents">Ctrl+K</span></p>
       ${[11, 12, 13, 14].map((size) => (
         `<p><span style="display:contents;font-size:${size}px">Visible text</span></p>`
       )).join('')}`,
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K4.pass, false);
      assert.equal(result.judged.items.K11.pass, false);
      assert.deepEqual(result.facts.K4.font_sizes.slice(0, 4), [11, 12, 13, 14]);
    } finally {
      await result.context.close();
    }
  });

  test('round 2 finding 4: perceptually identical accent fills count as the accent', async () => {
    const html = calmPage().replace(
      'Second decision item</p>',
      'Second decision item</p><button style="background:#336698;color:white">Second accent action</button>',
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K1.pass, false);
      assert.equal(result.facts.K1.accent_fill_ids.length, 2);
      assert.equal(result.judged.items.K6.pass, true);
    } finally {
      await result.context.close();
    }
  });

  test('round 2 finding 5: constant gradient backgrounds count as nested boxes', async () => {
    const html = calmPage().replace(
      'Second decision item</p>',
      `Second decision item</p>
       <div style="padding:8px;background:linear-gradient(#ddd,#ddd)">
         <div style="padding:8px;background:linear-gradient(#aaa,#aaa)">
           <div style="padding:8px;background:linear-gradient(#eee,#eee)">Nested boxes</div>
         </div>
       </div>`,
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K5.pass, false);
      assert.ok(result.facts.K5.max_box_ancestors > 1);
    } finally {
      await result.context.close();
    }
  });

  test('round 2 finding 6: every structural block with direct reading text enforces 72ch', async () => {
    for (const tag of ['section', 'article', 'main']) {
      const html = calmPage().replace(
        'Second decision item</p>',
        `Second decision item</p><${tag} style="width:1200px;max-width:none">${'Long reading text '.repeat(60)}</${tag}>`,
      );
      const result = await judgeHtml(html);
      try {
        assert.equal(result.judged.items.K7.pass, false, tag);
        assert.ok(result.facts.K7.wide_text.length > 0, tag);
      } finally {
        await result.context.close();
      }
    }
  });

  test('round 2 finding 11: a one-shot blink is an attention animation', async () => {
    const html = calmPage()
      .replace(
        '</style>',
        '@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}.blink{animation:blink 150ms 1}@media(prefers-reduced-motion:reduce){.blink{animation:none}}</style>',
      )
      .replace('Second decision item</p>', 'Second decision item</p><span class="blink">New</span>');
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K12.pass, false);
      assert.ok(result.facts.K12.normal.attention.length > 0);
    } finally {
      await result.context.close();
    }
  });

  test('round 2 finding 13: invisible keyboard-focusable rail descendants fail K3', async () => {
    const html = calmPage()
      .replace('.rail { display: block; overflow: hidden; width: 0; }', '.rail { display:block;overflow:hidden;width:0;opacity:0; }')
      .replace('.rail button { display: none; }', '.rail button { display:block;width:30px; }');
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K3.pass, false);
      assert.ok(result.facts.K3.samples[0].focusable_descendants > 0);
    } finally {
      await result.context.close();
    }
  });

  test('round 3 finding 5: display-none rail ancestors remove descendants from K3', async () => {
    const html = calmPage()
      .replace(
        '.rail { display: block; overflow: hidden; width: 0; }',
        '.rail { display:none;overflow:hidden;width:0; }',
      )
      .replace('.rail button { display: none; }', '.rail button { display:block; }');
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K3.pass, true);
      assert.equal(result.facts.K3.samples[0].focusable_descendants, 0);
    } finally {
      await result.context.close();
    }
  });

  test('round 2 finding 17: direct mockup text is excluded from typography and colour', async () => {
    const html = calmPage().replace(
      '<section data-rs-mockup class="mockup"><p>Platform preview</p></section>',
      '<section data-rs-mockup class="mockup" style="color:#d2691e;font-size:12px;font-weight:900">Platform preview</section>',
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K4.pass, true);
      assert.equal(result.judged.items.K6.pass, true);
    } finally {
      await result.context.close();
    }
  });

  test('round 2 finding 18: a display-none pseudo-element is not an accent fill', async () => {
    const html = calmPage()
      .replace('Second decision item</p>', 'Second decision item</p><button id="quiet">Quiet action</button>')
      .replace('</style>', '#quiet::before{content:"";display:none;background:#336699}</style>');
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K1.pass, true);
      assert.equal(result.facts.K1.accent_fill_ids.length, 1);
    } finally {
      await result.context.close();
    }
  });

  test('K1 amendment: a readable neutral disabled primary passes only with no accent fill', async () => {
    const neutral = calmPage().replace(
      '<button data-rs-primary class="primary">Approve</button>',
      '<button disabled data-rs-primary class="primary" style="background:#ddd;color:#222">Approve</button>',
    );
    const passing = await judgeHtml(neutral);
    try {
      assert.equal(passing.judged.items.K1.pass, true);
      assert.equal(passing.facts.K1.disabled_primary?.neutral_aa, true);
    } finally {
      await passing.context.close();
    }

    const failing = await judgeHtml(neutral.replace(
      'Second decision item</p>',
      'Second decision item</p><button style="background:#336699;color:white">Accent action</button>',
    ));
    try {
      assert.equal(failing.judged.items.K1.pass, false);
    } finally {
      await failing.context.close();
    }
  });

  test('round 3 finding 3: disabled-primary contrast composites label alpha and ancestor opacity', async () => {
    const neutral = calmPage().replace(
      '<button data-rs-primary class="primary">Approve</button>',
      '<button disabled data-rs-primary class="primary" style="background:#eee;color:#111">Approve</button>',
    );
    for (const html of [
      neutral.replace('color:#111', 'color:rgba(0,0,0,.15)'),
      neutral.replace('<main>', '<main style="opacity:.25">'),
    ]) {
      const result = await judgeHtml(html);
      try {
        assert.equal(result.judged.items.K1.pass, false);
        assert.equal(result.facts.K1.disabled_primary?.neutral_aa, false);
      } finally {
        await result.context.close();
      }
    }
  });

  test('round 4 finding 1: disabled-primary contrast uses the rendered child label', async () => {
    const html = calmPage().replace(
      '<button data-rs-primary class="primary">Approve</button>',
      '<button disabled data-rs-primary class="primary" style="background:#eee;color:#202020"><span style="color:rgba(0,0,0,.15)">Approve</span></button>',
    );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K1.pass, false);
      assert.equal(result.facts.K1.disabled_primary?.neutral_aa, false);
      assert.ok(result.facts.K1.disabled_primary?.contrast < 4.5);
    } finally {
      await result.context.close();
    }
  });

  test('round 3 finding 4: non-roving composite members count individually', async () => {
    for (const [size, expectedK9, singleEntry] of [
      [4, true, false],
      [4, true, true],
      [15, false, false],
    ]) {
      const controls = Array.from({ length: size }, (_, index) => (
        `<button tabindex="${singleEntry && index > 0 ? -1 : 0}">Action ${index + 1}</button>`
      )).join('');
      const html = calmPage().replace(
        'First decision item</p>',
        `First decision item</p><div role="toolbar">${controls}</div>`,
      );
      const result = await judgeHtml(html, { viewport: { width: 1280, height: 720 } });
      try {
        assert.equal(result.facts.K2.items[0].interactive_count, size);
        assert.equal(result.judged.items.K2.pass, false);
        if (!expectedK9) assert.equal(result.judged.items.K9.pass, false);
      } finally {
        await result.context.close();
      }
    }
  });

  test('round 4 finding 2: mixed toggle action groups count every action for K2 and K9', async () => {
    const rows = Array.from({ length: 4 }, (_, index) => `
      <article data-rs-item>
        <p>Message ${index + 1}</p>
        <div role="group" aria-label="Message actions">
          <button aria-pressed="false">Pin</button>
          <button>Reply</button>
          <button>Archive</button>
          <button>Delete</button>
        </div>
      </article>
    `).join('');
    const html = calmPage().replace('</main>', `${rows}</main>`);
    const result = await judgeHtml(html, { viewport: { width: 1280, height: 720 } });
    try {
      assert.ok(result.facts.K2.items.some((item) => item.interactive_count === 4));
      assert.equal(result.judged.items.K2.pass, false);
      assert.equal(result.judged.items.K9.pass, false);
    } finally {
      await result.context.close();
    }
  });

  test('K2 and K9 amendments: icon copies are exempt and roving groups count once', async () => {
    const copies = Array.from({ length: 8 }, (_, index) => (
      `<span data-copy-id="copy-${index}"><span>Value ${index}</span>` +
      `<button style="width:28px;height:28px" aria-label="Copy value ${index}">C</button></span>`
    )).join('');
    const html = calmPage().replace(
      '<article data-rs-item><p>Second decision item</p></article>',
      `<article data-rs-item><p>Second decision item</p>
       <div role="toolbar">
         <button tabindex="0">Choice one</button><button tabindex="-1">Choice two</button>
         <button tabindex="-1">Choice three</button>
       </div>
       <div role="group" aria-label="View">
         <button aria-pressed="true">List</button><button aria-pressed="false">Grid</button>
       </div>${copies}</article>`,
    );
    const result = await judgeHtml(html, {
      viewport: { width: 1280, height: 720 },
      verifiedRovingGroups: ['group-0'],
    });
    try {
      assert.equal(result.judged.items.K2.pass, true);
      assert.equal(result.judged.items.K9.pass, true);
      assert.equal(result.facts.K2.items[1].interactive_count, 2);
    } finally {
      await result.context.close();
    }
  });

  test('K10 amendment: aria-controls may target a tabpanel containing the mockup', async () => {
    const html = calmPage()
      .replace('role="tab" aria-selected="true"', 'role="tab" aria-selected="true" aria-controls="preview-panel"')
      .replace('role="tab" aria-selected="false"', 'role="tab" aria-selected="false" aria-controls="preview-panel"')
      .replace(
        '<section data-rs-mockup class="mockup"><p>Platform preview</p></section>',
        '<div role="tabpanel" id="preview-panel"><section data-rs-mockup class="mockup"><p>Platform preview</p></section></div>',
      );
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K10.pass, true);
      assert.equal(result.facts.K10.interaction.reachable_controls, 2);
    } finally {
      await result.context.close();
    }
  });

  test('round 2 findings 12 and 15: focus checks wait for visibility and reject clipped controls', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    try {
      await page.setContent(calmPage());
      assert.equal((await auditCopyFocus(page)).pass, true);

      await page.setContent(calmPage()
        .replace('<button data-copy-id="item-copy"', '<span style="display:block;width:0;height:0;overflow:hidden"><button data-copy-id="item-copy"')
        .replace('aria-label="Copy item">C</button>', 'aria-label="Copy item">C</button></span>'));
      assert.equal((await auditCopyFocus(page)).pass, false);

      await page.setContent(calmPage().replace(
        'outline: 2px solid #336699;',
        'outline: 2px solid transparent;',
      ));
      assert.equal((await auditCopyFocus(page)).pass, false);
    } finally {
      await context.close();
    }
  });

  test('round 2 finding 16: copy reachability follows the complete Tab sequence', async () => {
    const controls = Array.from(
      { length: 30 },
      (_, index) => `<button>Decision ${index + 1}</button>`,
    ).join('');
    const html = calmPage()
      .replace('<button data-copy-id="item-copy" class="copy" aria-label="Copy item">C</button>', '')
      .replace(
        '</main>',
        `<div style="margin-top:1200px">${controls}<span>Final value</span><button data-rs-copy class="copy" aria-label="Copy final">C</button></div></main>`,
      );
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await page.setContent(html);
      const audit = await auditCopyFocus(page);
      assert.equal(audit.pass, true, JSON.stringify(audit));
    } finally {
      await context.close();
    }
  });

  test('round 3 finding 7: lazy-created copies are revealed and audited', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await page.setContent(`
        <style>button:focus{outline:2px solid black}.hidden-copy{opacity:0}</style>
        <button id="open" aria-expanded="false">Open detail</button>
        <div id="mount"></div>
        <script>
          document.getElementById('open').onclick = () => {
            document.getElementById('open').setAttribute('aria-expanded', 'true');
            document.getElementById('mount').innerHTML = '<span data-copy-id="lazy"><button class="hidden-copy" aria-label="Copy lazy">Copy</button></span>';
          };
        </script>
      `);
      const revealCopies = async (visit) => {
        await page.click('#open');
        await visit();
      };

      const audit = await auditCopyFocus(page, revealCopies);

      assert.equal(audit.pass, false);
      assert.equal(audit.controls.length, 1);
      assert.match(audit.controls[0].selector, /copy/u);
    } finally {
      await context.close();
    }
  });

  test('round 3 finding 8: copy reachability follows arrows in a verified roving toolbar', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await page.setContent(`
        <style>button:focus{outline:2px solid black}</style>
        <div role="toolbar" id="copies">
          <span data-copy-id="first"><button tabindex="0" aria-label="Copy first">One</button></span>
          <span data-copy-id="second"><button tabindex="-1" aria-label="Copy second">Two</button></span>
        </div>
        <script>
          copies.onkeydown = (event) => {
            if (!['ArrowRight', 'ArrowLeft'].includes(event.key)) return;
            const members = [...copies.querySelectorAll('button')];
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = members[(members.indexOf(document.activeElement) + delta + members.length) % members.length];
            for (const member of members) member.tabIndex = member === next ? 0 : -1;
            next.focus();
          };
        </script>
      `);

      const audit = await auditCopyFocus(page);

      assert.equal(audit.pass, true, JSON.stringify(audit));
      assert.equal(audit.controls.length, 2);
      assert.ok(audit.controls.every((control) => control.focused && control.visible));
    } finally {
      await context.close();
    }
  });

  for (let index = 1; index <= 12; index += 1) {
    const item = `K${index}`;
    test(`${item}: cluttered synthetic page fails exactly ${item} and calm synthetic page passes all items`, async () => {
      const calm = judgeCalmFacts(await measure(), {
        templateId: 'synthetic-platform-preview',
        k13: passingEvidence,
      });
      assert.equal(calm.ok, true, JSON.stringify(calm.items, null, 2));

      const cluttered = judgeCalmFacts(await measure(item), {
        templateId: 'synthetic-platform-preview',
        k13: passingEvidence,
      });
      const failed = Object.entries(cluttered.items)
        .filter(([, result]) => !result.pass)
        .map(([name]) => name);
      assert.deepEqual(failed, [item], JSON.stringify(cluttered.items, null, 2));
      assert.match(cluttered.items[item].reasons.join(' '), new RegExp(item));
    });
  }

  test('K13: C16 requires C12/C13 evidence and hidden copy controls become visible on keyboard focus', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    try {
      await page.setContent(calmPage({ cluttered: 'K13' }));
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const hidden = await page.evaluate(focusedControlFacts);
      assert.equal(hidden.copy_control, true);
      assert.equal(hidden.visible, false);
      const source = readFileSync(path.join(ROOT, 'tools/e2e.mjs'), 'utf8');
      const scope = {
        CALM_THRESHOLDS,
        focusedControlFacts,
        settleShortAnimations: calmTools.settleShortAnimations,
      };
      vm.createContext(scope);
      vm.runInContext(
        source.slice(
          source.indexOf('async function focusedControl('),
          source.indexOf('async function runStep('),
        ),
        scope,
      );
      await assert.rejects(
        scope.assertFocusedOutline(page),
        /copy control is hidden on keyboard focus/i,
      );

      await page.setContent(calmPage());
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const visible = await page.evaluate(focusedControlFacts);
      assert.equal(visible.copy_control, true);
      assert.equal(visible.visible, true);
      await scope.assertFocusedOutline(page);

      const facts = await measure();
      const missingC12 = judgeCalmFacts(facts, {
        templateId: 'synthetic-platform-preview',
        k13: { keyboard: false, accessibility: true, copy_focus: true },
      });
      assert.equal(missingC12.items.K13.pass, false);
      assert.match(missingC12.items.K13.reasons.join(' '), /C12/);

      const missingC13 = judgeCalmFacts(facts, {
        templateId: 'synthetic-platform-preview',
        k13: { keyboard: true, accessibility: false, copy_focus: true },
      });
      assert.equal(missingC13.items.K13.pass, false);
      assert.match(missingC13.items.K13.reasons.join(' '), /C13/);

      const hiddenCopy = judgeCalmFacts(facts, {
        templateId: 'synthetic-platform-preview',
        k13: { keyboard: true, accessibility: true, copy_focus: false },
      });
      assert.equal(hiddenCopy.items.K13.pass, false);
      assert.match(hiddenCopy.items.K13.reasons.join(' '), /copy/i);
    } finally {
      await context.close();
    }
  });
});
