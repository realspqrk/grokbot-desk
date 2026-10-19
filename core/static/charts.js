/* grokbot-desk: hand-drawn SVG charts for the `chart` block and the
 * sparklines of `stats` tiles. No library.
 *
 * window.RSCharts.bar(spec, ctx) / line(spec, ctx) / spark(values, ctx)
 * return an <svg role="img"> whose aria-label is a generated summary (the
 * kind, the range and, per series, the high and low or first and last
 * value). The `chart` block puts a "Show data" table next to every chart.
 *
 * spec = {title?, kind, orientation?, labels[], series[{name, values[]}],
 * unit?, target?}; ctx = {t(key, vars), lang}.
 *
 * Calm: series colours are --rs-cat-1..4 in fixed order (never cycled,
 * max 4 series); text wears ink and muted, never a series colour; thin
 * marks with 4px rounded data ends; direct labels where they fit (values on
 * up to 12 bars, line ends named), a legend only for 2+ series; no axis
 * lines beyond the baseline and a quiet grid when values are not labelled.
 * Colours come from blocks.css classes, never literals here.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.RSCharts = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  /* drawn at the width it gets (blocks.js redraws on resize), so text
     stays 12px; never narrower than MIN_W */
  var DEFAULT_W = 640;
  var MIN_W = 280;
  function widthOf(ctx) {
    var w = ctx && typeof ctx.width === 'number' && isFinite(ctx.width) ? Math.round(ctx.width) : DEFAULT_W;
    return Math.max(MIN_W, w);
  }
  /* a rough text width at 12px system UI: layout only, never clipping */
  function textWidth(s) { return String(s).length * 6.6; }

  function el(tag, attrs, text) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function locale(ctx) { return ctx && ctx.lang === 'en' ? 'en-US' : 'de-DE'; }
  var MAX_DIGITS = 10;
  /* decimals a value is written with (0.001 -> 3, 1e-7 -> 7, 48200 -> 0) */
  function decimals(v) {
    if (typeof v !== 'number' || !isFinite(v) || v === 0) return 0;
    var s = String(Number(Math.abs(v).toPrecision(12)));
    var e = /e([+-])(\d+)$/.exec(s);
    var mantissa = e ? s.slice(0, e.index) : s;
    var dot = mantissa.indexOf('.');
    var digits = dot < 0 ? 0 : mantissa.length - dot - 1;
    if (e) digits = e[1] === '-' ? digits + Number(e[2]) : Math.max(0, digits - Number(e[2]));
    return Math.min(MAX_DIGITS, digits);
  }
  function numberFormat(ctx, digits) {
    var f = new Intl.NumberFormat(locale(ctx), { maximumFractionDigits: digits, minimumFractionDigits: digits });
    return function (v) { return f.format(v); };
  }
  /* values (labels, summaries, data tables): as many decimals as the data uses */
  function formatter(ctx, values) {
    var digits = 0;
    (values || []).forEach(function (v) { digits = Math.max(digits, decimals(v)); });
    return numberFormat(ctx, digits);
  }
  /* axis labels: the decimals of the tick step, more only if two labels
     would still read the same */
  function tickFormat(ctx, tickValues) {
    var digits = tickValues.length > 1 ? decimals(Math.abs(tickValues[1] - tickValues[0])) : decimals(tickValues[0]);
    for (; digits <= MAX_DIGITS; digits++) {
      var fmt = numberFormat(ctx, digits);
      var seen = {};
      var clash = tickValues.some(function (v) { var k = fmt(v); if (seen[k]) return true; seen[k] = true; return false; });
      if (!clash) return fmt;
    }
    return numberFormat(ctx, MAX_DIGITS);
  }
  function withUnit(text, unit) { return unit ? text + ' ' + unit : text; }

  /* 1, 2, 2.5, 5 x 10^n steps for about `count` grid lines */
  function niceStep(span, count) {
    if (!(span > 0) || !isFinite(span)) return 1;
    var raw = span / count;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * pow >= raw) return steps[i] * pow;
    return 10 * pow;
  }
  var MAX_TICKS = 12;
  /* grid values covering lo..hi, computed from integer indices (no float
     accumulation); a range the step cannot resolve gets just its ends */
  function ticks(lo, hi, count) {
    if (!isFinite(lo) || !isFinite(hi)) return [0];
    if (hi < lo) { var swap = lo; lo = hi; hi = swap; }
    if (hi === lo) return [lo];
    var ends = [lo, hi];
    var span = hi - lo;
    if (!isFinite(span)) return lo < 0 && hi > 0 ? [lo, 0, hi] : ends;
    var step = niceStep(span, count);
    var first = Math.floor(lo / step);
    var last = Math.ceil(hi / step);
    var n = last - first;
    if (!isFinite(n) || n < 1 || n > MAX_TICKS || first + 1 === first || last - 1 === last) return ends;
    var out = [];
    for (var i = 0; i <= n; i++) out.push((first + i) * step);
    for (var k = 1; k < out.length; k++) if (!(out[k] > out[k - 1])) return ends;
    return out;
  }

  function svgRoot(width, height, label, cls) {
    var svg = el('svg', {
      viewBox: '0 0 ' + width + ' ' + height, width: width, height: height, role: 'img', 'aria-label': label,
      class: 'rs-chart ' + cls, preserveAspectRatio: 'xMinYMin meet'
    });
    return svg;
  }

  /* a bar from the baseline with its data end rounded (4px) */
  function barPath(x, y, w, h, horizontal) {
    var r = Math.min(4, (horizontal ? h : w) / 2, Math.abs(horizontal ? w : h));
    if (!horizontal) {
      var up = h >= 0;
      var top = up ? y : y + h;
      var bottom = up ? y + h : y;
      var hh = bottom - top;
      if (hh <= 0) return '';
      if (up) {
        return 'M' + x + ' ' + bottom + 'V' + (top + r) + 'Q' + x + ' ' + top + ' ' + (x + r) + ' ' + top
          + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + top + ' ' + (x + w) + ' ' + (top + r) + 'V' + bottom + 'Z';
      }
      return 'M' + x + ' ' + top + 'V' + (bottom - r) + 'Q' + x + ' ' + bottom + ' ' + (x + r) + ' ' + bottom
        + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + bottom + ' ' + (x + w) + ' ' + (bottom - r) + 'V' + top + 'Z';
    }
    var right = w >= 0;
    var left = right ? x : x + w;
    var end = right ? x + w : x;
    if (end - left <= 0) return '';
    if (right) {
      return 'M' + left + ' ' + y + 'H' + (end - r) + 'Q' + end + ' ' + y + ' ' + end + ' ' + (y + r)
        + 'V' + (y + h - r) + 'Q' + end + ' ' + (y + h) + ' ' + (end - r) + ' ' + (y + h) + 'H' + left + 'Z';
    }
    return 'M' + end + ' ' + y + 'H' + (left + r) + 'Q' + left + ' ' + y + ' ' + left + ' ' + (y + r)
      + 'V' + (y + h - r) + 'Q' + left + ' ' + (y + h) + ' ' + (left + r) + ' ' + (y + h) + 'H' + end + 'Z';
  }

  function seriesOf(spec) {
    return (spec.series || []).slice(0, 4).map(function (s, i) {
      return { name: String(s.name), values: (s.values || []).slice(0, (spec.labels || []).length), cls: 'rs-chart__s' + (i + 1) };
    });
  }

  function allValues(series, target) {
    var all = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (typeof v === 'number' && isFinite(v)) all.push(v); }); });
    if (typeof target === 'number' && isFinite(target)) all.push(target);
    return all;
  }

  function extremes(values, labels) {
    var hi = 0, lo = 0;
    values.forEach(function (v, i) { if (v > values[hi]) hi = i; if (v < values[lo]) lo = i; });
    return { max: values[hi], maxLabel: labels[hi], min: values[lo], minLabel: labels[lo] };
  }

  /* "Revenue by month. Bar chart, Jun to Sep, EUR. Revenue: highest Sep 48,200, lowest Jun 41,000. Target 45,000." */
  function summary(kind, spec, series, fmt, ctx) {
    var t = ctx.t;
    var labels = spec.labels || [];
    var parts = [];
    if (spec.title) parts.push(spec.title);
    var head = t(kind === 'line' ? 'blk_chart_line' : 'blk_chart_bar');
    if (labels.length > 1) head += ', ' + t('blk_chart_range', { from: labels[0], to: labels[labels.length - 1] });
    if (spec.unit) head += ', ' + spec.unit;
    parts.push(head);
    series.forEach(function (s) {
      var e = extremes(s.values, labels);
      parts.push(kind === 'line'
        ? t('blk_chart_series_line', { name: s.name, first: fmt(s.values[0]), last: fmt(s.values[s.values.length - 1]), max: fmt(e.max), max_label: e.maxLabel })
        : t('blk_chart_series_bar', { name: s.name, max: fmt(e.max), max_label: e.maxLabel, min: fmt(e.min), min_label: e.minLabel }));
    });
    if (typeof spec.target === 'number') parts.push(t('blk_chart_target', { value: fmt(spec.target) }));
    return parts.join('. ') + '.';
  }

  /* legend row for 2+ series: swatch and name; returns its height */
  function legend(svg, series, y) {
    if (series.length < 2) return 0;
    var x = 0;
    var g = el('g', { class: 'rs-chart__legend', 'aria-hidden': 'true' });
    series.forEach(function (s) {
      g.appendChild(el('rect', { x: x, y: y + 2, width: 10, height: 10, rx: 2, class: s.cls + ' rs-chart__fill' }));
      g.appendChild(el('text', { x: x + 16, y: y + 11, class: 'rs-chart__text' }, s.name));
      x += 16 + textWidth(s.name) + 20;
    });
    svg.appendChild(g);
    return 24;
  }

  /* the target line; its label sits in the right gutter (label: true) */
  function target(svg, x0, x1, y, text, horizontal, y0, y1) {
    var g = el('g', { class: 'rs-chart__target', 'aria-hidden': 'true' });
    if (horizontal) {
      g.appendChild(el('line', { x1: y, x2: y, y1: y0, y2: y1, class: 'rs-chart__target-line' }));
      g.appendChild(el('text', { x: y + 4, y: y0 + 10, class: 'rs-chart__text rs-chart__text--muted' }, text));
    } else {
      g.appendChild(el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'rs-chart__target-line' }));
      if (text) g.appendChild(el('text', { x: x1 + 8, y: y + 4, class: 'rs-chart__text rs-chart__text--muted' }, text));
    }
    svg.appendChild(g);
  }

  // ---------------------------------------------------------------- bar --
  function bar(spec, ctx) {
    var W = widthOf(ctx);
    var labels = (spec.labels || []).map(String);
    var series = seriesOf(spec);
    var all = allValues(series, spec.target);
    var fmt = formatter(ctx, all);
    var label = summary('bar', spec, series, fmt, ctx);
    var lo = Math.min(0, Math.min.apply(null, all));
    var hi = Math.max(0, Math.max.apply(null, all));
    if (hi === lo) hi = lo + 1;
    var bars = labels.length * series.length;
    var direct = bars <= 12;
    var hasTarget = typeof spec.target === 'number' && isFinite(spec.target);
    var targetText = hasTarget ? ctx.t('blk_chart_target', { value: fmt(spec.target) }) : '';

    if (spec.orientation === 'horizontal') {
      var labelW = Math.min(200, Math.max.apply(null, labels.map(textWidth)) + 12);
      var valueW = direct ? Math.max.apply(null, all.map(function (v) { return textWidth(withUnit(fmt(v), '')); })) + 10 : 0;
      var rowH = series.length > 1 ? 10 * series.length + 14 : 26;
      var top = (series.length > 1 ? 24 : 0) + (hasTarget ? 16 : 0);
      var hgt = top + labels.length * rowH + 4;
      var svgH = svgRoot(W, hgt, label, 'rs-chart--bar rs-chart--horizontal');
      legend(svgH, series, 0);
      var x0 = labelW;
      var x1 = W - valueW;
      var sx = function (v) { return x0 + (v - lo) / (hi - lo) * (x1 - x0); };
      var zero = sx(0);
      var barH = series.length > 1 ? 10 : 16;
      labels.forEach(function (name, i) {
        var y = top + i * rowH;
        svgH.appendChild(el('text', { x: 0, y: y + rowH / 2 + 4, class: 'rs-chart__text' }, name));
        series.forEach(function (s, k) {
          var v = s.values[i];
          if (typeof v !== 'number') return;
          var by = y + (rowH - barH * series.length - 2 * (series.length - 1)) / 2 + k * (barH + 2);
          var d = barPath(zero, by, sx(v) - zero, barH, true);
          if (d) svgH.appendChild(el('path', { d: d, class: s.cls + ' rs-chart__fill' }));
          if (direct) {
            var end = sx(v);
            var lx = v >= 0 ? end + 6 : end - 6;
            /* a value label never sits on the target line: it moves past it */
            if (hasTarget) {
              var tx = sx(spec.target);
              var w = textWidth(fmt(v));
              var from = v >= 0 ? lx : lx - w;
              if (tx >= from - 3 && tx <= from + w + 3) lx = v >= 0 ? tx + 6 : tx - 6;
            }
            svgH.appendChild(el('text', {
              x: lx, y: by + barH / 2 + 4, 'text-anchor': v >= 0 ? 'start' : 'end',
              class: 'rs-chart__text rs-chart__value'
            }, fmt(v)));
          }
        });
      });
      svgH.appendChild(el('line', { x1: zero, x2: zero, y1: top - 2, y2: hgt - 2, class: 'rs-chart__base' }));
      if (hasTarget) target(svgH, 0, 0, sx(spec.target), targetText, true, top - 14, hgt - 2);
      return svgH;
    }

    var legendH = series.length > 1 ? 24 : 0;
    var topV = legendH + (direct ? 18 : 8) + (hasTarget ? 6 : 0);
    var plotH = 160;
    var bottomH = 24;
    var heightV = topV + plotH + bottomH;
    var tickVals = direct ? [] : ticks(lo, hi, 4);
    if (tickVals.length) { lo = Math.min(lo, tickVals[0]); hi = Math.max(hi, tickVals[tickVals.length - 1]); }
    var tickFmt = tickFormat(ctx, tickVals);
    var left = tickVals.length ? Math.max.apply(null, tickVals.map(function (v) { return textWidth(tickFmt(v)); })) + 10 : 0;
    var right = hasTarget ? textWidth(targetText) + 12 : 0;
    var plotR = W - right;
    var svg = svgRoot(W, heightV, label, 'rs-chart--bar');
    legend(svg, series, 0);
    var sy = function (v) { return topV + (hi - v) / (hi - lo) * plotH; };
    tickVals.forEach(function (v) {
      svg.appendChild(el('line', { x1: left, x2: plotR, y1: sy(v), y2: sy(v), class: 'rs-chart__grid' }));
      svg.appendChild(el('text', { x: left - 8, y: sy(v) + 4, 'text-anchor': 'end', class: 'rs-chart__text rs-chart__text--muted' }, tickFmt(v)));
    });
    var band = (plotR - left) / labels.length;
    var group = Math.min(band * 0.7, 56 * series.length);
    var gap = series.length > 1 ? 2 : 0;
    var bw = (group - gap * (series.length - 1)) / series.length;
    var base = sy(0);
    var every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor((plotR - left) / 56))));
    labels.forEach(function (name, i) {
      var gx = left + i * band + (band - group) / 2;
      series.forEach(function (s, k) {
        var v = s.values[i];
        if (typeof v !== 'number') return;
        var x = gx + k * (bw + gap);
        var d = barPath(x, sy(v), bw, base - sy(v), false);
        if (d) svg.appendChild(el('path', { d: d, class: s.cls + ' rs-chart__fill' }));
        if (direct) {
          var ly = v >= 0 ? sy(v) - 6 : sy(v) + 14;
          /* a value label never sits on the target line: it moves past it,
             away from its bar (the text box is about 14px high) */
          if (hasTarget) {
            var ty = sy(spec.target);
            if (ty >= ly - 14 && ty <= ly + 5) ly = v >= 0 ? ty - 6 : ty + 16;
          }
          svg.appendChild(el('text', {
            x: x + bw / 2, y: ly, 'text-anchor': 'middle', class: 'rs-chart__text rs-chart__value'
          }, fmt(v)));
        }
      });
      if (i % every === 0) {
        svg.appendChild(el('text', { x: left + i * band + band / 2, y: topV + plotH + 17, 'text-anchor': 'middle', class: 'rs-chart__text rs-chart__text--muted' }, name));
      }
    });
    svg.appendChild(el('line', { x1: left, x2: plotR, y1: base, y2: base, class: 'rs-chart__base' }));
    if (hasTarget) target(svg, left, plotR, sy(spec.target), targetText, false);
    return svg;
  }

  // --------------------------------------------------------------- line --
  function line(spec, ctx) {
    var W = widthOf(ctx);
    var labels = (spec.labels || []).map(String);
    var series = seriesOf(spec);
    var all = allValues(series, spec.target);
    var fmt = formatter(ctx, all);
    var label = summary('line', spec, series, fmt, ctx);
    var lo = Math.min.apply(null, all);
    var hi = Math.max.apply(null, all);
    if (hi === lo) { hi += 1; lo -= 1; }
    var tickVals = ticks(lo, hi, 4);
    lo = Math.min(lo, tickVals[0]);
    hi = Math.max(hi, tickVals[tickVals.length - 1]);
    var tickFmt = tickFormat(ctx, tickVals);
    var hasTarget = typeof spec.target === 'number' && isFinite(spec.target);
    var legendH = series.length > 1 ? 24 : 0;
    var top = legendH + 10;
    var plotH = 160;
    var height = top + plotH + 26;
    var left = Math.max.apply(null, tickVals.map(function (v) { return textWidth(tickFmt(v)); })) + 10;
    /* line ends are named: the last value, and the series name with 2+ */
    var endText = series.map(function (s) {
      var last = fmt(s.values[s.values.length - 1]);
      return series.length > 1 ? s.name + ' ' + last : last;
    });
    var targetText = hasTarget ? ctx.t('blk_chart_target', { value: fmt(spec.target) }) : '';
    var right = Math.min(200, Math.max.apply(null, endText.concat(targetText ? [targetText] : []).map(textWidth)) + 12);
    var x1 = W - right;
    var svg = svgRoot(W, height, label, 'rs-chart--line');
    legend(svg, series, 0);
    var sy = function (v) { return top + (hi - v) / (hi - lo) * plotH; };
    var n = labels.length;
    var sx = function (i) { return n > 1 ? left + i * (x1 - left) / (n - 1) : (left + x1) / 2; };
    tickVals.forEach(function (v) {
      svg.appendChild(el('line', { x1: left, x2: x1, y1: sy(v), y2: sy(v), class: 'rs-chart__grid' }));
      svg.appendChild(el('text', { x: left - 8, y: sy(v) + 4, 'text-anchor': 'end', class: 'rs-chart__text rs-chart__text--muted' }, tickFmt(v)));
    });
    /* every k-th label, always the last one; never two labels closer than 48px */
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((x1 - left) / 64))));
    var shown = [];
    for (var at = 0; at < n; at += every) shown.push(at);
    if (shown[shown.length - 1] !== n - 1) {
      if (shown.length > 1 && sx(n - 1) - sx(shown[shown.length - 1]) < 48) shown.pop();
      shown.push(n - 1);
    }
    shown.forEach(function (i) {
      svg.appendChild(el('text', {
        x: sx(i), y: top + plotH + 18, 'text-anchor': i === 0 && n > 1 ? 'start' : (i === n - 1 && n > 1 ? 'end' : 'middle'),
        class: 'rs-chart__text rs-chart__text--muted'
      }, labels[i]));
    });
    var ends = [];
    if (hasTarget) {
      target(svg, left, x1, sy(spec.target), '', false);
      ends.push({ y: sy(spec.target), text: targetText, muted: true });
    }
    series.forEach(function (s, k) {
      var pts = [];
      s.values.forEach(function (v, i) { if (typeof v === 'number') pts.push([sx(i), sy(v)]); });
      if (!pts.length) return;
      svg.appendChild(el('polyline', {
        points: pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '),
        class: s.cls + ' rs-chart__line'
      }));
      if (n <= 12) {
        pts.forEach(function (p) { svg.appendChild(el('circle', { cx: p[0], cy: p[1], r: 4, class: s.cls + ' rs-chart__dot' })); });
      } else {
        var lp = pts[pts.length - 1];
        svg.appendChild(el('circle', { cx: lp[0], cy: lp[1], r: 4, class: s.cls + ' rs-chart__dot' }));
      }
      ends.push({ y: pts[pts.length - 1][1], text: endText[k] });
    });
    /* end labels never overlap: push apart by a line height */
    ends.sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
    ends.forEach(function (e) {
      svg.appendChild(el('text', { x: x1 + 10, y: e.y + 4, class: 'rs-chart__text ' + (e.muted ? 'rs-chart__text--muted' : 'rs-chart__value') }, e.text));
    });
    return svg;
  }

  // -------------------------------------------------------------- spark --
  function spark(values, ctx) {
    var nums = (values || []).filter(function (v) { return typeof v === 'number' && isFinite(v); });
    var fmt = formatter(ctx, nums);
    var w = 96, h = 28, pad = 3;
    var lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
    if (hi === lo) { hi += 1; lo -= 1; }
    var svg = el('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, role: 'img', class: 'rs-spark',
      'aria-label': ctx.t('blk_spark_label', { first: fmt(nums[0]), last: fmt(nums[nums.length - 1]) })
    });
    var pts = nums.map(function (v, i) {
      return [pad + i * (w - 2 * pad) / Math.max(1, nums.length - 1), pad + (hi - v) / (hi - lo) * (h - 2 * pad)];
    });
    svg.appendChild(el('polyline', {
      points: pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '),
      class: 'rs-spark__line'
    }));
    var last = pts[pts.length - 1];
    svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 2.5, class: 'rs-spark__dot' }));
    return svg;
  }

  return { bar: bar, line: line, spark: spark, format: formatter, ticks: ticks, tickFormat: tickFormat };
});
