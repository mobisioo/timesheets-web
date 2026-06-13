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

const HOLIDAY_DATES = new Set([
  '1405-01-01','1405-01-02','1405-01-03','1405-01-04','1405-01-13'
]);

const JALALI_MONTHS = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];

let currentUser = null; // { id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id }
let HOURLY_RATE = DEFAULT_HOURLY_RATE;
let OVERTIME_COEFFICIENT = DEFAULT_OVERTIME_COEFFICIENT;
let reportRecordsCache = [];
let adminUsersCache = [];
let state = { date: '', taskId: undefined, taskName: '', tasks: [], editingTaskId: null, editingRecordId: null };
let confirmState = { open: false, message: '', onConfirm: null };

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
  if (expired) writeStorage(SESSION_EXPIRED_FLAG, '1');
  window.location.href = 'index.html';
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
    return;
  }
  if (gateBtn) { gateBtn.disabled = true; gateBtn.textContent = '...'; }
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
    if (gateBtn) { gateBtn.disabled = false; gateBtn.textContent = '→'; }
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
  ['passwordInput', 'signupPassword', 'signupPassword2', 'newUserPassword'].forEach(id => {
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
  if (modal) { modal.style.zIndex = '1100'; modal.classList.add('open'); }
  setTimeout(() => document.getElementById('signupUsername')?.focus(), 100);
}

function closeSignupModal() {
  const modal = document.getElementById('signupModal');
  if (modal) modal.classList.remove('open');
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

  if (!username || !password) { setSignupError('نام کاربری و رمز عبور الزامی است.'); return; }
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) { setSignupError('نام کاربری باید ۳ تا ۴۰ کاراکتر انگلیسی، عدد، نقطه، خط تیره یا آندرلاین باشد.'); return; }
  if (!isValidPassword(password)) { setSignupError('رمز عبور را وارد کنید.'); return; }
  if (password !== password2) { setSignupError('تکرار رمز عبور درست نیست.'); return; }
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
  window.location.href = 'index.html';
}

async function enterApp() {
  document.getElementById('passwordGate').style.display = 'none';
  document.getElementById('appRoot').style.display = 'block';
  paintUserBadge();

  const isAdminPage = Boolean(document.getElementById('adminUsersBody'));
  if (isAdminPage && !isCurrentUserAdmin()) {
    showToast('دسترسی به پنل ادمین مجاز نیست.', true);
    setTimeout(() => { window.location.href = 'index.html'; }, 700);
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
    window.location.href = 'index.html';
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
  el.textContent = `${name} · ${isCurrentUserAdmin() ? 'ادمین' : 'یوزر'}`;
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
  const m = String(value || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
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
  if (mm === 0) return `${hh} ساعت `;
  return `${hh}:${String(mm).padStart(2,'0')} ساعت `;
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString('en-US') + ' ت';
}

// ===================== داشبورد =====================
async function loadDashboard() {
  const dashTotal = document.getElementById('dashTotal');
  const dashMonth = document.getElementById('dashMonth');
  const dashSalary = document.getElementById('dashSalary');
  const dashError = document.getElementById('dashError');
  if (!dashTotal || !dashMonth || !dashSalary) return;

  try {
    let q = db.from('work_records').select('hours, work_date, user_id');
    if (!isCurrentUserAdmin()) q = q.eq('user_id', requireUserId());
    const { data: records, error } = await q;
    if (error) throw error;

    const totalHours = records.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);
    const currentMonthStr = `${today.y}-${String(today.m).padStart(2,'0')}`;
    const monthRecords = records.filter(r => r.work_date && r.work_date.startsWith(currentMonthStr));
    const monthHours = monthRecords.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);
    const salaryInfo = calculateMonthlySalary(monthHours, today.y, today.m);

    dashTotal.textContent = formatHours(totalHours);
    dashMonth.textContent = formatHours(monthHours);
    dashSalary.textContent = isCurrentUserAdmin() ? 'گزارش کلی' : formatMoney(salaryInfo.salary);
  } catch(e) {
    dashTotal.textContent = '—';
    dashMonth.textContent = '—';
    dashSalary.textContent = '—';
    if (dashError) { dashError.style.display = 'block'; dashError.textContent = 'خطا در بارگذاری اطلاعات: ' + e.message; }
  }
}

function getMonthlyWorkingThreshold(jy, jm) {
  const monthDays = jalaliMonthDays(jy, jm);
  const weekendDays = Math.floor(monthDays / 7) * 2 + Math.min(2, monthDays % 7);
  const holidayDays = Array.from({ length: monthDays }, (_, i) => `${jy}-${String(jm).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`)
    .filter(date => HOLIDAY_DATES.has(date)).length;
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
  if (!wrap || !select || !isCurrentUserAdmin()) return;

  wrap.style.display = 'flex';
  const { data, error } = await db.from('wt_users').select('id, username, full_name, role').eq('active', true).order('username');
  if (error) throw error;
  select.innerHTML = '<option value="all">همه کاربران</option>' + data.map(u => `<option value="${u.id}">${escapeHtml(u.full_name || u.username)}</option>`).join('');
}

async function loadReports() {
  const reportBody = document.getElementById('reportBody');
  if (!reportBody) return;
  reportBody.innerHTML = '<tr><td colspan="8" class="loading">در حال بارگذاری...</td></tr>';

  try {
    let q = db
      .from('work_records')
      .select('id, user_id, work_date, start_time, end_time, hours, description, task_id, tasks(id, name)')
      .order('work_date', { ascending: false });

    const selectedUser = document.getElementById('userFilter')?.value || 'all';
    const currentUserId = requireUserId();

    // قانون اصلی گزارش:
    // ادمین همه رکوردها را می‌بیند، کاربر عادی فقط رکوردهای خودش را.
    if (!isCurrentUserAdmin()) {
      q = q.eq('user_id', currentUserId);
    } else if (selectedUser !== 'all') {
      q = q.eq('user_id', selectedUser);
    }

    const { data, error } = await q;
    if (error) throw error;

    // گارد دوم سمت کلاینت: حتی اگر query اشتباهی تغییر کند، یوزر عادی فقط دیتای خودش را می‌بیند.
    const safeRecords = isCurrentUserAdmin()
      ? (data || [])
      : (data || []).filter(r => String(r.user_id) === currentUserId);

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
    reportBody.innerHTML = `<tr><td colspan="8" class="error-msg">خطا در بارگذاری گزارش‌ها: ${escapeHtml(e.message)}</td></tr>`;
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
    <div class="report-chip">حقوق تخمینی: <strong>${isCurrentUserAdmin() ? 'بر اساس نرخ حساب فعلی' : formatMoney(totalSalaryInfo.salary)}</strong></div>
    <div class="report-chip">ضریب اضافه‌کاری: <strong>${OVERTIME_COEFFICIENT.toFixed(1)}x</strong></div>
  `;

  if (!rows.length) {
    reportBody.innerHTML = '<tr><td colspan="8" class="empty-state">رکوردی برای فیلترهای انتخاب‌شده یافت نشد.</td></tr>';
    return;
  }

  reportBody.innerHTML = rows.map(r => `
    <tr>
      <td style="font-family:var(--font)">${escapeHtml(r.user)}</td>
      <td>${escapeHtml(r.date)}</td>
      <td style="font-family:var(--font)">${escapeHtml(r.task)}</td>
      <td>${formatHours(r.hours)}</td>
      <td>${escapeHtml(r.start)}</td>
      <td>${escapeHtml(r.end)}</td>
      <td style="font-family:var(--font);font-size:11px">${escapeHtml(r.desc)}</td>
      <td>
        <div class="table-actions" style="justify-content:center">
          <button class="mini-btn" onclick="openRecordEditor(${r.id})">ویرایش</button>
          <button class="mini-btn danger" onclick="deleteRecord(${r.id})">حذف</button>
        </div>
      </td>
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
  const rows = applyReportFilters(reportRecordsCache);
  return isCurrentUserAdmin()
    ? rows
    : rows.filter(r => String(r.user_id || '') === requireUserId());
}

function getRecordTaskName(record) {
  return record?.tasks?.name || record?.task_name || '';
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
    const wb = window.XLSX.utils.book_new();
    const ws = {};
    window.XLSX.utils.book_append_sheet(wb, ws, 'test');
    return wb;
  }
}

function getOdooProjectNameFromTemplate(workbook) {
  const sheetName = workbook.SheetNames?.[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  const value = sheet?.B1?.v;
  return String(value || ODOO_DEFAULT_PROJECT_NAME).trim() || ODOO_DEFAULT_PROJECT_NAME;
}

function buildOdooWorksheet(records, projectName) {
  const XLSX = window.XLSX;
  const ws = {};
  const range = { s: { r: 0, c: 0 }, e: { r: Math.max(records.length - 1, 0), c: 4 } };

  records.forEach((record, index) => {
    const gregorianDate = jalaliDateToGregorianDate(record.work_date);
    if (!gregorianDate) {
      throw new Error(`تاریخ ${record.work_date || 'نامشخص'} قابل تبدیل به میلادی نیست.`);
    }

    const values = [
      { t: 'd', v: gregorianDate, z: 'yyyy-mm-dd' },
      { t: 's', v: projectName },
      { t: 's', v: getRecordTaskName(record) },
      { t: 's', v: record.description || '' },
      { t: 'n', v: getOdooDecimalHours(record.hours), z: '0.##' }
    ];

    values.forEach((cell, col) => {
      ws[XLSX.utils.encode_cell({ r: index, c: col })] = cell;
    });
  });

  ws['!ref'] = XLSX.utils.encode_range(range);
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
    if (!currentUser) {
      const saved = loadSession();
      if (saved) currentUser = saved;
      else { redirectToLogin(false); return; }
    }

    const records = getOdooExportRows();
    if (!records.length) {
      showToast('رکوردی برای خروجی Odoo وجود ندارد', true);
      return;
    }

    const workbook = await loadOdooTemplateWorkbook();
    const sheetName = workbook.SheetNames?.[0] || 'test';
    const projectName = getOdooProjectNameFromTemplate(workbook);
    workbook.Sheets[sheetName] = buildOdooWorksheet(records, projectName);
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
  document.querySelectorAll('#formFlow .step').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('step'+n);
  el.classList.add('active');
  el.style.animation='none'; void el.offsetHeight; el.style.animation='';
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
  goToStep(1);
  loadTasks();
}

async function loadTasks() {
  const container = document.getElementById('taskContainer');
  container.innerHTML = '<div class="loading"><div class="spinner"></div> در حال بارگذاری...</div>';
  try {
    const { data: tasks, error } = await db
      .from('tasks')
      .select('id,name')
      .eq('user_id', requireUserId())
      .eq('active', true)
      .order('id', { ascending: true });
    if (error) throw error;
    state.tasks = tasks || [];
    renderTasks(state.tasks);
  } catch(e) {
    container.innerHTML = `<p class="error-msg">خطا: ${escapeHtml(e.message)}</p>`;
  }
}

function renderTasks(tasks) {
  const container = document.getElementById('taskContainer');
  let html = '<div class="task-list">';
  tasks.forEach(t => {
    html += `<div class="task-item" id="task-${t.id}" onclick="selectTask(${t.id},'${escapeAttr(t.name)}')">
      <span>${escapeHtml(t.name)}</span><div class="check"></div>
    </div>`;
  });
  html += `<div class="no-task" id="task-null" onclick="selectTask(null,'بدون وظیفه')">
    <span>—</span><span>بدون وظیفه مشخص</span>
  </div>`;
  html += '</div>';
  html += `<button class="btn-add-task" onclick="openTaskManagerModal()">+ مدیریت وظایف</button>`;
  container.innerHTML = html;
}

function selectTask(id, name) {
  document.querySelectorAll('.task-item,.no-task').forEach(el => el.classList.remove('selected'));
  document.getElementById('task-'+id)?.classList.add('selected');
  state.taskId = id; state.taskName = name;
  document.getElementById('btnTask').disabled = false;
}

function goToStep2() {
  if (state.taskId === undefined) { showToast('ابتدا یک وظیفه انتخاب کنید', true); return; }
  goToStep(2);
}

async function submitRecord() {
  const start = document.getElementById('startTimeVal').value;
  const end = document.getElementById('endTimeVal').value;
  const desc = document.getElementById('description').value.trim();
  if (!start||!end) { showToast('زمان شروع و پایان را انتخاب کنید', true); return; }
  const hours = calcHours(start, end);
  if (hours <= 0) { showToast('زمان پایان باید بعد از شروع باشد', true); return; }

  const btn = document.getElementById('btnSubmit');
  btn.disabled = true; btn.textContent = 'در حال ذخیره...';
  try {
    const { error } = await db.from('work_records').insert({
      user_id: requireUserId(),
      work_date: state.date,
      start_time: start,
      end_time: end,
      hours,
      description: desc,
      task_id: state.taskId || null
    });
    if (error) throw error;
    document.getElementById('successMsg').textContent = `${state.date} — ${state.taskName}`;
    document.getElementById('summaryPill').textContent = `${start} → ${end} · ${hours}h`;
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
  state = {date:'',taskId:undefined,taskName:'',tasks:[]};
  buildDayDropdown(today.m, today.d);
  document.getElementById('month').value = today.m;
  document.getElementById('description').value = '';
  buildTimePicker('startTimePicker','startTimeVal', 8, '30');
  buildTimePicker('endTimePicker','endTimeVal', 17, '00');
  goToStep(0);
}

// ===================== مودال وظایف =====================
async function openTaskManagerModal() {
  try {
    const { data: tasks, error } = await db
      .from('tasks').select('id,name').eq('user_id', requireUserId()).eq('active', true).order('id', { ascending: true });
    if (error) throw error;
    state.tasks = tasks || [];
    renderTaskManagerList(state.tasks);
    state.editingTaskId = null;
    document.getElementById('newTaskInput').value = '';
    document.getElementById('taskModalTitle').textContent = 'مدیریت وظایف';
    document.getElementById('btnSaveTask').textContent = 'افزودن وظیفه';
    document.getElementById('taskModal').classList.add('open');
    setTimeout(()=>document.getElementById('newTaskInput').focus(),100);
  } catch(e) {
    showToast('خطا در بارگذاری وظایف: ' + e.message, true);
  }
}

function renderTaskManagerList(tasks) {
  const list = document.getElementById('taskManagerList');
  if (!list) return;
  if (!tasks.length) { list.innerHTML = '<p class="muted-text" style="font-size:12px">هنوز وظیفه‌ای ثبت نشده.</p>'; return; }
  list.innerHTML = tasks.map(t => `
    <div class="task-manager-row">
      <span>${escapeHtml(t.name)}</span>
      <div class="task-mini-actions">
        <button class="mini-btn" onclick="startEditTask(${t.id},'${escapeAttr(t.name)}')">ویرایش</button>
        <button class="mini-btn danger" onclick="deleteTask(${t.id})">حذف</button>
      </div>
    </div>
  `).join('');
}

function startEditTask(id, name) {
  state.editingTaskId = id;
  document.getElementById('newTaskInput').value = name;
  document.getElementById('taskModalTitle').textContent = 'ویرایش وظیفه';
  document.getElementById('btnSaveTask').textContent = 'ذخیره تغییرات';
  document.getElementById('newTaskInput').focus();
}

function openSalaryModal() {
  document.getElementById('hourlyRateInput').value = HOURLY_RATE;
  document.getElementById('overtimeCoefInput').value = OVERTIME_COEFFICIENT;
  document.getElementById('salaryCurrentRate').textContent = HOURLY_RATE.toLocaleString('en-US');
  document.getElementById('salaryModal').classList.add('open');
}

function closeModal() {
  state.editingTaskId = null;
  document.getElementById('taskModalTitle').textContent = 'مدیریت وظایف';
  document.getElementById('btnSaveTask').textContent = 'افزودن وظیفه';
  document.getElementById('taskModal').classList.remove('open');
}

function closeSalaryModal() { document.getElementById('salaryModal').classList.remove('open'); }

function openUserSettingsModal() {
  if (!currentUser) return;
  const fullNameInput = document.getElementById('settingsFullNameInput');
  const telegramInput = document.getElementById('settingsTelegramInput');
  const status = document.getElementById('telegramLinkStatus');

  if (fullNameInput) fullNameInput.value = currentUser.full_name || '';
  if (telegramInput) telegramInput.value = normalizeTelegramUsername(currentUser.telegram_username) || '';
  if (status) {
    status.textContent = currentUser.telegram_chat_id
      ? 'بات تلگرام به این حساب وصل شده است.'
      : 'فعلاً فقط یوزرنیم ذخیره می‌شود؛ بعداً بات، chat_id را ثبت می‌کند.';
  }
  document.getElementById('userSettingsModal')?.classList.add('open');
}

function closeUserSettingsModal() {
  document.getElementById('userSettingsModal')?.classList.remove('open');
}

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
    closeUserSettingsModal();
    showToast('تنظیمات کاربر ذخیره شد');
  } catch(e) {
    showToast('خطا: ' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'ذخیره'; }
  }
}

async function saveSalarySettings() {
  const rate = Number(document.getElementById('hourlyRateInput').value || 0);
  const coef = Number(document.getElementById('overtimeCoefInput').value || 1);
  if (rate < 0 || coef < 1) { showToast('مقادیر نامعتبر', true); return; }
  try {
    const { error } = await db.from('wt_users')
      .update({ hourly_rate: rate, overtime_coefficient: coef })
      .eq('id', requireUserId());
    if (error) throw error;
    HOURLY_RATE = rate; OVERTIME_COEFFICIENT = coef;
    currentUser.hourly_rate = rate; currentUser.overtime_coefficient = coef;
    saveSession(currentUser);
    document.getElementById('salaryCurrentRate').textContent = HOURLY_RATE.toLocaleString('en-US');
    closeSalaryModal();
    loadDashboard();
    if (document.getElementById('reportBody')) renderReportFromCache();
    showToast('تنظیمات حقوق ذخیره شد');
  } catch(e) {
    showToast('خطا: '+e.message, true);
  }
}

async function saveNewTask() {
  const name = document.getElementById('newTaskInput').value.trim();
  if (!name) { showToast('نام وظیفه را وارد کنید', true); return; }
  const btn = document.getElementById('btnSaveTask');
  const editingId = state.editingTaskId;
  const isEditing = Boolean(editingId);
  btn.disabled=true; btn.textContent='در حال ذخیره...';
  try {
    if (isEditing) {
      const { error } = await db.from('tasks').update({ name }).eq('id', editingId);
      if (error) throw error;
      const cur = state.tasks.find(t => t.id === editingId);
      if (cur) cur.name = name;
      showToast('وظیفه ویرایش شد');
    } else {
      const { data, error } = await db.from('tasks').insert({ user_id: requireUserId(), name, active: true }).select('id,name').single();
      if (error) throw error;
      state.tasks.push(data);
      showToast('وظیفه افزوده شد');
    }
    closeModal();
    renderTaskManagerList(state.tasks);
    if (document.getElementById('taskContainer')) renderTasks(state.tasks);
    if (isEditing) {
      const task = state.tasks.find(t => t.id === editingId);
      if (task) selectTask(task.id, task.name);
    } else {
      const created = state.tasks[state.tasks.length-1];
      if (created) selectTask(created.id, created.name);
    }
  } catch(e) {
    showToast('خطا: '+e.message, true);
  } finally {
    btn.disabled=false; btn.textContent=isEditing?'ذذیره تغییرات':'افزودن وظیفه';
  }
}

function askConfirm(message, onConfirm) {
  confirmState = { open: true, message, onConfirm };
  document.getElementById('confirmText').textContent = message;
  document.getElementById('confirmModal').classList.add('open');
}

function closeConfirmModal() {
  document.getElementById('confirmModal')?.classList.remove('open');
  confirmState.open = false; confirmState.onConfirm = null;
}

async function deleteTask(id) {
  askConfirm('این وظیفه غیرفعال شود؟', async () => {
    try {
      const { error } = await db.from('tasks').update({ active: false }).eq('id', id);
      if (error) throw error;
      state.tasks = state.tasks.filter(t => t.id !== id);
      renderTaskManagerList(state.tasks);
      if (document.getElementById('taskContainer')) renderTasks(state.tasks);
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
    const { data: tasks, error } = await db
      .from('tasks').select('id,name').eq('user_id', taskOwnerId).eq('active', true).order('id', { ascending: true });
    if (error) throw error;

    state.editingRecordId = id;
    document.getElementById('recordDateInput').value = record.work_date || '';
    document.getElementById('recordStartInput').value = String(record.start_time || '08:30').slice(0,5);
    document.getElementById('recordEndInput').value = String(record.end_time || '17:00').slice(0,5);
    document.getElementById('recordDescInput').value = record.description || '';
    const taskSelect = document.getElementById('recordTaskSelect');
    taskSelect.innerHTML = '<option value="">بدون وظیفه</option>' + (tasks||[]).map(t => `<option value="${t.id}" ${String(t.id)===String(record.task_id)?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
    document.getElementById('recordModal').classList.add('open');
  } catch(e) { showToast('خطا: '+e.message, true); }
}

async function saveRecordEdit() {
  const date = document.getElementById('recordDateInput').value.trim();
  const start = document.getElementById('recordStartInput').value;
  const end = document.getElementById('recordEndInput').value;
  const desc = document.getElementById('recordDescInput').value.trim();
  const taskId = document.getElementById('recordTaskSelect').value || null;
  if (!date||!start||!end) { showToast('تاریخ و زمان را پر کنید', true); return; }
  const hours = calcHours(start, end);
  if (hours <= 0) { showToast('زمان پایان باید بعد از شروع باشد', true); return; }
  try {
    let q = db.from('work_records')
      .update({ work_date: date, start_time: start, end_time: end, hours, description: desc, task_id: taskId })
      .eq('id', state.editingRecordId);
    if (!isCurrentUserAdmin()) q = q.eq('user_id', requireUserId());
    const { error } = await q;
    if (error) throw error;
    closeRecordModal(); await loadReports(); await loadDashboard();
    showToast('رکورد ویرایش شد');
  } catch(e) { showToast('خطا: '+e.message, true); }
}

async function deleteRecord(id) {
  askConfirm('این رکورد حذف شود؟', async () => {
    try {
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
  document.getElementById('recordModal')?.classList.remove('open');
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
  body.innerHTML = '<tr><td colspan="8" class="loading">در حال بارگذاری...</td></tr>';
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
  body.innerHTML = adminUsersCache.map(u => `
    <tr>
      <td style="font-family:var(--font)">${escapeHtml(u.full_name || u.username)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.role === 'admin' ? 'ادمین' : 'یوزر'}</td>
      <td>${u.active ? 'فعال' : 'غیرفعال'}</td>
      <td>${formatMoney(u.hourly_rate ?? DEFAULT_HOURLY_RATE)}</td>
      <td>${Number(u.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT).toFixed(1)}x</td>
      <td>${escapeHtml(formatTelegramUsername(u.telegram_username))}</td>
      <td>
        <div class="table-actions" style="justify-content:center">
          <button class="mini-btn" onclick="changeUserPassword('${u.id}', '${escapeAttr(u.full_name || u.username)}')">رمز</button>
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
  const hourlyRate = Number(document.getElementById('newUserHourlyRate').value || DEFAULT_HOURLY_RATE);
  const overtimeCoef = Number(document.getElementById('newUserOvertimeCoef').value || DEFAULT_OVERTIME_COEFFICIENT);

  if (!username || !password) {
    showToast('نام کاربری و رمز عبور الزامی است.', true); return;
  }
  if (!isValidPassword(password)) {
    showToast('رمز عبور را وارد کنید.', true); return;
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

async function changeUserPassword(userId, displayName) {
  const password = window.prompt(`رمز عبور جدید برای ${displayName}:`);
  if (!password) return;
  if (!isValidPassword(password)) {
    showToast('رمز عبور را وارد کنید.', true);
    return;
  }
  try {
    const { error } = await db.from('wt_users').update({ password }).eq('id', userId);
    if (error) throw error;
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

async function editUser(userId) {
  const user = adminUsersCache.find(u => u.id === userId);
  if (!user) return;

  const fullName = window.prompt('نام نمایشی:', user.full_name || '') ?? user.full_name;
  const username = window.prompt('نام کاربری:', user.username || '') ?? user.username;
  const role = window.prompt('نقش (admin یا user):', user.role || 'user') ?? user.role;
  const hourlyRateText = window.prompt('نرخ ساعتی:', String(user.hourly_rate ?? DEFAULT_HOURLY_RATE));
  const overtimeText = window.prompt('ضریب اضافه‌کاری:', String(user.overtime_coefficient ?? DEFAULT_OVERTIME_COEFFICIENT));
  const telegramText = window.prompt('یوزرنیم تلگرام، بدون @:', normalizeTelegramUsername(user.telegram_username) || '') ?? user.telegram_username;

  if (!['admin','user'].includes(role)) { showToast('نقش نامعتبر است.', true); return; }
  const hourlyRate = Number(hourlyRateText || DEFAULT_HOURLY_RATE);
  const overtimeCoef = Number(overtimeText || DEFAULT_OVERTIME_COEFFICIENT);
  if (hourlyRate < 0 || overtimeCoef < 1) { showToast('نرخ یا ضریب نامعتبر است.', true); return; }
  const telegramUsername = normalizeTelegramUsername(telegramText);
  if (!isValidTelegramUsername(telegramUsername)) { showToast('یوزرنیم تلگرام معتبر نیست.', true); return; }

  try {
    const { error } = await db.from('wt_users').update({ username, full_name: fullName, role, hourly_rate: hourlyRate, overtime_coefficient: overtimeCoef, telegram_username: telegramUsername }).eq('id', userId);
    if (error) throw error;
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
  if (e.target.id === 'recordModal') closeRecordModal();
  if (e.target.id === 'confirmModal') closeConfirmModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSignupModal(); closeModal(); closeSalaryModal(); closeRecordModal(); closeConfirmModal(); }
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
  t.textContent = msg;
  t.className = 'toast'+(isError?' error':'')+' show';
  setTimeout(()=>{ t.className='toast'+(isError?' error':''); }, 3000);
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
  setupPasswordInputs();

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
