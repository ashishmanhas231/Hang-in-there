'use strict';
// Loads the script for this window's job: hanging, or an offline test render.
(function () {
  const views = { hang: 'hang-view.js', test: 'test-view.js' };
  const script = document.createElement('script');
  script.src = views[window.spidey.mode] || views.hang;
  document.body.appendChild(script);
})();
