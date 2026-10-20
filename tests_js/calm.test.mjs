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
import { parseColor, toHex } from '../tools/colour.mjs';
import { browserChannel, loadChromium } from '../tools/dev/rs-server.mjs';
import { ROOT } from '../tools/dev/rs-server.mjs';

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

  /* post: the synthetic page stands for a report with a post block (K10) */
  async function judgeHtml(html, {
    post = true,
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
            inbox_rendered: true,
            inbox_width: 180,
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
        openRuns: 1,
      });
      facts.K12 = { normal: one.K12, reduced: reduced.K12 };
      facts.K7.lint_pass = true;
      return {
        facts,
        judged: judgeCalmFacts(facts, {
          post,
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

  test('focus facts read oklch() outlines and backgrounds (design tokens are OKLCH)', async () => {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
    const page = await context.newPage();
    try {
      await page.setContent(
        '<body style="margin:0;background:oklch(0.2 0.006 265)">'
        + '<button id="b" style="outline:2px solid oklch(0.72 0.125 275);outline-offset:2px">Go</button></body>',
      );
      await page.focus('#b');
      const facts = await page.evaluate(focusedControlFacts);
      assert.equal(facts.outline_visible, true, JSON.stringify(facts));
      assert.ok(facts.outline_contrast > 6.5 && facts.outline_contrast < 7.8, String(facts.outline_contrast));
    } finally {
      await context.close();
    }
  });

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
    one.K3 = { open_runs: 1, inbox_rendered: false, inbox_width: 0, focusable_descendants: 0 };
    three.K3 = { open_runs: 3, inbox_rendered: true, inbox_width: 180, focusable_descendants: 1 };
    one.K9 = { measured: true, visible_interactive_above_fold: 11 };
    three.K9 = { measured: true, visible_interactive_above_fold: 14 };
    three.K13 = { copy_focus: { pass: true }, keyboard: false, accessibility: false };
    one.K13 = { copy_focus: { pass: true }, keyboard: true, accessibility: true };

    const source = readFileSync(path.join(ROOT, 'tools/e2e.mjs'), 'utf8');
    const scope = {
      CALM_THRESHOLDS,
      judgeCalmFacts,
      requestedFixture: 'approve-post',
      fixtureCases: () => [{ id: 'approve-post', fixture: 'approve-post' }],
      withSession: (callback) => callback({}),
      calmScene: async (_browser, _server, _testCase, scene) => (
        structuredClone(scene.openRuns === 1 ? one : three)
      ),
      coverageReport: () => ({}),
      calmIdentityScenes: async () => [],
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

  test('Only the shell inbox with verified arrow keys counts as the report switcher', async () => {
    const source = readFileSync(path.join(ROOT, 'tools/e2e.mjs'), 'utf8');
    const scope = {
      CALM_THRESHOLDS,
      focusedControlFacts,
      settleShortAnimations: calmTools.settleShortAnimations,
      setTimeout,
      clearTimeout,
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
    const style = '<style>body{background:white;color:black}button:focus,a:focus{outline:2px solid blue;outline-offset:2px}</style>';
    const extras = Array.from({ length: 9 }, (_, i) => `<button>Extra ${i + 1}</button>`).join('');
    // four toolbar buttons with one Tab stop and no arrow handler (review case)
    const toolbar = () => '<div role="toolbar" aria-label="Reports" data-rs-item>'
      + [0, 1, 2, 3].map((i) => `<button tabindex="${i ? -1 : 0}" data-run-id="r${i}">Agent ${i + 1}</button>`).join('')
      + '</div>';
    const pages = {
      'a toolbar of reports in the report': `<main id="rs-mount">${toolbar()}${extras}</main>`,
      'an inbox inside the report mount': `<main id="rs-mount"><nav id="rs-inbox">${toolbar()}</nav>${extras}</main>`,
    };
    // the shell's inbox: links with a roving tabindex; arrows open the
    // report next to the current one (no wrap) and the list re-renders
    // after a moment (data-rs-ready 0 -> 1) with the new one current
    const inbox = `<nav id="rs-inbox" aria-label="Reports" data-rs-item><ol id="rs-inbox-list"></ol></nav><main id="rs-mount">${extras}</main><script>(() => {
      const list = document.getElementById('rs-inbox-list');
      let active = 0;
      window.RS = { activeRun: 'r0' };
      function render() {
        list.textContent = '';
        for (let i = 0; i < 4; i += 1) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = '?run=r' + i;
          a.dataset.runId = 'r' + i;
          a.textContent = 'Report ' + (i + 1);
          a.tabIndex = i === active ? 0 : -1;
          if (i === active) a.setAttribute('aria-current', 'page');
          li.appendChild(a);
          list.appendChild(li);
        }
      }
      render();
      document.documentElement.dataset.rsReady = '1';
      list.addEventListener('keydown', (e) => {
        const next = { ArrowDown: Math.min(active + 1, 3), ArrowUp: Math.max(active - 1, 0), Home: 0, End: 3 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        active = next;
        list.children[active].firstChild.focus();
        document.documentElement.dataset.rsReady = '0';
        setTimeout(() => {
          window.RS.activeRun = 'r' + active;
          render();
          list.children[active].firstChild.focus();
          document.documentElement.dataset.rsReady = '1';
        }, 60);
      });
    })();</script>`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const scene = async (html) => {
      await page.setContent(`<html lang="de"><head>${style}</head><body>${html}</body></html>`);
      let audit = null;
      let error = null;
      try { audit = await scope.tabAudit(page); } catch (caught) { error = String(caught); }
      const verified = audit ? audit.groups.map((group) => group.identity).filter(Boolean) : [];
      const facts = await page.evaluate(calmEvaluator, {
        thresholds: CALM_THRESHOLDS, openRuns: 4, verifiedRovingGroups: verified,
      });
      return { audit, error, facts };
    };
    try {
      for (const [name, html] of Object.entries(pages)) {
        const { error, facts } = await scene(html);
        assert.match(error || '', /ArrowRight did not move within toolbar/, `${name}: the arrow audit still runs`);
        // K13 has no keyboard evidence; K2/K9 count all four buttons again
        const judged = judgeCalmFacts(facts, {
          post: false,
          k13: { keyboard: error === null, accessibility: true, copy_focus: true },
        });
        assert.equal(judged.items.K13.pass, false, name);
        assert.equal(facts.K2.items[0].interactive_count, 4, name);
        assert.equal(judged.items.K2.pass, false, name);
        assert.equal(facts.K9.visible_interactive_above_fold, 13, name);
        assert.equal(judged.items.K9.pass, false, name);
      }
      // the real inbox: arrows verified (each opens the report it moves to,
      // with a visible ring), then it counts as one control
      const { audit, error, facts } = await scene(inbox);
      assert.equal(error, null);
      const group = audit.groups.find((item) => item.kind === 'inbox');
      assert.equal(group.switcher, true);
      assert.deepEqual([...group.arrowed], ['r0', 'r1', 'r2', 'r3', 'r2', 'r1', 'r0']);
      assert.equal(facts.K2.items[0].interactive_count, 1);
      assert.equal(facts.K9.visible_interactive_above_fold, 10);
      // an inbox whose arrows open nothing is not verified
      const dead = await scene(inbox.replace("list.addEventListener('keydown'", "list.addEventListener('rs-never'"));
      assert.match(dead.error || '', /did not open the next report in the inbox/);
    } finally {
      await context.close();
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

  test('round 2 finding 13: invisible keyboard-focusable inbox descendants fail K3', async () => {
    const html = calmPage()
      .replace('.rail { display: block; overflow: hidden; width: 0; }', '.rail { display:block;overflow:hidden;width:0;opacity:0; }')
      .replace('.rail a { display: none; }', '.rail a { display:block;width:30px; }');
    const result = await judgeHtml(html);
    try {
      assert.equal(result.judged.items.K3.pass, false);
      assert.ok(result.facts.K3.samples[0].focusable_descendants > 0);
    } finally {
      await result.context.close();
    }
  });

  test('round 3 finding 5: display-none inbox ancestors remove descendants from K3', async () => {
    const html = calmPage()
      .replace(
        '.rail { display: block; overflow: hidden; width: 0; }',
        '.rail { display:none;overflow:hidden;width:0; }',
      )
      .replace('.rail a { display: none; }', '.rail a { display:block; }');
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
        post: true,
        k13: passingEvidence,
      });
      assert.equal(calm.ok, true, JSON.stringify(calm.items, null, 2));

      const cluttered = judgeCalmFacts(await measure(item), {
        post: true,
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
        post: true,
        k13: { keyboard: false, accessibility: true, copy_focus: true },
      });
      assert.equal(missingC12.items.K13.pass, false);
      assert.match(missingC12.items.K13.reasons.join(' '), /C12/);

      const missingC13 = judgeCalmFacts(facts, {
        post: true,
        k13: { keyboard: true, accessibility: false, copy_focus: true },
      });
      assert.equal(missingC13.items.K13.pass, false);
      assert.match(missingC13.items.K13.reasons.join(' '), /C13/);

      const hiddenCopy = judgeCalmFacts(facts, {
        post: true,
        k13: { keyboard: true, accessibility: true, copy_focus: false },
      });
      assert.equal(hiddenCopy.items.K13.pass, false);
      assert.match(hiddenCopy.items.K13.reasons.join(' '), /copy/i);
    } finally {
      await context.close();
    }
  });

  test('calm mode adds accent and shape-avatar scenes per payload fixture', async () => {
    const source = readFileSync(path.join(ROOT, 'tools/e2e.mjs'), 'utf8');
    const seen = [];
    const scope = {
      readFileSync,
      path,
      ROOT,
      parseColor,
      toHex,
      judgeCalmFacts: () => ({ ok: true, items: {} }),
      calmScene: async (_browser, _server, testCase, scene) => {
        seen.push({ case: testCase.id, ...scene });
        return {
          K13: { keyboard: { pass: true }, accessibility: { pass: true }, copy_focus: { pass: true } },
          identity: { pass: true, expected_accent: scene.expectedAccent },
        };
      },
    };
    vm.createContext(scope);
    vm.runInContext(
      source.slice(
        source.indexOf('const IDENTITY_FOREIGN = ['),
        source.indexOf('async function calmScene('),
      ),
      scope,
    );
    const scenes = await scope.calmIdentityScenes({}, {}, [{ id: 'approve', fixture: 'approve' }]);
    assert.equal(scenes.length, 20);
    assert.ok(seen.every((scene) => scene.case === 'approve'));
    assert.ok(seen.every((scene) => scene.openRuns === 3 && scene.identities.length === 3));
    const accentScenes = seen.filter((scene) => scene.fixture.endsWith('accent'));
    assert.equal(accentScenes.length, 8);
    assert.ok(accentScenes.every((scene) => new Set(scene.identities.map((item) => item.accent)).size === 3));
    const shapes = new Set(seen.flatMap((scene) => scene.identities.map((item) => item.avatar_shape)).filter(Boolean));
    assert.deepEqual([...shapes].sort(), ['blob', 'hex', 'pebble', 'squircle', 'star', 'tablet', 'teardrop']);
    const accent = (fixture, theme) => seen.find((scene) => (
      scene.fixture === fixture && scene.theme === theme
    )).expectedAccent;
    const tokens = readFileSync(path.join(ROOT, 'core/static/tokens.css'), 'utf8');
    const token = (name, theme) => {
      const block = theme === 'light'
        ? tokens.match(/:root\s*\{([^}]*)\}/u)[1]
        : tokens.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/u)[1];
      return toHex(parseColor(block.slice(block.indexOf(`${name}:`) + name.length + 1).match(/^\s*(#[0-9a-f]{6}|oklch\([^)]*\))/iu)[1]));
    };
    assert.equal(accent('approve+custom-accent', 'light'), token('--rs-accent', 'light'));
    assert.equal(accent('approve+custom-accent', 'dark'), '#0891b2');
    assert.equal(accent('approve+low-contrast-accent', 'light'), token('--rs-accent', 'light'));
    assert.equal(accent('approve+low-contrast-accent', 'dark'), '#f6c945');
    assert.equal(accent('approve+shape-avatars', 'light'), token('--rs-avatar-violet', 'light'));
    assert.equal(accent('approve+shape-avatars', 'dark'), token('--rs-accent', 'dark'));
    assert.equal(accent('approve+shape-avatars-2', 'light'), token('--rs-accent', 'light'));
    assert.equal(accent('approve+shape-avatars-2', 'dark'), token('--rs-avatar-orange', 'dark'));
    assert.equal(accent('approve+shape-fallbacks', 'light'), token('--rs-accent', 'light'));
    assert.equal(accent('approve+shape-fallbacks', 'dark'), token('--rs-accent', 'dark'));
  });

  // Identity calibration: avatars are media, a bot accent is the one
  // accent, and another report's accent painted in the inbox is caught.
  test('24 and 32 px avatars are media, not nested boxes (K5)', async () => {
    const avatar = (size, inner = '') => (
      `<span data-rs-avatar aria-hidden="true" style="display:inline-grid;width:${size}px;height:${size}px;border-radius:50%;background:#c4c4cc">${inner}</span>`
    );
    const nested = (content) => (
      `Second decision item</p><div style="padding:8px;background:#e0e0e0"><div style="padding:8px;background:#d0d0d4">${content} Inbox Agent</div></div>`
    );
    for (const [content, pass] of [
      [avatar(24) + avatar(32, '<img alt="" src="data:,">'), true],
      [avatar(48), false],
      [avatar(32, '<span>IA</span>'), false],
      [avatar(32, '<svg data-rs-shape="blob" viewBox="0 0 48 48"><path fill-rule="evenodd" d="M4 24a20 20 0 1 0 40 0a20 20 0 1 0-40 0Z"/></svg>'), true],
      [avatar(32, '<svg viewBox="0 0 48 48"><path d="M4 24h40"/></svg>'), false],
    ]) {
      const result = await judgeHtml(calmPage().replace('Second decision item</p>', nested(content)));
      try {
        assert.equal(result.judged.items.K5.pass, pass, content);
      } finally {
        await result.context.close();
      }
    }
  });

  test('a bot accent replacing the accent token passes K1 and K6', async () => {
    for (const accent of ['#0891b2', '#f6c945']) {
      const result = await judgeHtml(calmPage().replaceAll('#336699', accent));
      try {
        assert.equal(result.judged.items.K1.pass, true, accent);
        assert.equal(result.judged.items.K6.pass, true, accent);
        assert.equal(result.facts.K1.accent_fill_ids.length, 1, accent);
      } finally {
        await result.context.close();
      }
    }
  });

  test('another report\'s accent painted in the inbox fails K6 (one accent at a time)', async () => {
    const page = calmPage({ runCount: 3 }).replaceAll('#336699', '#0891b2');
    const clean = await judgeHtml(page);
    try {
      assert.equal(clean.judged.items.K6.pass, true);
    } finally {
      await clean.context.close();
    }
    const foreign = await judgeHtml(page.replace(
      '>Run 2</a>',
      '>Run 2 <span style="color:#a855f7">Desk Agent</span></a>',
    ));
    try {
      assert.equal(foreign.judged.items.K6.pass, false);
    } finally {
      await foreign.context.close();
    }
  });

  /* the C16 exception: the task banner's tint is a status colour per kind,
     not the accent, and the only large non-accent colour allowed */
  const taskBanner = (inner = '') => '<main><section data-rs-task style="padding:12px 16px;'
    + 'border-left:4px solid #1b7340;background:#e2f3e7"><p>Approve, then the bot posts</p>'
    + `<p>Check the text and the platforms.</p>${inner}</section>`;

  test('K11: a nameless bot shown by its id in the shell name slots is its name; the id in content is noise', async () => {
    const slots = await judgeHtml(calmPage().replace(
      '<header><h1>Review report</h1>',
      '<header><p id="rs-bot-name">deploy-bot</p><h1>Review report</h1>',
    ).replace('>Run 1</a>', '><span class="rs-inbox__bot">deploy-bot</span> · Urgent</a>'));
    try {
      assert.equal(slots.judged.items.K11.pass, true, slots.judged.items.K11.reasons.join('; '));
    } finally {
      await slots.context.close();
    }
    const content = await judgeHtml(calmPage().replace('</main>', '<p>Sent by deploy-bot</p></main>'));
    try {
      assert.equal(content.judged.items.K11.pass, false);
    } finally {
      await content.context.close();
    }
  });

  test('K6 status exception: a small status mark passes; a small mark painting a large child does not', async () => {
    const small = await judgeHtml(calmPage().replace(
      '</main>',
      '<p>Backups <span data-rs-status="ok" style="color:#1b7340">✓ fine</span></p></main>',
    ));
    try {
      assert.equal(small.judged.items.K6.pass, true, small.judged.items.K6.reasons.join('; '));
    } finally {
      await small.context.close();
    }
    // a 10x10 marked box whose overflowing child paints 800x500 off-accent
    const large = await judgeHtml(calmPage().replace(
      '</main>',
      '<span data-rs-status="danger" style="display:inline-block;width:10px;height:10px;overflow:visible">'
        + '<span style="display:block;width:800px;height:500px;color:#d2691e">A large status text</span></span></main>',
    ));
    try {
      assert.equal(large.judged.items.K6.pass, false, 'the exempt area includes overflowing descendants');
    } finally {
      await large.context.close();
    }
  });

  test('the task banner tint passes K6', async () => {
    const result = await judgeHtml(calmPage().replace('<main>', taskBanner()));
    try {
      assert.equal(result.facts.K6.task_banners, 1);
      assert.deepEqual(result.facts.K6.off_accent, []);
      assert.equal(result.judged.items.K6.pass, true, result.judged.items.K6.reasons.join('; '));
    } finally {
      await result.context.close();
    }
  });

  test('the same tint outside the task banner fails K6', async () => {
    const result = await judgeHtml(calmPage().replace('<main>', taskBanner().replace(' data-rs-task', '')));
    try {
      assert.equal(result.judged.items.K6.pass, false);
    } finally {
      await result.context.close();
    }
  });

  test('a second tinted task banner fails K6', async () => {
    const twice = taskBanner() + taskBanner().replace('<main>', '');
    const result = await judgeHtml(calmPage().replace('<main>', twice));
    try {
      assert.equal(result.facts.K6.task_banners, 2);
      assert.equal(result.judged.items.K6.pass, false);
    } finally {
      await result.context.close();
    }
  });

  test('the banner must sit under the title, hold one summary, and reject a semantic control', async () => {
    const placed = await judgeHtml(calmPage().replace(
      '</header>',
      '</header><section id="placed" data-rs-task style="padding:12px 16px;border-left:4px solid #1b7340;background:#e2f3e7"><p>Approve, then the bot posts</p></section>',
    ).replace('<h1>Review report</h1>', '<h1 id="rs-title">Review report</h1>'));
    try {
      assert.equal(placed.facts.K6.task_banner_under_title, true);
      assert.equal(placed.judged.items.K6.pass, true, placed.judged.items.K6.reasons.join('; '));
    } finally {
      await placed.context.close();
    }
    const above = await judgeHtml(calmPage().replace(
      '<header>',
      '<section data-rs-task style="padding:12px;background:#e2f3e7"><p>Early banner</p></section><header>',
    ).replace('<h1>Review report</h1>', '<h1 id="rs-title">Review report</h1>'));
    try {
      assert.equal(above.facts.K6.task_banner_under_title, false);
      assert.equal(above.judged.items.K6.pass, false);
      assert.match(above.judged.items.K6.reasons.join(' '), /under the title/u);
    } finally {
      await above.context.close();
    }
    const two = await judgeHtml(calmPage().replace(
      '<main>',
      taskBanner('<details><summary>More</summary><p>One.</p></details><details><summary>Again</summary><p>Two.</p></details>'),
    ));
    try {
      assert.equal(two.facts.K6.task_banner_summaries, 2);
      assert.equal(two.judged.items.K6.pass, false);
    } finally {
      await two.context.close();
    }
    const role = await judgeHtml(calmPage().replace(
      '<main>',
      taskBanner('<span role="button">Approve</span>'),
    ));
    try {
      assert.equal(role.judged.items.K6.pass, false);
      assert.match(role.judged.items.K6.reasons.join(' '), /holds controls/u);
    } finally {
      await role.context.close();
    }
    const painted = await judgeHtml(calmPage().replace(
      '<main>',
      taskBanner('<span style="color:#d2691e">A second hue inside</span>'),
    ));
    try {
      assert.equal(painted.judged.items.K6.pass, false);
      assert.ok(painted.facts.K6.off_accent.length > 0);
    } finally {
      await painted.context.close();
    }
  });

  test('a button in the task banner fails K6; the details toggle of a long why passes', async () => {
    const button = await judgeHtml(calmPage().replace('<main>', taskBanner('<button>Approve</button>')));
    try {
      assert.equal(button.judged.items.K6.pass, false);
      assert.match(button.judged.items.K6.reasons.join(' '), /holds controls/u);
    } finally {
      await button.context.close();
    }
    const details = await judgeHtml(calmPage().replace(
      '<main>',
      taskBanner('<details><summary>More on why</summary><p>The rest.</p></details>'),
    ));
    try {
      assert.equal(details.judged.items.K6.pass, true, details.judged.items.K6.reasons.join('; '));
    } finally {
      await details.context.close();
    }
  });
});

test('K10 judges a report with a post block, or a page the caller marks', () => {
  const facts = (n) => ({ K10: { post_blocks: n } });
  assert.equal(calmTools.judgesPostPreview(facts(1)), true);
  assert.equal(calmTools.judgesPostPreview(facts(0)), false);
  assert.equal(calmTools.judgesPostPreview({}), false);
  assert.equal(calmTools.judgesPostPreview(facts(0), { post: true }), true);
  assert.equal(calmTools.judgesPostPreview(facts(2), { post: false }), false);
});
