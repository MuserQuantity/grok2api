const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');

usernameInput.addEventListener('keypress', function (e) {
  if (e.key === 'Enter') passwordInput.focus();
});

passwordInput.addEventListener('keypress', function (e) {
  if (e.key === 'Enter') login();
});

async function login() {
  const username = (usernameInput.value || '').trim();
  const password = (passwordInput.value || '').trim();
  if (!username || !password) return;

  try {
    const res = await fetch('/api/v1/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (res.ok) {
      const data = await res.json();
      const sessionToken = data.api_key || password;
      await storeAppKey(sessionToken);
      window.location.href = '/admin/token';
    } else {
      showToast('用户名或密码错误', 'error');
    }
  } catch (e) {
    showToast('连接失败', 'error');
  }
}

// Auto-redirect checks
(async () => {
  const existingKey = await getStoredAppKey();

  usernameInput.value = 'admin';
  passwordInput.focus();

  if (!existingKey) return;

  try {
    const res = await fetch('/v1/admin/verify', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${existingKey}` }
    });
    if (res.ok) window.location.href = '/admin/token';
  } catch (e) {
    // ignore
  }
})();
