const SUPABASE_URL = 'https://kecwrwxjjcgwuqvjduhk.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_JaN4Xy-AB0gOXcJTsPrKoA_hAHQDROM';
const DEFAULT_HOURLY_RATE = 150000;
const DEFAULT_OVERTIME_COEFFICIENT = 1.5;
const STANDARD_DAILY_HOURS = 8;
const ODOO_TEMPLATE_PATH = 'templates/odoo-template.xlsx';
const ODOO_DEFAULT_PROJECT_NAME = 'BI (business intelligence)';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false }
});

const HOLIDAY_DATES_BY_YEAR = {
  1405: [
    '1405-01-01','1405-01-02','1405-01-03','1405-01-04','1405-01-13'
  ]
};

function getConfiguredHolidayDates(jy) {
  const year = String(jy);
  const localDates = HOLIDAY_DATES_BY_YEAR[year] || HOLIDAY_DATES_BY_YEAR[Number(jy)] || [];
  const override = window.WT_HOLIDAY_DATES_BY_YEAR?.[year] || window.WT_HOLIDAY_DATES_BY_YEAR?.[Number(jy)] || [];
  return new Set([...localDates, ...override]);
}

const JALALI_MONTHS = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];

let currentUser = null; // { id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id }
let HOURLY_RATE = DEFAULT_HOURLY_RATE;
let OVERTIME_COEFFICIENT = DEFAULT_OVERTIME_COEFFICIENT;
let reportRecordsCache = [];
let adminUsersCache = [];
let state = { date: '', projectId: undefined, projectName: '', taskId: undefined, taskName: '', taskProjectName: '', projects: [], tasks: [], editingProjectId: null, editingTaskId: null, editingRecordId: null, editingAdminUserId: null, passwordAdminUserId: null };
let confirmState = { open: false, message: '', onConfirm: null };

let stepTransitionTimer = null;
let highlightedRecordId = null;
let dashboardLoadSeq = 0;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PERSIAN_DIGITS = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
const ARABIC_DIGITS = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];

function toPersianDigits(value) {
  return String(value ?? '').replace(/[0-9٠-٩]/g, ch => {
    const arabicIndex = ARABIC_DIGITS.indexOf(ch);
    return arabicIndex >= 0 ? PERSIAN_DIGITS[arabicIndex] : PERSIAN_DIGITS[Number(ch)];
  });
}

function toEnglishDigits(value) {
  return String(value ?? '')
    .replace(/[۰-۹]/g, ch => String(PERSIAN_DIGITS.indexOf(ch)))
    .replace(/[٠-٩]/g, ch => String(ARABIC_DIGITS.indexOf(ch)));
}

function shouldLocalizeNode(node) {
  const parent = node?.parentElement;
  if (!parent) return false;
  return !parent.closest('script, style, template, textarea, noscript');
}

function localizeVisibleNumbers(root=document.body) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!shouldLocalizeNode(node)) return NodeFilter.FILTER_REJECT;
      return /[0-9٠-٩]/.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach(node => { node.nodeValue = toPersianDigits(node.nodeValue); });

  root.querySelectorAll?.('[placeholder], [title], [aria-label]').forEach(el => {
    ['placeholder','title','aria-label'].forEach(attr => {
      const value = el.getAttribute(attr);
      if (value && /[0-9٠-٩]/.test(value)) el.setAttribute(attr, toPersianDigits(value));
    });
  });
  if (document.title && /[0-9٠-٩]/.test(document.title)) document.title = toPersianDigits(document.title);
}

function startPersianDigitObserver() {
  localizeVisibleNumbers(document.body);
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          if (shouldLocalizeNode(node) && /[0-9٠-٩]/.test(node.nodeValue || '')) node.nodeValue = toPersianDigits(node.nodeValue);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          localizeVisibleNumbers(node);
        }
      });
      if (mutation.type === 'characterData') {
        const node = mutation.target;
        if (shouldLocalizeNode(node) && /[0-9٠-٩]/.test(node.nodeValue || '')) node.nodeValue = toPersianDigits(node.nodeValue);
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return observer;
}

function navigateTo(url) {
  if (!url) return;
  if (prefersReducedMotion()) {
    window.location.href = url;
    return;
  }
  document.body.classList.add('page-exit');
  setTimeout(() => { window.location.href = url; }, 150);
}

function openAnimatedModal(idOrElement) {
  const modal = typeof idOrElement === 'string' ? document.getElementById(idOrElement) : idOrElement;
  if (!modal) return;
  modal.classList.remove('closing');
  modal.classList.add('open');
}

function closeAnimatedModal(idOrElement) {
  const modal = typeof idOrElement === 'string' ? document.getElementById(idOrElement) : idOrElement;
  if (!modal || !modal.classList.contains('open')) return;
  if (prefersReducedMotion()) {
    modal.classList.remove('open', 'closing');
    return;
  }
  modal.classList.add('closing');
  setTimeout(() => modal.classList.remove('open', 'closing'), 160);
}

function shakeFields(...ids) {
  ids.flat().forEach(id => {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    el.classList.remove('field-shake');
    void el.offsetWidth;
    el.classList.add('field-shake');
    setTimeout(() => el.classList.remove('field-shake'), 420);
  });
}

function animateNumber(el, finalValue, formatter, duration=600, loadSeq=null) {
  if (!el) return;
  const isStale = () => loadSeq !== null && loadSeq !== dashboardLoadSeq;
  if (isStale()) return;

  const to = Number(finalValue || 0);
  const from = Number(el.dataset.countValue || 0);
  const safeFormatter = typeof formatter === 'function' ? formatter : (v => String(Math.round(v)));
  delete el.dataset.staticValue;

  if (prefersReducedMotion() || !Number.isFinite(to)) {
    if (isStale()) return;
    el.textContent = safeFormatter(to);
    el.dataset.countValue = String(to);
    el.dataset.loadedValue = '1';
    return;
  }

  const startedAt = performance.now();
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const tick = now => {
    if (isStale()) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    const value = from + (to - from) * easeOutCubic(progress);
    el.textContent = safeFormatter(value);
    if (progress < 1) requestAnimationFrame(tick);
    else {
      el.textContent = safeFormatter(to);
      el.dataset.countValue = String(to);
      el.dataset.loadedValue = '1';
    }
  };
  requestAnimationFrame(tick);
}

function markDashboardStaticValue(el, text) {
  if (!el) return;
  el.textContent = text;
  delete el.dataset.countValue;
  el.dataset.staticValue = '1';
  el.dataset.loadedValue = '1';
}

function clearDashboardLoadState(...elements) {
  elements.forEach(el => {
    if (!el) return;
    delete el.dataset.loadedValue;
    delete el.dataset.staticValue;
    delete el.dataset.countValue;
  });
}

function showDashboardSkeleton(loadSeq, delay=350) {
  const ids = ['dashTotal', 'dashMonth', 'dashSalary'];
  const timers = ids.map(id => setTimeout(() => {
    if (loadSeq !== dashboardLoadSeq) return;
    const target = document.getElementById(id);
    if (!target || target.dataset.loadedValue || target.dataset.staticValue || target.textContent.trim()) return;
    const wide = id === 'dashSalary' ? ' skeleton-wide' : '';
    target.innerHTML = `<span class="skeleton skeleton-text${wide}"></span>`;
  }, delay));
  return () => timers.forEach(clearTimeout);
}

function renderSkeletonRows(count=4, cols=8) {
  return Array.from({ length: count }, () => `
    <tr class="skeleton-row">
      ${Array.from({ length: cols }, () => '<td><span class="skeleton"></span></td>').join('')}
    </tr>
  `).join('');
}

function updateMonthlyProgress(monthHours, thresholdHours, loadSeq=null) {
  const bar = document.getElementById('dashMonthProgress');
  const label = document.getElementById('dashMonthProgressLabel');
  if (!bar) return;
  const threshold = Number(thresholdHours || 0);
  const ratio = threshold > 0 ? Math.min(Number(monthHours || 0) / threshold, 1) : 0;
  const percent = Math.round(ratio * 100);
  bar.classList.toggle('near-cap', ratio >= 0.85);
  requestAnimationFrame(() => {
    if (loadSeq !== null && loadSeq !== dashboardLoadSeq) return;
    bar.style.setProperty('--dash-progress', `${percent}%`);
  });
  if (label) label.textContent = threshold > 0 ? `${percent}% از سقف ماهانه` : 'سقف ماهانه نامشخص';
}

function pulseReportRow(recordId, className='row-highlight') {
  const row = document.querySelector(`#reportBody tr[data-record-id="${CSS.escape(String(recordId))}"]`);
  if (!row) return;
  row.classList.remove(className);
  void row.offsetWidth;
  row.classList.add(className);
  setTimeout(() => row.classList.remove(className), className === 'row-danger-pulse' ? 460 : 650);
}

// ===================== Session =====================
const SESSION_DURATION_MS = 15 * 60 * 1000;
const SESSION_KEY = 'wt_session';
const LEGACY_SESSION_KEY = 'wt_user';
const SESSION_EXPIRED_FLAG = 'wt_session_expired';
const SESSION_SYNC_KEY = 'wt_session_sync';
let sessionTimer = null;
let sessionExpiredOnLoad = false;

function isHomePage() {
  return Boolean(document.getElementById('stepHome'));
}

// صفحه گزارش عمومی است و نیازی به ورود ندارد.
function isReportPage() {
  return Boolean(document.getElementById('reportBody'));
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch {}
  try { sessionStorage.setItem(key, value); } catch {}
}

function readStorage(key) {
  try {
    const v = localStorage.getItem(key);
    if (v) return v;
  } catch {}
  try {
    const v = sessionStorage.getItem(key);
    if (v) return v;
  } catch {}
  return null;
}

function removeStorage(key) {
  try { localStorage.removeItem(key); } catch {}
  try { sessionStorage.removeItem(key); } catch {}
}

function broadcastSessionChange(type, user=null) {
  try {
    localStorage.setItem(SESSION_SYNC_KEY, JSON.stringify({
      type,
      userId: user?.id || null,
      at: Date.now()
    }));
  } catch {}
}

function getSavedSessionUserId() {
  try {
    const raw = readStorage(SESSION_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload?.user?.id || !payload?.expiresAt) return null;
    if (Date.now() >= Number(payload.expiresAt)) return null;
    return String(payload.user.id);
  } catch {
    return null;
  }
}

function saveSession(user) {
  const payload = {
    user,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION_MS,
    sessionId: `${user?.id || 'user'}-${Date.now()}`
  };
  writeStorage(SESSION_KEY, JSON.stringify(payload));
  removeStorage(LEGACY_SESSION_KEY);
  scheduleSessionExpiry(payload.expiresAt);
  broadcastSessionChange('login', user);
}

function loadSession() {
  try {
    const raw = readStorage(SESSION_KEY);
    if (raw) {
      const payload = JSON.parse(raw);
      if (!payload?.user || !payload?.expiresAt) { clearSession(); return null; }
      if (Date.now() >= Number(payload.expiresAt)) {
        sessionExpiredOnLoad = true;
        clearSession();
        return null;
      }
      // اگر session فقط در یکی از storageها بود، برای صفحه‌های بعدی sync شود
      writeStorage(SESSION_KEY, JSON.stringify(payload));
      scheduleSessionExpiry(Number(payload.expiresAt));
      return payload.user;
    }

    // تبدیل session قدیمی به session زمان‌دار، فقط برای جلوگیری از لاگین مجدد بعد از آپدیت فایل‌ها
    const legacyRaw = readStorage(LEGACY_SESSION_KEY);
    if (legacyRaw) {
      const user = JSON.parse(legacyRaw);
      if (user?.id) { saveSession(user); return user; }
    }
    return null;
  } catch {
    clearSession();
    return null;
  }
}

function clearSession() {
  removeStorage(SESSION_KEY);
  removeStorage(LEGACY_SESSION_KEY);
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
}

function scheduleSessionExpiry(expiresAt) {
  if (sessionTimer) clearTimeout(sessionTimer);
  const ms = Number(expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) { handleSessionExpired(); return; }
  sessionTimer = setTimeout(handleSessionExpired, Math.min(ms, 2147483647));
}

function redirectToLogin(expired=false) {
  if (isReportPage()) return; // گزارش صفحه عمومی است، کاربر را به صفحه ورود نمی‌فرستیم
  if (expired) writeStorage(SESSION_EXPIRED_FLAG, '1');
  navigateTo('index.html');
}

function handleSessionExpired() {
  clearSession();
  currentUser = null;

  // رمز فقط روی صفحه اصلی گرفته می‌شود. داخل report/admin فرم ورود نشان نمی‌دهیم.
  if (!isHomePage()) {
    redirectToLogin(true);
    return;
  }

  const gate = document.getElementById('passwordGate');
  const root = document.getElementById('appRoot');
  if (root) root.style.display = 'none';
  if (gate) gate.style.display = 'flex';
  setGateError('ورود شما منقضی شد. دوباره وارد شوید.');
  setTimeout(() => document.getElementById('loginInput')?.focus(), 100);
}

// ===================== Auth =====================
async function checkPassword() {
  const loginInput = document.getElementById('loginInput');
  const passwordInput = document.getElementById('passwordInput');
  const gateBtn = document.getElementById('gateBtn');
  const error = document.getElementById('gateError');

  const login = (loginInput?.value || '').trim();
  const password = passwordInput?.value || '';
  if (!login || !password) {
    setGateError('نام کاربری و رمز عبور را وارد کنید.');
    shakeFields(!login ? 'loginInput' : null, !password ? 'passwordInput' : null);
    return;
  }
  if (gateBtn) { gateBtn.disabled = true; gateBtn.textContent = 'در حال ورود...'; }
  if (error) error.textContent = '';

  try {
    const { data, error: dbErr } = await db
      .from('wt_users')
      .select('id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id, telegram_linked_at')
      .ilike('username', login)
      .eq('password', password)
      .eq('active', true)
      .maybeSingle();

    if (dbErr) throw dbErr;
    if (!data) throw new Error('نام کاربری یا رمز عبور اشتباه است.');

    currentUser = data;
    HOURLY_RATE = Number(data.hourly_rate ?? DEFAULT_HOURLY_RATE);
    OVERTIME_COEFFICIENT = Number(data.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT);
    saveSession(currentUser);
    await enterApp();
  } catch (e) {
    setGateError(e.message || 'ورود ناموفق بود.');
    if (passwordInput) { passwordInput.value = ''; passwordInput.focus(); }
    const card = document.querySelector('.gate-card');
    if (card) { card.style.animation = 'none'; void card.offsetHeight; card.style.animation = 'shake 0.4s ease'; }
  } finally {
    if (gateBtn) { gateBtn.disabled = false; gateBtn.textContent = 'ورود'; }
  }
}

function setGateError(message) {
  const error = document.getElementById('gateError');
  if (error) error.textContent = message;
}

function isValidPassword(password) {
  return String(password || '').trim().length > 0;
}

function normalizeTelegramUsername(value) {
  const raw = String(value || '').trim().replace(/^@+/, '');
  return raw || null;
}

function isValidTelegramUsername(value) {
  const normalized = normalizeTelegramUsername(value);
  if (!normalized) return true;
  return /^[a-zA-Z0-9_]{5,32}$/.test(normalized);
}

function formatTelegramUsername(value) {
  const normalized = normalizeTelegramUsername(value);
  return normalized ? '@' + normalized : 'ثبت نشده';
}

function setupPasswordInputs() {
  ['passwordInput', 'signupPassword', 'signupPassword2', 'newUserPassword', 'adminPasswordInput', 'adminPasswordRepeatInput'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.removeAttribute('maxlength');
    el.removeAttribute('inputmode');
    el.removeAttribute('pattern');
  });
}


function openSignupModal() {
  const modal = document.getElementById('signupModal');
  const err = document.getElementById('signupError');
  if (err) err.textContent = '';
  if (modal) { modal.style.zIndex = '1100'; openAnimatedModal(modal); }
  setTimeout(() => document.getElementById('signupUsername')?.focus(), 100);
}

function closeSignupModal() {
  const modal = document.getElementById('signupModal');
  if (modal) closeAnimatedModal(modal);
  ['signupUsername','signupFullName','signupPassword','signupPassword2','signupTelegramUsername'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const err = document.getElementById('signupError');
  if (err) err.textContent = '';
}

function setSignupError(message) {
  const err = document.getElementById('signupError');
  if (err) err.textContent = message || '';
}

async function registerUser() {
  const username = (document.getElementById('signupUsername')?.value || '').trim();
  const fullName = (document.getElementById('signupFullName')?.value || '').trim();
  const password = document.getElementById('signupPassword')?.value || '';
  const password2 = document.getElementById('signupPassword2')?.value || '';
  const telegramUsername = normalizeTelegramUsername(document.getElementById('signupTelegramUsername')?.value || '');
  const btn = document.getElementById('btnSignup');

  if (!username || !password) { setSignupError('نام کاربری و رمز عبور الزامی است.'); shakeFields(!username ? 'signupUsername' : null, !password ? 'signupPassword' : null); return; }
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) { setSignupError('نام کاربری باید ۳ تا ۴۰ کاراکتر انگلیسی، عدد، نقطه، خط تیره یا آندرلاین باشد.'); shakeFields('signupUsername'); return; }
  if (!isValidPassword(password)) { setSignupError('رمز عبور را وارد کنید.'); shakeFields('signupPassword'); return; }
  if (password !== password2) { setSignupError('تکرار رمز عبور درست نیست.'); shakeFields('signupPassword2'); return; }
  if (!isValidTelegramUsername(telegramUsername)) { setSignupError('یوزرنیم تلگرام معتبر نیست. فقط حروف انگلیسی، عدد یا _ وارد کن.'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'در حال ثبت‌نام...'; }
  setSignupError('');

  try {
    const { data, error } = await db
      .from('wt_users')
      .insert({
        username,
        password,
        full_name: fullName || username,
        role: 'user',
        active: true,
        hourly_rate: DEFAULT_HOURLY_RATE,
        overtime_coefficient: DEFAULT_OVERTIME_COEFFICIENT,
        telegram_username: telegramUsername
      })
      .select('id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id, telegram_linked_at')
      .single();

    if (error) throw error;

    currentUser = data;
    HOURLY_RATE = Number(data.hourly_rate ?? DEFAULT_HOURLY_RATE);
    OVERTIME_COEFFICIENT = Number(data.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT);
    saveSession(currentUser);
    closeSignupModal();
    await enterApp();
  } catch (e) {
    const msg = String(e?.message || 'ثبت‌نام ناموفق بود.');
    if (msg.includes('duplicate') || msg.includes('wt_users_username') || msg.includes('unique')) {
      setSignupError('این نام کاربری قبلاً ثبت شده است.');
    } else if (msg.includes('permission denied') || msg.includes('row-level security') || msg.includes('violates row-level security')) {
      setSignupError('دسترسی ثبت‌نام در دیتابیس فعال نیست. فایل database.sql را دوباره در Supabase اجرا کن.');
    } else if (msg.includes('relation') && msg.includes('wt_users')) {
      setSignupError('جدول wt_users ساخته نشده است. فایل database.sql را در Supabase اجرا کن.');
    } else {
      setSignupError('خطا: ' + msg);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'ثبت‌نام'; }
  }
}

function logout() {
  clearSession();
  currentUser = null;
  reportRecordsCache = [];
  adminUsersCache = [];
  broadcastSessionChange('logout');
  navigateTo('index.html');
}

async function enterApp() {
  document.getElementById('passwordGate').style.display = 'none';
  document.getElementById('appRoot').style.display = 'block';
  paintUserBadge();

  const isAdminPage = Boolean(document.getElementById('adminUsersBody'));
  if (isAdminPage && !isCurrentUserAdmin()) {
    showToast('دسترسی به پنل ادمین مجاز نیست.', true);
    setTimeout(() => { navigateTo('index.html'); }, 700);
    return;
  }

  if (document.getElementById('adminNavBtn') && isCurrentUserAdmin()) {
    document.getElementById('adminNavBtn').style.display = 'block';
  }
  if (document.getElementById('adminReportBtn') && isCurrentUserAdmin()) {
    document.getElementById('adminReportBtn').style.display = 'inline-flex';
  }

  if (document.getElementById('dashTotal')) await loadDashboard();
  if (document.getElementById('reportBody')) await initReportPage();
  if (document.getElementById('adminUsersBody')) await initAdminPage();
}

async function refreshPageForCurrentSession() {
  // فقط داده‌ها را دوباره می‌خوانیم؛ initReportPage فقط یک‌بار در بارگذاری اولیه صدا زده می‌شود
  // تا لیسنرهای فیلترها تکراری ثبت نشوند.
  if (isReportPage()) { await loadReports(); return; }
  if (!currentUser?.id) {
    if (!isHomePage()) redirectToLogin(false);
    return;
  }

  HOURLY_RATE = Number(currentUser.hourly_rate ?? DEFAULT_HOURLY_RATE);
  OVERTIME_COEFFICIENT = Number(currentUser.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT);

  const gate = document.getElementById('passwordGate');
  const root = document.getElementById('appRoot');
  if (gate) gate.style.display = 'none';
  if (root) root.style.display = 'block';

  reportRecordsCache = [];
  adminUsersCache = [];
  paintUserBadge();

  if (document.getElementById('adminUsersBody') && !isCurrentUserAdmin()) {
    navigateTo('index.html');
    return;
  }

  if (document.getElementById('dashTotal')) await loadDashboard();
  if (document.getElementById('reportBody')) await initReportPage();
  if (document.getElementById('adminUsersBody')) await initAdminPage();
}

async function syncCurrentUserFromStorage() {
  const saved = loadSession();
  const savedId = saved?.id ? String(saved.id) : null;
  const currentId = currentUser?.id ? String(currentUser.id) : null;

  if (!savedId) {
    if (currentUser) {
      currentUser = null;
      reportRecordsCache = [];
      adminUsersCache = [];
    }
    if (!isHomePage()) redirectToLogin(false);
    return;
  }

  if (savedId !== currentId) {
    currentUser = saved;
    await refreshPageForCurrentSession();
    return;
  }

  // حتی اگر id یکی بود، ممکن است role/rate/full_name تغییر کرده باشد.
  currentUser = saved;
  HOURLY_RATE = Number(saved.hourly_rate ?? DEFAULT_HOURLY_RATE);
  OVERTIME_COEFFICIENT = Number(saved.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT);
  paintUserBadge();
}

function paintUserBadge() {
  const el = document.getElementById('currentUserBadge');
  if (!el || !currentUser) return;
  const name = currentUser.full_name || currentUser.username;
  el.textContent = `${name} · ${isCurrentUserAdmin() ? 'ادمین' : 'کاربر'}`;
}

function requireUserId() {
  if (!currentUser?.id) throw new Error('کاربر لاگین نیست.');
  return String(currentUser.id);
}

function isCurrentUserAdmin() {
  return String(currentUser?.role || '').toLowerCase() === 'admin';
}

function isOwnRecord(record) {
  return String(record?.user_id || '') === requireUserId();
}

// ===================== ابزارهای جلالی =====================
function toJalali(gy, gm, gd) {
  let g_day_no = 365*(gy-1600) + Math.floor((gy-1597)/4) - Math.floor((gy-1601)/100) + Math.floor((gy-1601)/400);
  const gml = [31,(gy%4==0&&gy%100!=0)||gy%400==0?29:28,31,30,31,30,31,31,30,31,30,31];
  for (let i=0;i<gm-1;i++) g_day_no += gml[i];
  g_day_no += gd - 1;
  let j_day_no = g_day_no - 79;
  const j_np = Math.floor(j_day_no/12053);
  j_day_no %= 12053;
  let jy = 979 + 33*j_np + 4*Math.floor(j_day_no/1461);
  j_day_no %= 1461;
  if (j_day_no >= 366) { jy += Math.floor((j_day_no-1)/365); j_day_no = (j_day_no-1)%365; }
  const jml = [31,31,31,31,31,31,30,30,30,30,30,29];
  let jm = 0;
  for (let i=0;i<12;i++) { if (j_day_no < jml[i]) { jm = i+1; break; } j_day_no -= jml[i]; }
  return { y: jy, m: jm, d: j_day_no+1 };
}

function jalaliToGregorian(jy, jm, jd) {
  jy = Number(jy); jm = Number(jm); jd = Number(jd);
  if (!Number.isFinite(jy) || !Number.isFinite(jm) || !Number.isFinite(jd) || jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  const jMonthDays = [31,31,31,31,31,31,30,30,30,30,30,29];
  jy -= 979; jm -= 1; jd -= 1;

  let jDayNo = 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4);
  for (let i = 0; i < jm; i++) jDayNo += jMonthDays[i];
  jDayNo += jd;

  let gDayNo = jDayNo + 79;
  let gy = 1600 + 400 * Math.floor(gDayNo / 146097);
  gDayNo %= 146097;

  let leap = true;
  if (gDayNo >= 36525) {
    gDayNo--;
    gy += 100 * Math.floor(gDayNo / 36524);
    gDayNo %= 36524;
    if (gDayNo >= 365) gDayNo++;
    else leap = false;
  }

  gy += 4 * Math.floor(gDayNo / 1461);
  gDayNo %= 1461;

  if (gDayNo >= 366) {
    leap = false;
    gDayNo--;
    gy += Math.floor(gDayNo / 365);
    gDayNo %= 365;
  }

  const gMonthDays = [31, leap ? 29 : 28, 31,30,31,30,31,31,30,31,30,31];
  let gm = 0;
  while (gm < 12 && gDayNo >= gMonthDays[gm]) {
    gDayNo -= gMonthDays[gm];
    gm++;
  }

  return { gy, gm: gm + 1, gd: gDayNo + 1 };
}

function parseJalaliDate(value) {
  const m = toEnglishDigits(String(value || '').trim()).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  return { jy: Number(m[1]), jm: Number(m[2]), jd: Number(m[3]) };
}

function jalaliDateToGregorianDate(value) {
  const parts = parseJalaliDate(value);
  if (!parts) return null;
  const g = jalaliToGregorian(parts.jy, parts.jm, parts.jd);
  if (!g) return null;
  return new Date(Date.UTC(g.gy, g.gm - 1, g.gd));
}

function jalaliMonthDays(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return (jy%4==3) ? 30 : 29;
}

function getTodayJalali() {
  const n = new Date();
  return toJalali(n.getFullYear(), n.getMonth()+1, n.getDate());
}

const today = getTodayJalali();

// ===================== قالب‌بندی =====================
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function formatHours(h) {
  const safe = Number(h || 0);
  const hh = Math.floor(safe);
  const mm = Math.round((safe - hh) * 60);
  const value = mm === 0 ? `${hh} ساعت ` : `${hh}:${String(mm).padStart(2,'0')} ساعت `;
  return toPersianDigits(value);
}

function formatMoney(amount) {
  return toPersianDigits(Number(amount || 0).toLocaleString('en-US') + ' ت');
}

// ===================== داشبورد =====================
async function loadDashboard() {
  const dashTotal = document.getElementById('dashTotal');
  const dashMonth = document.getElementById('dashMonth');
  const dashSalary = document.getElementById('dashSalary');
  const dashError = document.getElementById('dashError');
  if (!dashTotal || !dashMonth || !dashSalary) return;

  const progressBar = document.getElementById('dashMonthProgress');
  const progressLabel = document.getElementById('dashMonthProgressLabel');
  const loadSeq = ++dashboardLoadSeq;
  if (dashError) { dashError.style.display = 'none'; dashError.textContent = ''; }
  if (progressBar) progressBar.style.setProperty('--dash-progress', '0%');
  if (progressLabel) progressLabel.innerHTML = '&nbsp;';
  const cancelSkeleton = showDashboardSkeleton(loadSeq);

  try {
    let q = db.from('work_records').select('hours, work_date, user_id');
    if (!isCurrentUserAdmin()) q = q.eq('user_id', requireUserId());
    const { data: records, error } = await q;
    cancelSkeleton();
    if (loadSeq !== dashboardLoadSeq) return;
    if (error) throw error;

    const safeRecords = records || [];
    const totalHours = safeRecords.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);
    const currentMonthStr = `${today.y}-${String(today.m).padStart(2,'0')}`;
    const monthRecords = safeRecords.filter(r => r.work_date && r.work_date.startsWith(currentMonthStr));
    const monthHours = monthRecords.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);
    const salaryInfo = calculateMonthlySalary(monthHours, today.y, today.m);

    animateNumber(dashTotal, totalHours, formatHours, 600, loadSeq);
    animateNumber(dashMonth, monthHours, formatHours, 600, loadSeq);
    if (isCurrentUserAdmin()) {
      markDashboardStaticValue(dashSalary, 'گزارش کلی');
    } else {
      animateNumber(dashSalary, salaryInfo.salary, formatMoney, 350, loadSeq);
    }
    updateMonthlyProgress(monthHours, salaryInfo.thresholdHours, loadSeq);
  } catch(e) {
    cancelSkeleton();
    if (loadSeq !== dashboardLoadSeq) return;
    dashTotal.textContent = '—';
    dashMonth.textContent = '—';
    dashSalary.textContent = '—';
    clearDashboardLoadState(dashTotal, dashMonth, dashSalary);
    if (dashError) { dashError.style.display = 'block'; dashError.textContent = 'خطا در بارگذاری اطلاعات: ' + e.message; }
  }
}

function isJalaliWeekend(dateValue) {
  const date = jalaliDateToGregorianDate(dateValue);
  if (!date) return false;
  const day = date.getUTCDay();
  return day === 4 || day === 5; // پنجشنبه و جمعه
}

function getMonthlyWorkingThreshold(jy, jm) {
  const monthDays = jalaliMonthDays(jy, jm);
  const holidayDates = getConfiguredHolidayDates(jy);
  let weekendDays = 0;
  let holidayDays = 0;

  for (let day = 1; day <= monthDays; day += 1) {
    const date = `${jy}-${String(jm).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isWeekend = isJalaliWeekend(date);
    if (isWeekend) weekendDays += 1;
    if (!isWeekend && holidayDates.has(date)) holidayDays += 1;
  }

  const workingDays = Math.max(0, monthDays - weekendDays - holidayDays);
  return { monthDays, workingDays, thresholdHours: workingDays * STANDARD_DAILY_HOURS, holidayDays, weekendDays };
}

function calculateMonthlySalary(monthHours, jy, jm) {
  const threshold = getMonthlyWorkingThreshold(jy, jm);
  const regularHours = Math.min(monthHours, threshold.thresholdHours);
  const overtimeHours = Math.max(0, monthHours - threshold.thresholdHours);
  return {
    regularHours, overtimeHours,
    thresholdHours: threshold.thresholdHours,
    workingDays: threshold.workingDays,
    salary: (regularHours * HOURLY_RATE) + (overtimeHours * HOURLY_RATE * OVERTIME_COEFFICIENT),
    isOvertime: monthHours > threshold.thresholdHours,
    thresholdInfo: threshold
  };
}

// ===================== گزارش‌ها =====================
async function initReportPage() {
  await loadReportUsersFilter();
  await loadReports();
  document.getElementById('userFilter')?.addEventListener('change', loadReports);
  document.getElementById('yearFilter')?.addEventListener('change', () => { updateDayOptions(); renderReportFromCache(); });
  document.getElementById('monthFilter')?.addEventListener('change', () => { updateDayOptions(); renderReportFromCache(); });
  document.getElementById('taskFilter')?.addEventListener('change', renderReportFromCache);
  document.getElementById('dayFilter')?.addEventListener('change', renderReportFromCache);
}

async function loadReportUsersFilter() {
  const wrap = document.getElementById('userFilterWrap');
  const select = document.getElementById('userFilter');
  if (!wrap || !select) return;

  wrap.style.display = 'flex';
  const { data, error } = await db.from('wt_users').select('id, username, full_name, role').eq('active', true).order('username');
  if (error) throw error;
  select.innerHTML = '<option value="all">همه کاربران</option>' + (data || []).map(u => `<option value="${u.id}">${escapeHtml(u.full_name || u.username)}</option>`).join('');
}

async function loadReports() {
  const reportBody = document.getElementById('reportBody');
  if (!reportBody) return;
  reportBody.innerHTML = renderSkeletonRows(4, 7);

  try {
    // گزارش صفحه عمومی است: بدون ورود، همه رکوردها (یا رکوردهای کاربر انتخاب‌شده) نمایش داده می‌شود.
    const selectedUser = document.getElementById('userFilter')?.value || 'all';
    const reportSelectClauses = [
      'id, user_id, work_date, start_time, end_time, hours, description, project_id, projects(id,name), task_id, tasks(id, name, project_id, project_name, projects(id,name))',
      'id, user_id, work_date, start_time, end_time, hours, description, project_id, task_id, tasks(id, name, project_id, project_name)',
      'id, user_id, work_date, start_time, end_time, hours, description, task_id, tasks(id, name, project_name)',
      'id, user_id, work_date, start_time, end_time, hours, description, task_id, tasks(id, name)'
    ];

    const runReportQuery = async (selectClause) => {
      let q = db.from('work_records').select(selectClause).order('work_date', { ascending: false });
      if (selectedUser !== 'all') q = q.eq('user_id', selectedUser);
      return q;
    };

    let data = null;
    let error = null;
    for (const selectClause of reportSelectClauses) {
      ({ data, error } = await runReportQuery(selectClause));
      if (!error) break;
      if (!isMissingProjectFeatureError(error) && !isMissingProjectNameColumnError(error)) break;
    }
    if (error) throw error;

    const safeRecords = data || [];

    // join با wt_users برای نمایش نام کاربر
    const userIds = [...new Set(safeRecords.map(r => r.user_id))];
    let usersMap = {};
    if (userIds.length) {
      const { data: users } = await db.from('wt_users').select('id, username, full_name').in('id', userIds);
      (users||[]).forEach(u => { usersMap[u.id] = u; });
    }

    reportRecordsCache = safeRecords.map(r => ({ ...r, wt_user: usersMap[r.user_id] || null }));
    buildReportFilters(reportRecordsCache);
    renderReportFromCache();
  } catch (e) {
    reportBody.innerHTML = `<tr><td colspan="7" class="error-msg">خطا در بارگذاری گزارش‌ها: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function buildReportFilters(records) {
  const taskFilter = document.getElementById('taskFilter');
  const yearFilter = document.getElementById('yearFilter');
  const monthFilter = document.getElementById('monthFilter');
  const dayFilter = document.getElementById('dayFilter');
  if (!taskFilter || !yearFilter || !monthFilter || !dayFilter) return;

  const selected = { task: taskFilter.value||'all', year: yearFilter.value||'all', month: monthFilter.value||'all', day: dayFilter.value||'all' };
  const years = [...new Set(records.map(r => String(r.work_date||'').slice(0,4)).filter(Boolean))].sort((a,b) => Number(b)-Number(a));
  const taskPairs = new Map();
  records.forEach(r => { if (r.tasks?.id) taskPairs.set(String(r.tasks.id), r.tasks.name); });

  yearFilter.innerHTML = '<option value="all">همه سال‌ها</option>' + (years.length ? years.map(y => `<option value="${y}">${y}</option>`).join('') : `<option value="${today.y}">${today.y}</option>`);
  monthFilter.innerHTML = '<option value="all">همه ماه‌ها</option>' + JALALI_MONTHS.map((m, i) => `<option value="${i+1}">${m}</option>`).join('');
  taskFilter.innerHTML = '<option value="all">همه وظایف</option>' + Array.from(taskPairs.entries()).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');

  yearFilter.value = years.includes(selected.year) ? selected.year : 'all';
  monthFilter.value = selected.month !== 'all' && JALALI_MONTHS[Number(selected.month)-1] ? selected.month : 'all';
  taskFilter.value = Array.from(taskFilter.options).some(o => o.value === selected.task) ? selected.task : 'all';
  updateDayOptions();
  const dayOpt = Array.from(dayFilter.options).some(o => o.value === selected.day);
  dayFilter.value = dayOpt ? selected.day : 'all';
}

function applyReportFilters(records) {
  const selectedTask = document.getElementById('taskFilter')?.value || 'all';
  const selectedYear = document.getElementById('yearFilter')?.value || 'all';
  const selectedMonth = document.getElementById('monthFilter')?.value || 'all';
  const selectedDay = document.getElementById('dayFilter')?.value || 'all';

  return records.filter(r => {
    const date = String(r.work_date || '');
    const [y,m,d] = date.split('-');
    return (selectedTask === 'all' || String(r.task_id) === String(selectedTask))
      && (selectedYear === 'all' || y === selectedYear)
      && (selectedMonth === 'all' || m === String(selectedMonth).padStart(2,'0'))
      && (selectedDay === 'all' || d === String(selectedDay).padStart(2,'0'));
  });
}

function renderReportFromCache() {
  const reportBody = document.getElementById('reportBody');
  const reportSummary = document.getElementById('reportSummary');
  if (!reportBody || !reportSummary) return;

  const filtered = applyReportFilters(reportRecordsCache);
  const rows = filtered.map(r => ({
    id: r.id,
    user_id: r.user_id,
    user: r.wt_user ? (r.wt_user.full_name || r.wt_user.username) : '—',
    date: r.work_date || '—',
    task: r.tasks?.name || '—',
    hours: Number(r.hours || 0),
    start: String(r.start_time || '—').slice(0,5),
    end: String(r.end_time || '—').slice(0,5),
    desc: r.description || '—'
  }));

  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
  const selectedYear = document.getElementById('yearFilter')?.value || 'all';
  const selectedMonth = document.getElementById('monthFilter')?.value || 'all';
  const calcYear = selectedYear === 'all' ? today.y : Number(selectedYear);
  const calcMonth = selectedMonth === 'all' ? today.m : Number(selectedMonth);
  const totalSalaryInfo = calculateMonthlySalary(totalHours, calcYear, calcMonth);

  reportSummary.innerHTML = `
    <div class="report-chip">مجموع: <strong>${formatHours(totalHours)}</strong></div>
    <div class="report-chip">سقف ماهانه: <strong>${formatHours(totalSalaryInfo.thresholdHours)}</strong></div>
    <div class="report-chip">اضافه‌کاری: <strong>${formatHours(totalSalaryInfo.overtimeHours)}</strong></div>
    <div class="report-chip">ضریب اضافه‌کاری: <strong>${OVERTIME_COEFFICIENT.toFixed(1)}x</strong></div>
  `;

  if (!rows.length) {
    reportBody.innerHTML = '<tr><td colspan="7" class="empty-state">رکوردی برای فیلترهای انتخاب‌شده یافت نشد.</td></tr>';
    return;
  }

  reportBody.innerHTML = rows.map((r, i) => `
    <tr data-record-id="${r.id}" class="row-enter" style="--row-i:${Math.min(i, 12)}">
      <td style="font-family:var(--font)">${escapeHtml(r.user)}</td>
      <td>${escapeHtml(r.date)}</td>
      <td style="font-family:var(--font)">${escapeHtml(r.task)}</td>
      <td>${formatHours(r.hours)}</td>
      <td>${escapeHtml(r.start)}</td>
      <td>${escapeHtml(r.end)}</td>
      <td style="font-family:var(--font);font-size:11px">${escapeHtml(r.desc)}</td>
    </tr>
  `).join('');
}

function updateDayOptions() {
  const yearFilter = document.getElementById('yearFilter');
  const monthFilter = document.getElementById('monthFilter');
  const dayFilter = document.getElementById('dayFilter');
  if (!yearFilter || !monthFilter || !dayFilter) return;

  const currentDay = dayFilter.value || 'all';
  const year = yearFilter.value === 'all' ? today.y : Number(yearFilter.value);
  const month = monthFilter.value === 'all' ? today.m : Number(monthFilter.value);
  const maxDay = month === today.m && year === today.y ? today.d : jalaliMonthDays(year, month);
  const days = Array.from({ length: maxDay }, (_, i) => i+1);

  dayFilter.innerHTML = '<option value="all">همه روزها</option>' + days.map(d => `<option value="${d}">${d}</option>`).join('');
  dayFilter.value = days.includes(Number(currentDay)) || currentDay === 'all' ? currentDay : 'all';
}

function exportReportToExcel() {
  const rows = Array.from(document.querySelectorAll('#reportBody tr'));
  if (!rows.length || rows[0].textContent.includes('رکوردی')) {
    showToast('رکوردی برای خروجی وجود ندارد', true); return;
  }
  const csv = [
    'کاربر,تاریخ,وظیفه,ساعت,شروع,پایان,توضیحات',
    ...Array.from(rows).map(row => Array.from(row.cells).slice(0,7).map(cell => `"${cell.textContent.replace(/"/g,'""').replace(/\n/g,' ').trim()}"`).join(','))
  ].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'work-report.csv';
  link.click(); URL.revokeObjectURL(url);
  showToast('CSV ذخیره شد');
}


function getOdooExportRows() {
  // گزارش عمومی است: همان رکوردهایی که با فیلترهای فعلی روی صفحه دیده می‌شوند خروجی می‌گیرند.
  return applyReportFilters(reportRecordsCache);
}

function getRecordTaskName(record) {
  return record?.tasks?.name || record?.task_name || '';
}

function getRecordProjectName(record, fallbackProjectName=ODOO_DEFAULT_PROJECT_NAME) {
  return String(
    record?.projects?.name
    || record?.tasks?.projects?.name
    || record?.tasks?.project_name
    || record?.project_name
    || fallbackProjectName
    || ODOO_DEFAULT_PROJECT_NAME
  ).trim() || ODOO_DEFAULT_PROJECT_NAME;
}

function getOdooDecimalHours(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function getSafeOdooFileName() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `odoo-export-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
}

async function loadOdooTemplateWorkbook() {
  if (!window.XLSX) throw new Error('کتابخانه خروجی اکسل بارگذاری نشده است. اتصال اینترنت/CDN را بررسی کن.');
  try {
    const res = await fetch(ODOO_TEMPLATE_PATH, { cache: 'no-store' });
    if (!res.ok) throw new Error('template fetch failed');
    const buffer = await res.arrayBuffer();
    return window.XLSX.read(buffer, { type: 'array', cellDates: true });
  } catch {
    // اگر تمپلیت در دسترس نبود، یک نسخه ساده با همان سرستون‌های تمپلیت اصلی ساخته می‌شود.
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([ODOO_TEMPLATE_HEADERS]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return wb;
  }
}

// ردیف اول تمپلیت اودو همیشه سرستون است (Date, Project, Task, Description, quantity)
// و نباید هنگام نوشتن داده‌ها بازنویسی شود.
const ODOO_TEMPLATE_HEADERS = ['Date', 'Project', 'Task', 'Description', 'quantity'];
const ODOO_HEADER_ROW_COUNT = 1;

function buildOdooWorksheet(sheet, records) {
  const XLSX = window.XLSX;
  const ws = sheet || {};

  // فقط ردیف‌های داده (زیر سرستون) پاک‌سازی می‌شوند؛ سرستون و استایل آن دست‌نخورده می‌ماند.
  Object.keys(ws).forEach(key => {
    if (key.startsWith('!')) return;
    const { r } = XLSX.utils.decode_cell(key);
    if (r >= ODOO_HEADER_ROW_COUNT) delete ws[key];
  });

  records.forEach((record, index) => {
    const rowIndex = ODOO_HEADER_ROW_COUNT + index;
    const gregorianDate = jalaliDateToGregorianDate(record.work_date);
    if (!gregorianDate) {
      throw new Error(`تاریخ ${record.work_date || 'نامشخص'} قابل تبدیل به میلادی نیست.`);
    }
    const projectName = getRecordProjectName(record, ODOO_DEFAULT_PROJECT_NAME);

    const values = [
      { t: 'd', v: gregorianDate, z: 'yyyy-mm-dd' },
      { t: 's', v: projectName },
      { t: 's', v: getRecordTaskName(record) },
      { t: 's', v: record.description || '' },
      { t: 'n', v: getOdooDecimalHours(record.hours), z: '0.##' }
    ];

    values.forEach((cell, col) => {
      ws[XLSX.utils.encode_cell({ r: rowIndex, c: col })] = cell;
    });
  });

  const lastRow = ODOO_HEADER_ROW_COUNT + Math.max(records.length, 0) - 1;
  const existingRange = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: ODOO_HEADER_ROW_COUNT - 1, c: 4 } };
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(lastRow, existingRange.e.r, ODOO_HEADER_ROW_COUNT - 1), c: Math.max(4, existingRange.e.c) }
  });
  ws['!cols'] = [
    { wch: 14 },
    { wch: 28 },
    { wch: 24 },
    { wch: 42 },
    { wch: 10 }
  ];
  return ws;
}

async function exportOdooReport() {
  try {
    const records = getOdooExportRows();
    if (!records.length) {
      showToast('رکوردی برای خروجی Odoo وجود ندارد', true);
      return;
    }

    const workbook = await loadOdooTemplateWorkbook();
    const sheetName = workbook.SheetNames?.[0] || 'Sheet1';
    workbook.Sheets[sheetName] = buildOdooWorksheet(workbook.Sheets[sheetName], records);
    if (!workbook.SheetNames?.length) workbook.SheetNames = [sheetName];

    window.XLSX.writeFile(workbook, getSafeOdooFileName(), { bookType: 'xlsx', cellDates: true });
    showToast('خروجی Odoo ساخته شد');
  } catch (e) {
    showToast('خطا در خروجی Odoo: ' + (e.message || e), true);
  }
}


// ===================== ناوبری فرم =====================
function startLog() {
  document.getElementById('stepHome').style.display = 'none';
  document.getElementById('formFlow').style.display = 'block';
  buildDateDropdowns();
  buildTimePicker('startTimePicker','startTimeVal', 8, '30');
  buildTimePicker('endTimePicker','endTimeVal', 17, '00');
  goToStep(0);
}

function backToHome() {
  document.getElementById('formFlow').style.display = 'none';
  document.getElementById('stepHome').style.display = 'block';
  loadDashboard();
}

function buildDateDropdowns() {
  document.getElementById('year').textContent = today.y;
  const monthSel = document.getElementById('month');
  monthSel.innerHTML = '';
  for (let m=1; m<=today.m; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = JALALI_MONTHS[m-1];
    if (m === today.m) o.selected = true;
    monthSel.appendChild(o);
  }
  buildDayDropdown(today.m, today.d);
  monthSel.onchange = () => {
    const selMonth = parseInt(monthSel.value);
    const maxDay = selMonth === today.m ? today.d : jalaliMonthDays(today.y, selMonth);
    buildDayDropdown(selMonth, selMonth === today.m ? today.d : 1, maxDay);
  };
}

function buildDayDropdown(jm, selectedDay, maxDay=null) {
  const daySel = document.getElementById('day');
  daySel.innerHTML = '';
  const limit = maxDay || jalaliMonthDays(today.y, jm);
  for (let d=1; d<=limit; d++) {
    const o = document.createElement('option');
    o.value = d; o.textContent = d;
    if (d === selectedDay) o.selected = true;
    daySel.appendChild(o);
  }
}

function buildTimePicker(containerId, inputId, defaultHour=8, defaultMin='30') {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const hours = []; for (let h=6; h<=23; h++) hours.push(h);
  const minutes = ['00','15','30','45'];

  const hSel = document.createElement('select');
  hSel.className = 'time-sel';
  hours.forEach(h => {
    const o = document.createElement('option');
    o.value = h; o.textContent = String(h).padStart(2,'0');
    if (h === defaultHour) o.selected = true;
    hSel.appendChild(o);
  });

  const sep = document.createElement('span');
  sep.className = 'time-sep'; sep.textContent = ':';

  const mSel = document.createElement('select');
  mSel.className = 'time-sel';
  minutes.forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    if (m === defaultMin) o.selected = true;
    mSel.appendChild(o);
  });

  const update = () => { document.getElementById(inputId).value = `${String(hSel.value).padStart(2,'0')}:${mSel.value}`; };
  hSel.addEventListener('change', update);
  mSel.addEventListener('change', update);
  update();

  container.appendChild(hSel);
  container.appendChild(sep);
  container.appendChild(mSel);
}

function goToStep(n) {
  const next = document.getElementById('step'+n);
  if (!next) return;
  const current = document.querySelector('#formFlow .step.active');
  const currentIndex = current?.id?.startsWith('step') ? Number(current.id.replace('step','')) : n;
  const isForward = n >= currentIndex;
  const enterClass = isForward ? 'enter-forward' : 'enter-back';
  const leaveClass = isForward ? 'leave-forward' : 'leave-back';

  if (stepTransitionTimer) clearTimeout(stepTransitionTimer);
  document.querySelectorAll('#formFlow .step').forEach(s => {
    s.classList.remove('enter-forward','enter-back','leave-forward','leave-back','leaving');
  });

  if (!current || current === next || prefersReducedMotion()) {
    document.querySelectorAll('#formFlow .step').forEach(s => s.classList.remove('active'));
    next.classList.add('active');
  } else {
    current.classList.add('leaving', leaveClass);
    next.classList.add('active', enterClass);
    stepTransitionTimer = setTimeout(() => {
      current.classList.remove('active','leaving',leaveClass);
      next.classList.remove(enterClass);
      stepTransitionTimer = null;
    }, 260);
  }

  for (let i=0;i<3;i++) {
    const dot = document.getElementById('dot'+i);
    if (!dot) continue;
    dot.className = 'prog-step' + (i===n?' active':i<n?' done':'');
  }
}

function goToStep1() {
  const m = document.getElementById('month').value;
  const d = document.getElementById('day').value;
  state.date = `${today.y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  state.projectId = undefined;
  state.projectName = '';
  state.taskId = undefined;
  state.taskName = '';
  state.taskProjectName = '';
  const btn = document.getElementById('btnTask');
  if (btn) btn.disabled = true;
  goToStep(1);
  loadProjectTaskPicker();
}

function isMissingProjectNameColumnError(error) {
  const message = String(error?.message || error?.details || '');
  return message.includes('project_name') || error?.code === 'PGRST204';
}

function isMissingProjectFeatureError(error) {
  const message = String(error?.message || error?.details || error?.hint || '');
  return message.includes('project_id')
    || message.includes('projects')
    || message.includes("Could not find a relationship")
    || error?.code === 'PGRST204';
}

function getTaskProjectId(task) {
  return task?.project_id ?? task?.projects?.id ?? null;
}

function getTaskProjectName(task) {
  return String(task?.projects?.name || task?.project_name || '').trim();
}

function normalizeTaskRecord(task, fallbackProjectName='') {
  return {
    ...task,
    project_id: getTaskProjectId(task),
    project_name: getTaskProjectName(task) || fallbackProjectName || ''
  };
}

function getSelectedProjectNameById(projectId) {
  const project = state.projects.find(p => String(p.id) === String(projectId));
  return project?.name || '';
}

async function fetchActiveProjectsForUser(userId) {
  const { data, error } = await db
    .from('projects')
    .select('id,name')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(p => ({ id: p.id, name: p.name || '' })).filter(p => p.name);
}

async function insertProjectRecord(payload) {
  const { data, error } = await db.from('projects').insert(payload).select('id,name').single();
  if (error) throw error;
  return data;
}

async function updateProjectRecord(id, payload) {
  const { error } = await db.from('projects').update(payload).eq('id', id).eq('user_id', requireUserId());
  if (error) throw error;
}

async function deactivateProjectRecord(id) {
  const { error } = await db.from('projects').update({ active: false }).eq('id', id).eq('user_id', requireUserId());
  if (error) throw error;
  // وظایف زیرمجموعه پروژه هم غیرفعال شوند تا در فرم ثبت کار نمایش داده نشوند.
  await db.from('tasks').update({ active: false }).eq('project_id', id).eq('user_id', requireUserId());
}

async function fetchActiveTasksForUser(userId, projectId=null) {
  const buildQuery = (selectClause) => {
    let q = db
      .from('tasks')
      .select(selectClause)
      .eq('user_id', userId)
      .eq('active', true)
      .order('id', { ascending: true });
    if (projectId !== null && projectId !== undefined && projectId !== '') q = q.eq('project_id', projectId);
    return q;
  };

  let { data, error } = await buildQuery('id,name,project_id,project_name,projects(id,name)');
  if (error && isMissingProjectFeatureError(error)) {
    ({ data, error } = await buildQuery('id,name,project_name'));
  }
  if (error && isMissingProjectNameColumnError(error)) {
    ({ data, error } = await buildQuery('id,name'));
  }
  if (error) throw error;
  return (data || []).map(t => normalizeTaskRecord(t));
}

async function insertTaskRecord(payload) {
  let { data, error } = await db
    .from('tasks')
    .insert(payload)
    .select('id,name,project_id,project_name,projects(id,name)')
    .single();
  if (error && isMissingProjectFeatureError(error)) {
    const { project_id, projects, ...fallbackPayload } = payload;
    ({ data, error } = await db.from('tasks').insert(fallbackPayload).select('id,name,project_name').single());
  }
  if (error && isMissingProjectNameColumnError(error)) {
    const { project_name, project_id, projects, ...fallbackPayload } = payload;
    ({ data, error } = await db.from('tasks').insert(fallbackPayload).select('id,name').single());
  }
  if (error) throw error;
  return normalizeTaskRecord(data, payload.project_name || getSelectedProjectNameById(payload.project_id));
}

async function updateTaskRecord(id, payload) {
  let { error } = await db.from('tasks').update(payload).eq('id', id).eq('user_id', requireUserId());
  if (error && isMissingProjectFeatureError(error)) {
    const { project_id, projects, ...fallbackPayload } = payload;
    ({ error } = await db.from('tasks').update(fallbackPayload).eq('id', id).eq('user_id', requireUserId()));
  }
  if (error && isMissingProjectNameColumnError(error)) {
    const { project_name, project_id, projects, ...fallbackPayload } = payload;
    ({ error } = await db.from('tasks').update(fallbackPayload).eq('id', id).eq('user_id', requireUserId()));
  }
  if (error) throw error;
}

async function loadProjectTaskPicker() {
  const projectContainer = document.getElementById('projectContainer');
  const taskContainer = document.getElementById('taskContainer');
  if (projectContainer) projectContainer.innerHTML = '<div class="loading"><div class="spinner"></div> در حال بارگذاری...</div>';
  if (taskContainer) taskContainer.innerHTML = '<p class="muted-text" style="font-size:12px;text-align:center;padding:16px 0">ابتدا یک پروژه انتخاب کن.</p>';
  try {
    const userId = requireUserId();
    const [projects, tasks] = await Promise.all([
      fetchActiveProjectsForUser(userId),
      fetchActiveTasksForUser(userId)
    ]);
    state.projects = projects;
    state.tasks = tasks;
    renderProjects(projects);
    if (!projects.length && taskContainer) {
      taskContainer.innerHTML = '<p class="muted-text" style="font-size:12px;text-align:center;padding:16px 0">اول از تنظیمات یک پروژه بساز.</p>';
    }
  } catch(e) {
    if (projectContainer) projectContainer.innerHTML = `<p class="error-msg">خطا: ${escapeHtml(e.message)}</p>`;
    if (taskContainer) taskContainer.innerHTML = '<p class="muted-text" style="font-size:12px;text-align:center;padding:16px 0">برای پروژه‌ها فایل projects_migration.sql را اجرا کن.</p>';
  }
}

async function loadTasks() {
  return loadProjectTaskPicker();
}

function renderProjects(projects) {
  const container = document.getElementById('projectContainer');
  if (!container) return;
  if (!projects.length) {
    container.innerHTML = `
      <div class="task-list">
        <div class="no-task" onclick="openAppSettingsModal('projects')">
          <span>+</span><span>اول یک پروژه اضافه کن</span>
        </div>
      </div>`;
    return;
  }
  let html = '<div class="task-list project-list">';
  projects.forEach(p => {
    html += `<div class="task-item project-item" id="project-${p.id}" onclick="selectProject(${escapeAttr(JSON.stringify(p.id))},${escapeAttr(JSON.stringify(p.name))})">
      <span>${escapeHtml(p.name)}</span><div class="check"></div>
    </div>`;
  });
  html += '</div>';
  html += `<button class="btn-add-task" onclick="openAppSettingsModal('projects')">+ تنظیمات پروژه‌ها</button>`;
  container.innerHTML = html;
}

function selectProject(id, name) {
  document.querySelectorAll('.project-item').forEach(el => el.classList.remove('selected'));
  const selected = document.getElementById('project-' + id);
  if (selected) {
    selected.classList.add('selected');
    selected.classList.remove('tap-feedback');
    void selected.offsetWidth;
    selected.classList.add('tap-feedback');
  }
  state.projectId = id;
  state.projectName = name || '';
  state.taskId = undefined;
  state.taskName = '';
  state.taskProjectName = name || '';
  const btn = document.getElementById('btnTask');
  if (btn) btn.disabled = true;
  const tasks = state.tasks.filter(t => String(getTaskProjectId(t)) === String(id));
  renderTasks(tasks);
}

function renderTasks(tasks) {
  const container = document.getElementById('taskContainer');
  if (!container) return;
  if (state.projectId === undefined) {
    container.innerHTML = '<p class="muted-text" style="font-size:12px;text-align:center;padding:16px 0">ابتدا یک پروژه انتخاب کن.</p>';
    return;
  }
  let html = '<div class="task-list">';
  tasks.forEach(t => {
    html += `<div class="task-item" id="task-${t.id}" onclick="selectTask(${t.id},${escapeAttr(JSON.stringify(t.name))},${escapeAttr(JSON.stringify(getTaskProjectName(t) || state.projectName || ''))})">
      <span>${escapeHtml(t.name)}</span><div class="check"></div>
    </div>`;
  });
  html += `<div class="no-task" id="task-null" onclick="selectTask(null,'بدون وظیفه',${escapeAttr(JSON.stringify(state.projectName || ''))})">
    <span>—</span><span>بدون وظیفه مشخص</span>
  </div>`;
  html += '</div>';
  html += `<button class="btn-add-task" onclick="openAppSettingsModal('tasks')">+ تنظیمات وظایف</button>`;
  container.innerHTML = html;
}

function selectTask(id, name, projectName='') {
  document.querySelectorAll('#taskContainer .task-item,#taskContainer .no-task').forEach(el => el.classList.remove('selected'));
  const selected = document.getElementById('task-'+id);
  if (selected) {
    selected.classList.add('selected');
    selected.classList.remove('tap-feedback');
    void selected.offsetWidth;
    selected.classList.add('tap-feedback');
  }
  state.taskId = id;
  state.taskName = name;
  state.taskProjectName = projectName || state.projectName || '';
  const btn = document.getElementById('btnTask');
  if (btn) btn.disabled = false;
}

function goToStep2() {
  if (state.projectId === undefined) { showToast('ابتدا یک پروژه انتخاب کنید', true); return; }
  if (state.taskId === undefined) { showToast('ابتدا یک وظیفه انتخاب کنید', true); return; }
  goToStep(2);
}

async function submitRecord() {
  const start = document.getElementById('startTimeVal').value;
  const end = document.getElementById('endTimeVal').value;
  const desc = document.getElementById('description').value.trim();
  if (state.projectId === undefined) { showToast('ابتدا یک پروژه انتخاب کنید', true); return; }
  if (state.taskId === undefined) { showToast('ابتدا یک وظیفه انتخاب کنید', true); return; }
  if (!start||!end) { showToast('زمان شروع و پایان را انتخاب کنید', true); return; }
  const hours = calcHours(start, end);
  if (hours <= 0) { showToast('زمان پایان باید بعد از شروع باشد', true); return; }

  const btn = document.getElementById('btnSubmit');
  btn.disabled = true; btn.textContent = 'در حال ذخیره...';
  const payload = {
    user_id: requireUserId(),
    work_date: state.date,
    start_time: start,
    end_time: end,
    hours,
    description: desc,
    project_id: state.projectId || null,
    task_id: state.taskId || null
  };
  try {
    let { error } = await db.from('work_records').insert(payload);
    if (error && isMissingProjectFeatureError(error)) {
      const { project_id, ...fallbackPayload } = payload;
      ({ error } = await db.from('work_records').insert(fallbackPayload));
    }
    if (error) throw error;
    document.getElementById('successMsg').textContent = `${state.date} — ${state.projectName || state.taskProjectName} — ${state.taskName}`;
    document.getElementById('summaryPill').textContent = `${start} → ${end} · ${formatHours(hours)}`;
    goToStep(3);
  } catch(e) {
    showToast('خطا: '+e.message, true);
  } finally {
    btn.disabled=false; btn.textContent='ثبت';
  }
}

function calcHours(s,e) {
  const [sh,sm]=s.split(':').map(Number), [eh,em]=e.split(':').map(Number);
  return Math.round(((eh*60+em)-(sh*60+sm))/60*100)/100;
}

function resetForm() {
  state = {date:'',projectId:undefined,projectName:'',taskId:undefined,taskName:'',taskProjectName:'',projects:[],tasks:[],editingProjectId:null,editingTaskId:null,editingRecordId:null,editingAdminUserId:null,passwordAdminUserId:null};
  buildDayDropdown(today.m, today.d);
  document.getElementById('month').value = today.m;
  document.getElementById('description').value = '';
  buildTimePicker('startTimePicker','startTimeVal', 8, '30');
  buildTimePicker('endTimePicker','endTimeVal', 17, '00');
  goToStep(0);
}

// ===================== مودال تنظیمات =====================
async function openTaskManagerModal() {
  return openAppSettingsModal('tasks');
}

function switchSettingsTab(tab='profile') {
  const tabs = ['profile','projects','tasks','salary'];
  const normalized = tabs.includes(tab) ? tab : 'profile';
  tabs.forEach(name => {
    const btn = document.getElementById('settingsTabBtn' + name.charAt(0).toUpperCase() + name.slice(1));
    const panel = document.getElementById('settingsPanel' + name.charAt(0).toUpperCase() + name.slice(1));
    const active = name === normalized;
    if (btn) {
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (panel) {
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    }
  });
}

function populateTaskProjectSelect(selectedId='') {
  const select = document.getElementById('taskProjectSelect');
  if (!select) return;
  select.innerHTML = state.projects.length
    ? state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">ابتدا پروژه بساز</option>';
  if (selectedId && Array.from(select.options).some(o => String(o.value) === String(selectedId))) select.value = selectedId;
}

async function openAppSettingsModal(focusSection='profile') {
  try {
    const userId = requireUserId();
    const [projects, tasks] = await Promise.all([
      fetchActiveProjectsForUser(userId),
      fetchActiveTasksForUser(userId)
    ]);
    state.projects = projects;
    state.tasks = tasks;
    renderProjectManagerList(state.projects);
    renderTaskManagerList(state.tasks);
    populateTaskProjectSelect();
    state.editingProjectId = null;
    state.editingTaskId = null;

    const projectInput = document.getElementById('newProjectInput');
    const taskInput = document.getElementById('newTaskInput');
    if (projectInput) projectInput.value = '';
    if (taskInput) taskInput.value = '';

    const title = document.getElementById('taskModalTitle');
    if (title) title.textContent = 'تنظیمات';
    const projectBtn = document.getElementById('btnSaveProject');
    if (projectBtn) projectBtn.textContent = 'افزودن پروژه';
    const taskBtn = document.getElementById('btnSaveTask');
    if (taskBtn) taskBtn.textContent = 'افزودن وظیفه';

    const fullNameInput = document.getElementById('settingsFullNameInput');
    const telegramInput = document.getElementById('settingsTelegramInput');
    const status = document.getElementById('telegramLinkStatus');
    if (fullNameInput) fullNameInput.value = currentUser?.full_name || '';
    if (telegramInput) telegramInput.value = normalizeTelegramUsername(currentUser?.telegram_username) || '';
    if (status) {
      status.textContent = currentUser?.telegram_chat_id
        ? 'بات تلگرام به این حساب وصل شده است.'
        : 'فعلاً فقط یوزرنیم ذخیره می‌شود؛ بعداً بات، chat_id را ثبت می‌کند.';
    }

    const rateInput = document.getElementById('hourlyRateInput');
    const coefInput = document.getElementById('overtimeCoefInput');
    const rateText = document.getElementById('salaryCurrentRate');
    if (rateInput) rateInput.value = HOURLY_RATE;
    if (coefInput) coefInput.value = OVERTIME_COEFFICIENT;
    if (rateText) rateText.textContent = Number(HOURLY_RATE || 0).toLocaleString('en-US');

    const tab = ['profile','projects','tasks','salary'].includes(focusSection) ? focusSection : 'profile';
    switchSettingsTab(tab);
    openAnimatedModal('taskModal');
    setTimeout(() => {
      if (tab === 'salary') rateInput?.focus();
      else if (tab === 'projects') projectInput?.focus();
      else if (tab === 'tasks') taskInput?.focus();
      else fullNameInput?.focus();
    }, 100);
  } catch(e) {
    showToast('خطا در بارگذاری تنظیمات: ' + e.message, true);
  }
}

function renderProjectManagerList(projects) {
  const list = document.getElementById('projectManagerList');
  if (!list) return;
  if (!projects.length) { list.innerHTML = '<p class="muted-text" style="font-size:12px">هنوز پروژه‌ای ثبت نشده.</p>'; return; }
  list.innerHTML = projects.map(p => `
    <div class="task-manager-row">
      <span>${escapeHtml(p.name)}</span>
      <div class="task-mini-actions">
        <button class="mini-btn" onclick="startEditProject(${escapeAttr(JSON.stringify(p.id))},${escapeAttr(JSON.stringify(p.name))})">ویرایش</button>
        <button class="mini-btn danger" onclick="deleteProject(${escapeAttr(JSON.stringify(p.id))})">حذف</button>
      </div>
    </div>
  `).join('');
}

function startEditProject(id, name) {
  state.editingProjectId = id;
  const input = document.getElementById('newProjectInput');
  if (input) input.value = name || '';
  const btn = document.getElementById('btnSaveProject');
  if (btn) btn.textContent = 'ذخیره تغییرات';
  switchSettingsTab('projects');
  input?.focus();
}

async function saveProject() {
  const input = document.getElementById('newProjectInput');
  const name = (input?.value || '').trim();
  if (!name) { showToast('نام پروژه را وارد کنید', true); shakeFields('newProjectInput'); return; }
  const btn = document.getElementById('btnSaveProject');
  if (btn) { btn.disabled = true; btn.textContent = 'در حال ذخیره...'; }
  const editingId = state.editingProjectId;
  try {
    if (editingId) {
      await updateProjectRecord(editingId, { name });
      const project = state.projects.find(p => String(p.id) === String(editingId));
      if (project) project.name = name;
      state.tasks.forEach(t => { if (String(t.project_id) === String(editingId)) t.project_name = name; });
      showToast('پروژه ویرایش شد');
    } else {
      const data = await insertProjectRecord({ user_id: requireUserId(), name, active: true });
      state.projects.push(data);
      showToast('پروژه افزوده شد');
    }
    state.editingProjectId = null;
    if (input) input.value = '';
    renderProjectManagerList(state.projects);
    populateTaskProjectSelect(editingId || state.projects.at(-1)?.id || '');
    if (document.getElementById('projectContainer')) renderProjects(state.projects);
  } catch(e) {
    showToast('خطا: '+e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = state.editingProjectId ? 'ذخیره تغییرات' : 'افزودن پروژه'; }
  }
}

async function deleteProject(id) {
  askConfirm('این پروژه و وظایف زیرمجموعه‌اش غیرفعال شوند؟', async () => {
    try {
      await deactivateProjectRecord(id);
      state.projects = state.projects.filter(p => String(p.id) !== String(id));
      state.tasks = state.tasks.filter(t => String(t.project_id) !== String(id));
      renderProjectManagerList(state.projects);
      renderTaskManagerList(state.tasks);
      populateTaskProjectSelect();
      if (document.getElementById('projectContainer')) {
        renderProjects(state.projects);
        const taskContainer = document.getElementById('taskContainer');
        if (taskContainer) taskContainer.innerHTML = '<p class="muted-text" style="font-size:12px;text-align:center;padding:16px 0">ابتدا یک پروژه انتخاب کن.</p>';
      }
      showToast('پروژه غیرفعال شد');
    } catch(e) { showToast('خطا: '+e.message, true); }
    finally { closeConfirmModal(); }
  });
}

function renderTaskManagerList(tasks) {
  const list = document.getElementById('taskManagerList');
  if (!list) return;
  if (!tasks.length) { list.innerHTML = '<p class="muted-text" style="font-size:12px">هنوز وظیفه‌ای ثبت نشده.</p>'; return; }
  list.innerHTML = tasks.map(t => `
    <div class="task-manager-row">
      <span>${escapeHtml(t.name)}${getTaskProjectName(t) ? ` · ${escapeHtml(getTaskProjectName(t))}` : ''}</span>
      <div class="task-mini-actions">
        <button class="mini-btn" onclick="startEditTask(${t.id},${escapeAttr(JSON.stringify(t.name))},${escapeAttr(JSON.stringify(getTaskProjectId(t) || ''))})">ویرایش</button>
        <button class="mini-btn danger" onclick="deleteTask(${t.id})">حذف</button>
      </div>
    </div>
  `).join('');
}

function startEditTask(id, name, projectId='') {
  state.editingTaskId = id;
  document.getElementById('newTaskInput').value = name;
  populateTaskProjectSelect(projectId || '');
  document.getElementById('taskModalTitle').textContent = 'ویرایش وظیفه';
  document.getElementById('btnSaveTask').textContent = 'ذخیره تغییرات';
  switchSettingsTab('tasks');
  document.getElementById('newTaskInput').focus();
}

function openSalaryModal() { openAppSettingsModal('salary'); }

function closeModal() {
  state.editingProjectId = null;
  state.editingTaskId = null;
  const title = document.getElementById('taskModalTitle');
  const projectBtn = document.getElementById('btnSaveProject');
  const taskBtn = document.getElementById('btnSaveTask');
  if (title) title.textContent = 'تنظیمات';
  if (projectBtn) projectBtn.textContent = 'افزودن پروژه';
  if (taskBtn) taskBtn.textContent = 'افزودن وظیفه';
  closeAnimatedModal('taskModal');
}

function closeSalaryModal() { closeModal(); }

function openUserSettingsModal() { return openAppSettingsModal('profile'); }

function closeUserSettingsModal() { closeModal(); }

async function saveUserSettings() {
  if (!currentUser?.id) return;
  const fullName = (document.getElementById('settingsFullNameInput')?.value || '').trim();
  const telegramUsername = normalizeTelegramUsername(document.getElementById('settingsTelegramInput')?.value || '');

  if (!isValidTelegramUsername(telegramUsername)) {
    showToast('یوزرنیم تلگرام معتبر نیست.', true);
    return;
  }

  const btn = document.getElementById('btnSaveUserSettings');
  if (btn) { btn.disabled = true; btn.textContent = 'در حال ذخیره...'; }

  try {
    const { data, error } = await db.from('wt_users')
      .update({
        full_name: fullName || currentUser.username,
        telegram_username: telegramUsername
      })
      .eq('id', requireUserId())
      .select('id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id, telegram_linked_at')
      .single();

    if (error) throw error;

    currentUser = data;
    HOURLY_RATE = Number(data.hourly_rate ?? DEFAULT_HOURLY_RATE);
    OVERTIME_COEFFICIENT = Number(data.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT);
    saveSession(currentUser);
    paintUserBadge();
    showToast('تنظیمات کاربر ذخیره شد');
  } catch(e) {
    showToast('خطا: ' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'ذخیره پروفایل'; }
  }
}

async function saveSalarySettings() {
  const rate = Number(toEnglishDigits(document.getElementById('hourlyRateInput').value || 0));
  const coef = Number(toEnglishDigits(document.getElementById('overtimeCoefInput').value || 1));
  if (rate < 0 || coef < 1) { showToast('مقادیر نامعتبر', true); shakeFields(rate < 0 ? 'hourlyRateInput' : null, coef < 1 ? 'overtimeCoefInput' : null); return; }
  try {
    const { error } = await db.from('wt_users')
      .update({ hourly_rate: rate, overtime_coefficient: coef })
      .eq('id', requireUserId());
    if (error) throw error;
    HOURLY_RATE = rate; OVERTIME_COEFFICIENT = coef;
    currentUser.hourly_rate = rate; currentUser.overtime_coefficient = coef;
    saveSession(currentUser);
    document.getElementById('salaryCurrentRate').textContent = Number(HOURLY_RATE || 0).toLocaleString('en-US');
    loadDashboard();
    if (document.getElementById('reportBody')) renderReportFromCache();
    showToast('تنظیمات حقوق ذخیره شد');
  } catch(e) {
    showToast('خطا: '+e.message, true);
  }
}

async function saveNewTask() {
  const name = document.getElementById('newTaskInput').value.trim();
  const projectSelect = document.getElementById('taskProjectSelect');
  const projectId = projectSelect?.value || '';
  const projectName = getSelectedProjectNameById(projectId);
  if (!projectId) { showToast('پروژه وظیفه را انتخاب کنید', true); shakeFields('taskProjectSelect'); return; }
  if (!name) { showToast('نام وظیفه را وارد کنید', true); shakeFields('newTaskInput'); return; }
  const btn = document.getElementById('btnSaveTask');
  const editingId = state.editingTaskId;
  const isEditing = Boolean(editingId);
  btn.disabled=true; btn.textContent='در حال ذخیره...';
  try {
    if (isEditing) {
      await updateTaskRecord(editingId, { name, project_id: projectId, project_name: projectName });
      const cur = state.tasks.find(t => String(t.id) === String(editingId));
      if (cur) { cur.name = name; cur.project_id = projectId; cur.project_name = projectName; cur.projects = { id: projectId, name: projectName }; }
      showToast('وظیفه ویرایش شد');
    } else {
      const data = await insertTaskRecord({ user_id: requireUserId(), name, project_id: projectId, project_name: projectName, active: true });
      state.tasks.push(data);
      showToast('وظیفه افزوده شد');
    }
    state.editingTaskId = null;
    document.getElementById('newTaskInput').value = '';
    renderTaskManagerList(state.tasks);
    if (document.getElementById('projectContainer')) {
      renderProjects(state.projects);
      if (state.projectId !== undefined) selectProject(state.projectId, state.projectName);
    }
    const createdOrEdited = isEditing ? state.tasks.find(t => String(t.id) === String(editingId)) : state.tasks[state.tasks.length-1];
    if (createdOrEdited && String(getTaskProjectId(createdOrEdited)) === String(state.projectId)) {
      selectTask(createdOrEdited.id, createdOrEdited.name, getTaskProjectName(createdOrEdited));
    }
  } catch(e) {
    showToast('خطا: '+e.message, true);
  } finally {
    btn.disabled=false; btn.textContent=state.editingTaskId?'ذخیره تغییرات':'افزودن وظیفه';
  }
}

function askConfirm(message, onConfirm) {
  confirmState = { open: true, message, onConfirm };
  document.getElementById('confirmText').textContent = message;
  openAnimatedModal('confirmModal');
}

function closeConfirmModal() {
  closeAnimatedModal('confirmModal');
  confirmState.open = false; confirmState.onConfirm = null;
}

async function deleteTask(id) {
  askConfirm('این وظیفه غیرفعال شود؟', async () => {
    try {
      const { error } = await db.from('tasks').update({ active: false }).eq('id', id).eq('user_id', requireUserId());
      if (error) throw error;
      state.tasks = state.tasks.filter(t => String(t.id) !== String(id));
      renderTaskManagerList(state.tasks);
      if (document.getElementById('projectContainer')) {
        renderProjects(state.projects);
        if (state.projectId !== undefined) selectProject(state.projectId, state.projectName);
      }
      showToast('وظیفه غیرفعال شد');
    } catch(e) { showToast('خطا: '+e.message, true); }
    finally { closeConfirmModal(); }
  });
}

async function openRecordEditor(id) {
  try {
    const record = reportRecordsCache.find(r => Number(r.id) === Number(id));
    if (!record) throw new Error('رکورد یافت نشد');
    if (!isCurrentUserAdmin() && !isOwnRecord(record)) {
      throw new Error('دسترسی به رکورد کاربران دیگر مجاز نیست.');
    }

    const taskOwnerId = isCurrentUserAdmin() ? record.user_id : requireUserId();
    const [projects, tasks] = await Promise.all([
      fetchActiveProjectsForUser(taskOwnerId),
      fetchActiveTasksForUser(taskOwnerId)
    ]);

    state.editingRecordId = id;
    document.getElementById('recordDateInput').value = record.work_date || '';
    document.getElementById('recordStartInput').value = String(record.start_time || '08:30').slice(0,5);
    document.getElementById('recordEndInput').value = String(record.end_time || '17:00').slice(0,5);
    document.getElementById('recordDescInput').value = record.description || '';

    const projectSelect = document.getElementById('recordProjectSelect');
    const taskSelect = document.getElementById('recordTaskSelect');
    const recordProjectId = record.project_id || record.projects?.id || record.tasks?.project_id || record.tasks?.projects?.id || '';

    const renderRecordTaskOptions = (projectId, selectedTaskId='') => {
      const filteredTasks = projectId ? tasks.filter(t => String(getTaskProjectId(t)) === String(projectId)) : tasks;
      taskSelect.innerHTML = '<option value="">بدون وظیفه</option>' + filteredTasks.map(t => `<option value="${t.id}" ${String(t.id)===String(selectedTaskId)?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
    };

    if (projectSelect) {
      projectSelect.innerHTML = '<option value="">بدون پروژه</option>' + projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      if (recordProjectId && Array.from(projectSelect.options).some(o => String(o.value) === String(recordProjectId))) projectSelect.value = recordProjectId;
      projectSelect.onchange = () => renderRecordTaskOptions(projectSelect.value, '');
      renderRecordTaskOptions(projectSelect.value, record.task_id || '');
    } else {
      renderRecordTaskOptions('', record.task_id || '');
    }

    openAnimatedModal('recordModal');
  } catch(e) { showToast('خطا: '+e.message, true); }
}

async function saveRecordEdit() {
  const date = toEnglishDigits(document.getElementById('recordDateInput').value.trim());
  const start = document.getElementById('recordStartInput').value;
  const end = document.getElementById('recordEndInput').value;
  const desc = document.getElementById('recordDescInput').value.trim();
  const projectId = document.getElementById('recordProjectSelect')?.value || null;
  const taskId = document.getElementById('recordTaskSelect').value || null;
  if (!date||!start||!end) { showToast('تاریخ و زمان را پر کنید', true); shakeFields(!date ? 'recordDateInput' : null, !start ? 'recordStartInput' : null, !end ? 'recordEndInput' : null); return; }
  const hours = calcHours(start, end);
  if (hours <= 0) { showToast('زمان پایان باید بعد از شروع باشد', true); return; }
  const payload = { work_date: date, start_time: start, end_time: end, hours, description: desc, project_id: projectId, task_id: taskId };
  try {
    let q = db.from('work_records').update(payload).eq('id', state.editingRecordId);
    if (!isCurrentUserAdmin()) q = q.eq('user_id', requireUserId());
    let { error } = await q;
    if (error && isMissingProjectFeatureError(error)) {
      const { project_id, ...fallbackPayload } = payload;
      q = db.from('work_records').update(fallbackPayload).eq('id', state.editingRecordId);
      if (!isCurrentUserAdmin()) q = q.eq('user_id', requireUserId());
      ({ error } = await q);
    }
    if (error) throw error;
    highlightedRecordId = state.editingRecordId;
    closeRecordModal(); await loadReports(); await loadDashboard();
    showToast('رکورد ویرایش شد');
  } catch(e) { showToast('خطا: '+e.message, true); }
}

async function deleteRecord(id) {
  askConfirm('این رکورد حذف شود؟', async () => {
    try {
      pulseReportRow(id, 'row-danger-pulse');
      if (!prefersReducedMotion()) await wait(220);
      let q = db.from('work_records').delete().eq('id', id);
      if (!isCurrentUserAdmin()) q = q.eq('user_id', requireUserId());
      const { error } = await q;
      if (error) throw error;
      await loadReports(); await loadDashboard();
      showToast('رکورد حذف شد');
    } catch(e) { showToast('خطا: '+e.message, true); }
    finally { closeConfirmModal(); }
  });
}

function closeRecordModal() {
  state.editingRecordId = null;
  closeAnimatedModal('recordModal');
}

function confirmYes() { if (confirmState.onConfirm) confirmState.onConfirm(); }
function confirmNo() { closeConfirmModal(); }

// ===================== پنل ادمین =====================
async function initAdminPage() {
  await loadAdminUsers();
}

async function loadAdminUsers() {
  const body = document.getElementById('adminUsersBody');
  if (!body) return;
  body.innerHTML = renderSkeletonRows(4, 8);
  try {
    const { data, error } = await db.from('wt_users')
      .select('id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id, telegram_linked_at, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    adminUsersCache = data || [];
    renderAdminUsers();
  } catch(e) {
    body.innerHTML = `<tr><td colspan="8" class="error-msg">خطا: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderAdminUsers() {
  const body = document.getElementById('adminUsersBody');
  if (!body) return;
  if (!adminUsersCache.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-state">هنوز کاربری ثبت نشده است.</td></tr>';
    return;
  }
  body.innerHTML = adminUsersCache.map((u, i) => `
    <tr class="row-enter" style="--row-i:${Math.min(i, 12)}">
      <td style="font-family:var(--font)">${escapeHtml(u.full_name || u.username)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.role === 'admin' ? 'ادمین' : 'کاربر'}</td>
      <td>${u.active ? 'فعال' : 'غیرفعال'}</td>
      <td>${formatMoney(u.hourly_rate ?? DEFAULT_HOURLY_RATE)}</td>
      <td>${Number(u.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT).toFixed(1)}x</td>
      <td>${escapeHtml(formatTelegramUsername(u.telegram_username))}</td>
      <td>
        <div class="table-actions" style="justify-content:center">
          <button class="mini-btn" onclick="changeUserPassword('${u.id}', ${escapeAttr(JSON.stringify(u.full_name || u.username))})">رمز</button>
          <button class="mini-btn" onclick="editUser('${u.id}')">ویرایش</button>
          <button class="mini-btn danger" onclick="toggleUserActive('${u.id}', ${!u.active})">${u.active ? 'غیرفعال' : 'فعال'}</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function createAdminUser() {
  const username = document.getElementById('newUserUsername').value.trim();
  const fullName = document.getElementById('newUserFullName').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;
  const telegramUsername = normalizeTelegramUsername(document.getElementById('newUserTelegram')?.value || '');
  const hourlyRate = Number(toEnglishDigits(document.getElementById('newUserHourlyRate').value || DEFAULT_HOURLY_RATE));
  const overtimeCoef = Number(toEnglishDigits(document.getElementById('newUserOvertimeCoef').value || DEFAULT_OVERTIME_COEFFICIENT));

  if (!username || !password) {
    showToast('نام کاربری و رمز عبور الزامی است.', true);
    shakeFields(!username ? 'newUserUsername' : null, !password ? 'newUserPassword' : null);
    return;
  }
  if (!isValidPassword(password)) {
    showToast('رمز عبور را وارد کنید.', true);
    shakeFields('newUserPassword');
    return;
  }
  if (!isValidTelegramUsername(telegramUsername)) {
    showToast('یوزرنیم تلگرام معتبر نیست.', true); return;
  }

  try {
    const { error } = await db.from('wt_users').insert({
      username, password, full_name: fullName, role, active: true,
      hourly_rate: hourlyRate, overtime_coefficient: overtimeCoef, telegram_username: telegramUsername
    });
    if (error) throw error;
    document.getElementById('newUserUsername').value = '';
    document.getElementById('newUserFullName').value = '';
    document.getElementById('newUserPassword').value = '';
    const newUserTelegram = document.getElementById('newUserTelegram');
    if (newUserTelegram) newUserTelegram.value = '';
    showToast('کاربر ساخته شد');
    await loadAdminUsers();
  } catch(e) {
    showToast('خطا: ' + e.message, true);
  }
}

function changeUserPassword(userId, displayName='') {
  state.passwordAdminUserId = userId;
  const title = document.getElementById('adminPasswordUserName');
  const pass = document.getElementById('adminPasswordInput');
  const pass2 = document.getElementById('adminPasswordRepeatInput');
  if (title) title.textContent = displayName || 'کاربر';
  if (pass) pass.value = '';
  if (pass2) pass2.value = '';
  openAnimatedModal('adminPasswordModal');
  setTimeout(() => pass?.focus(), 100);
}

function closeAdminPasswordModal() {
  state.passwordAdminUserId = null;
  closeAnimatedModal('adminPasswordModal');
}

async function saveAdminPassword() {
  const userId = state.passwordAdminUserId;
  const password = document.getElementById('adminPasswordInput')?.value || '';
  const repeat = document.getElementById('adminPasswordRepeatInput')?.value || '';
  if (!userId) return;
  if (!password) { showToast('رمز عبور را وارد کنید.', true); shakeFields('adminPasswordInput'); return; }
  if (!isValidPassword(password)) { showToast('رمز عبور را وارد کنید.', true); shakeFields('adminPasswordInput'); return; }
  if (password !== repeat) { showToast('تکرار رمز عبور درست نیست.', true); shakeFields('adminPasswordRepeatInput'); return; }
  try {
    const { error } = await db.from('wt_users').update({ password }).eq('id', userId);
    if (error) throw error;
    closeAdminPasswordModal();
    showToast('رمز عبور تغییر کرد');
  } catch(e) { showToast('خطا: ' + e.message, true); }
}

async function toggleUserActive(userId, active) {
  const user = adminUsersCache.find(u => u.id === userId);
  askConfirm(`${active ? 'فعال' : 'غیرفعال'} کردن ${user?.full_name || user?.username}؟`, async () => {
    try {
      const { error } = await db.from('wt_users').update({ active }).eq('id', userId);
      if (error) throw error;
      closeConfirmModal();
      showToast('وضعیت کاربر تغییر کرد');
      await loadAdminUsers();
    } catch(e) {
      closeConfirmModal();
      showToast('خطا: ' + e.message, true);
    }
  });
}

function editUser(userId) {
  const user = adminUsersCache.find(u => u.id === userId);
  if (!user) return;
  state.editingAdminUserId = userId;
  document.getElementById('adminEditFullName').value = user.full_name || '';
  document.getElementById('adminEditUsername').value = user.username || '';
  document.getElementById('adminEditRole').value = ['admin','user'].includes(user.role) ? user.role : 'user';
  document.getElementById('adminEditHourlyRate').value = user.hourly_rate ?? DEFAULT_HOURLY_RATE;
  document.getElementById('adminEditOvertimeCoef').value = user.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT;
  document.getElementById('adminEditTelegram').value = normalizeTelegramUsername(user.telegram_username) || '';
  openAnimatedModal('adminEditUserModal');
  setTimeout(() => document.getElementById('adminEditFullName')?.focus(), 100);
}

function closeAdminEditUserModal() {
  state.editingAdminUserId = null;
  closeAnimatedModal('adminEditUserModal');
}

async function saveAdminUserEdit() {
  const userId = state.editingAdminUserId;
  if (!userId) return;
  const fullName = document.getElementById('adminEditFullName').value.trim();
  const username = document.getElementById('adminEditUsername').value.trim();
  const role = document.getElementById('adminEditRole').value;
  const hourlyRate = Number(toEnglishDigits(document.getElementById('adminEditHourlyRate').value || DEFAULT_HOURLY_RATE));
  const overtimeCoef = Number(toEnglishDigits(document.getElementById('adminEditOvertimeCoef').value || DEFAULT_OVERTIME_COEFFICIENT));
  const telegramUsername = normalizeTelegramUsername(document.getElementById('adminEditTelegram').value || '');

  if (!username) { showToast('نام کاربری الزامی است.', true); shakeFields('adminEditUsername'); return; }
  if (!['admin','user'].includes(role)) { showToast('نقش نامعتبر است.', true); shakeFields('adminEditRole'); return; }
  if (hourlyRate < 0 || overtimeCoef < 1) { showToast('نرخ یا ضریب نامعتبر است.', true); shakeFields(hourlyRate < 0 ? 'adminEditHourlyRate' : null, overtimeCoef < 1 ? 'adminEditOvertimeCoef' : null); return; }
  if (!isValidTelegramUsername(telegramUsername)) { showToast('یوزرنیم تلگرام معتبر نیست.', true); shakeFields('adminEditTelegram'); return; }

  try {
    const { error } = await db.from('wt_users').update({ username, full_name: fullName, role, hourly_rate: hourlyRate, overtime_coefficient: overtimeCoef, telegram_username: telegramUsername }).eq('id', userId);
    if (error) throw error;
    closeAdminEditUserModal();
    showToast('کاربر ویرایش شد');
    await loadAdminUsers();
  } catch(e) { showToast('خطا: ' + e.message, true); }
}

// ===================== رویدادها =====================
document.addEventListener('click', e => {
  if (e.target.id === 'signupModal') closeSignupModal();
  if (e.target.id === 'taskModal') closeModal();
  if (e.target.id === 'salaryModal') closeSalaryModal();
  if (e.target.id === 'userSettingsModal') closeUserSettingsModal();
  if (e.target.id === 'adminEditUserModal') closeAdminEditUserModal();
  if (e.target.id === 'adminPasswordModal') closeAdminPasswordModal();
  if (e.target.id === 'recordModal') closeRecordModal();
  if (e.target.id === 'confirmModal') closeConfirmModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSignupModal(); closeModal(); closeSalaryModal(); closeAdminEditUserModal(); closeAdminPasswordModal(); closeRecordModal(); closeConfirmModal(); }
  if (e.key === 'Enter' && document.getElementById('passwordGate')?.style.display !== 'none') {
    if (document.getElementById('signupModal')?.classList.contains('open')) {
      e.preventDefault();
      registerUser();
    } else {
      checkPassword();
    }
  }
});

function showToast(msg, isError=false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = toPersianDigits(msg);
  t.className = 'toast'+(isError?' error':'');
  void t.offsetWidth;
  t.className = 'toast'+(isError?' error':'')+' show';
  clearTimeout(t._toastTimer);
  t._toastTimer = setTimeout(()=>{ t.className='toast'+(isError?' error':''); }, 3000);
}

window.addEventListener('storage', e => {
  if (e.key === SESSION_KEY || e.key === SESSION_SYNC_KEY || e.key === LEGACY_SESSION_KEY) {
    syncCurrentUserFromStorage();
  }
});

window.addEventListener('pageshow', e => {
  // وقتی مرورگر صفحه report/admin را از back-forward cache برمی‌گرداند، user قدیمی نباید بماند.
  if (e.persisted) syncCurrentUserFromStorage();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncCurrentUserFromStorage();
});

window.addEventListener('focus', () => {
  const savedId = getSavedSessionUserId();
  const currentId = currentUser?.id ? String(currentUser.id) : null;
  if (savedId !== currentId) syncCurrentUserFromStorage();
});

window.addEventListener('DOMContentLoaded', async () => {
  startPersianDigitObserver();
  setupPasswordInputs();

  // صفحه گزارش برای همه بدون ورود در دسترس است؛ از چرخه لاگین رد می‌شویم.
  if (isReportPage()) {
    await initReportPage();
    return;
  }

  const expiredFlag = readStorage(SESSION_EXPIRED_FLAG);
  removeStorage(SESSION_EXPIRED_FLAG);

  const saved = loadSession();
  if (saved) {
    currentUser = saved;
    HOURLY_RATE = Number(saved.hourly_rate ?? DEFAULT_HOURLY_RATE);
    OVERTIME_COEFFICIENT = Number(saved.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT);

    // صفحه را با همان یوزر ذخیره‌شده فوراً باز کن؛ report/admin دوباره رمز نمی‌خواهند.
    await enterApp();

    // فقط در پس‌زمینه چک کن کاربر هنوز active باشد و نرخ‌ها به‌روز شوند.
    try {
      const { data } = await db
        .from('wt_users')
        .select('id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id, telegram_linked_at')
        .eq('id', saved.id)
        .single();

      if (!data || !data.active) {
        clearSession();
        redirectToLogin(false);
        return;
      }

      currentUser = data;
      HOURLY_RATE = Number(data.hourly_rate ?? DEFAULT_HOURLY_RATE);
      OVERTIME_COEFFICIENT = Number(data.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT);
      saveSession(currentUser);
      paintUserBadge();
    } catch {
      // اگر دیتابیس لحظه‌ای جواب نداد، session معتبر محلی را نگه می‌داریم.
    }
    return;
  }

  // اگر توی report/admin مستقیم وارد شد و session ندارد، فرم رمز همان‌جا نمایش داده نشود؛ برگردد صفحه اصلی.
  if (!isHomePage()) {
    redirectToLogin(sessionExpiredOnLoad);
    return;
  }

  if (sessionExpiredOnLoad || expiredFlag === '1') {
    setGateError('ورود شما منقضی شد. دوباره وارد شوید.');
  }
  const gate = document.getElementById('passwordGate');
  if (gate) gate.style.display = 'flex';
  setTimeout(() => document.getElementById('loginInput')?.focus(), 100);
});
