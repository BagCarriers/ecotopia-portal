/**
 * Ecotopia Portal — Auth Manager
 * Single admin session using sessionStorage.
 */
const AuthManager = (() => {
  const SESSION_KEY = 'ecotopia_session';
  const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours
  const CREDENTIALS = { username: 'jordan', password: 'ecotopia2025' };

  function isAuthenticated() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const session = JSON.parse(raw);
      if (!session || !session.user || !session.expires) return false;
      if (Date.now() > session.expires) {
        sessionStorage.removeItem(SESSION_KEY);
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function signIn(username, password) {
    if (username === CREDENTIALS.username && password === CREDENTIALS.password) {
      const session = {
        user: username,
        expires: Date.now() + SESSION_DURATION_MS,
        loginTime: Date.now()
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return { success: true };
    }
    return { success: false, error: 'Invalid username or password.' };
  }

  function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = 'login.html';
  }

  function requireAuth() {
    if (!isAuthenticated()) {
      window.location.href = 'login.html';
      // Throw to stop any further script execution on the page
      throw new Error('Not authenticated — redirecting.');
    }
  }

  function getUser() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      return session ? session.user : null;
    } catch (e) {
      return null;
    }
  }

  return { isAuthenticated, signIn, signOut, requireAuth, getUser };
})();
