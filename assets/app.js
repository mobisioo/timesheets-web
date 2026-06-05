// ===================== CONFIG =====================
const SUPABASE_URL = 'https://kecwrwxjjcgwuqvjduhk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_JaN4Xy-AB0gOXcJTsPrKoA_hAHQDROM';
const USER_ID = 5229151285;
const HOURLY_RATE = 150000; // تومان — اگه نرخ متفاوته اینجا تغییر بده

const JALALI_MONTHS = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];

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
let state = { date: '', taskId: undefined, taskName: '', tasks: [] };
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

// ===================== DASHBOARD =====================
async function loadDashboard() {
  try {
    // fetch all work records for this user
    const records = await supabaseReq('GET','work_records',null,`?user_id=eq.${USER_ID}&select=hours,date`);

    const totalHours = records.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);

    // current jalali month records
    const currentMonthStr = `${today.y}-${String(today.m).padStart(2,'0')}`;
    const monthRecords = records.filter(r => r.date && r.date.startsWith(currentMonthStr));
    const monthHours = monthRecords.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);

    const salary = monthHours * HOURLY_RATE;

    document.getElementById('dashTotal').textContent = formatHours(totalHours);
    document.getElementById('dashMonth').textContent = formatHours(monthHours);
    document.getElementById('dashSalary').textContent = formatMoney(salary);
  } catch(e) {
    document.getElementById('dashTotal').textContent = '—';
    document.getElementById('dashMonth').textContent = '—';
    document.getElementById('dashSalary').textContent = '—';
    const errEl = document.getElementById('dashError');
    errEl.style.display = 'block';
    errEl.textContent = 'خطا در بارگذاری اطلاعات: ' + e.message;
  }
}

function formatHours(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  if (mm === 0) return `${hh} ساعت`;
  return `${hh}:${String(mm).padStart(2,'0')} ساعت`;
}

function formatMoney(amount) {
  return amount.toLocaleString('fa-IR') + ' تومان';
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
  // refresh dashboard
  loadDashboard();
}

// ===================== BUILD DATE DROPDOWNS =====================
function buildDateDropdowns() {
  const yearEl = document.getElementById('year');
  yearEl.textContent = today.y;

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
    o.value = d;
    o.textContent = d;
    if (d === selectedDay) o.selected = true;
    daySel.appendChild(o);
  }
}

// ===================== TIME PICKER =====================
// FIX: hour on RIGHT (چپ‌به‌راست داخل time-selects با direction:ltr → ساعت سمت راست، دقیقه سمت چپ)
// در رابط فارسی راست‌به‌چپ: ساعت باید اول (سمت راست) بیاد، بعد دقیقه
function buildTimePicker(containerId, inputId, defaultHour=8, defaultMin='30') {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const hours = [];
  for (let h=6; h<=23; h++) hours.push(h);
  const minutes = ['00','15','30','45'];

  // ساعت — سمت راست در LTR
  const hSel = document.createElement('select');
  hSel.className = 'time-sel';
  hours.forEach(h => {
    const o = document.createElement('option');
    o.value = h;
    o.textContent = String(h).padStart(2,'0');
    if (h === defaultHour) o.selected = true;
    hSel.appendChild(o);
  });

  const sep = document.createElement('span');
  sep.className = 'time-sep';
  sep.textContent = ':';

  // دقیقه — سمت چپ در LTR
  const mSel = document.createElement('select');
  mSel.className = 'time-sel';
  minutes.forEach(m => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    if (m === defaultMin) o.selected = true;
    mSel.appendChild(o);
  });

  const update = () => {
    document.getElementById(inputId).value = `${String(hSel.value).padStart(2,'0')}:${mSel.value}`;
  };
  hSel.addEventListener('change', update);
  mSel.addEventListener('change', update);
  update();

  // ترتیب: ساعت : دقیقه (LTR → ساعت سمت راست صفحه RTL)
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
  for (let i=0;i<4;i++) {
    document.getElementById('dot'+i).className = 'dot'+(i===n?' active':i<n?' done':'');
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
    const tasks = await supabaseReq('GET','tasks',null,`?user_id=eq.${USER_ID}&active=eq.true&order=id.asc`);
    state.tasks = tasks;
    renderTasks(tasks);
  } catch(e) {
    container.innerHTML = `<p class="error-msg">خطا: ${e.message}</p>`;
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
  html += `<div class="no-task" id="task-null" onclick="selectTask(null,'بدون تسک')">
    <span>—</span><span>بدون تسک مشخص</span>
  </div>`;
  html += '</div>';
  html += `<button class="btn btn-add-task" onclick="openNewTaskModal()">+ تسک جدید</button>`;
  container.innerHTML = html;
}

function selectTask(id, name) {
  document.querySelectorAll('.task-item,.no-task').forEach(el => el.classList.remove('selected'));
  document.getElementById('task-'+id)?.classList.add('selected');
  state.taskId = id;
  state.taskName = name;
  document.getElementById('btnTask').disabled = false;
}

function goToStep2() {
  if (state.taskId === undefined) { showToast('یه تسک انتخاب کن', true); return; }
  goToStep(2);
}

async function submitRecord() {
  const start = document.getElementById('startTimeVal').value;
  const end   = document.getElementById('endTimeVal').value;
  const desc  = document.getElementById('description').value.trim();
  if (!start||!end) { showToast('ساعت رو انتخاب کن', true); return; }
  const hours = calcHours(start, end);
  if (hours <= 0) { showToast('ساعت پایان باید بعد از شروع باشه', true); return; }

  const btn = document.getElementById('btnSubmit');
  btn.disabled = true; btn.textContent = 'در حال ثبت...';
  try {
    await supabaseReq('POST','work_records',{
      user_id: USER_ID, date: state.date,
      start_time: start, end_time: end,
      hours, description: desc,
      task_id: state.taskId || null
    });
    document.getElementById('successMsg').textContent = `${state.date} — ${state.taskName}`;
    document.getElementById('summaryPill').textContent = `${start} تا ${end} — ${hours} ساعت`;
    goToStep(3);
  } catch(e) {
    showToast('خطا: '+e.message, true);
    btn.disabled=false; btn.textContent='ثبت کن';
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

// ===================== NEW TASK MODAL =====================
function openNewTaskModal() {
  document.getElementById('newTaskInput').value = '';
  document.getElementById('taskModal').classList.add('open');
  setTimeout(()=>document.getElementById('newTaskInput').focus(),100);
}

function closeModal() {
  document.getElementById('taskModal').classList.remove('open');
}

async function saveNewTask() {
  const name = document.getElementById('newTaskInput').value.trim();
  if (!name) { showToast('اسم تسک رو بنویس', true); return; }
  const btn = document.getElementById('btnSaveTask');
  btn.disabled=true; btn.textContent='در حال ذخیره...';
  try {
    const [created] = await supabaseReq('POST','tasks',{ user_id: USER_ID, name, active: true });
    state.tasks.push(created);
    closeModal();
    renderTasks(state.tasks);
    selectTask(created.id, created.name);
    showToast('تسک جدید اضافه شد ✓');
  } catch(e) {
    showToast('خطا: '+e.message, true);
  } finally {
    btn.disabled=false; btn.textContent='ذخیره';
  }
}

document.addEventListener('click', e => { if (e.target.id === 'taskModal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

// ===================== TOAST =====================
function showToast(msg, isError=false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast'+(isError?' error':'')+' show';
  setTimeout(()=>{ t.className='toast'+(isError?' error':''); }, 3000);
}

// ===================== INIT =====================
window.addEventListener('DOMContentLoaded', ()=>{
  loadDashboard();
});
