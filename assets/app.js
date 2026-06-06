// ===================== CONFIG =====================
const SUPABASE_URL = 'https://kecwrwxjjcgwuqvjduhk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_JaN4Xy-AB0gOXcJTsPrKoA_hAHQDROM';
const USER_ID = 5229151285;
const DEFAULT_HOURLY_RATE = 150000;
const DEFAULT_OVERTIME_COEFFICIENT = 1.5;
const STANDARD_DAILY_HOURS = 8;

// ===== PASSWORD — change this to whatever you want =====
const APP_PASSWORD = 'mobin1234';
const SESSION_KEY = 'wt_auth_v1';
// ======================================================

const HOLIDAY_DATES = new Set([
  '1405-01-01','1405-01-02','1405-01-03','1405-01-04','1405-01-13'
]);

let HOURLY_RATE = Number(localStorage.getItem('worksheet_hourly_rate') || DEFAULT_HOURLY_RATE);
let OVERTIME_COEFFICIENT = Number(localStorage.getItem('worksheet_overtime_coefficient') || DEFAULT_OVERTIME_COEFFICIENT);

const JALALI_MONTHS = ['Farvardin','Ordibehesht','Khordad','Tir','Mordad','Shahrivar','Mehr','Aban','Azar','Dey','Bahman','Esfand'];
const JALALI_MONTHS_FA = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];

// ===================== PASSWORD GATE =====================
function checkPassword() {
  const input = document.getElementById('passwordInput');
  const error = document.getElementById('gateError');
  if (!input) return;
  if (input.value === APP_PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, '1');
    document.getElementById('passwordGate').style.display = 'none';
    document.getElementById('appRoot').style.display = 'block';
    error.textContent = '';
    input.value = '';
    // init after auth
    loadDashboard();
    if (document.getElementById('reportBody')) initReportPage();
  } else {
    error.textContent = 'Incorrect password.';
    input.value = '';
    input.focus();
    const card = document.querySelector('.gate-card');
    card.style.animation = 'none';
    void card.offsetHeight;
    card.style.animation = 'shake 0.4s ease';
  }
}

// ===================== JALALI UTILS =====================
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

function jalaliMonthDays(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return (jy%4==3) ? 30 : 29;
}

function getTodayJalali() {
  const n = new Date();
  return toJalali(n.getFullYear(), n.getMonth()+1, n.getDate());
}

// ===================== STATE =====================
let state = { date: '', taskId: undefined, taskName: '', tasks: [], editingTaskId: null, editingRecordId: null };
let confirmState = { open: false, message: '', onConfirm: null };
const today = getTodayJalali();

// ===================== SUPABASE =====================
async function supabaseReq(method, table, body=null, query='') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method==='POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.message || e.hint || JSON.stringify(e)); }
  return method==='DELETE' ? null : res.json();
}

// ===================== FORMAT HELPERS =====================
function formatHours(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  if (mm === 0) return `${hh}h`;
  return `${hh}:${String(mm).padStart(2,'0')}h`;
}

function formatMoney(amount) {
  // Always English digits
  return amount.toLocaleString('en-US') + ' T';
}

// ===================== DASHBOARD =====================
async function loadDashboard() {
  const dashTotal = document.getElementById('dashTotal');
  const dashMonth = document.getElementById('dashMonth');
  const dashSalary = document.getElementById('dashSalary');
  const dashError = document.getElementById('dashError');
  if (!dashTotal || !dashMonth || !dashSalary) return;

  try {
    const records = await supabaseReq('GET','work_records',null,`?user_id=eq.${USER_ID}&select=hours,date`);
    const totalHours = records.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);
    const currentMonthStr = `${today.y}-${String(today.m).padStart(2,'0')}`;
    const monthRecords = records.filter(r => r.date && r.date.startsWith(currentMonthStr));
    const monthHours = monthRecords.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);
    const salaryInfo = calculateMonthlySalary(monthHours, today.y, today.m);

    dashTotal.textContent = formatHours(totalHours);
    dashMonth.textContent = formatHours(monthHours);
    dashSalary.textContent = formatMoney(salaryInfo.salary);
  } catch(e) {
    dashTotal.textContent = '—';
    dashMonth.textContent = '—';
    dashSalary.textContent = '—';
    if (dashError) {
      dashError.style.display = 'block';
      dashError.textContent = 'Error loading data: ' + e.message;
    }
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

// ===================== REPORTS =====================
async function loadReports() {
  const reportBody = document.getElementById('reportBody');
  const reportSummary = document.getElementById('reportSummary');
  if (!reportBody || !reportSummary) return;

  try {
    const records = await supabaseReq('GET','work_records',null,`?user_id=eq.${USER_ID}&select=*,task_id&order=date.desc`);
    const tasks = await supabaseReq('GET','tasks',null,`?user_id=eq.${USER_ID}&active=eq.true&select=id,name`);
    const taskMap = Object.fromEntries(tasks.map(t => [t.id, t.name]));

    buildReportFilters(tasks, records);
    const filtered = applyReportFilters(records, taskMap);
    const rows = filtered.map(r => ({
      id: r.id,
      date: r.date || '—',
      task: taskMap[r.task_id] || '—',
      hours: Number(r.hours || 0),
      start: r.start_time || '—',
      end: r.end_time || '—',
      desc: r.description || '—'
    }));

    const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
    const selectedYear = document.getElementById('yearFilter')?.value || 'all';
    const selectedMonth = document.getElementById('monthFilter')?.value || 'all';
    const calcYear = selectedYear === 'all' ? today.y : Number(selectedYear);
    const calcMonth = selectedMonth === 'all' ? today.m : Number(selectedMonth);
    const totalSalaryInfo = calculateMonthlySalary(totalHours, calcYear, calcMonth);

    reportSummary.innerHTML = `
      <div class="report-chip">Total: <strong>${formatHours(totalHours)}</strong></div>
      <div class="report-chip">Monthly limit: <strong>${formatHours(totalSalaryInfo.thresholdHours)}</strong></div>
      <div class="report-chip">Overtime: <strong>${formatHours(totalSalaryInfo.overtimeHours)}</strong></div>
      <div class="report-chip">Salary: <strong>${formatMoney(totalSalaryInfo.salary)}</strong></div>
      <div class="report-chip">OT coefficient: <strong>${OVERTIME_COEFFICIENT.toFixed(1)}x</strong></div>
      <div class="report-chip">Status: <strong>${totalSalaryInfo.isOvertime ? 'Over limit' : 'Normal'}</strong></div>
    `;

    if (!rows.length) {
      reportBody.innerHTML = '<tr><td colspan="7" class="empty-state">No records found for the selected filters.</td></tr>';
      return;
    }

    reportBody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.date}</td>
        <td style="font-family:var(--font)">${r.task}</td>
        <td>${formatHours(r.hours)}</td>
        <td>${r.start}</td>
        <td>${r.end}</td>
        <td style="font-family:var(--font);font-size:11px">${r.desc}</td>
        <td>
          <div class="table-actions">
            <button class="mini-btn" onclick="openRecordEditor(${r.id})">Edit</button>
            <button class="mini-btn danger" onclick="deleteRecord(${r.id})">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    reportBody.innerHTML = `<tr><td colspan="7" class="error-msg">Error loading reports: ${e.message}</td></tr>`;
  }
}

function buildReportFilters(tasks, records) {
  const taskFilter = document.getElementById('taskFilter');
  const yearFilter = document.getElementById('yearFilter');
  const monthFilter = document.getElementById('monthFilter');
  const dayFilter = document.getElementById('dayFilter');
  if (!taskFilter || !yearFilter || !monthFilter || !dayFilter) return;

  const selected = {
    task: taskFilter.value || 'all',
    year: yearFilter.value || 'all',
    month: monthFilter.value || 'all',
    day: dayFilter.value || 'all'
  };

  const years = [...new Set(records.map(r => String(r.date||'').slice(0,4)).filter(Boolean))].sort((a,b) => b-a);
  yearFilter.innerHTML = '<option value="all">All years</option>' + (years.length
    ? years.map(y => `<option value="${y}">${y}</option>`).join('')
    : `<option value="${today.y}">${today.y}</option>`);
  monthFilter.innerHTML = '<option value="all">All months</option>' + JALALI_MONTHS.map((m, i) => `<option value="${i+1}">${m}</option>`).join('');
  taskFilter.innerHTML = '<option value="all">All tasks</option>' + tasks.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

  yearFilter.value = years.includes(selected.year) ? selected.year : 'all';
  monthFilter.value = selected.month !== 'all' && JALALI_MONTHS[Number(selected.month)-1] ? selected.month : 'all';
  taskFilter.value = selected.task;

  updateDayOptions();
  if (dayFilter.querySelector(`option[value="${selected.day}"]`)) dayFilter.value = selected.day;
  else dayFilter.value = 'all';
}

function applyReportFilters(records, taskMap) {
  const taskFilter = document.getElementById('taskFilter');
  const yearFilter = document.getElementById('yearFilter');
  const monthFilter = document.getElementById('monthFilter');
  const dayFilter = document.getElementById('dayFilter');

  const selectedTask = taskFilter ? taskFilter.value : 'all';
  const selectedYear = yearFilter ? yearFilter.value : 'all';
  const selectedMonth = monthFilter ? monthFilter.value : 'all';
  const selectedDay = dayFilter ? dayFilter.value : 'all';

  return records.filter(r => {
    const date = String(r.date || '');
    const [y,m,d] = date.split('-');
    return (selectedTask === 'all' || String(r.task_id) === String(selectedTask))
      && (selectedYear === 'all' || y === selectedYear)
      && (selectedMonth === 'all' || m === String(selectedMonth).padStart(2,'0'))
      && (selectedDay === 'all' || d === String(selectedDay).padStart(2,'0'));
  });
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

  dayFilter.innerHTML = '<option value="all">All days</option>' + days.map(d => `<option value="${d}">${d}</option>`).join('');
  dayFilter.value = days.includes(Number(currentDay)) || currentDay === 'all' ? currentDay : 'all';
}

function exportReportToExcel() {
  const rows = Array.from(document.querySelectorAll('#reportBody tr'));
  if (!rows.length || rows[0].textContent.includes('No records')) {
    showToast('No records to export', true); return;
  }
  const csv = [
    'Date,Task,Hours,Start,End,Notes',
    ...Array.from(rows).map(row => Array.from(row.cells).slice(0,6).map(cell => cell.textContent.replace(/\n/g,' ').trim()).join(','))
  ].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'work-report.csv';
  link.click(); URL.revokeObjectURL(url);
  showToast('CSV exported');
}

// ===================== NAVIGATION =====================
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

// ===================== DATE DROPDOWNS =====================
function buildDateDropdowns() {
  document.getElementById('year').textContent = today.y;
  const monthSel = document.getElementById('month');
  monthSel.innerHTML = '';
  for (let m=1; m<=today.m; m++) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = JALALI_MONTHS[m-1];
    if (m === today.m) o.selected = true;
    monthSel.appendChild(o);
  }
  buildDayDropdown(today.m, today.d);
  monthSel.addEventListener('change', () => {
    const selMonth = parseInt(monthSel.value);
    const maxDay = selMonth === today.m ? today.d : jalaliMonthDays(today.y, selMonth);
    buildDayDropdown(selMonth, selMonth === today.m ? today.d : 1, maxDay);
  });
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

// ===================== TIME PICKER =====================
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

// ===================== STEPS =====================
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
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';
  try {
    const tasks = await supabaseReq('GET','tasks',null,`?user_id=eq.${USER_ID}&active=eq.true&order=id.asc`);
    state.tasks = tasks;
    renderTasks(tasks);
  } catch(e) {
    container.innerHTML = `<p class="error-msg">Error: ${e.message}</p>`;
  }
}

function renderTasks(tasks) {
  const container = document.getElementById('taskContainer');
  let html = '<div class="task-list">';
  tasks.forEach(t => {
    html += `<div class="task-item" id="task-${t.id}" onclick="selectTask(${t.id},'${t.name.replace(/'/g,"\\'")}')">
      <span>${t.name}</span><div class="check"></div>
    </div>`;
  });
  html += `<div class="no-task" id="task-null" onclick="selectTask(null,'No Task')">
    <span>—</span><span>No specific task</span>
  </div>`;
  html += '</div>';
  html += `<button class="btn-add-task" onclick="openTaskManagerModal()">+ Manage Tasks</button>`;
  container.innerHTML = html;
}

function selectTask(id, name) {
  document.querySelectorAll('.task-item,.no-task').forEach(el => el.classList.remove('selected'));
  document.getElementById('task-'+id)?.classList.add('selected');
  state.taskId = id; state.taskName = name;
  document.getElementById('btnTask').disabled = false;
}

function goToStep2() {
  if (state.taskId === undefined) { showToast('Select a task first', true); return; }
  goToStep(2);
}

async function submitRecord() {
  const start = document.getElementById('startTimeVal').value;
  const end   = document.getElementById('endTimeVal').value;
  const desc  = document.getElementById('description').value.trim();
  if (!start||!end) { showToast('Select start and end times', true); return; }
  const hours = calcHours(start, end);
  if (hours <= 0) { showToast('End time must be after start', true); return; }

  const btn = document.getElementById('btnSubmit');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    await supabaseReq('POST','work_records',{
      user_id: USER_ID, date: state.date,
      start_time: start, end_time: end,
      hours, description: desc,
      task_id: state.taskId || null
    });
    document.getElementById('successMsg').textContent = `${state.date} — ${state.taskName}`;
    document.getElementById('summaryPill').textContent = `${start} → ${end} · ${hours}h`;
    goToStep(3);
  } catch(e) {
    showToast('Error: '+e.message, true);
    btn.disabled=false; btn.textContent='Submit';
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

// ===================== TASK MODAL =====================
async function openTaskManagerModal() {
  try {
    const tasks = await supabaseReq('GET','tasks',null,`?user_id=eq.${USER_ID}&active=eq.true&order=id.asc`);
    state.tasks = tasks;
    renderTaskManagerList(tasks);
    state.editingTaskId = null;
    document.getElementById('newTaskInput').value = '';
    document.getElementById('taskModalTitle').textContent = 'Manage Tasks';
    document.getElementById('btnSaveTask').textContent = 'Add Task';
    document.getElementById('taskModal').classList.add('open');
    setTimeout(()=>document.getElementById('newTaskInput').focus(),100);
  } catch(e) {
    showToast('Error loading tasks: ' + e.message, true);
  }
}

function renderTaskManagerList(tasks) {
  const list = document.getElementById('taskManagerList');
  if (!list) return;
  if (!tasks.length) { list.innerHTML = '<p class="muted-text" style="font-size:12px">No tasks yet.</p>'; return; }
  list.innerHTML = tasks.map(t => `
    <div class="task-manager-row">
      <span>${t.name}</span>
      <div class="task-mini-actions">
        <button class="mini-btn" onclick="startEditTask(${t.id},'${t.name.replace(/'/g,"\\'")}')">Edit</button>
        <button class="mini-btn danger" onclick="deleteTask(${t.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

function startEditTask(id, name) {
  state.editingTaskId = id;
  document.getElementById('newTaskInput').value = name;
  document.getElementById('taskModalTitle').textContent = 'Edit Task';
  document.getElementById('btnSaveTask').textContent = 'Save Changes';
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
  document.getElementById('taskModalTitle').textContent = 'Manage Tasks';
  document.getElementById('btnSaveTask').textContent = 'Add Task';
  document.getElementById('taskModal').classList.remove('open');
}

function closeSalaryModal() { document.getElementById('salaryModal').classList.remove('open'); }

function saveSalarySettings() {
  const rate = Number(document.getElementById('hourlyRateInput').value || 0);
  const coef = Number(document.getElementById('overtimeCoefInput').value || 1);
  if (rate < 0 || coef < 1) { showToast('Invalid values', true); return; }
  HOURLY_RATE = rate; OVERTIME_COEFFICIENT = coef;
  localStorage.setItem('worksheet_hourly_rate', String(HOURLY_RATE));
  localStorage.setItem('worksheet_overtime_coefficient', String(OVERTIME_COEFFICIENT));
  document.getElementById('salaryCurrentRate').textContent = HOURLY_RATE.toLocaleString('en-US');
  closeSalaryModal();
  loadDashboard(); loadReports();
  showToast('Salary settings saved');
}

async function saveNewTask() {
  const name = document.getElementById('newTaskInput').value.trim();
  if (!name) { showToast('Enter a task name', true); return; }
  const btn = document.getElementById('btnSaveTask');
  const editingId = state.editingTaskId;
  const isEditing = Boolean(editingId);
  btn.disabled=true; btn.textContent='Saving...';
  try {
    if (isEditing) {
      await supabaseReq('PATCH','tasks',{ name }, `?id=eq.${editingId}`);
      const cur = state.tasks.find(t => t.id === editingId);
      if (cur) cur.name = name;
      showToast('Task updated');
    } else {
      const [created] = await supabaseReq('POST','tasks',{ user_id: USER_ID, name, active: true });
      state.tasks.push(created);
      showToast('Task added');
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
    showToast('Error: '+e.message, true);
  } finally {
    btn.disabled=false; btn.textContent=isEditing?'Save Changes':'Add Task';
  }
}

function askConfirm(message, onConfirm) {
  confirmState = { open: true, message, onConfirm };
  document.getElementById('confirmText').textContent = message;
  document.getElementById('confirmModal').classList.add('open');
}

function closeConfirmModal() {
  document.getElementById('confirmModal').classList.remove('open');
  confirmState.open = false; confirmState.onConfirm = null;
}

async function deleteTask(id) {
  askConfirm('Delete this task?', async () => {
    try {
      await supabaseReq('PATCH','tasks',{ active: false }, `?id=eq.${id}`);
      state.tasks = state.tasks.filter(t => t.id !== id);
      renderTaskManagerList(state.tasks);
      if (document.getElementById('taskContainer')) renderTasks(state.tasks);
      showToast('Task deleted');
    } catch(e) { showToast('Error: '+e.message, true); }
    finally { closeConfirmModal(); }
  });
}

async function openRecordEditor(id) {
  try {
    const records = await supabaseReq('GET','work_records',null,`?user_id=eq.${USER_ID}&select=*,task_id&order=date.desc`);
    const tasks = await supabaseReq('GET','tasks',null,`?user_id=eq.${USER_ID}&active=eq.true&select=id,name`);
    const record = records.find(r => r.id === id);
    if (!record) throw new Error('Record not found');

    state.editingRecordId = id;
    document.getElementById('recordDateInput').value = record.date || '';
    document.getElementById('recordStartInput').value = record.start_time || '08:30';
    document.getElementById('recordEndInput').value = record.end_time || '17:00';
    document.getElementById('recordDescInput').value = record.description || '';
    const taskSelect = document.getElementById('recordTaskSelect');
    taskSelect.innerHTML = '<option value="">No task</option>' + tasks.map(t => `<option value="${t.id}" ${String(t.id)===String(record.task_id)?'selected':''}>${t.name}</option>`).join('');
    document.getElementById('recordModal').classList.add('open');
  } catch(e) { showToast('Error: '+e.message, true); }
}

async function saveRecordEdit() {
  const date = document.getElementById('recordDateInput').value.trim();
  const start = document.getElementById('recordStartInput').value;
  const end = document.getElementById('recordEndInput').value;
  const desc = document.getElementById('recordDescInput').value.trim();
  const taskId = document.getElementById('recordTaskSelect').value || null;
  if (!date||!start||!end) { showToast('Fill in date and times', true); return; }
  const hours = calcHours(start, end);
  if (hours <= 0) { showToast('End must be after start', true); return; }
  try {
    await supabaseReq('PATCH','work_records',{ date, start_time: start, end_time: end, hours, description: desc, task_id: taskId }, `?id=eq.${state.editingRecordId}`);
    closeRecordModal(); loadReports(); loadDashboard();
    showToast('Record updated');
  } catch(e) { showToast('Error: '+e.message, true); }
}

async function deleteRecord(id) {
  askConfirm('Delete this record?', async () => {
    try {
      await supabaseReq('DELETE','work_records',null,`?id=eq.${id}`);
      await loadReports(); await loadDashboard();
      showToast('Record deleted');
    } catch(e) { showToast('Error: '+e.message, true); }
    finally { closeConfirmModal(); }
  });
}

function closeRecordModal() {
  state.editingRecordId = null;
  document.getElementById('recordModal').classList.remove('open');
}

function confirmYes() { if (confirmState.onConfirm) confirmState.onConfirm(); }
function confirmNo() { closeConfirmModal(); }

document.addEventListener('click', e => {
  if (e.target.id === 'taskModal') closeModal();
  if (e.target.id === 'salaryModal') closeSalaryModal();
  if (e.target.id === 'recordModal') closeRecordModal();
  if (e.target.id === 'confirmModal') closeConfirmModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeSalaryModal(); closeRecordModal(); closeConfirmModal(); }
  if (e.key === 'Enter' && document.getElementById('passwordGate')?.style.display !== 'none') checkPassword();
});

// ===================== TOAST =====================
function showToast(msg, isError=false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast'+(isError?' error':'')+' show';
  setTimeout(()=>{ t.className='toast'+(isError?' error':''); }, 3000);
}

// ===================== INIT =====================
function initReportPage() {
  loadReports();
  document.getElementById('yearFilter')?.addEventListener('change', () => { updateDayOptions(); loadReports(); });
  document.getElementById('monthFilter')?.addEventListener('change', () => { updateDayOptions(); loadReports(); });
  document.getElementById('taskFilter')?.addEventListener('change', loadReports);
  document.getElementById('dayFilter')?.addEventListener('change', loadReports);
}

window.addEventListener('DOMContentLoaded', () => {
  // Check if already authenticated in this session
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    document.getElementById('passwordGate').style.display = 'none';
    document.getElementById('appRoot').style.display = 'block';
    loadDashboard();
    if (document.getElementById('reportBody')) initReportPage();
  } else {
    // Show gate, focus input
    setTimeout(() => document.getElementById('passwordInput')?.focus(), 100);
  }
});
