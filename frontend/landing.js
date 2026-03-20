/* ── Landing page initialization ── */
(function() {
  var particles = document.getElementById('landing-particles');
  if (particles) {
    for (var i = 0; i < 20; i++) {
      var span = document.createElement('span');
      span.style.left = Math.random() * 100 + '%';
      span.style.animationDelay = Math.random() * 6 + 's';
      span.style.animationDuration = (4 + Math.random() * 4) + 's';
      particles.appendChild(span);
    }
  }
  var landing = document.getElementById('landing-screen');
  var authScreen = document.getElementById('auth-screen');
  if (landing && authScreen) {
    authScreen.style.display = 'none';
    document.getElementById('btn-get-started').onclick = function() {
      landing.style.display = 'none';
      authScreen.style.display = '';
      showForm('signup');
    };
    document.getElementById('btn-sign-in').onclick = function() {
      landing.style.display = 'none';
      authScreen.style.display = '';
      showForm('login');
    };
  }
})();
