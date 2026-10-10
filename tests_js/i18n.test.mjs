// German string table (spec 5.3, 4.6, 4.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const de = JSON.parse(readFileSync(new URL('../core/i18n/de.json', import.meta.url), 'utf8'));

test('spec 5.3 core set, exact wording', () => {
  const core = {
    submit: 'An Bot senden', discard: 'Verwerfen', seen: 'Gesehen', copy: 'Kopieren',
    copied: 'Kopiert ✓', copy_text: 'Text kopieren', copy_hashtags: 'Hashtags kopieren',
    copy_comment: 'Kommentar kopieren', reveal: 'Im Ordner zeigen' /* calm UI: cross-platform wording */, approve: 'Freigeben',
    request_changes: 'Änderungen anfordern', comment: 'Kommentar', note: 'Notiz',
    sent: 'An Bot übermittelt ✓', expired: 'Abgelaufen',
    clipboard_busy: 'Zwischenablage belegt – bitte nochmal klicken', new: 'neu',
    theme: 'Hell/Dunkel', confirm_type: 'Zum Bestätigen „{word}“ eintippen',
    no_runs: 'keine offenen Berichte',
  };
  for (const [k, v] of Object.entries(core)) assert.equal(de[k], v, k);
});

test('template strings from spec 4.6 / 4.7', () => {
  const want = {
    section_todo: 'Wartet auf dich' /* calm UI: no icon, no count */, section_done: 'Erledigt', section_feed: 'Feed', section_keep: 'Behalten',
    verb_pay: 'Zahlen', verb_sign: 'Unterschreiben', verb_reply: 'Antworten', verb_shop: 'Neuer Shop',
    verb_unsub: 'Abmelden?', verb_check: 'Prüfen', verb_other: 'Sonstiges',
    choice_erledigt: 'Erledigt', choice_spaeter: 'Später', choice_ignorieren: 'Ignorieren',
    choice_ja: 'Ja', choice_nein: 'Nein',
    approve_for: 'Freigeben für {platform}',
    lint_em_dash: 'Gedankenstrich (—) gefunden', lint_registered: '® gefunden',
    lint_ig_needs_image: 'Instagram braucht ein Bild',
    platform_x: 'X', platform_linkedin: 'LinkedIn', platform_instagram: 'Instagram', platform_facebook: 'Facebook',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(de[k], v, k);
});

test('no em dash except the lint badge that names it', () => {
  for (const [k, v] of Object.entries(de)) {
    if (k === 'lint_em_dash') continue;
    assert.ok(!v.includes('—'), k + ' contains an em dash');
  }
});

test('keys are English snake_case, values non-empty strings, placeholders {name}', () => {
  for (const [k, v] of Object.entries(de)) {
    assert.match(k, /^[a-z][a-z0-9_]*$/, k);
    assert.equal(typeof v, 'string', k);
    assert.ok(v.length > 0, k);
    for (const m of v.matchAll(/\{([^}]*)\}/g)) assert.match(m[1], /^[a-z][a-z0-9_]*$/, k + ': ' + m[0]);
  }
});

test('platform name keys match platforms.json name_key', () => {
  const p = JSON.parse(readFileSync(new URL('../core/static/platforms.json', import.meta.url), 'utf8'));
  for (const v of Object.values(p.platforms)) assert.ok(de[v.name_key], v.name_key);
});
