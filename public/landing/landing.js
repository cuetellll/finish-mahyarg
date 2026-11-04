/* Mahyar Gap landing — progressive enhancement only (no libraries).
   1. Remembers the visitor's language choice (cookie + localStorage).
   2. Toggles the mobile navigation.
   3. Moves the floating hero icons with the pointer: one rAF loop, transforms
      only, no DOM writes per event, disabled for touch and reduced motion. */
(function () {
  'use strict';

  // Persist language choice: the server reads the cookie on "/" to redirect.
  var html = document.documentElement;
  var lang = html.getAttribute('lang') === 'en' ? 'en' : 'fa';
  try {
    localStorage.setItem('mahyar_lang', lang);
    document.cookie = 'mahyar_lang=' + lang + ';path=/;max-age=31536000;samesite=lax';
  } catch (_) { /* storage blocked — server default (/fa) still works */ }

  var burger = document.getElementById('nav-burger');
  var menu = document.getElementById('mobile-menu');
  if (burger && menu) {
    burger.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
    });
  }

  // ------------------------------------------------------------ icon parallax
  var icons = Array.prototype.slice.call(document.querySelectorAll('.float-icon'));
  if (!icons.length) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (reduceMotion || coarse) return;

  var hero = document.querySelector('.hero');
  if (!hero) return;

  // Target and current offsets are normalised to -1..1; the loop eases towards
  // the target so the icons glide instead of snapping to the cursor.
  var targetX = 0;
  var targetY = 0;
  var currentX = 0;
  var currentY = 0;
  var running = false;
  var depths = icons.map(function (icon) {
    return Number(icon.getAttribute('data-depth')) || 12;
  });

  function onPointerMove(event) {
    var rect = hero.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    targetX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    targetY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }

  function tick() {
    currentX += (targetX - currentX) * 0.075;
    currentY += (targetY - currentY) * 0.075;
    for (var i = 0; i < icons.length; i += 1) {
      var depth = depths[i];
      // Subtle translation + a hair of rotation keeps the depth readable without
      // the icons ever chasing the pointer.
      icons[i].style.transform =
        'translate3d(' + (-currentX * depth).toFixed(2) + 'px,' + (-currentY * depth * 0.8).toFixed(2) + 'px,0)';
    }
    if (Math.abs(targetX - currentX) > 0.001 || Math.abs(targetY - currentY) > 0.001) {
      requestAnimationFrame(tick);
    } else {
      running = false;
    }
  }

  hero.addEventListener('pointermove', onPointerMove, { passive: true });
  hero.addEventListener('pointerleave', function () {
    targetX = 0;
    targetY = 0;
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }, { passive: true });
})();
