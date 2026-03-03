const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');

if (usernameInput) {
  usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      if (passwordInput) passwordInput.focus();
    }
  });
}
if (passwordInput) {
  passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
  });
}

async function login() {
  const username = (usernameInput ? usernameInput.value : '').trim();
  const password = (passwordInput ? passwordInput.value : '').trim();
  if (!username || !password) {
    showToast('请输入账户名和密码', 'error');
    return;
  }

  try {
    const res = await fetch('/api/v1/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (res.ok) {
      const data = await res.json();
      const sessionToken = data.api_key;
      if (!sessionToken) {
        showToast('登录响应异常', 'error');
        return;
      }
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
