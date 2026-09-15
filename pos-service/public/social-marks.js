/* =====================================================================
   NOKTApp - the three social marks, as geometry.
   =====================================================================
   Drawn here rather than fetched. The two places these appear - the customer
   display (a browser that is sometimes on another machine with no internet at
   all) and the printed A5 table card (a PDF built by pdfkit, which has no
   HTML and no icon font) - can both reach a CDN sprite exactly never.

   They are stored as SHAPES rather than as an SVG string because the card is
   not drawn with SVG. A string would mean the PDF re-invented the glyph by
   eye, and the mark on the card would drift away from the mark on the screen
   the first time either was touched. Numbers are on a 24x24 box, the usual
   icon grid; both consumers scale from there.

   This file loads in a <script> tag (window.NOKT_SOCIAL) and in node
   (require), because those are the two things that need it.
   ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NOKT_SOCIAL = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* The order they are drawn in, everywhere. */
  var ORDER = ['instagram', 'facebook', 'tiktok'];

  var LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' };

  /*
   * Outline glyphs in the brand's own stroke - recognisable at three metres on
   * a television, and at reading distance on a printed card, which are the two
   * distances that matter. `fill:true` marks the one solid dot (Instagram's
   * lens flare); everything else is stroked.
   */
  var MARKS = {
    instagram: [
      { t: 'rect', x: 3, y: 3, w: 18, h: 18, r: 5 },
      { t: 'circle', cx: 12, cy: 12, r: 4 },
      { t: 'circle', cx: 17.2, cy: 6.8, r: 1.1, fill: true },
    ],
    facebook: [
      { t: 'path', d: 'M14.5 8.5h2.2V5.6h-2.4c-2.2 0-3.6 1.4-3.6 3.7v1.8H8.4v2.9h2.3V21h3.1v-7h2.4l.4-2.9h-2.8V9.6c0-.7.3-1.1.7-1.1z' },
    ],
    tiktok: [
      { t: 'path', d: 'M14.4 3v10.9a3.3 3.3 0 1 1-2.7-3.2' },
      { t: 'path', d: 'M14.4 3c.3 2.3 1.9 3.9 4.2 4.2' },
    ],
  };

  /** The inner markup of a 0 0 24 24 <svg>. `accent` fills the solid dot. */
  function svgInner(key, accent) {
    var parts = (MARKS[key] || []).map(function (s) {
      var solid = s.fill ? ' fill="' + (accent || '#FF7A1A') + '" stroke="none"' : '';
      if (s.t === 'rect') {
        return '<rect x="' + s.x + '" y="' + s.y + '" width="' + s.w + '" height="' + s.h
          + '" rx="' + s.r + '"' + solid + '/>';
      }
      if (s.t === 'circle') return '<circle cx="' + s.cx + '" cy="' + s.cy + '" r="' + s.r + '"' + solid + '/>';
      return '<path d="' + s.d + '"' + solid + '/>';
    });
    return parts.join('');
  }

  /**
   * How the handle is written out.
   *
   * Facebook pages are named, not handled: an @ in front of a page name is
   * wrong, so only the two that use handles get one.
   */
  function display(key, value) {
    var v = String(value == null ? '' : value).replace(/^@+/, '');
    if (!v) return '';
    return (key === 'facebook' ? '' : '@') + v;
  }

  return { ORDER: ORDER, LABEL: LABEL, MARKS: MARKS, svgInner: svgInner, display: display };
}));
