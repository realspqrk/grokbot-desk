const dots = ['\u3002', '\uFF0E', '\uFF61'];

const cases = [
  ['balanced group directly after slash', 'http://example.com/(a)', 23],
  ['period before balanced group ends the path', 'http://example.com/.(a)', 27],
  ['exclamation before balanced group ends the path', 'http://example.com/!(a)', 27],
  ['semicolon before balanced group ends the path', 'http://example.com/;(a)', 27],
  ['closing bracket before balanced group ends the path', 'http://example.com/[a](b)', 27],
  ['balanced group after an ending character', 'http://example.com/a(b)', 23],
  ['punctuation after an ending character ends before a balanced group', 'http://example.com/a!(b)', 27],
  ['percent inside a balanced group', 'http://example.com/(%)', 23],
  ['balanced group followed by an ending character', 'http://example.com/(a)b', 23],
  ['adjacent balanced groups', 'http://example.com/(a)(b)', 23],
  ['adjacent balanced groups after an ending character', 'http://example.com/a(b)(c)', 23],
  ['nested group with an outer suffix', 'http://example.com/a((b)c)', 23],
  ['nested group with an outer prefix', 'http://example.com/a(a(b))', 23],
  ['multiplication sign is not a Latin accent path character', 'http://example.com/a\u00D7b', 25],
  ['division sign is not a Latin accent path character', 'http://example.com/a\u00F7b', 25],
  ['explicit Latin accent member remains a path character', 'http://example.com/a\u019Bb', 23],
  ['punycode TLD keeps its upstream boundary before at-sign', '4.xn--M@', 24],
];

for (const [index, dot] of dots.entries()) {
  const label = `Unicode dot separator ${index + 1}`;
  cases.push(
    [`${label} maps between ASCII components`, 'http://' + ('a' + dot).repeat(27) + 'x.com', 23],
    [`${label} maps and encodes accented components separately`, 'http://' + ('é' + dot).repeat(8) + 'x.com', 36],
    [`${label} maps and encodes CJK components separately`, 'http://' + ('日' + dot).repeat(8) + 'x.com', 44],
    [`${label} accepts a 63-character ASCII toASCII label`, 'http://' + 'a'.repeat(31) + dot + 'b'.repeat(31) + '.com', 23],
    [`${label} rejects a 64-character ASCII toASCII label`, 'http://' + 'a'.repeat(32) + dot + 'b'.repeat(31) + '.com', 76],
    [`${label} accepts a 63-character encoded non-ASCII label`, 'http://' + 'é'.repeat(25) + dot + 'é'.repeat(25) + '.com', 23],
    [`${label} rejects a 64-character encoded non-ASCII label`, 'http://' + 'é'.repeat(25) + dot + 'é'.repeat(26) + '.com', 64],
  );
}

export default {
  source: 'twitter-text 3.1.0 extractUrlsWithIndices and parseTweet weighting',
  cases: cases.map(([name, text, upstream_count]) => ({ name, text, upstream_count })),
};
