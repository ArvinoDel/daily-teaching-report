
/* ═══════════════════════════════════════════════════════════════
   Shared helpers
   ═══════════════════════════════════════════════════════════════ */
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var MAX_AC_COUNT = 10;

/* ═══════════════════════════════════════════════════════════════
   Session type & mode toggles
   ═══════════════════════════════════════════════════════════════ */
function setSessionType(type) {
  document.getElementById('session_type_input').value = type;
  var bG = document.getElementById('btn-group'), bP = document.getElementById('btn-private'), bC = document.getElementById('btn-competition');
  var classInput      = document.getElementById('class_name');
  var privateInput    = document.getElementById('private_name_input');
  var groupAcWrap     = document.getElementById('group-ac-wrap');
  var privateAcWrap   = document.getElementById('private-ac-wrap');
  var compWrap        = document.getElementById('competition-group-wrap');
  var groupHint       = document.getElementById('group-hint');
  var classNameLabel  = document.getElementById('class-name-label');

  var inactiveCls = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-slate-200 bg-white text-slate-400 hover:border-slate-300';

  if (typeof clearCompetitionError === 'function') clearCompetitionError();
  var compClassHidden = document.getElementById('comp-class-name-hidden');
  if (compClassHidden && compClassHidden.parentNode) {
    compClassHidden.parentNode.removeChild(compClassHidden);
  }

  if (type === 'group') {
    bG.className = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-brand-500 bg-brand-50 text-brand-700';
    bP.className = inactiveCls;
    bC.className = inactiveCls;
    competitionSelectedIds = [];
    var compHiddenG = document.getElementById('competition_groups_hidden');
    if (compHiddenG) compHiddenG.value = '';
    renderCompetitionTags();
    groupAcWrap.classList.remove('hidden');
    if (privateAcWrap) privateAcWrap.classList.add('hidden');
    compWrap.classList.add('hidden');
    privateInput.removeAttribute('name');
    privateInput.required = false;
    classInput.setAttribute('name', 'class_name');
    classInput.required = true;
    groupHint.classList.remove('hidden');
    setGroupHintDefault();
    classNameLabel.innerHTML = 'Group / Class Name <span class="text-red-500">*</span>';
  } else if (type === 'private') {
    bG.className = inactiveCls;
    bP.className = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-purple-400 bg-purple-50 text-purple-700';
    bC.className = inactiveCls;
    competitionSelectedIds = [];
    var compHiddenP = document.getElementById('competition_groups_hidden');
    if (compHiddenP) compHiddenP.value = '';
    renderCompetitionTags();
    // Only clear when manually switching away from a GROUP — not when selectGroup() auto-switches to private
    if (selectedGroup && selectedGroup.type !== 'PRIVATE') { clearGroupSelection(); }
    groupAcWrap.classList.add('hidden');
    compWrap.classList.add('hidden');
    classInput.removeAttribute('name');
    classInput.required = false;
    if (privateAcWrap) privateAcWrap.classList.remove('hidden');
    privateInput.setAttribute('name', 'class_name');
    privateInput.required = true;
    if (!privateInput.value && classInput.value) privateInput.value = classInput.value;
    groupHint.classList.add('hidden');
    classNameLabel.innerHTML = 'Student Name <span class="text-red-500">*</span>';
  } else if (type === 'competition') {
    bG.className = inactiveCls;
    bP.className = inactiveCls;
    bC.className = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-orange-500 bg-orange-50 text-orange-700';
    if (selectedGroup) { clearGroupSelection(); }
    groupAcWrap.classList.add('hidden');
    if (privateAcWrap) privateAcWrap.classList.add('hidden');
    compWrap.classList.remove('hidden');
    classInput.removeAttribute('name');
    classInput.required = false;
    privateInput.removeAttribute('name');
    privateInput.required = false;
    if (formEl) {
      var allNamedClass = formEl.querySelectorAll('input[name="class_name"]');
      allNamedClass.forEach(function(el) { el.removeAttribute('name'); });
    }
    groupHint.classList.remove('hidden');
    classNameLabel.innerHTML = 'Competition Groups <span class="text-red-500">*</span>';
    groupHint.innerHTML = '<span class="inline-flex items-center gap-1 text-orange-600 font-semibold">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 0 1 3 3h-15a3 3 0 0 1 3-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 0 1-.982-3.172M9.497 14.25a7.454 7.454 0 0 0 .981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 0 0 7.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 0 0 2.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 0 1 2.916.52 6.003 6.003 0 0 1-5.395 4.972m0 0a6.726 6.726 0 0 1-2.749 1.35m0 0a6.772 6.772 0 0 1-3.044 0"/></svg>' +
      'Select 2 or more groups for the competition</span>';
    groupHint.className = 'text-xs';
    renderCompetitionRoster();
  }
  var subEl = document.getElementById('subject');
  if (subEl && typeof subEl._matAcReRank === 'function') subEl._matAcReRank();
}

function setMode(mode) {
  document.getElementById('session_mode_input').value = mode;
  var bOff = document.getElementById('btn-offline'), bOn = document.getElementById('btn-online');
  var piW  = document.getElementById('personal-internet-wrapper');
  if (mode === 'online') {
    bOn.className  = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-blue-500 bg-blue-50 text-blue-700';
    bOff.className = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-slate-200 bg-white text-slate-400 hover:border-slate-300';
    piW.classList.remove('hidden');
  } else {
    bOff.className = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-slate-700 bg-slate-700 text-white';
    bOn.className  = 'flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition border-slate-200 bg-white text-slate-400 hover:border-slate-300';
    piW.classList.add('hidden');
    var pic = document.getElementById('personal_internet_check');
    if (pic) pic.checked = false;
  }
}

var formEl = document.getElementById('report-form');

/* Duration hint */
var durationEl = document.getElementById('duration');
if (durationEl) {
  durationEl.addEventListener('input', function() {
    var v = parseInt(this.value), h = document.getElementById('duration-hint');
    if (!h) return;
    if (!isNaN(v) && v > 0) {
      var hrs = Math.floor(v/60), min = v%60, parts = [];
      if (hrs > 0) parts.push(hrs + ' hour(s)');
      if (min > 0) parts.push(min + ' minute(s)');
      h.textContent = '= ' + parts.join(' ');
    } else { h.textContent = ''; }
  });
  // Trigger on load if value exists
  if (durationEl.value) durationEl.dispatchEvent(new Event('input'));
}

/* Char counter */
var notesEl = document.getElementById('notes');
var charCnt = document.getElementById('char-count');
if (notesEl && charCnt) {
  notesEl.addEventListener('input', function() {
    charCnt.textContent = this.value.length;
    charCnt.classList.toggle('text-red-400', this.value.length > 900);
  });
  // Trigger on load
  charCnt.textContent = notesEl.value.length;
}

/* ═══════════════════════════════════════════════════════════════
   Tag input — returns controller { reset, getTags }
   ═══════════════════════════════════════════════════════════════ */
function initTagInput({ inputId, boxId, hiddenId, countId, tagCls, allowDuplicates }) {
  var input   = document.getElementById(inputId);
  var box     = document.getElementById(boxId);
  var hidden  = document.getElementById(hiddenId);
  var countEl = document.getElementById(countId);
  if (!input || !box || !hidden || !countEl) return null;
  var tags    = hidden.value ? hidden.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [];

  function render() {
    box.innerHTML = '';
    tags.forEach(function(tag, i) {
      var pill = document.createElement('span');
      pill.className = 'inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ' + tagCls;
      pill.innerHTML = escHtml(tag) + ' <button type="button" class="ml-0.5 leading-none opacity-60 hover:opacity-100 transition text-sm" data-i="'+i+'">×</button>';
      pill.querySelector('button').addEventListener('click', function() {
        tags.splice(i, 1);
        render();
        if (typeof triggerAutoSave === 'function') triggerAutoSave();
      });
      box.appendChild(pill);
    });
    var unique = [];
    tags.forEach(function(t) { if (unique.indexOf(t) === -1) unique.push(t); });
    countEl.textContent = unique.length;
    hidden.value = tags.join(',');
  }
  function tryAdd() {
    var val = input.value.replace(/,/g,'').trim();
    if (val && (allowDuplicates || tags.indexOf(val) === -1)) {
      tags.push(val);
      if (typeof triggerAutoSave === 'function') triggerAutoSave();
    }
    input.value = ''; render();
  }
  input.addEventListener('keydown', function(e) {
    if (e.key==='Enter')     { e.preventDefault(); tryAdd(); }
    else if (e.key===',')    { e.preventDefault(); tryAdd(); }
    else if (e.key==='Backspace' && input.value==='' && tags.length) { tags.pop(); render(); }
  });
  input.addEventListener('blur', function() { if (input.value.trim()) tryAdd(); });
  render();

  return {
    reset: function(newTags) { tags = newTags.slice(); render(); },
    getTags: function() { return tags.slice(); }
  };
}

var acCtrl, acReducedCtrl, absentCtrl;

/* ═══════════════════════════════════════════════════════════════
   Groups Autocomplete
   ═══════════════════════════════════════════════════════════════ */
var groupsData    = JSON.parse(document.getElementById('groups-json').textContent);
var selectedGroup = null;
var studentStates = {};

/* ═══════════════════════════════════════════════════════════════
   Partner Teacher Autocomplete (Assistant Teacher mode)
   ═══════════════════════════════════════════════════════════════ */
var teachersData = JSON.parse(document.getElementById('teachers-json').textContent || '[]');
var _currentUserInfo = JSON.parse(document.getElementById('current-user-info')?.textContent || '{}');

function _getCurrentTeacherId() {
  var tSel = document.getElementById('teacher');
  if (tSel && tSel.value) return tSel.value;
  return _currentUserInfo ? _currentUserInfo.id : '';
}

function _isSelfTeacher(teacherId, teacherName, currentTid) {
  var cId = currentTid || _getCurrentTeacherId();
  if (teacherId && cId && String(teacherId) === String(cId)) return true;
  var currentName = '';
  var currentUsername = '';
  if (cId && _currentUserInfo && String(_currentUserInfo.id) === String(cId)) {
    currentName = (_currentUserInfo.displayName || '').toLowerCase();
    currentUsername = (_currentUserInfo.username || '').toLowerCase();
  } else if (cId) {
    var found = teachersData.find(function(t) { return String(t._id) === String(cId); });
    if (found) {
      currentName = (found.displayName || '').toLowerCase();
      currentUsername = (found.username || '').toLowerCase();
    }
  }
  if (teacherName) {
    var tn = teacherName.trim().toLowerCase();
    if (currentName && tn === currentName) return true;
    if (currentUsername && (tn === currentUsername || tn === '@' + currentUsername)) return true;
  }
  return false;
}

var partnerSection   = document.getElementById('partner-teacher-section');
var partnerDisplay   = document.getElementById('partner_teacher_display');
var partnerHidden    = document.getElementById('partner_teacher_hidden');
var partnerNameHidden = document.getElementById('partner_teacher_name_hidden');
var partnerDropdown  = document.getElementById('partner-teacher-dropdown');
var partnerPill      = document.getElementById('partner-teacher-selected');
var partnerPillName  = document.getElementById('partner-teacher-pill-name');
var partnerHint      = document.getElementById('partner-teacher-hint');
var partnerClearBtn  = document.getElementById('btn-clear-partner');
var teachingTypeEl   = document.getElementById('teaching_type');

function showPartnerSection() {
  if (partnerSection) partnerSection.classList.remove('hidden');
}
function hidePartnerSection() {
  if (partnerSection) partnerSection.classList.add('hidden');
  clearPartnerTeacher(true);
}
function clearPartnerTeacher(silent) {
  if (partnerDisplay)   partnerDisplay.value = '';
  if (partnerHidden)    partnerHidden.value  = '';
  if (partnerNameHidden) partnerNameHidden.value = '';
  if (partnerDropdown)  partnerDropdown.classList.add('hidden');
  if (partnerPill)      partnerPill.classList.add('hidden');
  if (partnerClearBtn)  partnerClearBtn.classList.add('hidden');
  if (partnerHint)      partnerHint.textContent = 'Start typing to search. If not registered, the name will be saved as text.';
}
function selectPartnerTeacher(teacher) {
  if (_isSelfTeacher(teacher._id, teacher.displayName)) {
    if (partnerHint) partnerHint.innerHTML = '<span class="text-red-500 font-semibold">You cannot tag yourself as the partner teacher.</span>';
    return;
  }
  if (partnerDisplay)   partnerDisplay.value  = teacher.displayName;
  if (partnerHidden)    partnerHidden.value   = teacher._id;
  if (partnerNameHidden) partnerNameHidden.value = teacher.displayName;
  if (partnerDropdown)  partnerDropdown.classList.add('hidden');
  if (partnerPill)      partnerPill.classList.remove('hidden');
  if (partnerPillName)  partnerPillName.textContent = teacher.displayName;
  if (partnerClearBtn)  partnerClearBtn.classList.remove('hidden');
  if (partnerHint)      partnerHint.textContent = '';
}
function renderPartnerDropdown(list) {
  if (!partnerDropdown) return;
  if (!list.length) { partnerDropdown.classList.add('hidden'); return; }
  partnerDropdown.innerHTML = list.slice(0, 8).map(function(t) {
    return '<button type="button" data-action="selectPartnerTeacher" data-teacher-id="' + escHtml(t._id) + '" data-teacher-name="' + escHtml(t.displayName) + '" ' +
      'class="w-full text-left px-4 py-3 hover:bg-sky-50 transition flex items-center justify-between gap-3">' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-semibold text-slate-800 truncate">' + escHtml(t.displayName) + '</p>' +
        '<p class="text-xs text-slate-400 truncate">@' + escHtml(t.username) + '</p>' +
      '</div>' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-sky-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>' +
    '</button>';
  }).join('');
  partnerDropdown.classList.remove('hidden');
}

if (partnerDisplay) {
  partnerDisplay.addEventListener('input', function() {
    var q = this.value.trim();
    // Update the name hidden field as the user types (manual entry support)
    if (partnerNameHidden) partnerNameHidden.value = q;
    // If user types away from a selected registered teacher, deselect
    if (partnerHidden && partnerHidden.value) {
      partnerHidden.value = '';
      if (partnerPill)     partnerPill.classList.add('hidden');
      if (partnerClearBtn) partnerClearBtn.classList.add(q ? '' : 'hidden').toString();
    }
    if (q) { partnerClearBtn && partnerClearBtn.classList.remove('hidden'); } else { partnerClearBtn && partnerClearBtn.classList.add('hidden'); }
    if (!q) { partnerDropdown && partnerDropdown.classList.add('hidden'); return; }
    var ql = q.toLowerCase();
    var cId = _getCurrentTeacherId();
    var list = teachersData.filter(function(t) {
      if (cId && String(t._id) === String(cId)) return false;
      return t.displayName.toLowerCase().includes(ql) || t.username.toLowerCase().includes(ql);
    });
    renderPartnerDropdown(list);
  });
  partnerDisplay.addEventListener('focus', function() {
    var cId = _getCurrentTeacherId();
    var list = teachersData.filter(function(t) {
      return !cId || String(t._id) !== String(cId);
    });
    if (!this.value.trim() && list.length) renderPartnerDropdown(list);
  });
  partnerDisplay.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.key === 'Tab') partnerDropdown && partnerDropdown.classList.add('hidden');
  });
  partnerDisplay.addEventListener('blur', function() {
    // Save typed name even if no teacher was selected
    if (partnerNameHidden) partnerNameHidden.value = this.value.trim();
    if (_isSelfTeacher(partnerHidden ? partnerHidden.value : '', this.value.trim())) {
      if (partnerHint) partnerHint.innerHTML = '<span class="text-red-500 font-semibold">You cannot tag yourself as the partner teacher.</span>';
    }
  });
}

var teacherSelectEl = document.getElementById('teacher');
if (teacherSelectEl) {
  teacherSelectEl.addEventListener('change', function() {
    var newTid = this.value;
    if (partnerHidden && partnerHidden.value && String(partnerHidden.value) === String(newTid)) {
      clearPartnerTeacher(true);
    }
  });
}

function updatePartnerLabels(type) {
  var lbl = document.getElementById('partner-teacher-label');
  var sub = document.getElementById('partner-teacher-subtext');
  if (type === 'Assistant Teacher') {
    if (lbl) lbl.innerHTML = 'Prime Teacher <span class="text-red-500">*</span>';
    if (sub) sub.textContent = 'Tag the Prime Teacher for this assisted class. Search by name or type manually if not registered.';
  } else if (type === '1/2 Prime Teacher') {
    if (lbl) lbl.innerHTML = '1/2 Partner Teacher <span class="text-red-500">*</span>';
    if (sub) sub.textContent = 'Tag the partner 1/2 Prime Teacher for this split class. Search by name or type manually if not registered.';
  }
}

// Show/hide partner section based on teaching type selection
if (teachingTypeEl) {
  teachingTypeEl.addEventListener('change', function() {
    if (this.value === 'Assistant Teacher' || this.value === '1/2 Prime Teacher') {
      updatePartnerLabels(this.value);
      showPartnerSection();
    } else {
      hidePartnerSection();
    }
  });
  // Trigger on page load (edit mode)
  if (teachingTypeEl.value === 'Assistant Teacher' || teachingTypeEl.value === '1/2 Prime Teacher') {
    updatePartnerLabels(teachingTypeEl.value);
    showPartnerSection();
  }
}

var classInput    = document.getElementById('class_name');
var groupDropdown = document.getElementById('group-dropdown');
var clearBtn      = document.getElementById('btn-clear-group');
var groupHint     = document.getElementById('group-hint');
var rosterPanel   = document.getElementById('student-roster');
var manualSection = document.getElementById('manual-students-section');

function renderDropdown(groups) {
  groupDropdown.innerHTML = groups.slice(0, 8).map(function(g) {
    var tcls = g.type === 'GROUP' ? 'bg-emerald-100 text-emerald-700' : 'bg-purple-100 text-purple-700';
    var tlbl = g.type === 'GROUP' ? 'Group' : 'Private';
    return '<button type="button" data-action="selectGroup" data-group-id="'+escHtml(g._id)+'" '+
      'class="w-full text-left px-4 py-3 hover:bg-brand-50 transition flex items-center justify-between gap-3">' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-semibold text-slate-800 truncate">' + escHtml(g.group_name) + '</p>' +
        '<div class="flex items-center gap-1.5 mt-0.5">' +
          '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full '+tcls+'">' + tlbl + '</span>' +
          (g.level ? '<span class="text-[10px] font-mono text-slate-400">'+escHtml(g.level)+'</span>' : '') +
        '</div>' +
      '</div>' +
      '<span class="text-xs text-slate-400 flex-shrink-0">'+g.students.length+' student(s)</span>' +
    '</button>';
  }).join('');
  groupDropdown.classList.remove('hidden');
}

function hideDropdown() { groupDropdown.classList.add('hidden'); }

function setGroupHintDefault() {
  groupHint.textContent = 'Type a name or select from your groups list.';
  groupHint.className = 'text-xs text-slate-400';
}
function setGroupHintSelected() {
  groupHint.innerHTML = '<span class="inline-flex items-center gap-1 text-brand-600 font-semibold">' +
    '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>' +
    'Group selected — mark students below</span>';
  groupHint.className = 'text-xs';
}

if (classInput) {
  classInput.addEventListener('focus', function() {
    if (document.getElementById('session_type_input').value === 'competition') return;
    var q = this.value.trim().toLowerCase();
    var list = q ? groupsData.filter(function(g){return g.group_name.toLowerCase().includes(q);}) : groupsData;
    if (list.length) renderDropdown(list);
  });

  classInput.addEventListener('input', function() {
    if (document.getElementById('session_type_input').value === 'competition') return;
    var q = this.value.trim().toLowerCase();
    if (selectedGroup && this.value !== selectedGroup.group_name) {
      selectedGroup = null; studentStates = {};
      hideRoster(); if (clearBtn) clearBtn.classList.add('hidden');
      setGroupHintDefault();
    }
    if (!q) { hideDropdown(); return; }
    var list = groupsData.filter(function(g){return g.group_name.toLowerCase().includes(q);});
    list.length ? renderDropdown(list) : hideDropdown();
  });

  classInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.key === 'Tab') hideDropdown();
  });
}

/* ═══════════════════════════════════════════════════════════════
   Private Autocomplete (searches PRIVATE-type groups only)
   ═══════════════════════════════════════════════════════════════ */
var privateDropdown  = document.getElementById('private-dropdown');
var clearPrivateBtn  = document.getElementById('btn-clear-private');
var privateNameInput = document.getElementById('private_name_input');

function renderPrivateDropdown(groups) {
  if (!privateDropdown) return;
  var filtered = groups.filter(function(g) { return g.type === 'PRIVATE'; });
  if (filtered.length === 0) { privateDropdown.classList.add('hidden'); return; }
  privateDropdown.innerHTML = filtered.slice(0, 8).map(function(g) {
    return '<button type="button" data-action="selectGroup" data-group-id="' + escHtml(g._id) + '" ' +
      'class="w-full text-left px-4 py-3 hover:bg-purple-50 transition flex items-center justify-between gap-3">' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-semibold text-slate-800 truncate">' + escHtml(g.group_name) + '</p>' +
        '<div class="flex items-center gap-1.5 mt-0.5">' +
          '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">Private</span>' +
          (g.level ? '<span class="text-[10px] font-mono text-slate-400">' + escHtml(g.level) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<span class="text-xs text-slate-400 flex-shrink-0">' + g.students.length + ' student(s)</span>' +
    '</button>';
  }).join('');
  privateDropdown.classList.remove('hidden');
}

function hidePrivateDropdown() {
  if (privateDropdown) privateDropdown.classList.add('hidden');
}

function clearPrivateSelection() {
  selectedGroup = null; studentStates = {};
  if (privateNameInput) { privateNameInput.value = ''; privateNameInput.focus(); }
  if (clearPrivateBtn) clearPrivateBtn.classList.add('hidden');
  hidePrivateDropdown();
  hideRoster();
  if (acCtrl) acCtrl.reset([]);
  if (absentCtrl) absentCtrl.reset([]);
}

if (privateNameInput) {
  privateNameInput.addEventListener('focus', function() {
    var q = this.value.trim().toLowerCase();
    var list = q
      ? groupsData.filter(function(g) { return g.type === 'PRIVATE' && g.group_name.toLowerCase().includes(q); })
      : groupsData.filter(function(g) { return g.type === 'PRIVATE'; });
    if (list.length) renderPrivateDropdown(list);
  });

  privateNameInput.addEventListener('input', function() {
    var q = this.value.trim().toLowerCase();
    // If user edits away from a selected private group, deselect it
    if (selectedGroup && selectedGroup.type === 'PRIVATE' && this.value !== selectedGroup.group_name) {
      selectedGroup = null; studentStates = {};
      hideRoster();
      if (clearPrivateBtn) clearPrivateBtn.classList.add('hidden');
    }
    if (!q) { hidePrivateDropdown(); return; }
    var list = groupsData.filter(function(g) { return g.type === 'PRIVATE' && g.group_name.toLowerCase().includes(q); });
    list.length ? renderPrivateDropdown(list) : hidePrivateDropdown();
  });

  privateNameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.key === 'Tab') hidePrivateDropdown();
  });
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#group-ac-wrap')) hideDropdown();
  if (!e.target.closest('#competition-group-wrap')) {
    var cd = document.getElementById('competition-dropdown');
    if (cd) cd.classList.add('hidden');
  }
  if (!e.target.closest('#private-ac-wrap')) hidePrivateDropdown();
  if (!e.target.closest('#partner-teacher-ac-wrap') && partnerDropdown) partnerDropdown.classList.add('hidden');
});

/* ═══════════════════════════════════════════════════════════════
   Group Selection (single group mode)
   ═══════════════════════════════════════════════════════════════ */
function selectGroup(id, opts) {
  selectedGroup = groupsData.find(function(g){return g._id === id;});
  if (!selectedGroup) return;

  if (classInput) classInput.value = selectedGroup.group_name;
  hideDropdown();

  setSessionType(selectedGroup.type === 'PRIVATE' ? 'private' : 'group');

  // Sync the private name input when a PRIVATE group is selected
  if (selectedGroup.type === 'PRIVATE') {
    var pvInput = document.getElementById('private_name_input');
    if (pvInput) pvInput.value = selectedGroup.group_name;
    if (clearPrivateBtn) clearPrivateBtn.classList.remove('hidden');
    hidePrivateDropdown();
  } else {
    if (clearBtn) clearBtn.classList.remove('hidden');
  }

  // Reset states
  studentStates = {};
  selectedGroup.students.forEach(function(s) { studentStates[s] = { state: null, acCount: 0, reduceCount: 0 }; });

  // Pre-fill from existing report ac/reduced/absent data
  if (opts && opts.preAc) {
    var acCounts = {};
    opts.preAc.forEach(function(s) { acCounts[s] = (acCounts[s] || 0) + 1; });
    Object.keys(acCounts).forEach(function(s) {
      if (studentStates[s] !== undefined) {
        studentStates[s] = { state: 'ac', acCount: acCounts[s], reduceCount: 0 };
      }
    });
  }
  if (opts && opts.preReduced) {
    var redCounts = {};
    opts.preReduced.forEach(function(s) { redCounts[s] = (redCounts[s] || 0) + 1; });
    Object.keys(redCounts).forEach(function(s) {
      if (studentStates[s] !== undefined) {
        studentStates[s] = { state: 'reduce', acCount: 0, reduceCount: redCounts[s] };
      }
    });
  }
  if (opts && opts.preAbsent) {
    opts.preAbsent.forEach(function(s) {
      if (studentStates[s] !== undefined) studentStates[s] = { state: 'absent', acCount: 0, reduceCount: 0 };
    });
  }

  var rosterNameEl = document.getElementById('roster-group-name');
  if (rosterNameEl) rosterNameEl.textContent = selectedGroup.group_name;
  renderRoster();
  if (rosterPanel) rosterPanel.classList.remove('hidden');
  if (manualSection) manualSection.classList.add('hidden');
  // clearBtn is for group mode; clearPrivateBtn is already shown above for private mode
  if (selectedGroup.type !== 'PRIVATE' && clearBtn) clearBtn.classList.remove('hidden');
  if (selectedGroup.type === 'GROUP') setGroupHintSelected();
  updateHiddenInputs();
  var subEl = document.getElementById('subject');
  if (subEl && typeof subEl._matAcReRank === 'function') subEl._matAcReRank();
}

function clearGroupSelection() {
  selectedGroup = null; studentStates = {};
  if (classInput) { classInput.value = ''; classInput.focus(); }
  // Also clear private input in case we were in private mode
  var pvInput = document.getElementById('private_name_input');
  if (pvInput) pvInput.value = '';
  if (clearPrivateBtn) clearPrivateBtn.classList.add('hidden');
  hideRoster();
  if (clearBtn) clearBtn.classList.add('hidden');
  if (acCtrl) acCtrl.reset([]);
  if (acReducedCtrl) acReducedCtrl.reset([]);
  if (absentCtrl) absentCtrl.reset([]);
  setGroupHintDefault();
  var subEl = document.getElementById('subject');
  if (subEl && typeof subEl._matAcReRank === 'function') subEl._matAcReRank();
}

/* ═══════════════════════════════════════════════════════════════
   Competition: Multi-Group Selection
   ═══════════════════════════════════════════════════════════════ */
function clearCompetitionError() {
  var errEl = document.getElementById('competition-error');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
}

var competitionSelectedIds = [];
var competitionSearchInput = document.getElementById('competition-search');
var competitionDropdown    = document.getElementById('competition-dropdown');

function renderCompetitionDropdown(groups) {
  var filtered = groups.filter(function(g) {
    return competitionSelectedIds.indexOf(g._id) === -1;
  });
  if (filtered.length === 0) {
    competitionDropdown.classList.add('hidden');
    return;
  }
  competitionDropdown.innerHTML = filtered.slice(0, 8).map(function(g) {
    var tcls  = g.type === 'GROUP' ? 'bg-emerald-100 text-emerald-700' : 'bg-purple-100 text-purple-700';
    var tlbl  = g.type === 'GROUP' ? 'Group' : 'Private';
    return '<button type="button" data-action="addCompetitionGroup" data-group-id="'+escHtml(g._id)+'" '+
      'class="w-full text-left px-4 py-3 hover:bg-orange-50 transition flex items-center justify-between gap-3">' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-semibold text-slate-800 truncate">' + escHtml(g.group_name) + '</p>' +
        '<div class="flex items-center gap-1.5 mt-0.5">' +
          '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full '+tcls+'">' + tlbl + '</span>' +
          (g.level ? '<span class="text-[10px] font-mono text-slate-400">'+escHtml(g.level)+'</span>' : '') +
        '</div>' +
      '</div>' +
      '<span class="text-xs text-slate-400 flex-shrink-0">'+g.students.length+' student(s)</span>' +
    '</button>';
  }).join('');
  competitionDropdown.classList.remove('hidden');
}

if (competitionSearchInput) {
  competitionSearchInput.addEventListener('focus', function() {
    var q = this.value.trim().toLowerCase();
    var list = q ? groupsData.filter(function(g){return g.group_name.toLowerCase().includes(q);}) : groupsData;
    if (list.length) renderCompetitionDropdown(list);
  });

  competitionSearchInput.addEventListener('input', function() {
    clearCompetitionError();
    var q = this.value.trim().toLowerCase();
    if (!q) { competitionDropdown.classList.add('hidden'); return; }
    var list = groupsData.filter(function(g){return g.group_name.toLowerCase().includes(q);});
    list.length ? renderCompetitionDropdown(list) : competitionDropdown.classList.add('hidden');
  });

  competitionSearchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.key === 'Tab') competitionDropdown.classList.add('hidden');
  });
}

function addCompetitionGroup(id) {
  clearCompetitionError();
  if (competitionSelectedIds.indexOf(id) === -1) {
    competitionSelectedIds.push(id);
  }
  if (competitionSearchInput) competitionSearchInput.value = '';
  if (competitionDropdown) competitionDropdown.classList.add('hidden');
  renderCompetitionTags();
  renderCompetitionRoster();
}

function removeCompetitionGroup(id) {
  clearCompetitionError();
  competitionSelectedIds = competitionSelectedIds.filter(function(x) { return x !== id; });
  renderCompetitionTags();
  renderCompetitionRoster();
}

function renderCompetitionTags() {
  var container = document.getElementById('competition-selected-tags');
  if (!container) return;
  container.innerHTML = competitionSelectedIds.map(function(id) {
    var g = groupsData.find(function(x) { return x._id === id; });
    if (!g) return '';
    return '<span class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-orange-100 text-orange-700">' +
      escHtml(g.group_name) +
      ' <button type="button" class="ml-0.5 leading-none opacity-60 hover:opacity-100 transition text-sm" data-action="removeCompetitionGroup" data-group-id="'+escHtml(id)+'">×</button>' +
    '</span>';
  }).join('');
  
  var countEl = document.getElementById('comp-group-count');
  if (countEl) countEl.textContent = competitionSelectedIds.length;

  var names = competitionSelectedIds.map(function(id) {
    var g = groupsData.find(function(x) { return x._id === id; });
    return g ? g.group_name : '';
  }).filter(Boolean);

  var compClassHidden = document.getElementById('comp-class-name-hidden');
  if (compClassHidden && compClassHidden.parentNode) {
    compClassHidden.parentNode.removeChild(compClassHidden);
  }

  var compGroupsHidden = document.getElementById('competition_groups_hidden');
  if (compGroupsHidden) compGroupsHidden.value = names.join(',');
}

function renderCompetitionRoster() {
  if (competitionSelectedIds.length === 0) {
    hideRoster();
    return;
  }

  var allStudents = [];
  var groupLabels = [];
  competitionSelectedIds.forEach(function(id) {
    var g = groupsData.find(function(x) { return x._id === id; });
    if (g) {
      groupLabels.push(g.group_name);
      g.students.forEach(function(s) {
        if (allStudents.indexOf(s) === -1) allStudents.push(s);
      });
    }
  });

  var newStates = {};
  allStudents.forEach(function(s) {
    newStates[s] = studentStates[s] || { state: null, acCount: 0 };
  });
  studentStates = newStates;

  var rosterNameEl = document.getElementById('roster-group-name');
  if (rosterNameEl) rosterNameEl.textContent = groupLabels.join(' vs ');
  selectedGroup = { group_name: groupLabels.join(' vs '), students: allStudents };
  renderGroupedRoster();
  if (rosterPanel) rosterPanel.classList.remove('hidden');
  if (manualSection) manualSection.classList.add('hidden');
  updateHiddenInputs();
}

/* ═══════════════════════════════════════════════════════════════
   Student Roster — helpers
   ═══════════════════════════════════════════════════════════════ */
function hideRoster()  {
  if (rosterPanel) rosterPanel.classList.add('hidden');
  if (manualSection) manualSection.classList.remove('hidden');
}

function renderStudentRow(student) {
  var stObj   = studentStates[student] || { state: null, acCount: 0, reduceCount: 0 };
  var state   = stObj.state;
  var acCount = stObj.acCount || 0;
  var redCount = stObj.reduceCount || 0;

  var rowCls = 'flex items-center justify-between py-2.5 px-3 rounded-xl border transition-all duration-200 ';
  rowCls += state === 'ac'     ? 'bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200 shadow-sm shadow-emerald-100/50' :
            state === 'reduce' ? 'bg-gradient-to-r from-rose-50 to-pink-50 border-rose-200 shadow-sm shadow-rose-100/50' :
            state === 'absent' ? 'bg-red-50 border-red-200' :
            'bg-white border-slate-100 hover:border-slate-200';

  var nameCls = 'text-sm ' + (state === 'ac' ? 'text-emerald-800 font-semibold' : state === 'reduce' ? 'text-rose-800 font-semibold' : state === 'absent' ? 'text-red-700 font-medium' : 'text-slate-700');

  var statusIcon = '';
  if (state === 'ac') {
    statusIcon = '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white flex-shrink-0">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd"/></svg>' +
    '</span>';
  } else if (state === 'reduce') {
    statusIcon = '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-rose-500 text-white flex-shrink-0">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15"/></svg>' +
    '</span>';
  } else if (state === 'absent') {
    statusIcon = '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-500 flex-shrink-0">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
    '</span>';
  } else {
    statusIcon = '<span class="flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-slate-400 flex-shrink-0">' +
      '<span class="w-1.5 h-1.5 rounded-full bg-slate-300"></span>' +
    '</span>';
  }

  var acHtml = '';
  if (state === 'ac') {
    var canRemove = acCount > 1;
    var canAdd    = acCount < MAX_AC_COUNT;
    acHtml = '<div class="inline-flex items-center rounded-full bg-emerald-500 shadow-sm overflow-hidden">' +
      '<button type="button" ' + (canRemove ? '' : 'disabled ') +
        'class="w-7 h-7 flex items-center justify-center text-sm font-bold transition-colors ' +
        (canRemove ? 'text-white/90 hover:bg-emerald-600 active:bg-emerald-700' : 'text-emerald-300 cursor-not-allowed') +
        '" data-student="'+escHtml(student)+'" data-role="remove">&minus;</button>' +
      '<span class="px-1.5 text-[11px] font-bold text-white tracking-wide select-none border-x border-emerald-400/40 min-w-[38px] text-center leading-7">' + acCount + ' AC</span>' +
      '<button type="button" ' + (canAdd ? '' : 'disabled ') +
        'class="w-7 h-7 flex items-center justify-center text-sm font-bold transition-colors ' +
        (canAdd ? 'text-white/90 hover:bg-emerald-600 active:bg-emerald-700' : 'text-emerald-300 cursor-not-allowed') +
        '" data-student="'+escHtml(student)+'" data-role="add">+</button>' +
    '</div>' +
    '<button type="button" class="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors" data-student="'+escHtml(student)+'" data-role="clear-ac" title="Remove AC">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
    '</button>';
  } else if (state === 'reduce') {
    var canRemRed = redCount > 1;
    var canAddRed = redCount < MAX_AC_COUNT;
    acHtml = '<div class="inline-flex items-center rounded-full bg-rose-500 shadow-sm overflow-hidden">' +
      '<button type="button" ' + (canRemRed ? '' : 'disabled ') +
        'class="w-7 h-7 flex items-center justify-center text-sm font-bold transition-colors ' +
        (canRemRed ? 'text-white/90 hover:bg-rose-600 active:bg-rose-700' : 'text-rose-300 cursor-not-allowed') +
        '" data-student="'+escHtml(student)+'" data-role="reduce-minus">&minus;</button>' +
      '<span class="px-1.5 text-[11px] font-bold text-white tracking-wide select-none border-x border-rose-400/40 min-w-[38px] text-center leading-7">' + redCount + ' −AC</span>' +
      '<button type="button" ' + (canAddRed ? '' : 'disabled ') +
        'class="w-7 h-7 flex items-center justify-center text-sm font-bold transition-colors ' +
        (canAddRed ? 'text-white/90 hover:bg-rose-600 active:bg-rose-700' : 'text-rose-300 cursor-not-allowed') +
        '" data-student="'+escHtml(student)+'" data-role="reduce-add">+</button>' +
    '</div>' +
    '<button type="button" class="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors" data-student="'+escHtml(student)+'" data-role="clear-reduce" title="Clear reduction">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
    '</button>';
  } else {
    acHtml = '<button type="button" class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full transition-all duration-200 border border-emerald-200 bg-white text-emerald-600 hover:bg-emerald-500 hover:text-white hover:border-emerald-500 hover:shadow-sm active:scale-95" data-student="'+escHtml(student)+'" data-role="ac">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd"/></svg>' +
      '+AC</button>' +
      '<button type="button" class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full transition-all duration-200 border border-rose-200 bg-white text-rose-600 hover:bg-rose-500 hover:text-white hover:border-rose-500 hover:shadow-sm active:scale-95" data-student="'+escHtml(student)+'" data-role="reduce">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15"/></svg>' +
      '−AC</button>';
  }

  var absCls = 'inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-full transition-all duration-200 ' +
    (state === 'absent' ? 'bg-red-500 text-white shadow-sm border border-red-500' :
     'border border-slate-200 bg-white text-slate-400 hover:border-red-300 hover:text-red-500 active:scale-95');

  return '<div class="'+rowCls+'">' +
    '<div class="flex items-center gap-2 min-w-0">' +
      statusIcon +
      '<span class="'+nameCls+' truncate">' + escHtml(student) + '</span>' +
    '</div>' +
    '<div class="flex items-center gap-1.5 flex-shrink-0">' +
      acHtml +
      '<button type="button" class="'+absCls+'" data-student="'+escHtml(student)+'" data-role="absent">Absent</button>' +
    '</div>' +
  '</div>';
}

function renderRoster() {
  var container = document.getElementById('roster-students');
  if (!container) return;
  var actionsEl = document.getElementById('global-roster-actions');
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (!selectedGroup || selectedGroup.students.length === 0) {
    container.innerHTML = '<p class="text-sm text-slate-400 italic py-2 text-center">No students in this group.</p>';
    return;
  }
  container.innerHTML = selectedGroup.students.map(renderStudentRow).join('');
  updateRosterSummary();
}

function renderGroupedRoster() {
  var container = document.getElementById('roster-students');
  if (!container) return;
  var actionsEl = document.getElementById('global-roster-actions');
  if (actionsEl) actionsEl.classList.add('hidden');
  var html = '';

  competitionSelectedIds.forEach(function(id, idx) {
    var g = groupsData.find(function(x) { return x._id === id; });
    if (!g) return;

    var gAc = 0, gAbs = 0;
    g.students.forEach(function(s) {
      var st = studentStates[s];
      if (st && st.state === 'ac') gAc++;
      if (st && st.state === 'absent') gAbs++;
    });
    var statsParts = [];
    if (gAc  > 0) statsParts.push('<span class="text-emerald-600 font-semibold">' + gAc + ' AC</span>');
    if (gAbs > 0) statsParts.push('<span class="text-red-500 font-semibold">' + gAbs + ' Absent</span>');

    if (idx > 0) {
      html += '<div class="border-t-2 border-dashed border-orange-200 my-3"></div>';
    }

    html += '<div class="flex items-center justify-between py-2 px-1 mb-1.5">' +
      '<div class="flex items-center gap-2 min-w-0">' +
        '<span class="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 whitespace-nowrap">' +
          '<svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"/></svg>' +
          escHtml(g.group_name) +
        '</span>' +
        '<span class="text-[10px] text-slate-400">' + g.students.length + ' student(s)</span>' +
        (statsParts.length ? '<span class="text-[10px]">' + statsParts.join(' · ') + '</span>' : '') +
      '</div>' +
      '<div class="flex items-center gap-1 flex-shrink-0">' +
        '<button type="button" data-action="markAllInGroup" data-group-id="' + escHtml(id) + '" data-status="ac" class="text-[10px] font-semibold bg-emerald-100 hover:bg-emerald-200 text-emerald-700 px-2 py-1 rounded-md transition">All AC</button>' +
        '<button type="button" data-action="markAllInGroup" data-group-id="' + escHtml(id) + '" data-status="absent" class="text-[10px] font-semibold bg-red-100 hover:bg-red-200 text-red-600 px-2 py-1 rounded-md transition">All Absent</button>' +
        '<button type="button" data-action="markAllInGroup" data-group-id="' + escHtml(id) + '" data-status="clear" class="text-[10px] font-semibold bg-white hover:bg-slate-100 text-slate-500 border border-slate-200 px-2 py-1 rounded-md transition">Clear</button>' +
      '</div>' +
    '</div>';

    html += '<div class="space-y-1.5">';
    g.students.forEach(function(student) {
      html += renderStudentRow(student);
    });
    html += '</div>';
  });

  container.innerHTML = html;
  updateRosterSummary();
}

function rerender() {
  if (document.getElementById('session_type_input').value === 'competition') {
    renderGroupedRoster();
  } else {
    renderRoster();
  }
}

function toggleStudent(name, role) {
  var st = studentStates[name] || { state: null, acCount: 0, reduceCount: 0 };

  if (role === 'ac') {
    st.state = 'ac';
    st.acCount = 1;
    st.reduceCount = 0;
  } else if (role === 'add') {
    if (st.state === 'ac' && st.acCount < MAX_AC_COUNT) {
      st.acCount++;
    }
  } else if (role === 'remove') {
    if (st.state === 'ac' && st.acCount > 1) {
      st.acCount--;
    }
  } else if (role === 'clear-ac') {
    st.state = null;
    st.acCount = 0;
  } else if (role === 'reduce') {
    st.state = 'reduce';
    st.reduceCount = 1;
    st.acCount = 0;
  } else if (role === 'reduce-add') {
    if (st.state === 'reduce' && st.reduceCount < MAX_AC_COUNT) {
      st.reduceCount++;
    }
  } else if (role === 'reduce-minus') {
    if (st.state === 'reduce' && st.reduceCount > 1) {
      st.reduceCount--;
    }
  } else if (role === 'clear-reduce') {
    st.state = null;
    st.reduceCount = 0;
  } else if (role === 'absent') {
    if (st.state === 'absent') {
      st.state = null;
      st.acCount = 0;
      st.reduceCount = 0;
    } else {
      st.state = 'absent';
      st.acCount = 0;
      st.reduceCount = 0;
    }
  }

  studentStates[name] = st;
  rerender();
  updateHiddenInputs();
  if (typeof triggerAutoSave === 'function') triggerAutoSave();
}

function markAll(role) {
  if (!selectedGroup) return;
  selectedGroup.students.forEach(function(s) {
    if (role === 'clear') {
      studentStates[s] = { state: null, acCount: 0, reduceCount: 0 };
    } else if (role === 'ac') {
      studentStates[s] = { state: 'ac', acCount: 1, reduceCount: 0 };
    } else if (role === 'absent') {
      studentStates[s] = { state: 'absent', acCount: 0, reduceCount: 0 };
    }
  });
  rerender();
  updateHiddenInputs();
  if (typeof triggerAutoSave === 'function') triggerAutoSave();
}

function markAllInGroup(groupId, role) {
  var g = groupsData.find(function(x) { return x._id === groupId; });
  if (!g) return;
  g.students.forEach(function(s) {
    if (role === 'clear') {
      studentStates[s] = { state: null, acCount: 0, reduceCount: 0 };
    } else if (role === 'ac') {
      studentStates[s] = { state: 'ac', acCount: 1, reduceCount: 0 };
    } else if (role === 'absent') {
      studentStates[s] = { state: 'absent', acCount: 0, reduceCount: 0 };
    }
  });
  rerender();
  updateHiddenInputs();
  if (typeof triggerAutoSave === 'function') triggerAutoSave();
}

function updateRosterSummary() {
  var vals       = Object.values(studentStates);
  var acCnt      = vals.filter(function(v){return v.state==='ac';}).length;
  var totalAc    = vals.reduce(function(s, v){return s + (v.state==='ac' ? v.acCount : 0);}, 0);
  var redCnt     = vals.filter(function(v){return v.state==='reduce';}).length;
  var totalRed   = vals.reduce(function(s, v){return s + (v.state==='reduce' ? (v.reduceCount||1) : 0);}, 0);
  var absCnt     = vals.filter(function(v){return v.state==='absent';}).length;
  var el         = document.getElementById('roster-summary');
  if (!el) return;
  var parts      = [];
  if (acCnt > 0) {
    var acText = acCnt + ' +AC';
    if (totalAc > acCnt) acText += ' (' + totalAc + ' total)';
    parts.push('<span class="text-emerald-600 font-semibold">' + acText + '</span>');
  }
  if (redCnt > 0) {
    var redText = redCnt + ' −AC';
    if (totalRed > redCnt) redText += ' (' + totalRed + ' total)';
    parts.push('<span class="text-rose-600 font-semibold">' + redText + '</span>');
  }
  if (absCnt > 0) parts.push('<span class="text-red-500 font-semibold">'+absCnt+' Absent</span>');
  el.innerHTML = parts.length ? parts.join(' · ') : '<span class="text-slate-400">No marks yet</span>';
}

function updateHiddenInputs() {
  var acList = [], redList = [], absList = [];
  Object.keys(studentStates).forEach(function(s) {
    var st = studentStates[s];
    if (st.state === 'ac') {
      for (var i = 0; i < st.acCount; i++) {
        acList.push(s);
      }
    }
    if (st.state === 'reduce') {
      for (var j = 0; j < (st.reduceCount || 1); j++) {
        redList.push(s);
      }
    }
    if (st.state === 'absent') absList.push(s);
  });
  if (acCtrl)        acCtrl.reset(acList);
  if (acReducedCtrl) acReducedCtrl.reset(redList);
  if (absentCtrl)    absentCtrl.reset(absList);
}

/* ═══════════════════════════════════════════════════════════════
   Init tag inputs
   ═══════════════════════════════════════════════════════════════ */
acCtrl        = initTagInput({ inputId:'ac-input',         boxId:'ac-tag-box',         hiddenId:'ac-hidden',         countId:'ac-count',         tagCls:'bg-emerald-100 text-emerald-700', allowDuplicates: true });
acReducedCtrl = initTagInput({ inputId:'ac-reduced-input', boxId:'ac-reduced-tag-box', hiddenId:'ac-reduced-hidden', countId:'ac-reduced-count', tagCls:'bg-rose-100 text-rose-700',       allowDuplicates: true });
absentCtrl    = initTagInput({ inputId:'absent-input',     boxId:'absent-tag-box',     hiddenId:'absent-hidden',     countId:'absent-count',     tagCls:'bg-red-100 text-red-600',         allowDuplicates: false });

/* ═══════════════════════════════════════════════════════════════
   Auto-detect & pre-select group / setup page states on page load
   ═══════════════════════════════════════════════════════════════ */
(function autoSelectGroup() {
  var initSessionType     = formEl.dataset.sessionType || 'group';
  var initSessionMode     = formEl.dataset.sessionMode || 'offline';
  var initClassName       = formEl.dataset.className || '';
  var initAc              = formEl.dataset.acStudents ? formEl.dataset.acStudents.split(',').filter(Boolean) : [];
  var initAcReduced       = formEl.dataset.acReducedStudents ? formEl.dataset.acReducedStudents.split(',').filter(Boolean) : [];
  var initAbsent          = formEl.dataset.absentStudents ? formEl.dataset.absentStudents.split(',').filter(Boolean) : [];
  var initCompGroups      = formEl.dataset.competitionGroups ? formEl.dataset.competitionGroups.split(',').map(function(s){return s.trim();}).filter(Boolean) : [];

  setSessionType(initSessionType);
  setMode(initSessionMode);
  if (formEl.dataset.usesPersonalInternet === 'true') {
    var pic = document.getElementById('personal_internet_check');
    if (pic) pic.checked = true;
  }

  if (initSessionType === 'competition') {
    initCompGroups.forEach(function(name) {
      var g = groupsData.find(function(x) { return x.group_name === name; });
      if (!g) {
        g = {
          _id: 'custom_' + encodeURIComponent(name),
          group_name: name,
          students: [],
          type: 'GROUP'
        };
        groupsData.push(g);
      }
      if (g && competitionSelectedIds.indexOf(g._id) === -1) {
        competitionSelectedIds.push(g._id);
      }
    });
    renderCompetitionTags();

    var allStudents = [];
    competitionSelectedIds.forEach(function(id) {
      var g = groupsData.find(function(x) { return x._id === id; });
      if (g) g.students.forEach(function(s) { if (allStudents.indexOf(s) === -1) allStudents.push(s); });
    });
    studentStates = {};
    allStudents.forEach(function(s) { studentStates[s] = { state: null, acCount: 0, reduceCount: 0 }; });

    var acCounts = {};
    initAc.forEach(function(s) { acCounts[s] = (acCounts[s] || 0) + 1; });
    Object.keys(acCounts).forEach(function(s) {
      if (studentStates[s] !== undefined) {
        studentStates[s] = { state: 'ac', acCount: acCounts[s], reduceCount: 0 };
      }
    });

    var redCounts = {};
    initAcReduced.forEach(function(s) { redCounts[s] = (redCounts[s] || 0) + 1; });
    Object.keys(redCounts).forEach(function(s) {
      if (studentStates[s] !== undefined) {
        studentStates[s] = { state: 'reduce', acCount: 0, reduceCount: redCounts[s] };
      }
    });

    initAbsent.forEach(function(s) {
      if (studentStates[s] !== undefined) studentStates[s] = { state: 'absent', acCount: 0, reduceCount: 0 };
    });

    renderCompetitionRoster();
    return;
  }

  var match = groupsData.find(function(g) { return g.group_name === initClassName; });
  if (match) {
    selectGroup(match._id, { preAc: initAc, preReduced: initAcReduced, preAbsent: initAbsent });
  } else if (initSessionType === 'private') {
    var privateInput = document.getElementById('private_name_input');
    if (privateInput) privateInput.value = initClassName;
  }
})();

// Event delegation for student roster buttons
var rosterStudentsEl = document.getElementById('roster-students');
if (rosterStudentsEl) {
  rosterStudentsEl.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    var student = btn.getAttribute('data-student');
    var role = btn.getAttribute('data-role');
    if (student && role) {
      toggleStudent(student, role);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   Material Autocomplete
   Shared between single report form and bulk report entries.
   ═══════════════════════════════════════════════════════════════ */
function attachMaterialAutocomplete(inputEl, dropdownEl, getLevel) {
  if (!inputEl || !dropdownEl) return;

  var activeIndex = -1;
  var visibleItems = [];

  function getRawMaterials() {
    var raw = [];
    try {
      var el = document.getElementById('report-form-materials-json') || document.getElementById('materials-json');
      if (el && el.textContent) {
        raw = JSON.parse(el.textContent);
      }
    } catch (e) {
      raw = [];
    }
    return raw || [];
  }

  function clientNormalize(raw) {
    if (!raw || typeof raw !== 'string') return '';
    try {
      return raw.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    } catch (e) {
      return raw.trim().toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim();
    }
  }

  function hideDropdown() {
    dropdownEl.classList.add('hidden');
    dropdownEl.classList.remove('open');
    dropdownEl.innerHTML = '';
    activeIndex = -1;
    visibleItems = [];
  }

  function showDropdown() {
    var query = inputEl.value || '';
    var qNorm = clientNormalize(query);
    var currentLevel = (typeof getLevel === 'function' ? (getLevel() || '') : '').trim().toUpperCase();
    var allMaterials = getRawMaterials();

    // 1. Filter: match level with current group level (prevent global leakage across levels)
    var matched = [];
    for (var i = 0; i < allMaterials.length; i++) {
      var m = allMaterials[i];
      var mLvl = (m.level || '').trim().toUpperCase();

      // If group level is known, only show materials matching that level (or universal ones)
      // If group has no level, do not show materials tied to a specific level
      if (currentLevel) {
        if (mLvl && mLvl !== currentLevel) {
          continue; // Mismatch: do not show globally across levels
        }
      } else {
        if (mLvl) {
          continue; // Material is level-specific, but current group has no level
        }
      }

      var mNorm = m._norm || clientNormalize(m.name);
      m._norm = mNorm;
      if (!qNorm || mNorm.indexOf(qNorm) !== -1) {
        matched.push(m);
      }
    }

    // 2. Ranking: level match first, then usageCount desc, then name asc
    matched.sort(function(a, b) {
      var aLvl = (a.level || '').trim().toUpperCase();
      var bLvl = (b.level || '').trim().toUpperCase();
      var aLevelMatch = currentLevel && aLvl === currentLevel ? 1 : 0;
      var bLevelMatch = currentLevel && bLvl === currentLevel ? 1 : 0;

      if (aLevelMatch !== bLevelMatch) {
        return bLevelMatch - aLevelMatch;
      }
      var aUsage = a.usageCount || 0;
      var bUsage = b.usageCount || 0;
      if (bUsage !== aUsage) {
        return bUsage - aUsage;
      }
      return (a.name || '').localeCompare(b.name || '');
    });

    // Deduplicate by (normalizedName, level)
    var deduped = [];
    var seenKeys = {};
    for (var j = 0; j < matched.length; j++) {
      var item = matched[j];
      var key = (item._norm || '') + '|' + (item.level || '').trim().toUpperCase();
      if (!seenKeys[key]) {
        seenKeys[key] = true;
        deduped.push(item);
      }
    }

    var suggestions = deduped.slice(0, 8);

    // 3. Exact match check for (typed text, current level)
    var exactMatch = false;
    if (qNorm) {
      for (var k = 0; k < deduped.length; k++) {
        var itm = deduped[k];
        var itmLvl = (itm.level || '').trim().toUpperCase();
        if (itm._norm === qNorm && itmLvl === currentLevel) {
          exactMatch = true;
          break;
        }
      }
    }

    visibleItems = [];
    var html = '';

    if (qNorm && !exactMatch) {
      var cleanTyped = query.trim();
      visibleItems.push({
        isNewOption: true,
        text: cleanTyped
      });
      html += '<button type="button" class="mat-ac-item w-full text-left px-4 py-2.5 transition flex items-center justify-between gap-3 border-b border-slate-100 bg-brand-50/40 hover:bg-brand-50" data-idx="0">' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-sm font-semibold text-brand-700 truncate">+ Use &ldquo;' + escHtml(cleanTyped) + '&rdquo; as new material</p>' +
          '<p class="text-[11px] text-slate-400 mt-0.5">Will be saved to suggestions when report is submitted</p>' +
        '</div>' +
        (currentLevel ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-700">' + escHtml(currentLevel) + '</span>' : '<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">No level</span>') +
      '</button>';
    }

    for (var s = 0; s < suggestions.length; s++) {
      var sug = suggestions[s];
      var idx = visibleItems.length;
      visibleItems.push({
        isNewOption: false,
        item: sug
      });
      var sLvl = (sug.level || '').trim().toUpperCase();
      var lvlBadge = sLvl
        ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700">' + escHtml(sLvl) + '</span>'
        : '<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400">No level</span>';

      html += '<button type="button" class="mat-ac-item w-full text-left px-4 py-2.5 hover:bg-slate-50 transition flex items-center justify-between gap-3" data-idx="' + idx + '">' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-sm font-semibold text-slate-800 truncate">' + escHtml(sug.name) + '</p>' +
          (sug.usageCount ? '<p class="text-[11px] text-slate-400 mt-0.5">Used ' + sug.usageCount + ' time' + (sug.usageCount === 1 ? '' : 's') + '</p>' : '') +
        '</div>' +
        '<div class="flex-shrink-0 flex items-center gap-1.5">' +
          lvlBadge +
        '</div>' +
      '</button>';
    }

    if (visibleItems.length === 0) {
      hideDropdown();
      return;
    }

    dropdownEl.innerHTML = html;
    dropdownEl.classList.remove('hidden');
    dropdownEl.classList.add('open');
    activeIndex = -1;
  }

  function updateOpenMaterialLink() {
    if (inputEl.id !== 'subject') return;
    var wrap = document.getElementById('open-material-wrap');
    var link = document.getElementById('open-material-link');
    if (!wrap || !link) return;

    var query = inputEl.value || '';
    var qNorm = clientNormalize(query);
    var currentLevel = (typeof getLevel === 'function' ? (getLevel() || '') : '').trim().toUpperCase();
    var allMaterials = getRawMaterials();

    var matchingMaterial = null;
    if (qNorm) {
      for (var i = 0; i < allMaterials.length; i++) {
        var m = allMaterials[i];
        var mNorm = m._norm || clientNormalize(m.name);
        m._norm = mNorm;
        var mLvl = (m.level || '').trim().toUpperCase();
        if (mNorm === qNorm) {
          if (!currentLevel || !mLvl || mLvl === currentLevel) {
            if (m.hasContent) {
              matchingMaterial = m;
              break;
            } else if (!matchingMaterial) {
              matchingMaterial = m;
            }
          }
        }
      }
    }

    var textSpan = document.getElementById('open-material-text') || link;
    if (matchingMaterial && matchingMaterial._id) {
      if (matchingMaterial.hasContent) {
        link.href = '/materials/' + matchingMaterial._id;
        textSpan.textContent = 'Open material';
      } else {
        link.href = '/materials/' + matchingMaterial._id + '/edit';
        textSpan.textContent = '+ Add material content';
      }
      wrap.classList.remove('hidden');
    } else {
      var initialMatId = wrap.dataset.initialMaterialId;
      var initialSubject = wrap.dataset.initialSubject;
      var initialHasContent = wrap.dataset.initialHasContent === 'true';
      if (initialMatId && initialSubject && clientNormalize(initialSubject) === qNorm) {
        if (initialHasContent) {
          link.href = '/materials/' + initialMatId;
          textSpan.textContent = 'Open material';
        } else {
          link.href = '/materials/' + initialMatId + '/edit';
          textSpan.textContent = '+ Add material content';
        }
        wrap.classList.remove('hidden');
      } else {
        wrap.classList.add('hidden');
        link.href = '#';
      }
    }
  }

  function selectIndex(idx) {
    if (idx < 0 || idx >= visibleItems.length) return;
    var target = visibleItems[idx];
    if (target.isNewOption) {
      inputEl.value = target.text;
    } else if (target.item) {
      inputEl.value = target.item.name;
    }
    hideDropdown();
    updateOpenMaterialLink();
    try {
      var evt = new Event('input', { bubbles: true });
      inputEl.dispatchEvent(evt);
    } catch (e) {}
  }

  function updateActiveVisual() {
    var buttons = dropdownEl.querySelectorAll('.mat-ac-item');
    for (var b = 0; b < buttons.length; b++) {
      if (b === activeIndex) {
        buttons[b].classList.add('bg-slate-100');
        buttons[b].classList.add('active');
        try { buttons[b].scrollIntoView({ block: 'nearest' }); } catch (e) {}
      } else {
        buttons[b].classList.remove('bg-slate-100');
        buttons[b].classList.remove('active');
      }
    }
  }

  inputEl.addEventListener('focus', function() {
    showDropdown();
  });

  inputEl.addEventListener('input', function() {
    showDropdown();
    updateOpenMaterialLink();
  });

  if (inputEl.id === 'subject') {
    setTimeout(updateOpenMaterialLink, 50);
  }

  inputEl.addEventListener('keydown', function(e) {
    if (dropdownEl.classList.contains('hidden') || visibleItems.length === 0) {
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) >= visibleItems.length ? 0 : activeIndex + 1;
      updateActiveVisual();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = activeIndex <= 0 ? visibleItems.length - 1 : activeIndex - 1;
      updateActiveVisual();
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < visibleItems.length) {
        e.preventDefault();
        selectIndex(activeIndex);
      }
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      hideDropdown();
    }
  });

  dropdownEl.addEventListener('click', function(e) {
    var btn = e.target.closest('.mat-ac-item');
    if (!btn) return;
    var idx = parseInt(btn.getAttribute('data-idx'), 10);
    if (!isNaN(idx)) {
      selectIndex(idx);
    }
  });

  document.addEventListener('click', function(e) {
    if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target)) {
      hideDropdown();
    }
  });

  inputEl._matAcReRank = function() {
    if (!dropdownEl.classList.contains('hidden')) {
      showDropdown();
    }
  };
}
window.attachMaterialAutocomplete = attachMaterialAutocomplete;

// Initialize material autocomplete for single form
var mainSubjInp = document.getElementById('subject');
var mainSubjList = document.getElementById('subject-mat-ac-list');
if (mainSubjInp && mainSubjList) {
  attachMaterialAutocomplete(mainSubjInp, mainSubjList, function() {
    var sType = (document.getElementById('session_type_input') || {}).value;
    if (sType === 'competition') return '';
    if (typeof selectedGroup !== 'undefined' && selectedGroup && selectedGroup.level) {
      return selectedGroup.level;
    }
    var cInp = document.getElementById('class_name');
    if (cInp && cInp.value && typeof groupsData !== 'undefined' && Array.isArray(groupsData)) {
      var val = cInp.value.trim().toLowerCase();
      var found = groupsData.find(function(g) {
        return g.group_name && g.group_name.trim().toLowerCase() === val;
      });
      if (found && found.level) return found.level;
    }
    return '';
  });
}



  (function () {
    var form  = document.getElementById('report-form');
    var dirty = false;

    form.addEventListener('input',  function () { dirty = true; });
    form.addEventListener('change', function () { dirty = true; });

    form.querySelectorAll('button[type="button"]').forEach(function (btn) {
      btn.addEventListener('click', function () { dirty = true; });
    });

    form.addEventListener('submit', function (e) {
      if (typeof teachingTypeEl !== 'undefined' && teachingTypeEl) {
        var tVal = teachingTypeEl.value;
        if (tVal === 'Assistant Teacher' || tVal === '1/2 Prime Teacher') {
          var pId = partnerHidden ? partnerHidden.value : '';
          var pNm = partnerNameHidden ? partnerNameHidden.value : (partnerDisplay ? partnerDisplay.value : '');
          if (_isSelfTeacher(pId, pNm)) {
            e.preventDefault();
            e.stopPropagation();
            dirty = true;
            if (typeof Swal !== 'undefined') {
              Swal.fire({
                title: 'Cannot Tag Yourself',
                text: 'You cannot tag yourself as the partner teacher.',
                icon: 'error',
                confirmButtonColor: '#0284c7',
                customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' }
              });
            } else {
              alert('You cannot tag yourself as the partner teacher.');
            }
            return false;
          }
        }
      }
      dirty = false;
    });

    var cancelBtn = document.getElementById('cancel-btn');
    var backLink  = document.getElementById('back-link');

    function guardNav(e, href) {
      if (!dirty) return;
      e.preventDefault();
      Swal.fire({
        title: 'Unsaved changes',
        text: 'You have unsaved changes. Leave anyway?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444', cancelButtonColor: '#64748b',
        confirmButtonText: 'Leave', cancelButtonText: 'Stay',
        reverseButtons: true, focusCancel: true,
        customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
      }).then(function (result) {
        if (result.isConfirmed) window.location.href = href;
      });
    }

    if (cancelBtn) cancelBtn.addEventListener('click', function (e) { guardNav(e, ((document.getElementById('report-form-config') ? JSON.parse(document.getElementById('report-form-config').textContent).cancelUrl : null) || (cancelBtn ? cancelBtn.getAttribute('href') : null) || (backLink ? backLink.getAttribute('href') : null) || '/')); });
    if (backLink)  backLink.addEventListener('click',  function (e) { guardNav(e, ((document.getElementById('report-form-config') ? JSON.parse(document.getElementById('report-form-config').textContent).cancelUrl : null) || (cancelBtn ? cancelBtn.getAttribute('href') : null) || (backLink ? backLink.getAttribute('href') : null) || '/')); });

    window.addEventListener('beforeunload', function (e) {
      if (dirty && !window.__bulkSubmitting) { e.preventDefault(); e.returnValue = ''; }
    });
  })();

  if (typeof window.triggerAutoSave !== 'function') {
    window.triggerAutoSave = function() {};
  }
