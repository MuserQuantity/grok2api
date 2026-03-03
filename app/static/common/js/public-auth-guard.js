/**
 * Public Auth Guard
 * Must be loaded AFTER admin-auth.js which defines ensurePublicKey().
 * Checks authentication and redirects to /login if not authenticated.
 * Hides page content during the check to prevent flash of unauthenticated content.
 */
(async function publicAuthGuard() {
  const isLoginPage = window.location.pathname === '/login' ||
    window.location.pathname.startsWith('/login/') ||
    window.location.pathname === '/admin/login' ||
    window.location.pathname.startsWith('/admin/login/');

  if (isLoginPage) return;

  document.documentElement.classList.add('auth-checking');

  try {
    const authHeader = (typeof window.ensurePublicKey === 'function')
      ? await window.ensurePublicKey()
      : null;

    if (authHeader === null) {
      window.location.href = '/login';
      return;
    }

    document.documentElement.classList.remove('auth-checking');
  } catch (e) {
    window.location.href = '/login';
  }
})();
