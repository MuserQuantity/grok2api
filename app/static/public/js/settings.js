/**
 * Settings page controller
 * Manages client-side preferences stored in localStorage.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'grok2api_public_settings';

  const DEFAULTS = {
    defaultNsfw: false,
    defaultRatio: '2:3',
    defaultConcurrency: 1,
    autoSaveImages: false,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function initToggle(id, settingKey) {
    const el = document.getElementById(id);
    if (!el) return;
    const settings = loadSettings();
    if (settings[settingKey]) el.classList.add('active');

    el.addEventListener('click', function () {
      const s = loadSettings();
      s[settingKey] = !s[settingKey];
      saveSettings(s);
      el.classList.toggle('active');
    });
  }

  function initSelect(id, settingKey) {
    const el = document.getElementById(id);
    if (!el) return;
    const settings = loadSettings();
    if (settings[settingKey] !== undefined) el.value = String(settings[settingKey]);

    el.addEventListener('change', function () {
      const s = loadSettings();
      s[settingKey] = el.value;
      saveSettings(s);
    });
  }

  function initAuthStatus() {
    const statusEl = document.getElementById('auth-status-text');
    if (!statusEl) return;

    if (typeof window.ensurePublicKey === 'function') {
      window.ensurePublicKey().then(function (key) {
        if (key === null) {
          statusEl.textContent = '未认证';
          statusEl.style.color = 'var(--error)';
        } else if (key === '') {
          statusEl.textContent = '已认证 (无密钥模式)';
          statusEl.style.color = 'var(--success)';
        } else {
          statusEl.textContent = '已认证';
          statusEl.style.color = 'var(--success)';
        }
      });
    }
  }

  function initThemeToggle() {
    const el = document.getElementById('settings-theme-toggle');
    if (!el) return;
    if (document.documentElement.getAttribute('data-theme') === 'dark') {
      el.classList.add('active');
    }
    el.addEventListener('click', function () {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('theme', isDark ? 'light' : 'dark');
      el.classList.toggle('active');
    });
  }

  function initLogout() {
    const btn = document.getElementById('settings-logout-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (typeof window.publicLogout === 'function') {
        window.publicLogout();
      } else {
        if (typeof window.clearStoredPublicKey === 'function') {
          window.clearStoredPublicKey();
        }
        window.location.href = '/login';
      }
    });
  }

  function initClearData() {
    const btn = document.getElementById('settings-clear-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!confirm('确定要清除所有本地数据吗？这将清除设置、缓存和登录状态。')) return;
      localStorage.clear();
      sessionStorage.clear();
      window.location.href = '/login';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initToggle('settings-nsfw-toggle', 'defaultNsfw');
    initToggle('settings-autosave-toggle', 'autoSaveImages');
    initSelect('settings-ratio-select', 'defaultRatio');
    initSelect('settings-concurrency-select', 'defaultConcurrency');
    initThemeToggle();
    initAuthStatus();
    initLogout();
    initClearData();
  });
})();
