/* grokbot-desk: platform character counter (spec 4.7, C6).
 * UMD: in the browser it sets window.RS_COUNT; in Node it is module.exports
 * (load it with createRequire). Rules and limits live in platforms.json; the
 * exact rules are written down in its "notes".
 * URL logic is adapted from twitter-text 3.1.0, Copyright 2018 Twitter, Inc.,
 * Apache-2.0; see vendor/twitter-text.LICENSE and vendor/README.md.
 *
 * Browser: rs.js calls RS_COUNT.setPlatforms(boot.platforms). Without that,
 * the first count() reads the platforms from <script id="rs-boot">.
 */
(function (root, factory) {
  var twitterText = root && root.RS_TWITTER_TEXT_V3;
  if (typeof module === 'object' && module && module.exports) {
    try { twitterText = require('./twitter-text-v3-data.js'); } catch (e) { /* set by browser */ }
  }
  var api = factory(twitterText || {});
  if (typeof module === 'object' && module && module.exports) {
    try { api.setPlatforms(require('./platforms.json')); } catch (e) { /* set later */ }
    module.exports = api;
  }
  if (root) root.RS_COUNT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (twitterText) {
  'use strict';

  var cfg = null;
  var domainRe = null;
  var domainRunCharRe = null;
  var asciiDomainRe = null;
  var HTTP_PREFIX = 'http:' + '//';
  var DEFAULT_PROTOCOL = 'https:' + '//';

  // twitter-text applies emoji_weight only to the entities recognized by its
  // parser. The pinned longest-first regex comes from twitter-text-v3-data.js;
  // unmatched selectors, joiners and regional indicators fall through.
  var EMOJI_SEQ_RE = new RegExp(twitterText.emoji ||
    '[0-9#*]\\uFE0F?\\u20E3|\\p{RGI_Emoji}', twitterText.emoji ? 'g' : 'gv');
  var HASHTAG_RE = /(^|[^\p{L}\p{M}\p{N}_&#])#+(?=[\p{L}\p{M}\p{N}_])/gu;
  var PATH_CHAR_RE = /[a-z0-9!\*';:=+,\.$\/%#\[\]\-\u2013_~@\|&\xC0-\xD6\xD8-\xF6\xF8-\xFF\u0100-\u024F\u0253\u0254\u0256\u0257\u0259\u025B\u0263\u0268\u026F\u0272\u0289\u028B\u02BB\u0300-\u036F\u1E00-\u1EFF\u0400-\u04FF]/i;
  var PATH_END_RE = /[+\-a-z0-9=_#\/\xC0-\xD6\xD8-\xF6\xF8-\xFF\u0100-\u024F\u0253\u0254\u0256\u0257\u0259\u025B\u0263\u0268\u026F\u0272\u0289\u028B\u02BB\u0300-\u036F\u1E00-\u1EFF\u0400-\u04FF]/i;
  var QUERY_CHAR_RE = /[a-z0-9!?\*'@();:&=+\$\/%#\[\]\-_\.,~|]/i;
  var QUERY_END_RE = /[a-z0-9\-_&=#\/]/i;

  function setPlatforms(p) {
    cfg = p;
    var tlds = (twitterText.tlds || '').split('|').filter(Boolean);
    // Ported from twitter-text 3.1.0 regexp/{validDomain,validSubdomain,
    // validDomainName,invalidDomainChars}. The alternatives inside a label
    // are disjoint, avoiding the overlapping Unicode branches that previously
    // caused exponential backtracking on an unknown TLD.
    var domainChar = "[^!'#%&'()*+,\\\\\\-./:;<=>?@\\[\\]\\^_{|}~$" +
      '\\x09-\\x0D\\x20\\x85\\xA0\\u1680\\u180E\\u2000-\\u200A' +
      '\\u2028\\u2029\\u202F\\u205F\\u3000\\uFFFE\\uFEFF\\uFFFF' +
      '\\u202A-\\u202E\\u061C\\u200E\\u200F\\u2066-\\u2069]';
    var subdomain = '(?:(?:' + domainChar + '(?:[_-]|' + domainChar +
      ')*)?' + domainChar + '\\.)';
    var domainName = '(?:(?:' + domainChar + '(?:-|' + domainChar +
      ')*)?' + domainChar + '\\.)';
    var tld = '(?:(?:' + tlds.join('|') + ')(?![0-9a-z@+\\-])' +
      '|xn--[-0-9a-z]+)';
    var domain = '(?:' + subdomain + ')*' + domainName + tld;
    domainRe = new RegExp(
      '((https?:\\/\\/)?(' + domain + '))',
      'iy');
    domainRunCharRe = new RegExp('^(?:' + domainChar + '|[._-])$');

    // Bare URLs are reduced to Latin/accented ASCII-domain ranges exactly as
    // extractUrlsWithIndices does after matching the wider Unicode candidate.
    var latinAccent = '\\xC0-\\xD6\\xD8-\\xF6\\xF8-\\xFF' +
      '\\u0100-\\u024F\\u0253\\u0254\\u0256\\u0257\\u0259\\u025B' +
      '\\u0263\\u0268\\u026F\\u0272\\u0289\\u028B\\u02BB' +
      '\\u0300-\\u036F\\u1E00-\\u1EFF';
    asciiDomainRe = new RegExp(
      '(?:(?:[-a-z0-9' + latinAccent + ']+)\\.)+' + tld,
      'gi');
  }

  function ensure() {
    if (cfg) return;
    if (typeof document !== 'undefined') {
      var el = document.getElementById('rs-boot');
      if (el) {
        try {
          var boot = JSON.parse(el.textContent);
          if (boot && boot.platforms) { setPlatforms(boot.platforms); return; }
        } catch (e) { /* fall through */ }
      }
    }
    throw new Error('RS_COUNT: platforms not configured');
  }

  function platformCfg(platform) {
    ensure();
    var p = cfg.platforms[platform];
    if (!p) throw new TypeError('RS_COUNT: unknown platform ' + platform);
    return p;
  }

  function norm(text) {
    if (text === null || text === undefined) return '';
    return String(text).normalize('NFC');
  }

  function codePoints(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) i++;
      }
      n++;
    }
    return n;
  }

  // validUrlBalancedParens allows one nested pair. A failed group ends the
  // path, so each input character is visited at most once.
  function balancedEnd(s, start) {
    var pos = start + 1;
    var outerChars = 0;
    var nested = false;
    while (pos < s.length) {
      var ch = s.charAt(pos);
      if (PATH_CHAR_RE.test(ch)) {
        outerChars++;
        pos++;
      } else if (ch === '(' && !nested) {
        nested = true;
        pos++;
        var innerChars = 0;
        while (pos < s.length && PATH_CHAR_RE.test(s.charAt(pos))) {
          innerChars++;
          pos++;
        }
        if (!innerChars || s.charAt(pos) !== ')') return -1;
        pos++;
      } else if (ch === ')') {
        return (nested || outerChars) ? pos + 1 : -1;
      } else {
        return -1;
      }
    }
    return -1;
  }

  function pathEnd(s, start) {
    // The leading slash is outside validUrlPath in upstream's extractUrl.
    // A general-character/balanced-group segment becomes a path token only
    // when it reaches validUrlPathEndingChars. A balanced group can also be a
    // token by itself, but punctuation before it cannot borrow that ending.
    var pos = start + 1;
    var validEnd = pos;
    while (pos < s.length) {
      var ch = s.charAt(pos);
      if (PATH_CHAR_RE.test(ch)) {
        pos++;
        if (PATH_END_RE.test(ch)) validEnd = pos;
        continue;
      }
      if (ch === '(') {
        var groupEnd = balancedEnd(s, pos);
        if (groupEnd !== -1) {
          if (pos === validEnd) validEnd = groupEnd;
          pos = groupEnd;
          continue;
        }
      }
      break;
    }
    return validEnd;
  }

  function queryEnd(s, start) {
    var pos = start;
    var validEnd = start;
    while (pos < s.length && QUERY_CHAR_RE.test(s.charAt(pos))) {
      pos++;
      if (QUERY_END_RE.test(s.charAt(pos - 1))) validEnd = pos;
    }
    return validEnd;
  }

  function urlEnd(s, baseEnd) {
    var pos = baseEnd;
    if (s.charAt(pos) === ':' && /[0-9]/.test(s.charAt(pos + 1))) {
      pos += 2;
      while (/[0-9]/.test(s.charAt(pos))) pos++;
    }

    var hasPath = s.charAt(pos) === '/';
    if (hasPath) pos = pathEnd(s, pos);
    if (s.charAt(pos) === '?') {
      var query = queryEnd(s, pos + 1);
      if (query > pos + 1) pos = query;
    }
    return { end: pos, hasPath: hasPath };
  }

  function adaptBias(delta, points, firstTime) {
    delta = firstTime ? Math.floor(delta / 700) : Math.floor(delta / 2);
    delta += Math.floor(delta / points);
    var k = 0;
    while (delta > 455) {
      delta = Math.floor(delta / 35);
      k += 36;
    }
    return k + Math.floor(36 * delta / (delta + 38));
  }

  // RFC 3492 component length used by punycode.toASCII. Components whose
  // minimum encoding already exceeds the DNS limit never enter the encoder.
  function punycodeComponentLength(label) {
    var points = [];
    var basic = 0;
    var nonAscii = false;
    for (var ch of label) {
      var cp = ch.codePointAt(0);
      points.push(cp);
      if (cp < 128) basic++;
      else nonAscii = true;
    }
    if (!nonAscii) return points.length;
    if (points.length + 4 > 63) return 64;

    var output = basic + (basic ? 1 : 0);
    var handled = basic;
    var n = 128;
    var delta = 0;
    var bias = 72;
    while (handled < points.length) {
      var next = Infinity;
      for (var i = 0; i < points.length; i++) {
        if (points[i] >= n && points[i] < next) next = points[i];
      }
      delta += (next - n) * (handled + 1);
      n = next;
      for (var j = 0; j < points.length; j++) {
        if (points[j] < n) {
          delta++;
        } else if (points[j] === n) {
          var q = delta;
          for (var k = 36; ; k += 36) {
            var threshold = k <= bias ? 1 : (k >= bias + 26 ? 26 : k - bias);
            output++;
            if (q < threshold) break;
            q = Math.floor((q - threshold) / (36 - threshold));
          }
          bias = adaptBias(delta, handled + 1, handled === basic);
          delta = 0;
          handled++;
          if (output + 4 > 63) return 64;
        }
      }
      delta++;
      n++;
    }
    return output + 4;
  }

  // punycode.toASCII maps all four IDNA separators before encoding each
  // resulting component. idna.js then checks the returned token's total
  // length, while preserving the original domain string for URL accounting.
  function toAsciiLength(label) {
    var total = 0;
    var componentStart = 0;
    for (var i = 0; i < label.length; i++) {
      var ch = label.charAt(i);
      if (ch !== '\u3002' && ch !== '\uFF0E' && ch !== '\uFF61') continue;
      total += punycodeComponentLength(label.slice(componentStart, i)) + 1;
      if (total > 63) return 64;
      componentStart = i + 1;
    }
    total += punycodeComponentLength(label.slice(componentStart));
    return total > 63 ? 64 : total;
  }

  function asciiDomain(domain) {
    // Mirrors twitter-text's special rejection of a non-ASCII domain that
    // claims to have already been punycode encoded.
    if (domain.slice(0, 4) === 'xn--') {
      asciiDomainRe.lastIndex = 0;
      if (!asciiDomainRe.test(domain)) return null;
    }

    var labels = domain.split('.');
    for (var i = 0; i < labels.length; i++) {
      var length = toAsciiLength(labels[i]);
      if (length < 1 || length > 63) return null;
    }
    return labels.join('.');
  }

  function validUrlLength(url, protocol, domain) {
    var encoded = asciiDomain(domain);
    if (!encoded) return false;
    var encodedLength = url.length + encoded.length - domain.length;
    return (protocol || DEFAULT_PROTOCOL).length + encodedLength <= 4096;
  }

  function isDomainRunChar(ch) {
    return ch !== '' && domainRunCharRe.test(ch);
  }

  function invalidPrecedingChar(ch) {
    return /[A-Za-z0-9@＠$#＃\uFFFE\uFEFF\uFFFF]/.test(ch);
  }

  function protocolAt(s, index) {
    var prefix = s.slice(index, index + 8).toLowerCase();
    return prefix.indexOf(HTTP_PREFIX) === 0 || prefix === DEFAULT_PROTOCOL;
  }

  function candidateStart(s, from, allowAtFrom) {
    var fallback = -1;
    var sawDot = false;
    for (var i = from; i < s.length; i++) {
      var before = i ? s.charAt(i - 1) : '';
      // extractUrl consumes its preceding character. After a prior match,
      // that character must be at or beyond RegExp.lastIndex.
      var validBefore = i === 0
        || (i > from && !invalidPrecedingChar(before))
        || (allowAtFrom && i === from && !invalidPrecedingChar(before));
      if (validBefore && protocolAt(s, i)) {
        return fallback !== -1 && sawDot ? fallback : i;
      }
      if (!isDomainRunChar(s.charAt(i))) {
        if (fallback !== -1) return fallback;
        continue;
      }
      if (fallback !== -1 && s.charAt(i) === '.') sawDot = true;
      if (fallback === -1 && validBefore && !/[-_.]/.test(s.charAt(i))) {
        fallback = i;
      }
    }
    return fallback;
  }

  function protocolStartInRun(s, start, end) {
    for (var i = start; i < end; i++) {
      var before = i ? s.charAt(i - 1) : '';
      if (!invalidPrecedingChar(before) && protocolAt(s, i)) return i;
    }
    return end;
  }

  function retryStartInRun(s, start, end) {
    var protocol = protocolStartInRun(s, start + 1, end);
    var underscore = s.lastIndexOf('_', end - 1);
    if (underscore < start || underscore + 1 >= end) return protocol;
    return Math.min(protocol, underscore + 1);
  }

  function domainRunEnd(s, start) {
    var end = start;
    while (end < s.length && isDomainRunChar(s.charAt(end))) end++;
    return end;
  }

  // URL ranges [start, end) in UTF-16 indices, sorted, non-overlapping.
  function urlRanges(s) {
    var found = [];
    if (s.indexOf('.') === -1) return found;
    var searchFrom = 0;
    var allowAtFrom = false;
    while (searchFrom < s.length) {
      var start = candidateStart(s, searchFrom, allowAtFrom);
      allowAtFrom = false;
      if (start === -1) break;
      domainRe.lastIndex = start;
      var m = domainRe.exec(s);
      if (!m) {
        var runEnd = domainRunEnd(s, start);
        searchFrom = retryStartInRun(s, start, runEnd);
        allowAtFrom = searchFrom < runEnd;
        if (searchFrom === start) searchFrom++;
        continue;
      }
      var protocol = m[2] || '';
      var baseEnd = domainRe.lastIndex;
      var parsed = urlEnd(s, baseEnd);
      var end = parsed.end;
      // The upstream extraction regex consumes the path and query as part of
      // this match. Advance equivalently so a domain-looking path segment
      // cannot swallow a later CJK-delimited URL candidate.
      searchFrom = end;
      var url = s.slice(start, end);
      if (!validUrlLength(url, protocol, m[3])) continue;

      if (protocol) {
        var entityEnd = end;
        if (
          m[3].toLowerCase() === 't.co'
          && s.charAt(baseEnd) === '/'
          && /[a-z0-9]/i.test(s.charAt(baseEnd + 1))
        ) {
          var slugEnd = baseEnd + 1;
          while (/[a-z0-9]/i.test(s.charAt(slugEnd))) slugEnd++;
          if (slugEnd - baseEnd - 1 > 40) continue;
          entityEnd = slugEnd;
          if (s.charAt(entityEnd) === '?') {
            var tcoQuery = queryEnd(s, entityEnd + 1);
            if (tcoQuery > entityEnd + 1) entityEnd = tcoQuery;
          }
        }
        found.push([start, entityEnd]);
        continue;
      }

      if (/[-_.\/]/.test(start ? s.charAt(start - 1) : '')) continue;

      // A wide Unicode candidate may contain several Latin URL domains
      // separated by CJK text. Upstream emits each ASCII-compatible domain;
      // only the final one inherits the candidate's path/query.
      var domain = m[3];
      var matches = [];
      var ascii;
      asciiDomainRe.lastIndex = 0;
      while ((ascii = asciiDomainRe.exec(domain))) {
        matches.push([
          start + ascii.index,
          start + ascii.index + ascii[0].length
        ]);
      }
      for (var i = 0; i < matches.length; i++) {
        if (i === matches.length - 1 && parsed.hasPath) matches[i][1] = end;
        found.push(matches[i]);
      }
    }
    return found;
  }

  function cpWeight(cp, p) {
    var r = p.ranges;
    for (var i = 0; i < r.length; i++) {
      if (cp >= r[i][0] && cp <= r[i][1]) return r[i][2];
    }
    return p.default_weight;
  }

  function weightCodePoints(s, p) {
    var w = 0;
    for (var ch of s) w += cpWeight(ch.codePointAt(0), p);
    return w;
  }

  function weightPlain(s, p) {
    if (!s) return 0;
    var w = 0;
    var pos = 0;
    var m;
    EMOJI_SEQ_RE.lastIndex = 0;
    while ((m = EMOJI_SEQ_RE.exec(s))) {
      w += weightCodePoints(s.slice(pos, m.index), p) + p.emoji_weight;
      pos = m.index + m[0].length;
    }
    return w + weightCodePoints(s.slice(pos), p);
  }

  function weighted(s, p) {
    var ranges = urlRanges(s);
    var w = 0;
    var pos = 0;
    for (var i = 0; i < ranges.length; i++) {
      w += weightPlain(s.slice(pos, ranges[i][0]), p);
      w += p.url_weight;
      pos = ranges[i][1];
    }
    return w + weightPlain(s.slice(pos), p);
  }

  function hashtags(s) {
    var n = 0;
    HASHTAG_RE.lastIndex = 0;
    while (HASHTAG_RE.exec(s)) n++;
    return n;
  }

  /** count(text, platform) -> {count, limit, over, fold?, hashtags?, hashtagLimit?} */
  function count(text, platform) {
    var p = platformCfg(platform);
    var s = norm(text);
    var n = p.unit === 'weighted' ? weighted(s, p) : codePoints(s);
    var out = { count: n, limit: p.limit, over: n > p.limit };
    if (p.fold) out.fold = p.fold;
    if (p.hashtag_limit !== undefined) {
      out.hashtags = hashtags(s);
      out.hashtagLimit = p.hashtag_limit;
      if (out.hashtags > p.hashtag_limit) out.over = true;
    }
    return out;
  }

  /** UTF-16 index (in the NFC text) where the platform's fold (its "… more") goes, or -1. */
  function foldIndex(text, platform) {
    var p = platformCfg(platform);
    if (!p.fold) return -1;
    var s = norm(text);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      if (n === p.fold) return i;
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) i++;
      n++;
    }
    return -1;
  }

  return {
    count: count,
    foldIndex: foldIndex,
    setPlatforms: setPlatforms,
    get platforms() { ensure(); return cfg; }
  };
});
