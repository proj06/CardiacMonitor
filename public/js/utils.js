// ─── Shared Utilities ────────────────────────────────────────────────────────

// Toast notifications
const Toast = {
    container: null,
    init() {
      this.container = document.querySelector('.toast-container');
      if (!this.container) {
        this.container = document.createElement('div');
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
      }
    },
    show(msg, type = 'info', duration = 3500) {
      if (!this.container) this.init();
      const t = document.createElement('div');
      t.className = `toast ${type}`;
      t.textContent = msg;
      this.container.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; t.style.transition = '0.3s'; setTimeout(() => t.remove(), 300); }, duration);
    }
  };
  
  // API helper
  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  
  // Auth guard — redirect to / if not logged in
  async function requireLogin() {
    try {
      const user = await api('GET', '/api/me');
      return user;
    } catch {
      window.location.href = '/';
      return null;
    }
  }
  
  // Logout
  async function logout() {
    await api('POST', '/api/logout');
    window.location.href = '/';
  }
  
  // Active nav link
  function setActiveNav() {
    const path = window.location.pathname;
    document.querySelectorAll('.nav-links a').forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === path);
    });
  }
  
  // Format time ago
  function timeAgo(date) {
    const secs = Math.floor((Date.now() - new Date(date)) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
    return `${Math.floor(secs/3600)}h ago`;
  }
  
  // Risk color
  function riskColor(score) {
    if (score >= 70) return 'var(--red)';
    if (score >= 40) return 'var(--amber)';
    return 'var(--green)';
  }
  
  function riskClass(score) {
    if (score >= 70) return 'emergency';
    if (score >= 40) return 'warning';
    return 'normal';
  }
  
  function riskLabel(score) {
    if (score >= 70) return 'EMERGENCY';
    if (score >= 40) return 'WARNING';
    return 'NORMAL';
  }

  // Add this to utils.js
const VoiceAI = {
  speak(text, onEndCallback) {
    if (!('speechSynthesis' in window)) return;
    
    // Cancel any current speech to prevent overlapping
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.pitch = 1.1;
    utterance.rate = 1.0;
    utterance.volume = 1.0;

    if (onEndCallback) {
      utterance.onend = onEndCallback;
    }

    window.speechSynthesis.speak(utterance);
  }
};