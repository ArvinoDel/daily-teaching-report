
/* ═══════════════════════════════════════════════════════════════════════
   BULK ADD: Multi-Class Entry Management
   Each extra card is a fully independent report entry.
   ═══════════════════════════════════════════════════════════════════════ */

// Server-side data injected for use in dynamically-built cards
var _bulkTeachingTypes = JSON.parse(document.getElementById('bulk-teaching-types-json').textContent);
var _bulkIsAdmin       = JSON.parse(document.getElementById('bulk-is-admin-json').textContent);
var _bulkTeachers      = JSON.parse(document.getElementById('bulk-teachers-json').textContent);
var _bulkToday         = (document.getElementById('report-form-config') ? JSON.parse(document.getElementById('report-form-config').textContent).today : null) || new Date().toISOString().substring(0,10);

var _bulkIdCounter = 0;
var _bulkIds       = []; // ordered list of active entry IDs
var _bulkStates    = {}; // { id: { sessionType, sessionMode, selectedGroup, studentStates, acTags, absentTags } }

/* ─── Add / Remove entries ──────────────────────────────────────────── */
function addBulkEntry() {
  var id  = ++_bulkIdCounter;
  var num = _bulkIds.length + 2; // +2 because entry #1 is the main form
  _bulkIds.push(id);
  _bulkStates[id] = { sessionType: 'group', sessionMode: 'offline', selectedGroup: null, studentStates: {}, acTags: [], acReducedTags: [], absentTags: [] };

  var container = document.getElementById('bulk-extra-entries');
  var wrapper   = document.createElement('div');
  wrapper.innerHTML = _buildEntryHtml(id, num);
  container.appendChild(wrapper.firstElementChild);

  _initBulkEntry(id);
  _updateBulkUI();

  // Smooth scroll to new entry
  document.getElementById('bulk-entry-' + id).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function removeBulkEntry(id) {
  var el = document.getElementById('bulk-entry-' + id);
  if (el) { el.style.opacity = '0'; el.style.transform = 'scale(0.97)'; el.style.transition = 'all 0.15s'; setTimeout(function() { el.remove(); }, 150); }
  _bulkIds     = _bulkIds.filter(function(x) { return x !== id; });
  delete _bulkStates[id];
  setTimeout(function() { _renumberEntries(); _updateBulkUI(); }, 160);
}

function _renumberEntries() {
  _bulkIds.forEach(function(id, idx) {
    var numEl   = document.getElementById('bulk-entry-' + id + '-num');
    var titleEl = document.getElementById('bulk-entry-' + id + '-title');
    var st      = _bulkStates[id];
    var newNum  = idx + 2;
    if (numEl) numEl.textContent = newNum;
    if (titleEl && !(st && st.selectedGroup)) titleEl.textContent = 'Class ' + newNum;
  });
}

/* ─── UI update (button text, submit bar) ───────────────────────────── */
function _updateBulkUI() {
  var total       = 1 + _bulkIds.length;
  var submitBar   = document.getElementById('bulk-submit-bar');
  var countEl     = document.getElementById('bulk-total-count');
  var bulkBtnText = document.getElementById('bulk-submit-text');
  var mainBtnText = document.getElementById('btn-submit-text');

  if (_bulkIds.length > 0) {
    if (submitBar)   submitBar.classList.remove('hidden');
    if (countEl)     countEl.textContent     = total;
    if (bulkBtnText) bulkBtnText.textContent = 'Save ' + total + ' Reports';
    if (mainBtnText) mainBtnText.textContent = 'Save ' + total + ' Reports';
  } else {
    if (submitBar)   submitBar.classList.add('hidden');
    if (mainBtnText) mainBtnText.textContent = (document.getElementById('report-form-config') ? JSON.parse(document.getElementById('report-form-config').textContent).submitText : null) || 'Submit Report';
  }
}

/* ─── Session Type ──────────────────────────────────────────────────── */
function setEntrySessionType(id, type) {
  var st = _bulkStates[id]; if (!st) return;
  st.sessionType = type;
  var inact = 'flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition border-slate-200 bg-white text-slate-400 hover:border-slate-300';
  var btnG = document.getElementById('bulk-entry-' + id + '-btn-group');
  var btnP = document.getElementById('bulk-entry-' + id + '-btn-private');
  var btnC = document.getElementById('bulk-entry-' + id + '-btn-competition');
  if (btnG) btnG.className = inact;
  if (btnP) btnP.className = inact;
  if (btnC) btnC.className = inact;
  if (type === 'group'       && btnG) btnG.className = 'flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition border-brand-500 bg-brand-50 text-brand-700';
  if (type === 'private'     && btnP) btnP.className = 'flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition border-purple-400 bg-purple-50 text-purple-700';
  if (type === 'competition' && btnC) btnC.className = 'flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition border-orange-500 bg-orange-50 text-orange-700';
  var bSub = document.getElementById('bulk-entry-' + id + '-subject');
  if (bSub && typeof bSub._matAcReRank === 'function') bSub._matAcReRank();
}

/* ─── Session Mode ──────────────────────────────────────────────────── */
function setEntryMode(id, mode) {
  var st = _bulkStates[id]; if (!st) return;
  st.sessionMode = mode;
  var inact  = 'flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition border-slate-200 bg-white text-slate-400 hover:border-slate-300';
  var btnOff = document.getElementById('bulk-entry-' + id + '-btn-offline');
  var btnOn  = document.getElementById('bulk-entry-' + id + '-btn-online');
  var piWrap = document.getElementById('bulk-entry-' + id + '-pi-wrap');
  if (mode === 'online') {
    if (btnOn)  btnOn.className  = 'flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition border-blue-500 bg-blue-50 text-blue-700';
    if (btnOff) btnOff.className = inact;
    if (piWrap) piWrap.classList.remove('hidden');
  } else {
    if (btnOff) btnOff.className = 'flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition border-slate-700 bg-slate-700 text-white';
    if (btnOn)  btnOn.className  = inact;
    if (piWrap) piWrap.classList.add('hidden');
    var pic = document.getElementById('bulk-entry-' + id + '-pi-check');
    if (pic) pic.checked = false;
  }
}

/* ─── Autocomplete ──────────────────────────────────────────────────── */
function _entryClassFocus(id) {
  var inp  = document.getElementById('bulk-entry-' + id + '-class-name'); if (!inp) return;
  var q    = inp.value.trim().toLowerCase();
  var list = q ? groupsData.filter(function(g){ return g.group_name.toLowerCase().includes(q); }) : groupsData;
  if (list.length) _renderEntryDropdown(id, list);
}

function _entryClassInput(id, val) {
  var st = _bulkStates[id]; if (!st) return;
  if (st.selectedGroup && val !== st.selectedGroup.group_name) {
    st.selectedGroup = null; st.studentStates = {};
    _hideEntryRoster(id);
    var cb = document.getElementById('bulk-entry-' + id + '-clear-btn');
    if (cb) cb.classList.add('hidden');
    _entryHintDefault(id);
  }
  if (!val.trim()) { _hideEntryDropdown(id); return; }
  var list = groupsData.filter(function(g){ return g.group_name.toLowerCase().includes(val.trim().toLowerCase()); });
  list.length ? _renderEntryDropdown(id, list) : _hideEntryDropdown(id);
}

function _renderEntryDropdown(id, groups) {
  var dd = document.getElementById('bulk-entry-' + id + '-dropdown'); if (!dd) return;
  dd.innerHTML = groups.slice(0, 8).map(function(g) {
    var tcls = g.type === 'GROUP' ? 'bg-emerald-100 text-emerald-700' : 'bg-purple-100 text-purple-700';
    var tlbl = g.type === 'GROUP' ? 'Group' : 'Private';
    return '<button type="button" data-action="selectEntryGroup" data-entry-id="' + id + '" data-group-id="' + escHtml(g._id) + '" class="w-full text-left px-4 py-3 hover:bg-brand-50 transition flex items-center justify-between gap-3">' +
      '<div class="flex-1 min-w-0"><p class="text-sm font-semibold text-slate-800 truncate">' + escHtml(g.group_name) + '</p>' +
      '<div class="flex items-center gap-1.5 mt-0.5"><span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full ' + tcls + '">' + tlbl + '</span>' +
      (g.level ? '<span class="text-[10px] font-mono text-slate-400">' + escHtml(g.level) + '</span>' : '') + '</div></div>' +
      '<span class="text-xs text-slate-400 flex-shrink-0">' + g.students.length + ' student(s)</span></button>';
  }).join('');
  dd.classList.remove('hidden');
}

function _hideEntryDropdown(id) {
  var dd = document.getElementById('bulk-entry-' + id + '-dropdown');
  if (dd) dd.classList.add('hidden');
}

function selectEntryGroup(id, groupId) {
  var st = _bulkStates[id]; if (!st) return;
  var g  = groupsData.find(function(x){ return x._id === groupId; }); if (!g) return;

  st.selectedGroup  = g;
  st.studentStates  = {};
  g.students.forEach(function(s){ st.studentStates[s] = { state: null, acCount: 0, reduceCount: 0 }; });

  var inp = document.getElementById('bulk-entry-' + id + '-class-name');
  if (inp) inp.value = g.group_name;
  _hideEntryDropdown(id);

  var cb = document.getElementById('bulk-entry-' + id + '-clear-btn');
  if (cb) cb.classList.remove('hidden');

  var rn = document.getElementById('bulk-entry-' + id + '-roster-name');
  if (rn) rn.textContent = g.group_name;

  var titleEl = document.getElementById('bulk-entry-' + id + '-title');
  if (titleEl) titleEl.textContent = g.group_name;

  setEntrySessionType(id, g.type === 'PRIVATE' ? 'private' : 'group');
  _renderEntryRoster(id);
  _showEntryRoster(id);
  _entryHintSelected(id);
  var bSub = document.getElementById('bulk-entry-' + id + '-subject');
  if (bSub && typeof bSub._matAcReRank === 'function') bSub._matAcReRank();
}

function clearEntryGroup(id) {
  var st = _bulkStates[id]; if (!st) return;
  st.selectedGroup = null; st.studentStates = {}; st.acTags = []; st.acReducedTags = []; st.absentTags = [];
  var inp = document.getElementById('bulk-entry-' + id + '-class-name');
  if (inp) { inp.value = ''; inp.focus(); }
  var cb = document.getElementById('bulk-entry-' + id + '-clear-btn');
  if (cb) cb.classList.add('hidden');
  _hideEntryRoster(id);
  _renderEntryTagBox(id, 'ac');
  _renderEntryTagBox(id, 'ac-reduced');
  _renderEntryTagBox(id, 'absent');
  _entryHintDefault(id);
  var bSub = document.getElementById('bulk-entry-' + id + '-subject');
  if (bSub && typeof bSub._matAcReRank === 'function') bSub._matAcReRank();
  var idx     = _bulkIds.indexOf(id);
  var titleEl = document.getElementById('bulk-entry-' + id + '-title');
  if (titleEl) titleEl.textContent = 'Class ' + (idx + 2);
}

function _showEntryRoster(id) {
  var r = document.getElementById('bulk-entry-' + id + '-roster');
  var m = document.getElementById('bulk-entry-' + id + '-manual');
  if (r) r.classList.remove('hidden');
  if (m) m.classList.add('hidden');
}
function _hideEntryRoster(id) {
  var r = document.getElementById('bulk-entry-' + id + '-roster');
  var m = document.getElementById('bulk-entry-' + id + '-manual');
  if (r) r.classList.add('hidden');
  if (m) m.classList.remove('hidden');
}
function _entryHintDefault(id) {
  var h = document.getElementById('bulk-entry-' + id + '-hint');
  if (h) { h.textContent = 'Type a name or select from your groups list.'; h.className = 'text-xs text-slate-400'; }
}
function _entryHintSelected(id) {
  var h = document.getElementById('bulk-entry-' + id + '-hint');
  if (h) {
    h.innerHTML = '<span class="inline-flex items-center gap-1 text-brand-600 font-semibold"><svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>Group selected — mark students below</span>';
    h.className = 'text-xs';
  }
}

/* ─── Student Roster ────────────────────────────────────────────────── */
function _renderEntryRoster(id) {
  var st = _bulkStates[id]; if (!st || !st.selectedGroup) return;
  var c  = document.getElementById('bulk-entry-' + id + '-roster-students'); if (!c) return;
  c.innerHTML = st.selectedGroup.students.map(function(s){ return _renderEntryStudentRow(id, s); }).join('');
  _updateEntryRosterSummary(id);
}

function _renderEntryStudentRow(id, student) {
  var st        = _bulkStates[id];
  var stObj     = (st && st.studentStates[student]) || { state: null, acCount: 0, reduceCount: 0 };
  var state     = stObj.state;
  var acCnt     = stObj.acCount || 0;
  var redCnt    = stObj.reduceCount || 0;
  var MAX_AC    = 10;

  var rowCls = 'flex items-center justify-between py-2.5 px-3 rounded-xl border transition-all duration-200 ' +
    (state === 'ac' ? 'bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200 shadow-sm shadow-emerald-100/50' :
     state === 'reduce' ? 'bg-gradient-to-r from-rose-50 to-pink-50 border-rose-200 shadow-sm shadow-rose-100/50' :
     state === 'absent' ? 'bg-red-50 border-red-200' : 'bg-white border-slate-100 hover:border-slate-200');

  var nameCls = 'text-sm ' + (state === 'ac' ? 'text-emerald-800 font-semibold' : state === 'reduce' ? 'text-rose-800 font-semibold' : state === 'absent' ? 'text-red-700 font-medium' : 'text-slate-700');

  var icon = state === 'ac'
    ? '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd"/></svg></span>'
    : state === 'reduce'
    ? '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-rose-500 text-white flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15"/></svg></span>'
    : state === 'absent'
    ? '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-500 flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></span>'
    : '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 flex-shrink-0"><span class="w-1.5 h-1.5 rounded-full bg-slate-300"></span></span>';

  var acHtml = '';
  if (state === 'ac') {
    acHtml = '<div class="inline-flex items-center rounded-full bg-emerald-500 shadow-sm overflow-hidden">' +
        '<button type="button" ' + (acCnt > 1 ? '' : 'disabled ') + 'class="w-7 h-7 flex items-center justify-center text-sm font-bold ' + (acCnt > 1 ? 'text-white/90 hover:bg-emerald-600' : 'text-emerald-300 cursor-not-allowed') + '" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="remove">−</button>' +
        '<span class="px-1.5 text-[11px] font-bold text-white border-x border-emerald-400/40 min-w-[38px] text-center leading-7">' + acCnt + ' AC</span>' +
        '<button type="button" ' + (acCnt < MAX_AC ? '' : 'disabled ') + 'class="w-7 h-7 flex items-center justify-center text-sm font-bold ' + (acCnt < MAX_AC ? 'text-white/90 hover:bg-emerald-600' : 'text-emerald-300 cursor-not-allowed') + '" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="add">+</button>' +
      '</div>' +
      '<button type="button" class="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-500" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="clear-ac"><svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>';
  } else if (state === 'reduce') {
    acHtml = '<div class="inline-flex items-center rounded-full bg-rose-500 shadow-sm overflow-hidden">' +
        '<button type="button" ' + (redCnt > 1 ? '' : 'disabled ') + 'class="w-7 h-7 flex items-center justify-center text-sm font-bold ' + (redCnt > 1 ? 'text-white/90 hover:bg-rose-600' : 'text-rose-300 cursor-not-allowed') + '" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="reduce-minus">−</button>' +
        '<span class="px-1.5 text-[11px] font-bold text-white border-x border-rose-400/40 min-w-[38px] text-center leading-7">' + redCnt + ' −AC</span>' +
        '<button type="button" ' + (redCnt < MAX_AC ? '' : 'disabled ') + 'class="w-7 h-7 flex items-center justify-center text-sm font-bold ' + (redCnt < MAX_AC ? 'text-white/90 hover:bg-rose-600' : 'text-rose-300 cursor-not-allowed') + '" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="reduce-add">+</button>' +
      '</div>' +
      '<button type="button" class="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-500" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="clear-reduce"><svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>';
  } else {
    acHtml = '<button type="button" class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full border border-emerald-200 bg-white text-emerald-600 hover:bg-emerald-500 hover:text-white hover:border-emerald-500 active:scale-95 transition-all" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="ac">' +
        '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd"/></svg>' +
        '+AC</button>' +
      '<button type="button" class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full border border-rose-200 bg-white text-rose-600 hover:bg-rose-500 hover:text-white hover:border-rose-500 active:scale-95 transition-all" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="reduce">' +
        '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15"/></svg>' +
        '−AC</button>';
  }

  var absCls = 'inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full transition-all duration-200 ' +
    (state === 'absent' ? 'bg-red-500 text-white shadow-sm border border-red-500' : 'border border-slate-200 bg-white text-slate-400 hover:border-red-300 hover:text-red-500 active:scale-95');

  return '<div class="' + rowCls + '">' +
    '<div class="flex items-center gap-2 min-w-0">' + icon + '<span class="' + nameCls + ' truncate">' + escHtml(student) + '</span></div>' +
    '<div class="flex items-center gap-1.5 flex-shrink-0">' + acHtml +
      '<button type="button" class="' + absCls + '" data-beid="' + id + '" data-student="' + escHtml(student) + '" data-role="absent">Absent</button>' +
    '</div></div>';
}

function toggleEntryStudent(id, student, role) {
  var st   = _bulkStates[id]; if (!st) return;
  var stObj = st.studentStates[student] || { state: null, acCount: 0, reduceCount: 0 };
  if (role === 'ac')            { stObj.state = 'ac'; stObj.acCount = 1; stObj.reduceCount = 0; }
  else if (role === 'add')      { if (stObj.state === 'ac' && stObj.acCount < 10) stObj.acCount++; }
  else if (role === 'remove')   { if (stObj.state === 'ac' && stObj.acCount > 1) stObj.acCount--; }
  else if (role === 'clear-ac') { stObj.state = null; stObj.acCount = 0; }
  else if (role === 'reduce')   { stObj.state = 'reduce'; stObj.reduceCount = 1; stObj.acCount = 0; }
  else if (role === 'reduce-add') { if (stObj.state === 'reduce' && stObj.reduceCount < 10) stObj.reduceCount++; }
  else if (role === 'reduce-minus') { if (stObj.state === 'reduce' && stObj.reduceCount > 1) stObj.reduceCount--; }
  else if (role === 'clear-reduce') { stObj.state = null; stObj.reduceCount = 0; }
  else if (role === 'absent')   { stObj.state = stObj.state === 'absent' ? null : 'absent'; stObj.acCount = 0; stObj.reduceCount = 0; }
  st.studentStates[student] = stObj;
  _renderEntryRoster(id);
}

function markAllEntry(id, role) {
  var st = _bulkStates[id]; if (!st || !st.selectedGroup) return;
  st.selectedGroup.students.forEach(function(s) {
    if (role === 'clear')       st.studentStates[s] = { state: null, acCount: 0, reduceCount: 0 };
    else if (role === 'ac')     st.studentStates[s] = { state: 'ac', acCount: 1, reduceCount: 0 };
    else if (role === 'reduce') st.studentStates[s] = { state: 'reduce', acCount: 0, reduceCount: 1 };
    else if (role === 'absent') st.studentStates[s] = { state: 'absent', acCount: 0, reduceCount: 0 };
  });
  _renderEntryRoster(id);
}

function _updateEntryRosterSummary(id) {
  var st   = _bulkStates[id]; if (!st) return;
  var vals = Object.values(st.studentStates);
  var acCnt   = vals.filter(function(v){ return v.state === 'ac'; }).length;
  var totalAc = vals.reduce(function(s,v){ return s + (v.state==='ac' ? v.acCount : 0); }, 0);
  var redCnt  = vals.filter(function(v){ return v.state === 'reduce'; }).length;
  var totalRed = vals.reduce(function(s,v){ return s + (v.state==='reduce' ? (v.reduceCount || 1) : 0); }, 0);
  var absCnt  = vals.filter(function(v){ return v.state === 'absent'; }).length;
  var el = document.getElementById('bulk-entry-' + id + '-roster-summary'); if (!el) return;
  var parts = [];
  if (acCnt > 0) { var t = acCnt + ' +AC'; if (totalAc > acCnt) t += ' (' + totalAc + ' total)'; parts.push('<span class="text-emerald-600 font-semibold">' + t + '</span>'); }
  if (redCnt > 0) { var rt = redCnt + ' −AC'; if (totalRed > redCnt) rt += ' (' + totalRed + ' total)'; parts.push('<span class="text-rose-600 font-semibold">' + rt + '</span>'); }
  if (absCnt > 0) parts.push('<span class="text-red-500 font-semibold">' + absCnt + ' Absent</span>');
  el.innerHTML = parts.length ? parts.join(' · ') : '<span class="text-slate-400">No marks yet</span>';
}

/* ─── Tag inputs (manual AC/Reduced AC/Absent) ─────────────────────── */
function _initBulkTagInput(id, type) {
  var inp = document.getElementById('bulk-entry-' + id + '-' + type + '-input'); if (!inp) return;
  function tryAdd() {
    var val = inp.value.replace(/,/g, '').trim(); if (!val) return;
    var st  = _bulkStates[id]; if (!st) return;
    var arr = type === 'ac' ? st.acTags : (type === 'ac-reduced' ? st.acReducedTags : st.absentTags);
    if (type === 'absent' && arr.indexOf(val) !== -1) { inp.value = ''; return; }
    arr.push(val); inp.value = ''; _renderEntryTagBox(id, type);
  }
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); tryAdd(); }
    else if (e.key === ',') { e.preventDefault(); tryAdd(); }
    else if (e.key === 'Backspace' && inp.value === '') {
      var st = _bulkStates[id]; if (!st) return;
      var arr = type === 'ac' ? st.acTags : (type === 'ac-reduced' ? st.acReducedTags : st.absentTags);
      if (arr.length) { arr.pop(); _renderEntryTagBox(id, type); }
    }
  });
  inp.addEventListener('blur', function(){ if (inp.value.trim()) tryAdd(); });
}

function _renderEntryTagBox(id, type) {
  var box  = document.getElementById('bulk-entry-' + id + '-' + type + '-box');
  var cntEl = document.getElementById('bulk-entry-' + id + '-' + type + '-count');
  var st   = _bulkStates[id]; if (!st || !box) return;
  var arr  = type === 'ac' ? st.acTags : (type === 'ac-reduced' ? st.acReducedTags : st.absentTags);
  var cls  = type === 'ac' ? 'bg-emerald-100 text-emerald-700' : (type === 'ac-reduced' ? 'bg-rose-100 text-rose-700' : 'bg-red-100 text-red-600');
  box.innerHTML = (arr || []).map(function(tag, i) {
    return '<span class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ' + cls + '">' +
      escHtml(tag) + ' <button type="button" class="ml-0.5 leading-none opacity-60 hover:opacity-100 transition text-sm" data-be-rm-id="' + id + '" data-be-rm-type="' + type + '" data-be-rm-idx="' + i + '">×</button></span>';
  }).join('');
  if (cntEl) cntEl.textContent = (arr || []).length;
  box.querySelectorAll('button[data-be-rm-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var bId  = parseInt(btn.getAttribute('data-be-rm-id'));
      var bTyp = btn.getAttribute('data-be-rm-type');
      var bIdx = parseInt(btn.getAttribute('data-be-rm-idx'));
      var bSt  = _bulkStates[bId]; if (!bSt) return;
      var bArr = bTyp === 'ac' ? bSt.acTags : (bTyp === 'ac-reduced' ? bSt.acReducedTags : bSt.absentTags);
      bArr.splice(bIdx, 1); _renderEntryTagBox(bId, bTyp);
    });
  });
}

/* ─── Entry init ────────────────────────────────────────────────────── */
function _initBulkEntry(id) {
  setEntrySessionType(id, 'group');
  setEntryMode(id, 'offline');
  _initBulkTagInput(id, 'ac');
  _initBulkTagInput(id, 'ac-reduced');
  _initBulkTagInput(id, 'absent');
  _initBulkEntryTeachingTypeListener(id);

  // Material autocomplete
  var bSubjInp = document.getElementById('bulk-entry-' + id + '-subject');
  var bSubjList = document.getElementById('bulk-entry-' + id + '-subject-mat-ac-list');
  if (bSubjInp && bSubjList && typeof attachMaterialAutocomplete === 'function') {
    attachMaterialAutocomplete(bSubjInp, bSubjList, function() {
      var st = _bulkStates[id];
      if (!st || st.sessionType === 'competition') return '';
      if (st.selectedGroup && st.selectedGroup.level) return st.selectedGroup.level;
      var bInp = document.getElementById('bulk-entry-' + id + '-class');
      if (bInp && bInp.value && typeof groupsData !== 'undefined' && Array.isArray(groupsData)) {
        var bVal = bInp.value.trim().toLowerCase();
        var bFound = groupsData.find(function(g) {
          return g.group_name && g.group_name.trim().toLowerCase() === bVal;
        });
        if (bFound && bFound.level) return bFound.level;
      }
      return '';
    });
  }

  // Roster click delegation
  var rosterEl = document.getElementById('bulk-entry-' + id + '-roster-students');
  if (rosterEl) {
    rosterEl.addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      var beid    = parseInt(btn.getAttribute('data-beid'));
      var student = btn.getAttribute('data-student');
      var role    = btn.getAttribute('data-role');
      if (!isNaN(beid) && student && role) toggleEntryStudent(beid, student, role);
    });
  }

  // Close dropdown on outside click
  document.addEventListener('click', function(e) {
    if (!e.target.closest('#bulk-entry-' + id + '-group-wrap')) _hideEntryDropdown(id);
    if (!e.target.closest('#bulk-entry-' + id + '-pt-wrap')) _hideBulkPtDropdown(id);
  });

  // PT input listeners
  var ptDisp = document.getElementById('bulk-entry-' + id + '-pt-display');
  if (ptDisp) {
    ptDisp.addEventListener('input', function() { _bulkPtInput(id, this.value); });
    ptDisp.addEventListener('focus', function() { _bulkPtFocus(id); });
    ptDisp.addEventListener('blur', function() { _bulkPtBlur(id, this.value); });
    ptDisp.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' || e.key === 'Tab') _hideBulkPtDropdown(id);
    });
  }

  // Class input listeners
  var clsInp = document.getElementById('bulk-entry-' + id + '-class-name');
  if (clsInp) {
    clsInp.addEventListener('input', function() { _entryClassInput(id, this.value); });
    clsInp.addEventListener('focus', function() { _entryClassFocus(id); });
    clsInp.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' || e.key === 'Tab') _hideEntryDropdown(id);
    });
  }
}

/* ─── Collect entry data ────────────────────────────────────────────── */
function _getEntryData(id) {
  var st = _bulkStates[id]; if (!st) return null;
  var inp       = document.getElementById('bulk-entry-' + id + '-class-name');
  var className = inp ? inp.value.trim() : '';
  if (st.selectedGroup) className = st.selectedGroup.group_name;

  var acStudents = [], acReducedStudents = [], absentStudents = [];
  if (st.selectedGroup) {
    Object.keys(st.studentStates).forEach(function(s) {
      var stObj = st.studentStates[s];
      if (stObj.state === 'ac')          { for (var i = 0; i < stObj.acCount; i++) acStudents.push(s); }
      else if (stObj.state === 'reduce') { for (var j = 0; j < (stObj.reduceCount || 1); j++) acReducedStudents.push(s); }
      else if (stObj.state === 'absent') absentStudents.push(s);
    });
  } else {
    acStudents        = (st.acTags || []).slice();
    acReducedStudents = (st.acReducedTags || []).slice();
    absentStudents    = (st.absentTags || []).slice();
  }

  var dateEl    = document.getElementById('bulk-entry-' + id + '-date');
  var typeEl    = document.getElementById('bulk-entry-' + id + '-teaching-type');
  var durEl     = document.getElementById('bulk-entry-' + id + '-duration');
  var teacherEl = document.getElementById('bulk-entry-' + id + '-teacher');
  var subjEl    = document.getElementById('bulk-entry-' + id + '-subject');
  var notesEl   = document.getElementById('bulk-entry-' + id + '-notes');
  var piCheck   = document.getElementById('bulk-entry-' + id + '-pi-check');
  var ptHidden  = document.getElementById('bulk-entry-' + id + '-pt-hidden');
  var ptNameHid = document.getElementById('bulk-entry-' + id + '-pt-name-hidden');

  return {
    date:                   dateEl    ? dateEl.value    : _bulkToday,
    teaching_type:          typeEl    ? typeEl.value    : '',
    duration:               durEl     ? durEl.value     : '',
    teacher:                teacherEl ? teacherEl.value : '',
    class_name:             className,
    session_type:           st.sessionType,
    session_mode:           st.sessionMode,
    uses_personal_internet: piCheck ? piCheck.checked : false,
    subject:                subjEl  ? subjEl.value.trim()  : '',
    notes:                  notesEl ? notesEl.value.trim() : '',
    ac_students:            acStudents,
    ac_reduced_students:    acReducedStudents,
    absent_students:        absentStudents,
    competition_groups:     [],
    partner_teacher:        ptHidden  ? ptHidden.value  : '',
    partner_teacher_name:   ptNameHid ? ptNameHid.value : '',
  };
}

function _getMainEntryData() {
  var form = document.getElementById('report-form'); if (!form) return null;
  var sessionType = (document.getElementById('session_type_input') || {}).value || 'group';
  var sessionMode = (document.getElementById('session_mode_input') || {}).value || 'offline';
  var className   = '';
  if (sessionType === 'competition') {
    className = '';
  } else if (sessionType === 'private') {
    var pvInp = document.getElementById('private_name_input');
    className = pvInp ? pvInp.value.trim() : '';
  } else {
    var cnInp = document.getElementById('class_name');
    className = cnInp ? cnInp.value.trim() : '';
  }
  var piCheck         = document.getElementById('personal_internet_check');
  var subjectEl       = document.getElementById('subject');
  var notesEl         = document.getElementById('notes');
  var acHidden        = document.getElementById('ac-hidden');
  var acReducedHidden = document.getElementById('ac-reduced-hidden');
  var absHidden       = document.getElementById('absent-hidden');
  var compHidden      = document.getElementById('competition_groups_hidden');
  var csrfEl          = form.querySelector('[name="_csrf"]');
  var dateEl          = form.querySelector('[name="date"]');
  var typeEl          = form.querySelector('[name="teaching_type"]');
  var durEl           = form.querySelector('[name="duration"]');
  var teacherEl       = form.querySelector('[name="teacher"]');
  var ptHidden        = document.getElementById('partner_teacher_hidden');
  var ptNameHid       = document.getElementById('partner_teacher_name_hidden');
  return {
    _csrf:                  csrfEl    ? csrfEl.value    : '',
    date:                   dateEl    ? dateEl.value    : '',
    teaching_type:          typeEl    ? typeEl.value    : '',
    duration:               durEl     ? durEl.value     : '',
    teacher:                teacherEl ? teacherEl.value : '',
    class_name:             className,
    session_type:           sessionType,
    session_mode:           sessionMode,
    uses_personal_internet: piCheck ? piCheck.checked : false,
    subject:                subjectEl ? subjectEl.value.trim() : '',
    notes:                  notesEl   ? notesEl.value.trim()   : '',
    ac_students:            acHidden        ? acHidden.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [],
    ac_reduced_students:    acReducedHidden ? acReducedHidden.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [],
    absent_students:        absHidden       ? absHidden.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [],
    competition_groups:     compHidden ? compHidden.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [],
    partner_teacher:        ptHidden  ? ptHidden.value  : '',
    partner_teacher_name:   ptNameHid ? ptNameHid.value : '',
  };
}

/* ─── Bulk Submit ───────────────────────────────────────────────────── */

/* ─── Bulk Partner Teacher helpers ─────────────────────────────────── */
function _hideBulkPtDropdown(id) {
  var d = document.getElementById('bulk-entry-' + id + '-pt-dropdown');
  if (d) d.classList.add('hidden');
}
function _clearBulkPt(id, silent) {
  var disp    = document.getElementById('bulk-entry-' + id + '-pt-display');
  var hidden  = document.getElementById('bulk-entry-' + id + '-pt-hidden');
  var nameHid = document.getElementById('bulk-entry-' + id + '-pt-name-hidden');
  var pill    = document.getElementById('bulk-entry-' + id + '-pt-pill');
  var clrBtn  = document.getElementById('bulk-entry-' + id + '-pt-clear');
  if (disp)    disp.value    = '';
  if (hidden)  hidden.value  = '';
  if (nameHid) nameHid.value = '';
  if (pill)    pill.classList.add('hidden');
  if (clrBtn)  clrBtn.classList.add('hidden');
  _hideBulkPtDropdown(id);
}

function _getBulkTeacherId(id) {
  var tSel = document.getElementById('bulk-entry-' + id + '-teacher');
  if (tSel && tSel.value) return tSel.value;
  return _currentUserInfo ? _currentUserInfo.id : '';
}

function _selectBulkPt(id, teacher) {
  var tid = _getBulkTeacherId(id);
  if (_isSelfTeacher(teacher._id, teacher.displayName, tid)) {
    return;
  }
  var disp    = document.getElementById('bulk-entry-' + id + '-pt-display');
  var hidden  = document.getElementById('bulk-entry-' + id + '-pt-hidden');
  var nameHid = document.getElementById('bulk-entry-' + id + '-pt-name-hidden');
  var pill    = document.getElementById('bulk-entry-' + id + '-pt-pill');
  var pillNm  = document.getElementById('bulk-entry-' + id + '-pt-pill-name');
  var clrBtn  = document.getElementById('bulk-entry-' + id + '-pt-clear');
  if (disp)    disp.value    = teacher.displayName;
  if (hidden)  hidden.value  = teacher._id;
  if (nameHid) nameHid.value = teacher.displayName;
  if (pill)    pill.classList.remove('hidden');
  if (pillNm)  pillNm.textContent = teacher.displayName;
  if (clrBtn)  clrBtn.classList.remove('hidden');
  _hideBulkPtDropdown(id);
}
function _renderBulkPtDropdown(id, list) {
  var dropdown = document.getElementById('bulk-entry-' + id + '-pt-dropdown');
  if (!dropdown) return;
  if (!list.length) { dropdown.classList.add('hidden'); return; }
  dropdown.innerHTML = list.slice(0, 8).map(function(t) {
    return '<button type="button" data-action="selectBulkPt" data-entry-id="' + id + '" data-teacher-id="' + escHtml(t._id) + '" data-teacher-name="' + escHtml(t.displayName) + '" ' +
      'class="w-full text-left px-4 py-3 hover:bg-sky-50 transition flex items-center justify-between gap-3">' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-semibold text-slate-800 truncate">' + escHtml(t.displayName) + '</p>' +
        '<p class="text-xs text-slate-400 truncate">@' + escHtml(t.username) + '</p>' +
      '</div>' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-sky-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>' +
    '</button>';
  }).join('');
  dropdown.classList.remove('hidden');
}
function _bulkPtInput(id, val) {
  var nameHid = document.getElementById('bulk-entry-' + id + '-pt-name-hidden');
  var hidden  = document.getElementById('bulk-entry-' + id + '-pt-hidden');
  var pill    = document.getElementById('bulk-entry-' + id + '-pt-pill');
  var clrBtn  = document.getElementById('bulk-entry-' + id + '-pt-clear');
  if (nameHid) nameHid.value = val.trim();
  if (hidden && hidden.value) { hidden.value = ''; if (pill) pill.classList.add('hidden'); }
  if (clrBtn) { if (val.trim()) clrBtn.classList.remove('hidden'); else clrBtn.classList.add('hidden'); }
  if (!val.trim()) { _hideBulkPtDropdown(id); return; }
  var ql = val.toLowerCase();
  _renderBulkPtDropdown(id, teachersData.filter(function(t){
    return t.displayName.toLowerCase().includes(ql) || t.username.toLowerCase().includes(ql);
  }));
}
function _bulkPtFocus(id) {
  var disp = document.getElementById('bulk-entry-' + id + '-pt-display');
  if (!disp || disp.value.trim()) return;
  if (teachersData.length) _renderBulkPtDropdown(id, teachersData);
}
function _bulkPtBlur(id, val) {
  var nameHid = document.getElementById('bulk-entry-' + id + '-pt-name-hidden');
  if (nameHid) nameHid.value = val.trim();
}

function _updateBulkPtLabels(id, type) {
  var lbl = document.getElementById('bulk-entry-' + id + '-pt-label');
  var sub = document.getElementById('bulk-entry-' + id + '-pt-subtext');
  if (type === 'Assistant Teacher') {
    if (lbl) lbl.innerHTML = 'Prime Teacher <span class="text-red-500">*</span>';
    if (sub) sub.textContent = 'Tag the Prime Teacher. Search by name or type manually.';
  } else if (type === '1/2 Prime Teacher') {
    if (lbl) lbl.innerHTML = '1/2 Partner Teacher <span class="text-red-500">*</span>';
    if (sub) sub.textContent = 'Tag the partner 1/2 Prime Teacher. Search by name or type manually.';
  }
}

/* Hook up teaching type change for bulk entries — called after DOM insert */
function _initBulkEntryTeachingTypeListener(id) {
  var typeEl = document.getElementById('bulk-entry-' + id + '-teaching-type');
  if (!typeEl) return;
  typeEl.addEventListener('change', function() {
    var section = document.getElementById('bulk-entry-' + id + '-pt-section');
    if (!section) return;
    if (this.value === 'Assistant Teacher' || this.value === '1/2 Prime Teacher') {
      _updateBulkPtLabels(id, this.value);
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
      _clearBulkPt(id, true);
    }
  });
}

async function submitBulkReports() {
  var bulkBtn  = document.getElementById('btn-submit-bulk');
  var mainBtn  = document.getElementById('btn-main-submit');
  var total    = 1 + _bulkIds.length;
  var saving   = 'Saving\u2026';
  if (bulkBtn) { bulkBtn.disabled = true; document.getElementById('bulk-submit-text').textContent = saving; }
  if (mainBtn) { mainBtn.disabled = true; document.getElementById('btn-submit-text').textContent  = saving; }

  var mainData  = _getMainEntryData();
  var extraData = _bulkIds.map(function(id){ return _getEntryData(id); });
  var errors    = [];

  // Validate main entry
  if (mainData.session_type === 'competition') {
    if (!mainData.competition_groups || mainData.competition_groups.length < 2) {
      errors.push('Report 1: Select at least 2 groups for the competition.');
    }
  } else {
    if (!mainData.class_name)    errors.push('Report 1: Class name is required.');
  }
  if (!mainData.teaching_type) errors.push('Report 1: Teaching type is required.');
  if (!mainData.duration)      errors.push('Report 1: Duration is required.');
  if (mainData.teaching_type === 'Assistant Teacher' || mainData.teaching_type === '1/2 Prime Teacher') {
    if (!mainData.partner_teacher_name) {
      var ptRole = mainData.teaching_type === 'Assistant Teacher' ? 'Prime Teacher' : 'Partner Teacher';
      errors.push('Report 1: ' + ptRole + ' name is required.');
    } else if (_isSelfTeacher(mainData.partner_teacher, mainData.partner_teacher_name, _getCurrentTeacherId())) {
      errors.push('Report 1: You cannot tag yourself as the partner teacher.');
    }
  }

  // Validate each extra entry independently
  extraData.forEach(function(d, i) {
    var label = 'Report ' + (i + 2);
    if (d && d.session_type === 'competition') {
      if (!d.competition_groups || d.competition_groups.length < 2) {
        errors.push(label + ': Select at least 2 groups for the competition.');
      }
    } else {
      if (!d || !d.class_name)    errors.push(label + ': Class name is required.');
    }
    if (!d || !d.teaching_type) errors.push(label + ': Teaching type is required.');
    if (!d || !d.duration)      errors.push(label + ': Duration is required.');
    if (d && (d.teaching_type === 'Assistant Teacher' || d.teaching_type === '1/2 Prime Teacher')) {
      var cardTeacherId = d.teacher || _getBulkTeacherId(_bulkIds[i]);
      if (!d.partner_teacher_name) {
        var dRole = d.teaching_type === 'Assistant Teacher' ? 'Prime Teacher' : 'Partner Teacher';
        errors.push(label + ': ' + dRole + ' name is required.');
      } else if (_isSelfTeacher(d.partner_teacher, d.partner_teacher_name, cardTeacherId)) {
        errors.push(label + ': You cannot tag yourself as the partner teacher.');
      }
    }
  });

  if (errors.length) {
    _showBulkErrors(errors);
    if (bulkBtn) { bulkBtn.disabled = false; document.getElementById('bulk-submit-text').textContent = 'Save ' + total + ' Reports'; }
    if (mainBtn) { mainBtn.disabled = false; document.getElementById('btn-submit-text').textContent  = 'Save ' + total + ' Reports'; }
    return;
  }

  // Hide previous errors
  var errEl = document.getElementById('bulk-errors'); if (errEl) errEl.classList.add('hidden');
  var errListEl = document.getElementById('bulk-error-list'); if (errListEl) errListEl.innerHTML = '';

  try {
    // Each entry carries its own date / teaching_type / duration / teacher
    var res = await fetch('/reports/bulk', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': mainData._csrf },
      body:    JSON.stringify({ entries: [mainData].concat(extraData) })
    });
    var json = await res.json();
    if (json.ok) {
      window.__isDraftDisabled = true;
      window.__isSubmitting = true;
      window.__bulkSubmitting = true;
      if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
      if (typeof clearDraft === 'function') clearDraft();
      try { sessionStorage.setItem('dtr_draft_discarded', '1'); } catch(e) {}
      window.location.href = '/reports';
    } else {
      _showBulkErrors(json.errors || ['An error occurred. Please try again.']);
      if (bulkBtn) { bulkBtn.disabled = false; document.getElementById('bulk-submit-text').textContent = 'Save ' + total + ' Reports'; }
      if (mainBtn) { mainBtn.disabled = false; document.getElementById('btn-submit-text').textContent  = 'Save ' + total + ' Reports'; }
    }
  } catch (err) {
    _showBulkErrors(['Network error. Please try again.']);
    if (bulkBtn) { bulkBtn.disabled = false; document.getElementById('bulk-submit-text').textContent = 'Save ' + total + ' Reports'; }
    if (mainBtn) { mainBtn.disabled = false; document.getElementById('btn-submit-text').textContent  = 'Save ' + total + ' Reports'; }
  }
}

function _showBulkErrors(errors) {
  var el   = document.getElementById('bulk-errors');
  var list = document.getElementById('bulk-error-list');
  if (!el || !list) return;
  list.innerHTML = errors.map(function(e){ return '<li>' + escHtml(String(e)) + '</li>'; }).join('');
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ─── Intercept main form submit when extra entries exist ───────────── */
document.getElementById('report-form').addEventListener('submit', function(e) {
  if (_bulkIds.length > 0) {
    e.preventDefault();
    submitBulkReports();
  } else {
    var sessionType = (document.getElementById('session_type_input') || {}).value;
    if (sessionType === 'competition') {
      var compHidden = document.getElementById('competition_groups_hidden');
      var compGroups = compHidden && compHidden.value ? compHidden.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [];
      if (compGroups.length < 2) {
        e.preventDefault();
        e.stopPropagation();
        var searchInp = document.getElementById('competition-search');
        var errEl = document.getElementById('competition-error');
        var typed = searchInp ? searchInp.value.trim() : '';
        var msg = typed ? 'Choose the group from the list.' : 'Select at least 2 groups for the competition.';
        if (errEl) {
          errEl.textContent = msg;
          errEl.classList.remove('hidden');
        }
        if (searchInp) {
          searchInp.focus();
          if (typeof searchInp.scrollIntoView === 'function') {
            searchInp.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
        return false;
      }
    }
    window.__isDraftDisabled = true;
    window.__isSubmitting = true;
    if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
    if (typeof clearDraft === 'function') clearDraft();
    try { sessionStorage.setItem('dtr_draft_discarded', '1'); } catch(e) {}
  }
});

/* ─── HTML template for extra entry cards ───────────────────────────── */
function _buildEntryHtml(id, num) {
  // Build teaching type <option> list from server data
  var typeOpts = '<option value="" disabled selected>\u2014 Select type \u2014</option>' +
    _bulkTeachingTypes.map(function(t) {
      return '<option value="' + escHtml(t) + '">' + escHtml(t) + '</option>';
    }).join('');

  // Build teacher selector (admin only)
  var teacherBlock = '';
  if (_bulkIsAdmin && _bulkTeachers.length > 0) {
    var teacherOpts = '<option value="" disabled selected>\u2014 Select teacher \u2014</option>' +
      _bulkTeachers.map(function(t) {
        return '<option value="' + escHtml(t._id) + '">' + escHtml(t.displayName || t.username) + '</option>';
      }).join('');
    teacherBlock =
      '<div class="space-y-1.5">' +
        '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Teacher <span class="text-red-500">*</span></label>' +
        '<select id="bulk-entry-' + id + '-teacher" class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition">' +
          teacherOpts +
        '</select>' +
      '</div>';
  }

  return '<div id="bulk-entry-' + id + '" class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden" style="transition:opacity 0.2s,transform 0.2s">' +

    /* \u2500\u2500 Header \u2500\u2500 */
    '<div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-gradient-to-r from-slate-50 to-white">' +
      '<div class="flex items-center gap-2.5">' +
        '<span id="bulk-entry-' + id + '-num" class="w-7 h-7 rounded-full bg-brand-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">' + num + '</span>' +
        '<div>' +
          '<p class="text-sm font-semibold text-slate-800" id="bulk-entry-' + id + '-title">Report ' + num + '</p>' +
          '<p class="text-xs text-slate-400 mt-0.5">Fill in all fields for this class</p>' +
        '</div>' +
      '</div>' +
      '<button type="button" data-action="removeBulkEntry" data-entry-id="' + id + '" class="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-red-500 transition px-2.5 py-1.5 rounded-lg hover:bg-red-50">' +
        '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>Remove' +
      '</button>' +
    '</div>' +

    /* \u2500\u2500 Body \u2500\u2500 */
    '<div class="px-6 py-5 space-y-5">' +

      /* \u2500\u2500 Date / Teaching Type / Duration \u2500\u2500 */
      '<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">' +
        '<div class="space-y-1.5">' +
          '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Teaching Date <span class="text-red-500">*</span></label>' +
          '<input type="date" id="bulk-entry-' + id + '-date" value="' + _bulkToday + '"' +
            ' class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 font-mono focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition"/>' +
        '</div>' +
        '<div class="space-y-1.5">' +
          '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Teaching Type <span class="text-red-500">*</span></label>' +
          '<select id="bulk-entry-' + id + '-teaching-type"' +
            ' class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition">' +
            typeOpts +
          '</select>' +
        '</div>' +
        '<div class="space-y-1.5">' +
          '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Duration <span class="text-red-500">*</span></label>' +
          '<div class="relative">' +
            '<input type="number" id="bulk-entry-' + id + '-duration" min="1" max="480" placeholder="e.g: 60" value="60"' +
              ' class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 pr-14 text-sm text-slate-800 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition"/>' +
            '<span class="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">min</span>' +
          '</div>' +
        '</div>' +
      '</div>' +

      /* \u2500\u2500 Teacher (admin only) \u2500\u2500 */
      (teacherBlock ? '<div class="sm:max-w-xs">' + teacherBlock + '</div>' : '') +

      /* \u2500\u2500 Partner Teacher (shown when teaching type = Assistant Teacher) \u2500\u2500 */
      '<div id="bulk-entry-' + id + '-pt-section" class="hidden">' +
        '<div class="rounded-2xl border border-sky-200 bg-sky-50/40 p-4 space-y-3">' +
          '<div class="flex items-center gap-2">' +
            '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"/></svg>' +
            '<label id="bulk-entry-' + id + '-pt-label" class="block text-xs font-semibold text-sky-700 uppercase tracking-wider">Prime Teacher <span class="text-red-500">*</span></label>' +
          '</div>' +
          '<p id="bulk-entry-' + id + '-pt-subtext" class="text-xs text-sky-500 -mt-1">Tag the Prime Teacher. Search by name or type manually.</p>' +
          '<div class="relative" id="bulk-entry-' + id + '-pt-wrap">' +
            '<input type="text" id="bulk-entry-' + id + '-pt-display" placeholder="Search registered teachers\u2026" autocomplete="off"' +
              ' class="w-full rounded-xl border border-sky-200 bg-white px-4 py-2.5 pr-10 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition"/>' +
            '<button type="button" id="bulk-entry-' + id + '-pt-clear" data-action="clearBulkPt" data-entry-id="' + id + '" class="hidden absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-500 transition">' +
              '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
            '</button>' +
            '<div id="bulk-entry-' + id + '-pt-dropdown" class="hidden absolute z-30 left-0 right-0 top-full mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden divide-y divide-slate-50 max-h-52 overflow-y-auto"></div>' +
          '</div>' +
          '<div id="bulk-entry-' + id + '-pt-pill" class="hidden">' +
            '<div class="inline-flex items-center gap-2 text-xs font-semibold bg-sky-100 text-sky-700 px-3 py-1.5 rounded-full">' +
              '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>' +
              '<span id="bulk-entry-' + id + '-pt-pill-name"></span>' +
              '<span class="text-sky-400 text-[10px] font-normal">\u00b7 Registered</span>' +
            '</div>' +
          '</div>' +
          '<input type="hidden" id="bulk-entry-' + id + '-pt-hidden" value="">' +
          '<input type="hidden" id="bulk-entry-' + id + '-pt-name-hidden" value="">' +
        '</div>' +
      '</div>' +

      /* \u2500\u2500 Divider \u2500\u2500 */
      '<div class="border-t border-slate-100"></div>' +

      /* \u2500\u2500 Class Name \u2500\u2500 */
      '<div class="space-y-1.5">' +
        '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Group / Class Name <span class="text-red-500">*</span></label>' +
        '<div id="bulk-entry-' + id + '-group-wrap" class="relative">' +
          '<input type="text" id="bulk-entry-' + id + '-class-name" placeholder="Type to search groups\u2026" autocomplete="off"' +
            ' class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 pr-10 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition"/>' +
          '<button type="button" id="bulk-entry-' + id + '-clear-btn" data-action="clearEntryGroup" data-entry-id="' + id + '" class="hidden absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-500 transition">' +
            '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
          '</button>' +
          '<div id="bulk-entry-' + id + '-dropdown" class="hidden absolute z-30 left-0 right-0 top-full mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden divide-y divide-slate-50 max-h-56 overflow-y-auto"></div>' +
        '</div>' +
        '<p id="bulk-entry-' + id + '-hint" class="text-xs text-slate-400">Type a name or select from your groups list.</p>' +
      '</div>' +

      /* \u2500\u2500 Session Type & Mode \u2500\u2500 */
      '<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">' +
        '<div class="space-y-2"><label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Session Type</label>' +
          '<div class="flex gap-2">' +
            '<button type="button" id="bulk-entry-' + id + '-btn-group"   data-action="setEntrySessionType" data-entry-id="' + id + '" data-type="group"   class="flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition">Group</button>' +
            '<button type="button" id="bulk-entry-' + id + '-btn-private" data-action="setEntrySessionType" data-entry-id="' + id + '" data-type="private" class="flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition">Private</button>' +
          '</div>' +
          '<p class="text-[11px] text-slate-400 mt-1">Competition reports: use the main form (add other reports one at a time).</p>' +
        '</div>' +
        '<div class="space-y-2"><label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Class Mode</label>' +
          '<div class="flex gap-2">' +
            '<button type="button" id="bulk-entry-' + id + '-btn-offline" data-action="setEntryMode" data-entry-id="' + id + '" data-mode="offline" class="flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition">Offline</button>' +
            '<button type="button" id="bulk-entry-' + id + '-btn-online"  data-action="setEntryMode" data-entry-id="' + id + '" data-mode="online"  class="flex-1 py-2 rounded-xl border-2 text-xs font-semibold transition">Online</button>' +
          '</div></div>' +
      '</div>' +

      /* \u2500\u2500 Personal Internet \u2500\u2500 */
      '<div id="bulk-entry-' + id + '-pi-wrap" class="hidden">' +
        '<label class="flex items-center gap-3 cursor-pointer bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">' +
          '<input type="checkbox" id="bulk-entry-' + id + '-pi-check" class="w-4 h-4 rounded border-blue-300 text-blue-600 focus:ring-blue-200 flex-shrink-0">' +
          '<div><p class="text-sm font-semibold text-blue-700">Personal Internet</p><p class="text-xs text-blue-400 mt-0.5">Using own data / wifi</p></div>' +
        '</label>' +
      '</div>' +

      /* \u2500\u2500 Subject \u2500\u2500 */
      '<div class="space-y-1.5">' +
        '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Material <span class="ml-1 font-normal normal-case text-slate-400">\u2014 optional</span></label>' +
        '<div class="mat-ac-wrap">' +
          '<input type="text" id="bulk-entry-' + id + '-subject" placeholder="e.g: Folder AA-BB" autocomplete="off" maxlength="100" class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition"/>' +
          '<div id="bulk-entry-' + id + '-subject-mat-ac-list" class="mat-ac-list" role="listbox" aria-label="Material suggestions"></div>' +
        '</div>' +
      '</div>' +

      /* \u2500\u2500 Notes \u2500\u2500 */
      '<div class="space-y-1.5">' +
        '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Notes</label>' +
        '<textarea id="bulk-entry-' + id + '-notes" rows="2" placeholder="Notes for this class\u2026" class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition resize-none"></textarea>' +
      '</div>' +

      /* \u2500\u2500 Student Roster \u2500\u2500 */
      '<div id="bulk-entry-' + id + '-roster" class="hidden">' +
        '<div class="rounded-2xl border border-brand-200 bg-brand-50/30 overflow-hidden">' +
          '<div class="px-5 py-3.5 border-b border-brand-100 flex items-center justify-between flex-wrap gap-2">' +
            '<div><p class="text-xs font-semibold text-brand-500 uppercase tracking-wider">Students from</p><h3 id="bulk-entry-' + id + '-roster-name" class="text-sm font-bold text-slate-800 mt-0.5"></h3></div>' +
            '<div class="flex items-center gap-1.5">' +
              '<span id="bulk-entry-' + id + '-roster-summary" class="text-xs text-slate-500 mr-1"></span>' +
              '<button type="button" data-action="markAllEntry" data-entry-id="' + id + '" data-status="ac"     class="text-xs font-semibold bg-emerald-100 hover:bg-emerald-200 text-emerald-700 px-2.5 py-1.5 rounded-lg transition">All AC</button>' +
              '<button type="button" data-action="markAllEntry" data-entry-id="' + id + '" data-status="absent" class="text-xs font-semibold bg-red-100 hover:bg-red-200 text-red-600 px-2.5 py-1.5 rounded-lg transition">All Absent</button>' +
              '<button type="button" data-action="markAllEntry" data-entry-id="' + id + '" data-status="clear"  class="text-xs font-semibold bg-white hover:bg-slate-100 text-slate-500 border border-slate-200 px-2.5 py-1.5 rounded-lg transition">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div id="bulk-entry-' + id + '-roster-students" class="px-4 py-3 space-y-1.5 max-h-72 overflow-y-auto"></div>' +
        '</div>' +
      '</div>' +

      /* \u2500\u2500 Manual AC / Absent \u2500\u2500 */
      /* ─── Manual AC / Reduced AC / Absent ─── */
      '<div id="bulk-entry-' + id + '-manual">' +
        '<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">' +
          '<div class="space-y-1.5">' +
            '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Achievement Card (+AC)</label>' +
            '<p class="text-xs text-slate-400 -mt-1">Press <kbd class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono text-xs">Enter</kbd> or <kbd class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono text-xs">,</kbd> to add</p>' +
            '<div id="bulk-entry-' + id + '-ac-box" class="min-h-[44px] flex flex-wrap gap-1.5 items-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 cursor-text focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 transition" data-action="focusInput" data-target="' + 'bulk-entry-' + id + '-ac-input' + '"></div>' +
            '<input type="text" id="bulk-entry-' + id + '-ac-input" placeholder="e.g: Darren" autocomplete="off" class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition"/>' +
            '<p class="text-xs text-slate-400"><span id="bulk-entry-' + id + '-ac-count">0</span> student(s) added</p>' +
          '</div>' +
          '<div class="space-y-1.5">' +
            '<label class="block text-xs font-semibold text-rose-600 uppercase tracking-wider">AC Deductions (−AC)</label>' +
            '<p class="text-xs text-slate-400 -mt-1">Press <kbd class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono text-xs">Enter</kbd> or <kbd class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono text-xs">,</kbd> to add</p>' +
            '<div id="bulk-entry-' + id + '-ac-reduced-box" class="min-h-[44px] flex flex-wrap gap-1.5 items-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 cursor-text focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 transition" data-action="focusInput" data-target="' + 'bulk-entry-' + id + '-ac-reduced-input' + '"></div>' +
            '<input type="text" id="bulk-entry-' + id + '-ac-reduced-input" placeholder="e.g: Darren" autocomplete="off" class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100 transition"/>' +
            '<p class="text-xs text-slate-400"><span id="bulk-entry-' + id + '-ac-reduced-count">0</span> student(s) added</p>' +
          '</div>' +
          '<div class="space-y-1.5">' +
            '<label class="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Absent</label>' +
            '<p class="text-xs text-slate-400 -mt-1">Press <kbd class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono text-xs">Enter</kbd> or <kbd class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono text-xs">,</kbd> to add</p>' +
            '<div id="bulk-entry-' + id + '-absent-box" class="min-h-[44px] flex flex-wrap gap-1.5 items-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 cursor-text focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 transition" data-action="focusInput" data-target="' + 'bulk-entry-' + id + '-absent-input' + '"></div>' +
            '<input type="text" id="bulk-entry-' + id + '-absent-input" placeholder="e.g: Michael" autocomplete="off" class="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 placeholder-slate-300 focus:outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 transition"/>' +
            '<p class="text-xs text-slate-400"><span id="bulk-entry-' + id + '-absent-count">0</span> student(s) added</p>' +
          '</div>' +
        '</div>' +
      '</div>' +

    '</div>' + // end body
  '</div>'; // end card
}

/* ═══════════════════════════════════════════════════════════════════════
   DRAFT AUTO-SAVE & RESTORE ENGINE (Active on Add Report)
   ═══════════════════════════════════════════════════════════════════════ */
var _draftUserInfo = {};
try {
  _draftUserInfo = JSON.parse(document.getElementById('current-user-info').textContent || '{}');
} catch(e) {}
var DRAFT_KEY = 'dtr_report_draft_' + (_draftUserInfo.id || 'anonymous');
var _draftSaveTimer = null;
window.__isDraftDisabled = false;
window.__isSubmitting = false;

function saveDraft() {
  if (window.__isDraftDisabled || window.__isSubmitting || window.__bulkSubmitting || window.__isDraftRestoring) return;
  try {
    var form = document.getElementById('report-form');
    if (!form) return;

    var mainData = typeof _getMainEntryData === 'function' ? _getMainEntryData() : null;
    if (!mainData) return;

    // Check if there is any user-entered content
    var hasContent = false;
    if (mainData.class_name || mainData.subject || mainData.notes || mainData.teaching_type || mainData.duration) hasContent = true;
    if (mainData.ac_students && mainData.ac_students.length) hasContent = true;
    if (mainData.ac_reduced_students && mainData.ac_reduced_students.length) hasContent = true;
    if (mainData.absent_students && mainData.absent_students.length) hasContent = true;
    if (typeof competitionSelectedIds !== 'undefined' && competitionSelectedIds.length) hasContent = true;
    if (typeof _bulkIds !== 'undefined' && _bulkIds.length) hasContent = true;

    if (!hasContent) {
      return;
    }

    var draftPayload = {
      savedAt: new Date().toISOString(),
      mainData: mainData,
      selectedGroupId: (typeof selectedGroup !== 'undefined' && selectedGroup) ? selectedGroup._id : null,
      studentStates: (typeof studentStates !== 'undefined') ? studentStates : {},
      competitionSelectedIds: (typeof competitionSelectedIds !== 'undefined') ? competitionSelectedIds : [],
      extraEntries: (typeof _bulkIds !== 'undefined' && typeof _getEntryData === 'function')
        ? _bulkIds.map(function(id){ return _getEntryData(id); })
        : []
    };

    localStorage.setItem(DRAFT_KEY, JSON.stringify(draftPayload));
  } catch (err) {
    console.warn('Failed to auto-save draft:', err);
  }
}

window.triggerAutoSave = function() {
  if (window.__isDraftDisabled || window.__isSubmitting || window.__isDraftRestoring) return;
  if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(saveDraft, 350);
};

window.clearDraft = function() {
  try {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem('dtr_report_draft_anonymous');
  } catch(e) {}
};

window.discardDraft = function() {
  function proceed() {
    window.__isDraftDisabled = true;
    window.__isSubmitting = true;
    if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
    clearDraft();
    try { sessionStorage.setItem('dtr_draft_discarded', '1'); } catch(e) {}
    window.location.href = window.location.pathname;
  }
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      title: 'Discard Draft?',
      text: 'This will permanently remove your saved draft and reset the form.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      cancelButtonColor: '#64748b',
      confirmButtonText: 'Yes, discard',
      cancelButtonText: 'Keep draft',
      reverseButtons: true,
      customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' }
    }).then(function(res) {
      if (res.isConfirmed) proceed();
    });
  } else {
    if (confirm('Discard your saved draft?')) proceed();
  }
};

function restoreDraft() {
  try {
    if (sessionStorage.getItem('dtr_draft_discarded') === '1') {
      sessionStorage.removeItem('dtr_draft_discarded');
      clearDraft();
      return;
    }
  } catch(e) {}

  var raw = null;
  try { raw = localStorage.getItem(DRAFT_KEY); } catch(e) {}
  if (!raw) return;

  var draft = null;
  try { draft = JSON.parse(raw); } catch(e) { return; }
  if (!draft || !draft.mainData) return;

  // Don't restore if server already passed pre-populated form data due to validation error
  var form = document.getElementById('report-form');
  if (form && (form.dataset.className || form.dataset.notes || form.dataset.subject)) {
    return;
  }

  window.__isDraftRestoring = true;
  var d = draft.mainData;

  // 1. Session Type & Mode
  if (d.session_type) setSessionType(d.session_type);
  if (d.session_mode) setMode(d.session_mode);
  var pic = document.getElementById('personal_internet_check');
  if (pic) pic.checked = !!d.uses_personal_internet;

  // 2. Date, Teaching Type, Duration, Teacher
  var dateEl = form.querySelector('[name="date"]');
  if (dateEl && d.date) dateEl.value = d.date;

  var typeEl = document.getElementById('teaching_type');
  if (typeEl && d.teaching_type) {
    typeEl.value = d.teaching_type;
    typeEl.dispatchEvent(new Event('change'));
  }

  var durEl = document.getElementById('duration');
  if (durEl && d.duration) {
    durEl.value = d.duration;
    durEl.dispatchEvent(new Event('input'));
  }

  var teacherEl = document.getElementById('teacher');
  if (teacherEl && d.teacher) {
    teacherEl.value = d.teacher;
    teacherEl.dispatchEvent(new Event('change'));
  }

  // 3. Subject & Notes
  var subjEl = document.getElementById('subject');
  if (subjEl && d.subject) subjEl.value = d.subject;

  var notesEl = document.getElementById('notes');
  if (notesEl && d.notes) {
    notesEl.value = d.notes;
    notesEl.dispatchEvent(new Event('input'));
  }

  // 4. Partner Teacher
  if (d.partner_teacher || d.partner_teacher_name) {
    var ptDisp = document.getElementById('partner_teacher_display');
    var ptHid  = document.getElementById('partner_teacher_hidden');
    var ptNm   = document.getElementById('partner_teacher_name_hidden');
    var ptPill = document.getElementById('partner-teacher-pill');
    var ptPillNm = document.getElementById('partner-teacher-pill-name');
    var ptClr  = document.getElementById('btn-clear-partner-teacher');
    if (ptDisp) ptDisp.value = d.partner_teacher_name || '';
    if (ptHid)  ptHid.value  = d.partner_teacher || '';
    if (ptNm)   ptNm.value   = d.partner_teacher_name || '';
    if (d.partner_teacher && ptPill && ptPillNm) {
      ptPill.classList.remove('hidden');
      ptPillNm.textContent = d.partner_teacher_name || '';
    }
    if (ptClr && (d.partner_teacher || d.partner_teacher_name)) {
      ptClr.classList.remove('hidden');
    }
  }

  // 5. Group / Competition / Manual Roster
  if (d.session_type === 'competition') {
    setSessionType('competition');
    if (draft.competitionSelectedIds && draft.competitionSelectedIds.length) {
      competitionSelectedIds = draft.competitionSelectedIds.slice();
    } else if (d.competition_groups && d.competition_groups.length) {
      d.competition_groups.forEach(function(name) {
        var g = groupsData.find(function(x) { return x.group_name === name; });
        if (!g) {
          g = { _id: 'custom_' + encodeURIComponent(name), group_name: name, students: [], type: 'GROUP' };
          groupsData.push(g);
        }
        if (g && competitionSelectedIds.indexOf(g._id) === -1) {
          competitionSelectedIds.push(g._id);
        }
      });
    }
    renderCompetitionTags();
    renderCompetitionRoster();
    if (draft.studentStates) {
      studentStates = draft.studentStates;
      renderCompetitionRoster();
      updateHiddenInputs();
    }
  } else if (draft.selectedGroupId) {
    var matchGroup = groupsData.find(function(g){ return g._id === draft.selectedGroupId; });
    if (matchGroup) {
      selectGroup(matchGroup._id);
      if (draft.studentStates) {
        studentStates = draft.studentStates;
        renderRoster();
        updateHiddenInputs();
      }
    }
  } else {
    if (d.session_type === 'private') {
      setSessionType('private');
      var pvInp = document.getElementById('private_name_input');
      if (pvInp) pvInp.value = d.class_name || '';
    } else {
      setSessionType('group');
      var cnInp = document.getElementById('class_name');
      if (cnInp) cnInp.value = d.class_name || '';
    }
    if (acCtrl && d.ac_students) acCtrl.reset(d.ac_students);
    if (acReducedCtrl && d.ac_reduced_students) acReducedCtrl.reset(d.ac_reduced_students);
    if (absentCtrl && d.absent_students) absentCtrl.reset(d.absent_students);
  }

  // 6. Bulk Extra Entries (if any)
  if (draft.extraEntries && draft.extraEntries.length > 0) {
    draft.extraEntries.forEach(function(entryData) {
      addBulkEntry();
      var newId = _bulkIds[_bulkIds.length - 1];
      if (!newId) return;

      var bDate    = document.getElementById('bulk-entry-' + newId + '-date');
      var bType    = document.getElementById('bulk-entry-' + newId + '-teaching-type');
      var bDur     = document.getElementById('bulk-entry-' + newId + '-duration');
      var bTeacher = document.getElementById('bulk-entry-' + newId + '-teacher');
      var bSubj    = document.getElementById('bulk-entry-' + newId + '-subject');
      var bNotes   = document.getElementById('bulk-entry-' + newId + '-notes');
      var bPi      = document.getElementById('bulk-entry-' + newId + '-pi-check');

      if (bDate && entryData.date) bDate.value = entryData.date;
      if (bType && entryData.teaching_type) {
        bType.value = entryData.teaching_type;
        bType.dispatchEvent(new Event('change'));
      }
      if (bDur && entryData.duration) bDur.value = entryData.duration;
      if (bTeacher && entryData.teacher) bTeacher.value = entryData.teacher;
      if (bSubj && entryData.subject) bSubj.value = entryData.subject;
      if (bNotes && entryData.notes) bNotes.value = entryData.notes;
      if (bPi) bPi.checked = !!entryData.uses_personal_internet;

      setEntrySessionType(newId, entryData.session_type || 'group');
      setEntryMode(newId, entryData.session_mode || 'offline');

      var gMatch = groupsData.find(function(g){ return g.group_name === entryData.class_name; });
      if (gMatch) {
        selectEntryGroup(newId, gMatch._id);
        var bSt = _bulkStates[newId];
        if (bSt && bSt.studentStates) {
          (entryData.ac_students || []).forEach(function(s){
            if (bSt.studentStates[s]) {
              bSt.studentStates[s].state = 'ac';
              bSt.studentStates[s].acCount = (bSt.studentStates[s].acCount || 0) + 1;
            }
          });
          (entryData.ac_reduced_students || []).forEach(function(s){
            if (bSt.studentStates[s]) {
              bSt.studentStates[s].state = 'reduce';
              bSt.studentStates[s].reduceCount = (bSt.studentStates[s].reduceCount || 0) + 1;
            }
          });
          (entryData.absent_students || []).forEach(function(s){
            if (bSt.studentStates[s]) bSt.studentStates[s].state = 'absent';
          });
          _renderEntryRoster(newId);
        }
      } else {
        var bClassInp = document.getElementById('bulk-entry-' + newId + '-class-name');
        if (bClassInp) bClassInp.value = entryData.class_name || '';
        var bSt = _bulkStates[newId];
        if (bSt) {
          bSt.acTags = (entryData.ac_students || []).slice();
          bSt.acReducedTags = (entryData.ac_reduced_students || []).slice();
          bSt.absentTags = (entryData.absent_students || []).slice();
          _renderEntryTagBox(newId, 'ac');
          _renderEntryTagBox(newId, 'ac-reduced');
          _renderEntryTagBox(newId, 'absent');
        }
      }
    });
  }

  // 7. Show Banner
  var banner = document.getElementById('draft-banner');
  if (banner) {
    banner.classList.remove('hidden');
    if (draft.savedAt) {
      try {
        var dTime = new Date(draft.savedAt);
        var bannerText = document.getElementById('draft-banner-text');
        if (bannerText) {
          bannerText.textContent = 'Auto-restored your unsaved draft from ' + dTime.toLocaleDateString() + ' at ' + dTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.';
        }
      } catch(e) {}
    }
  }

  window.__isDraftRestoring = false;
}

// Attach Auto-Save listeners
var _reportFormEl = document.getElementById('report-form');
if (_reportFormEl) {
  _reportFormEl.addEventListener('input', triggerAutoSave);
  _reportFormEl.addEventListener('change', triggerAutoSave);
}
window.addEventListener('pagehide', saveDraft);
window.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') saveDraft();
});

// Expose functions globally for backward-compatibility and tests
window.discardDraft = typeof discardDraft === 'function' ? discardDraft : window.discardDraft;
window.clearGroupSelection = typeof clearGroupSelection === 'function' ? clearGroupSelection : window.clearGroupSelection;
window.clearPrivateSelection = typeof clearPrivateSelection === 'function' ? clearPrivateSelection : window.clearPrivateSelection;
window.setSessionType = typeof setSessionType === 'function' ? setSessionType : window.setSessionType;
window.setMode = typeof setMode === 'function' ? setMode : window.setMode;
window.clearPartnerTeacher = typeof clearPartnerTeacher === 'function' ? clearPartnerTeacher : window.clearPartnerTeacher;
window.markAll = typeof markAll === 'function' ? markAll : window.markAll;
window.addBulkEntry = typeof addBulkEntry === 'function' ? addBulkEntry : window.addBulkEntry;
window.submitBulkReports = typeof submitBulkReports === 'function' ? submitBulkReports : window.submitBulkReports;
window.selectPartnerTeacher = typeof selectPartnerTeacher === 'function' ? selectPartnerTeacher : window.selectPartnerTeacher;
window.selectGroup = typeof selectGroup === 'function' ? selectGroup : window.selectGroup;
window.addCompetitionGroup = typeof addCompetitionGroup === 'function' ? addCompetitionGroup : window.addCompetitionGroup;
window.removeCompetitionGroup = typeof removeCompetitionGroup === 'function' ? removeCompetitionGroup : window.removeCompetitionGroup;
window.markAllInGroup = typeof markAllInGroup === 'function' ? markAllInGroup : window.markAllInGroup;
window.selectEntryGroup = typeof selectEntryGroup === 'function' ? selectEntryGroup : window.selectEntryGroup;
window._selectBulkPt = typeof _selectBulkPt === 'function' ? _selectBulkPt : window._selectBulkPt;
window.removeBulkEntry = typeof removeBulkEntry === 'function' ? removeBulkEntry : window.removeBulkEntry;
window._clearBulkPt = typeof _clearBulkPt === 'function' ? _clearBulkPt : window._clearBulkPt;
window.clearEntryGroup = typeof clearEntryGroup === 'function' ? clearEntryGroup : window.clearEntryGroup;
window.setEntrySessionType = typeof setEntrySessionType === 'function' ? setEntrySessionType : window.setEntrySessionType;
window.setEntryMode = typeof setEntryMode === 'function' ? setEntryMode : window.setEntryMode;
window.markAllEntry = typeof markAllEntry === 'function' ? markAllEntry : window.markAllEntry;

if (typeof registerAction === 'function') {
  registerAction('discardDraft', function() { if (typeof discardDraft === 'function') discardDraft(); });
  registerAction('clearGroupSelection', function() { if (typeof clearGroupSelection === 'function') clearGroupSelection(); });
  registerAction('clearPrivateSelection', function() { if (typeof clearPrivateSelection === 'function') clearPrivateSelection(); });
  registerAction('setSessionType', function(e, el) { if (typeof setSessionType === 'function') setSessionType(el.dataset.type); });
  registerAction('setMode', function(e, el) { if (typeof setMode === 'function') setMode(el.dataset.mode); });
  registerAction('clearPartnerTeacher', function() { if (typeof clearPartnerTeacher === 'function') clearPartnerTeacher(); });
  registerAction('markAll', function(e, el) { if (typeof markAll === 'function') markAll(el.dataset.status); });
  registerAction('addBulkEntry', function() { if (typeof addBulkEntry === 'function') addBulkEntry(); });
  registerAction('submitBulkReports', function() { if (typeof submitBulkReports === 'function') submitBulkReports(); });
  registerAction('selectPartnerTeacher', function(e, el) {
    if (typeof selectPartnerTeacher === 'function') {
      selectPartnerTeacher({ _id: el.dataset.teacherId, displayName: el.dataset.teacherName });
    }
  });
  registerAction('selectGroup', function(e, el) { if (typeof selectGroup === 'function') selectGroup(el.dataset.groupId); });
  registerAction('addCompetitionGroup', function(e, el) { if (typeof addCompetitionGroup === 'function') addCompetitionGroup(el.dataset.groupId); });
  registerAction('removeCompetitionGroup', function(e, el) { if (typeof removeCompetitionGroup === 'function') removeCompetitionGroup(el.dataset.groupId); });
  registerAction('markAllInGroup', function(e, el) { if (typeof markAllInGroup === 'function') markAllInGroup(el.dataset.groupId, el.dataset.status); });
  registerAction('selectEntryGroup', function(e, el) { if (typeof selectEntryGroup === 'function') selectEntryGroup(Number(el.dataset.entryId), el.dataset.groupId); });
  registerAction('selectBulkPt', function(e, el) {
    if (typeof _selectBulkPt === 'function') {
      _selectBulkPt(Number(el.dataset.entryId), { _id: el.dataset.teacherId, displayName: el.dataset.teacherName });
    }
  });
  registerAction('removeBulkEntry', function(e, el) { if (typeof removeBulkEntry === 'function') removeBulkEntry(Number(el.dataset.entryId)); });
  registerAction('clearBulkPt', function(e, el) { if (typeof _clearBulkPt === 'function') _clearBulkPt(Number(el.dataset.entryId)); });
  registerAction('clearEntryGroup', function(e, el) { if (typeof clearEntryGroup === 'function') clearEntryGroup(Number(el.dataset.entryId)); });
  registerAction('setEntrySessionType', function(e, el) { if (typeof setEntrySessionType === 'function') setEntrySessionType(Number(el.dataset.entryId), el.dataset.type); });
  registerAction('setEntryMode', function(e, el) { if (typeof setEntryMode === 'function') setEntryMode(Number(el.dataset.entryId), el.dataset.mode); });
  registerAction('markAllEntry', function(e, el) { if (typeof markAllEntry === 'function') markAllEntry(Number(el.dataset.entryId), el.dataset.status); });
}

// Restore draft on initial load
setTimeout(restoreDraft, 60);
