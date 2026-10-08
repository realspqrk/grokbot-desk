const variants = {
  K1: '<button data-rs-primary class="primary">Second primary</button>',
  K2: '<div class="extra-actions"><button>One</button><button>Two</button><button>Three</button><button>Four</button></div>',
  K4: '<p class="extra-type">A fourth type size</p>',
  K5: '<div class="box outer"><div class="box middle"><div class="box inner">Nested boxes</div></div></div>',
  K6: '<p class="second-hue">A second hue</p>',
  K8: '<label>Comment <input value=""></label>',
  K9: '<div class="above-fold">' + Array.from({ length: 9 }, (_, index) => `<button>Extra ${index + 1}</button>`).join('') + '</div>',
  K10: '<section data-rs-mockup class="mockup second-mockup"><p>Second platform preview</p></section>',
  K11: '<p>Updated 2026-10-08 12:30</p>',
  K12: '<div class="slow-motion">Slow motion</div>',
};

export function calmPage({ cluttered = null, runCount = 1 } = {}) {
  const extra = variants[cluttered] || '';
  const badCopyFocus = cluttered === 'K13' ? ' bad-copy-focus' : '';
  const itemGap = cluttered === 'K7' ? '4px' : '20px';
  const railDisplay = cluttered === 'K3' || runCount >= 2 ? 'block' : 'none';
  return `<!doctype html>
<html>
<head>
<style>
:root { --rs-accent: #336699; --space-4: 16px; }
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; min-height: 100%; background: #f5f5f0; color: #202020; font: 400 16px/1.4 Arial, sans-serif; }
header { height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; }
h1 { margin: 0; font-size: 24px; font-weight: 600; }
button { font: inherit; color: inherit; border: 0; background: transparent; }
button:focus-visible, [tabindex]:focus-visible { outline: 2px solid #336699; }
.layout { width: 100%; display: grid; grid-template-columns: ${railDisplay === 'block' ? '180px 1fr' : '0 1fr'}; }
.rail { display: block; overflow: hidden; width: ${railDisplay === 'block' ? '180px' : '0'}; }
.rail button { display: ${railDisplay === 'block' ? 'block' : 'none'}; }
main { width: 620px; max-width: 100%; padding: 24px; }
.items { display: flex; flex-direction: column; gap: ${itemGap}; }
[data-rs-item] { min-height: 44px; }
.copy { opacity: 0; width: 28px; height: 28px; transition: opacity 150ms; }
[data-rs-item]:hover .copy, .copy:focus-visible { opacity: 1; }
.bad-copy-focus:focus-visible { opacity: 0; }
.primary { display: inline-block; margin-top: 20px; padding: 10px 18px; color: #fff; background: #336699; }
.tabs { display: flex; gap: 12px; margin: 20px 0; }
[role=tab] [data-rs-status] { display: inline-block; width: 6px; height: 6px; background: #4d7d3c; }
.mockup { width: 500px; min-height: 120px; border: 1px solid #aaa; }
.mockup p { margin: 16px; }
.box { padding: 8px; border: 1px solid #999; background: #eee; }
.extra-type { width: 500px; font-size: 11px; font-weight: 900; }
.second-hue { color: #d2691e; }
.extra-actions button, .above-fold button { margin: 2px; }
.slow-motion { animation: slow 500ms linear infinite; }
@keyframes slow { from { opacity: .9; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0s !important; animation-duration: 0s !important; }
  .slow-motion { animation-duration: 500ms !important; }
}
</style>
</head>
<body>
<header><h1>Review report</h1><button aria-label="More">More</button></header>
<div class="layout">
  <nav class="rail" aria-label="Open runs">
    ${Array.from({ length: runCount }, (_, index) => `<button>Run ${index + 1}</button>`).join('')}
  </nav>
  <main>
    <div class="items">
      <article data-rs-item><p>First decision item</p><button data-copy-id="item-copy" class="copy${badCopyFocus}" aria-label="Copy item">C</button>${cluttered === 'K2' ? variants.K2 : ''}</article>
      <article data-rs-item><p>Second decision item</p></article>
    </div>
    <button aria-expanded="false">Add note</button>
    <div class="tabs" role="tablist" aria-label="Platforms">
      <button role="tab" aria-selected="true">Web <span data-rs-status aria-label="Approved"></span></button>
      <button role="tab" aria-selected="false">Mail <span data-rs-status aria-label="Pending"></span></button>
    </div>
    <section data-rs-mockup class="mockup"><p>Platform preview</p></section>
    <details><summary>Handled items</summary><p>Hidden details</p></details>
    <button data-rs-primary class="primary">Approve</button>
    ${cluttered === 'K2' ? '' : extra}
  </main>
</div>
<script>
document.querySelector('.tabs').addEventListener('click', (event) => {
  const control = event.target.closest('button');
  if (!control) return;
  for (const peer of control.parentElement.querySelectorAll('button')) {
    if (peer.hasAttribute('aria-selected')) {
      peer.setAttribute('aria-selected', String(peer === control));
    }
    if (peer.hasAttribute('aria-pressed')) {
      peer.setAttribute('aria-pressed', String(peer === control));
    }
  }
});
</script>
</body>
</html>`;
}
