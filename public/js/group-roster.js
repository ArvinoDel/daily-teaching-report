/**
 * public/js/group-roster.js
 *
 * Client-side logic for manual group roster management:
 *  - Autocomplete student search with "Create new student" option
 *  - Bulk add students
 *  - In-place roster list with Move and Remove actions
 *  - Move modal with group search and class-type mismatch detection
 *  - Remove modal with optional "Mark inactive" checkbox if student has no other groups
 *  - Toast alerts with QR code badge, profile link, and print card link
 *  - Concurrency (409) handling
 *  - Zero inline scripts; CSP compliant; quote-safe HTML escaping
 */
'use strict';

(function () {
  let GROUP_ID = '';
  let GROUP_NAME = '';
  let GROUP_TYPE = '';
  let ROSTER = [];
  let TARGET_GROUPS = [];
  let CSRF_TOKEN = '';

  let activeEditStudent = null;
  let activeMoveStudent = null;
  let activeRemoveStudent = null;
  let searchDebounceTimer = null;

  /* ── Quote-safe HTML escaping ── */
  function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── SweetAlert2 Toast helper ── */
  const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 4500,
    timerProgressBar: true,
    didOpen: (toast) => {
      toast.addEventListener('mouseenter', Swal.stopTimer);
      toast.addEventListener('mouseleave', Swal.resumeTimer);
    },
  });

  /* ── DOM Init ── */
  document.addEventListener('DOMContentLoaded', () => {
    // 1. Read CSRF token from meta tag
    const metaCsrf = document.querySelector('meta[name="csrf-token"]');
    CSRF_TOKEN = metaCsrf ? metaCsrf.getAttribute('content') : '';

    // 2. Read initial data injected via JSON script tag
    const dataEl = document.getElementById('group-roster-data');
    if (dataEl) {
      try {
        const data = JSON.parse(dataEl.textContent || '{}');
        GROUP_ID = data.groupId || '';
        GROUP_NAME = data.groupName || '';
        GROUP_TYPE = data.groupType || 'GROUP';
        ROSTER = Array.isArray(data.roster) ? data.roster : [];
        TARGET_GROUPS = Array.isArray(data.targetGroups) ? data.targetGroups : [];
      } catch (err) {
        console.error('Failed to parse group-roster-data:', err);
      }
    }

    if (!GROUP_ID) return;

    // 3. Render initial roster
    renderRoster();

    // 4. Attach event listeners
    initSearchAutocomplete();
    initBulkAdd();
    initEditModal();
    initMoveModal();
    initRemoveModal();
    initDeleteGroupButton();
    initTypeAndLevelForm();
    initRepairRoster();
  });

  function initTypeAndLevelForm() {
    // Type card border/bg toggling
    document.querySelectorAll('input[name="type"]').forEach(radio => {
      radio.addEventListener('change', () => {
        document.querySelectorAll('input[name="type"]').forEach(r => {
          const card = r.closest('label');
          if (!card) return;
          if (r.value === 'GROUP') {
            card.classList.toggle('border-emerald-400', r.checked);
            card.classList.toggle('bg-emerald-50', r.checked);
            card.classList.toggle('border-slate-100', !r.checked);
          } else {
            card.classList.toggle('border-purple-400', r.checked);
            card.classList.toggle('bg-purple-50', r.checked);
            card.classList.toggle('border-slate-100', !r.checked);
          }
        });
      });
    });

    // Level chips
    document.querySelectorAll('.level-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const levelInput = document.getElementById('level');
        if (levelInput) {
          levelInput.value = btn.dataset.level || '';
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     ROSTER RENDERING
  ════════════════════════════════════════════════════════════════ */
  function renderRoster() {
    const countEl = document.getElementById('roster-count');
    if (countEl) {
      countEl.textContent = ROSTER.length;
    }

    const container = document.getElementById('roster-list-container');
    if (!container) return;

    if (ROSTER.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 px-4 bg-slate-50 rounded-xl border border-dashed border-slate-200">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 mx-auto text-slate-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
          </svg>
          <p class="text-sm font-semibold text-slate-600">No students in this group yet</p>
          <p class="text-xs text-slate-400 mt-0.5">Search or add students using the input above.</p>
        </div>
      `;
      return;
    }

    let rowsHtml = '';
    ROSTER.forEach((student, idx) => {
      const isInactive = student.status === 'inactive';
      const studentId = student.studentId || '';
      const name = student.name || 'Unnamed';
      const code = student.student_code || student.barcode || '—';

      rowsHtml += `
        <tr class="border-b border-slate-100 hover:bg-slate-50/70 transition group">
          <td class="py-3 px-3 text-xs font-mono text-slate-400 text-center w-8">
            ${idx + 1}
          </td>
          <td class="py-3 px-3">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-slate-800">${escHtml(name)}</span>
              ${isInactive ? '<span class="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">Inactive</span>' : ''}
            </div>
          </td>
          <td class="py-3 px-3">
            ${code && code !== '—' ? `
              <span class="inline-flex items-center gap-1 font-mono text-xs px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 border border-slate-200">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z" />
                </svg>
                ${escHtml(code)}
              </span>
            ` : '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">No QR yet</span>'}
          </td>
          <td class="py-3 px-3 text-right">
            <div class="inline-flex items-center gap-1.5">
              ${studentId ? `
                <button type="button"
                  class="btn-edit-student inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition shadow-sm"
                  data-student-id="${escHtml(studentId)}"
                  data-student-name="${escHtml(name)}"
                  data-student-code="${escHtml(code)}">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                  </svg>
                  Edit
                </button>
                <button type="button"
                  class="btn-move-student inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition shadow-sm"
                  data-student-id="${escHtml(studentId)}"
                  data-student-name="${escHtml(name)}"
                  data-student-code="${escHtml(code)}">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                  </svg>
                  Move
                </button>
                <button type="button"
                  class="btn-remove-student inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-white border border-slate-200 text-red-600 hover:bg-red-50 hover:border-red-200 transition shadow-sm"
                  data-student-id="${escHtml(studentId)}"
                  data-student-name="${escHtml(name)}"
                  data-is-only-group="${student.isOnlyGroup ? 'true' : 'false'}">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                  </svg>
                  Remove
                </button>
              ` : `
                <button type="button" disabled
                  title="Repair roster first to link this student"
                  class="opacity-50 cursor-not-allowed inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-50 border border-slate-200 text-slate-400">
                  Edit
                </button>
                <button type="button" disabled
                  title="Repair roster first to link this student"
                  class="opacity-50 cursor-not-allowed inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-50 border border-slate-200 text-slate-400">
                  Move
                </button>
                <button type="button" disabled
                  title="Repair roster first to link this student"
                  class="opacity-50 cursor-not-allowed inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-50 border border-slate-200 text-slate-400">
                  Remove
                </button>
              `}
            </div>
          </td>
        </tr>
      `;
    });

    container.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-slate-200 bg-slate-50/75 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              <th class="py-2.5 px-3 w-8 text-center">#</th>
              <th class="py-2.5 px-3">Student Name</th>
              <th class="py-2.5 px-3">Code / Barcode</th>
              <th class="py-2.5 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;

    // Attach row action listeners
    container.querySelectorAll('.btn-edit-student').forEach(btn => {
      btn.addEventListener('click', () => {
        openEditModal({
          studentId: btn.dataset.studentId,
          name: btn.dataset.studentName,
          studentCode: btn.dataset.studentCode,
        }, btn);
      });
    });

    container.querySelectorAll('.btn-move-student').forEach(btn => {
      btn.addEventListener('click', () => {
        openMoveModal({
          studentId: btn.dataset.studentId,
          name: btn.dataset.studentName,
          studentCode: btn.dataset.studentCode,
        });
      });
    });

    container.querySelectorAll('.btn-remove-student').forEach(btn => {
      btn.addEventListener('click', () => {
        openRemoveModal({
          studentId: btn.dataset.studentId,
          name: btn.dataset.studentName,
          isOnlyGroup: btn.dataset.isOnlyGroup === 'true',
        });
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     AUTOCOMPLETE STUDENT SEARCH
  ═══════════════════════════════════════════════════════════════ */
  function initSearchAutocomplete() {
    const input = document.getElementById('student-search-input');
    const dropdown = document.getElementById('student-suggestions');
    if (!input || !dropdown) return;

    input.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      const query = input.value.trim();

      if (!query) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
        return;
      }

      searchDebounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/admin/students/search?q=${encodeURIComponent(query)}&limit=10`, {
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
          if (!res.ok) throw new Error('Search failed');
          const results = await res.json();
          renderSuggestions(query, results);
        } catch (err) {
          console.error(err);
        }
      }, 250);
    });

    // Close suggestions on outside click
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });

    // Re-open on focus if query present
    input.addEventListener('focus', () => {
      if (input.value.trim() && dropdown.children.length > 0) {
        dropdown.classList.remove('hidden');
      }
    });
  }

  function renderSuggestions(query, results) {
    const dropdown = document.getElementById('student-suggestions');
    if (!dropdown) return;

    dropdown.innerHTML = '';

    // Suggestions from DB
    if (Array.isArray(results) && results.length > 0) {
      results.forEach(s => {
        const item = document.createElement('div');
        item.className = 'px-4 py-2.5 hover:bg-brand-50 cursor-pointer border-b border-slate-100 transition flex items-center justify-between gap-3 text-sm';

        const name = s.raw_name || s.full_name || '—';
        const code = s.student_code || '';
        const groups = Array.isArray(s.groups) ? s.groups : [];
        const isAlreadyInGroup = ROSTER.some(r => (r.studentId && r.studentId === s._id) || (r.name && r.name.toLowerCase() === name.toLowerCase()));

        let groupsBadges = '';
        if (groups.length > 0) {
          groupsBadges = groups.map(g => `<span class="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">${escHtml(g.group_name)} (${escHtml(g.type)})</span>`).join(' ');
        } else {
          groupsBadges = '<span class="text-[10px] text-slate-400">No active classes</span>';
        }

        item.innerHTML = `
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-slate-800 truncate">${escHtml(name)}</span>
              ${code ? `<span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">${escHtml(code)}</span>` : ''}
              ${isAlreadyInGroup ? '<span class="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.2 rounded font-semibold">In this group</span>' : ''}
            </div>
            <div class="flex flex-wrap gap-1 mt-1">${groupsBadges}</div>
          </div>
          <button type="button" class="flex-shrink-0 text-xs font-semibold px-2.5 py-1 rounded-lg ${isAlreadyInGroup ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-brand-600 hover:bg-brand-700 text-white'} transition">
            ${isAlreadyInGroup ? 'Added' : 'Select'}
          </button>
        `;

        if (!isAlreadyInGroup) {
          item.addEventListener('click', () => {
            dropdown.classList.add('hidden');
            const searchInput = document.getElementById('student-search-input');
            if (searchInput) searchInput.value = '';
            submitAddStudents([name]);
          });
        }

        dropdown.appendChild(item);
      });
    }

    // Always append: "Create new student: <query>"
    const createItem = document.createElement('div');
    createItem.className = 'px-4 py-3 bg-slate-50 hover:bg-indigo-50 cursor-pointer text-sm font-semibold text-indigo-700 flex items-center gap-2 border-t border-slate-200 transition';
    createItem.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-indigo-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
      </svg>
      <span class="truncate">Create new student: "<strong>${escHtml(query)}</strong>"</span>
    `;

    createItem.addEventListener('click', () => {
      dropdown.classList.add('hidden');
      const searchInput = document.getElementById('student-search-input');
      if (searchInput) searchInput.value = '';
      submitAddStudents([query]);
    });

    dropdown.appendChild(createItem);
    dropdown.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════════════════════════
     BULK ADD
  ═══════════════════════════════════════════════════════════════ */
  function initBulkAdd() {
    const toggleBtn = document.getElementById('toggle-bulk-add');
    const bulkSection = document.getElementById('bulk-add-section');
    const cancelBtn = document.getElementById('btn-cancel-bulk-add');
    const submitBtn = document.getElementById('btn-submit-bulk-add');
    const textarea = document.getElementById('bulk-add-textarea');

    if (toggleBtn && bulkSection) {
      toggleBtn.addEventListener('click', () => {
        bulkSection.classList.toggle('hidden');
        if (!bulkSection.classList.contains('hidden') && textarea) {
          textarea.focus();
        }
      });
    }

    if (cancelBtn && bulkSection) {
      cancelBtn.addEventListener('click', () => {
        bulkSection.classList.add('hidden');
        if (textarea) textarea.value = '';
      });
    }

    if (submitBtn && textarea) {
      submitBtn.addEventListener('click', () => {
        const text = textarea.value.trim();
        if (!text) {
          Toast.fire({ icon: 'warning', title: 'Please enter student names.' });
          return;
        }

        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) {
          Toast.fire({ icon: 'warning', title: 'Please enter at least one valid name.' });
          return;
        }

        submitAddStudents(lines, () => {
          textarea.value = '';
          if (bulkSection) bulkSection.classList.add('hidden');
        });
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     API: SUBMIT ADD STUDENTS
  ═══════════════════════════════════════════════════════════════ */
  async function submitAddStudents(names, onSuccess, confirmSameStudent) {
    if (!names || names.length === 0) return;

    try {
      const payload = { names };
      if (Array.isArray(confirmSameStudent) && confirmSameStudent.length > 0) {
        payload.confirmSameStudent = confirmSameStudent;
      }

      const res = await fetch(`/admin/groups/${GROUP_ID}/students`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': CSRF_TOKEN,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));

        if (data.possibleNamesake && Array.isArray(data.possibleNamesake) && data.possibleNamesake.length > 0) {
          let listHtml = '<div class="text-left space-y-3 mt-3">';
          data.possibleNamesake.forEach(p => {
            const grpStr = p.groupNames && p.groupNames.length ? p.groupNames.join(', ') : 'None';
            listHtml += '<div class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs space-y-1">'
              + '<div class="font-bold text-amber-900 text-sm">Incoming: ' + escHtml(p.rawName) + '</div>'
              + '<div class="text-slate-700"><strong>Existing Student:</strong> ' + escHtml(p.name) + '</div>'
              + '<div class="text-slate-600"><strong>Grade / School:</strong> ' + escHtml(p.grade_school || 'None') + '</div>'
              + '<div class="text-slate-600"><strong>Status:</strong> ' + escHtml(p.status || 'active') + '</div>'
              + '<div class="text-slate-600"><strong>Current Groups:</strong> ' + escHtml(grpStr) + '</div>'
              + '</div>';
          });
          listHtml += '</div>';

          const modalResult = await Swal.fire({
            title: 'Possible Namesake Detected',
            html: '<p class="text-sm text-slate-600">An existing student with a matching name was found, but the grade or school details indicate they might be different students.</p>'
              + listHtml
              + '<p class="text-xs text-slate-500 mt-3">If this is a different student, click Cancel and add a last initial or surname (e.g. "Jason J 12 CS") to separate them.</p>',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Yes, same student',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#4f46e5',
            cancelButtonColor: '#6b7280',
          });

          if (modalResult.isConfirmed) {
            const confirmedNorms = data.possibleNamesake.map(p => p.norm).filter(Boolean);
            return submitAddStudents(names, onSuccess, confirmedNorms);
          }
          return;
        }

        if (data.needsRepair) {
          const banner = document.getElementById('roster-inconsistent-banner');
          if (banner) banner.classList.remove('hidden');
          Toast.fire({ icon: 'warning', title: data.message || "Repair this group's roster first." });
          return;
        }
        Swal.fire({
          icon: 'error',
          title: 'Conflict Detected',
          text: data.message || 'Group was changed by another user. Please refresh the page to see the latest version.',
          confirmButtonColor: '#4f46e5',
        });
        return;
      }

      const data = await res.json();
      if (!res.ok || !data.ok) {
        Swal.fire({
          icon: 'error',
          title: 'Error',
          text: data.message || 'Failed to add students.',
          confirmButtonColor: '#ef4444',
        });
        return;
      }

      // Add to local ROSTER
      const addedList = data.added || [];
      addedList.forEach(a => {
        ROSTER.push({
          studentId: a.studentId,
          name: a.name,
          student_code: a.student_code,
          barcode: a.barcode,
          status: 'active',
          isOnlyGroup: true,
        });
      });

      renderRoster();
      if (typeof onSuccess === 'function') onSuccess();

      // Show notifications
      const createdStudents = addedList.filter(a => a.created);
      if (createdStudents.length > 0) {
        // Detailed toast / modal notification for created students with links
        const first = createdStudents[0];
        Swal.fire({
          icon: 'success',
          title: 'New Student Added',
          html: `
            <p class="text-sm text-slate-700">Added <strong>${escHtml(first.name)}</strong> to group.</p>
            <div class="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-800">
              <div class="font-bold">New QR created: ${escHtml(first.student_code)}</div>
              <div class="mt-2 flex items-center justify-center gap-3">
                <a href="/admin/student-achievements/student/${first.studentId}" target="_blank" class="font-semibold text-indigo-600 hover:text-indigo-800 underline">View Profile</a>
                <span>·</span>
                <a href="/admin/student-achievements/print-cards?student_id=${first.studentId}" target="_blank" class="font-semibold text-indigo-600 hover:text-indigo-800 underline">Print QR Card</a>
              </div>
            </div>
            ${createdStudents.length > 1 ? `<p class="text-xs text-slate-500 mt-2">+${createdStudents.length - 1} other new student(s) created.</p>` : ''}
          `,
          confirmButtonText: 'Done',
          confirmButtonColor: '#4f46e5',
          customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
        });
      } else if (addedList.length > 0) {
        Toast.fire({
          icon: 'success',
          title: `Added ${addedList.length} student${addedList.length !== 1 ? 's' : ''} to group.`,
        });
      }

      // If any skipped
      if (data.skipped && data.skipped.length > 0) {
        const skippedMsg = data.skipped.map(s => `${s.name} (${s.reason})`).join(', ');
        setTimeout(() => {
          Toast.fire({
            icon: 'info',
            title: `Skipped: ${skippedMsg}`,
          });
        }, 1000);
      }

    } catch (err) {
      console.error(err);
      Swal.fire({
        icon: 'error',
        title: 'Network Error',
        text: 'Failed to communicate with the server.',
        confirmButtonColor: '#ef4444',
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     EDIT STUDENT MODAL
  ════════════════════════════════════════════════════════════════ */
  let lastFocusedEditButton = null;

  function initEditModal() {
    const modal = document.getElementById('modal-edit-student');
    const cancelBtn = document.getElementById('btn-cancel-edit-student');
    const confirmBtn = document.getElementById('btn-confirm-edit-student');
    const nameInput = document.getElementById('edit-student-name-input');
    const errorBox = document.getElementById('edit-student-error');

    if (!modal) return;

    function closeModal() {
      modal.classList.add('hidden');
      activeEditStudent = null;
      if (errorBox) {
        errorBox.classList.add('hidden');
        errorBox.textContent = '';
      }
      const previewNotice = document.getElementById('edit-student-preview-notice');
      if (previewNotice) {
        previewNotice.classList.add('hidden');
        previewNotice.innerHTML = '';
      }
      if (lastFocusedEditButton && typeof lastFocusedEditButton.focus === 'function') {
        lastFocusedEditButton.focus();
        lastFocusedEditButton = null;
      }
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', closeModal);
    }

    // Close on click outside backdrop
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeModal();
      }
    });

    // Focus trap (Tab and Shift+Tab stay inside modal)
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        const focusable = modal.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        const visibleFocusable = Array.prototype.filter.call(focusable, el => el.offsetParent !== null);
        if (visibleFocusable.length === 0) return;
        const first = visibleFocusable[0];
        const last = visibleFocusable[visibleFocusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });

    if (nameInput) {
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (confirmBtn) confirmBtn.click();
        }
      });
      nameInput.addEventListener('input', () => {
        if (errorBox) errorBox.classList.add('hidden');
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (!activeEditStudent) return;
        const newName = nameInput ? nameInput.value.trim() : '';
        if (!newName) {
          if (errorBox) {
            errorBox.textContent = 'Please enter a student name.';
            errorBox.classList.remove('hidden');
          } else {
            Toast.fire({ icon: 'warning', title: 'Please enter a student name.' });
          }
          if (nameInput) nameInput.focus();
          return;
        }

        if (newName === activeEditStudent.name) {
          closeModal();
          Toast.fire({ icon: 'info', title: 'Student name unchanged.' });
          return;
        }

        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Saving…';
        if (errorBox) errorBox.classList.add('hidden');

        try {
          const res = await fetch(`/admin/groups/${GROUP_ID}/students/${activeEditStudent.studentId}/rename`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': CSRF_TOKEN,
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({ newName }),
          });

          const data = await res.json().catch(() => ({}));

          if (res.status === 409) {
            if (data.needsRepair) {
              const banner = document.getElementById('roster-inconsistent-banner');
              if (banner) banner.classList.remove('hidden');
              Toast.fire({ icon: 'warning', title: data.message || "Repair this group's roster first." });
              closeModal();
              return;
            }

            if (errorBox) {
              errorBox.textContent = data.message || 'Name conflict detected.';
              errorBox.classList.remove('hidden');
            } else {
              Toast.fire({ icon: 'warning', title: data.message || 'Name conflict detected.' });
            }
            return;
          }

          if (!res.ok || !data.ok) {
            if (errorBox) {
              errorBox.textContent = data.message || 'Failed to update student name.';
              errorBox.classList.remove('hidden');
            } else {
              Swal.fire({
                icon: 'error',
                title: 'Error',
                text: data.message || 'Failed to update student name.',
                confirmButtonColor: '#ef4444',
              });
            }
            return;
          }

          // Update local ROSTER
          const target = ROSTER.find(r => r.studentId === activeEditStudent.studentId);
          if (target) {
            target.name = data.name;
          }
          renderRoster();
          closeModal();

          const nOther = data.groupsUpdated || 0;
          const mReports = data.reportsUpdated || 0;
          Toast.fire({
            icon: 'success',
            title: `Renamed. Updated ${nOther} other group(s) and ${mReports} report entries.`,
          });

          // Warning if historyIncomplete or skippedGroups is non-empty
          const skipped = Array.isArray(data.skippedGroups) ? data.skippedGroups : [];
          if (data.historyIncomplete || skipped.length > 0) {
            const warningParts = [];
            if (skipped.length > 0) {
              const namesList = skipped.map(g => `<li><strong>${escHtml(g.group_name)}</strong>: ${escHtml(g.reason)}</li>`).join('');
              warningParts.push(`
                <p class="font-semibold text-slate-800">The following group(s) were skipped and not updated:</p>
                <ul class="list-disc list-inside mt-1 mb-2 text-xs text-slate-600 space-y-1">${namesList}</ul>
                <p class="text-xs text-slate-500">Please open those groups and run "Repair roster" to fix any inconsistencies.</p>
              `);
            }
            if (data.historyIncomplete) {
              warningParts.push(`
                <p class="text-xs text-amber-700 mt-2 font-medium">
                  Some past report entries could not be updated automatically.
                </p>
              `);
            }

            Swal.fire({
              icon: 'warning',
              title: 'Partial Update Warning',
              html: `<div class="text-left text-sm text-slate-700 space-y-2">${warningParts.join('')}</div>`,
              confirmButtonText: 'Understood',
              confirmButtonColor: '#4f46e5',
              customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
            });
          }

        } catch (err) {
          console.error(err);
          if (errorBox) {
            errorBox.textContent = 'Network error. Could not reach server.';
            errorBox.classList.remove('hidden');
          } else {
            Swal.fire({
              icon: 'error',
              title: 'Network Error',
              text: 'Failed to communicate with the server.',
              confirmButtonColor: '#ef4444',
            });
          }
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Save name';
        }
      });
    }
  }

  async function openEditModal(student, triggerBtn) {
    activeEditStudent = student;
    lastFocusedEditButton = triggerBtn || document.activeElement;
    const modal = document.getElementById('modal-edit-student');
    if (!modal) return;

    const codeEl = document.getElementById('edit-student-code');
    const currentNameEl = document.getElementById('edit-student-current-name');
    const nameInput = document.getElementById('edit-student-name-input');
    const errorBox = document.getElementById('edit-student-error');
    const previewNotice = document.getElementById('edit-student-preview-notice');

    if (codeEl) codeEl.textContent = student.studentCode && student.studentCode !== '—' ? student.studentCode : '—';
    if (currentNameEl) currentNameEl.textContent = student.name || '—';
    if (nameInput) {
      nameInput.value = student.name || '';
    }
    if (errorBox) {
      errorBox.classList.add('hidden');
      errorBox.textContent = '';
    }

    // Neutral loading state while preview loads
    if (previewNotice) {
      previewNotice.className = 'mb-4 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex items-center gap-2';
      previewNotice.innerHTML = `
        <svg class="animate-spin w-3.5 h-3.5 text-slate-400 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span>Checking other groups and report history…</span>
      `;
      previewNotice.classList.remove('hidden');
    }

    modal.classList.remove('hidden');
    if (nameInput) {
      setTimeout(() => {
        nameInput.focus();
        nameInput.select();
      }, 50);
    }

    // Fetch rename preview
    const sid = student.studentId;
    try {
      const res = await fetch(`/admin/groups/${GROUP_ID}/students/${sid}/rename-preview`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error('Preview failed');
      const data = await res.json();

      if (activeEditStudent && activeEditStudent.studentId === sid && previewNotice) {
        const otherGroups = Array.isArray(data.otherGroups) ? data.otherGroups : [];
        const moreGroups = data.moreGroups || 0;
        const totalOther = otherGroups.length + moreGroups;
        const reportEntries = data.reportEntries || 0;

        let groupsListStr = '';
        if (otherGroups.length > 0) {
          const names = otherGroups.map(g => escHtml(g.group_name)).join(', ');
          groupsListStr = ` (${names}${moreGroups > 0 ? `, +${moreGroups} more` : ''})`;
        }

        previewNotice.className = 'mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900';
        previewNotice.innerHTML = `
          <div class="flex items-start gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <div class="leading-relaxed">
              This renames the student everywhere: in this group, in ${totalOther} other group(s)${groupsListStr} and in ${reportEntries} past report entries.
            </div>
          </div>
        `;
      }
    } catch (err) {
      console.error('Rename preview error:', err);
      if (activeEditStudent && activeEditStudent.studentId === sid && previewNotice) {
        // Fallback: general warning text without numbers
        previewNotice.className = 'mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900';
        previewNotice.innerHTML = `
          <div class="flex items-start gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <div class="leading-relaxed">
              This renames the student everywhere: in this group, in other groups containing this student, and in past report entries.
            </div>
          </div>
        `;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     MOVE STUDENT MODAL
  ═══════════════════════════════════════════════════════════════ */
  function initMoveModal() {
    const modal = document.getElementById('modal-move-student');
    const cancelBtn = document.getElementById('btn-cancel-move');
    const confirmBtn = document.getElementById('btn-confirm-move');
    const filterInput = document.getElementById('move-group-filter');
    const select = document.getElementById('move-group-select');

    if (!modal) return;

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        activeMoveStudent = null;
      });
    }

    if (filterInput && select) {
      filterInput.addEventListener('input', () => {
        const query = filterInput.value.toLowerCase().trim();
        populateMoveGroupSelect(query);
      });

      select.addEventListener('change', () => {
        checkMoveTypeMismatch();
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (!activeMoveStudent || !select.value) {
          Toast.fire({ icon: 'warning', title: 'Please select a target group.' });
          return;
        }

        const targetGroupId = select.value;
        const targetGroup = TARGET_GROUPS.find(g => g._id === targetGroupId);
        const confirmCheckbox = document.getElementById('move-confirm-type-checkbox');
        const confirmTypeChange = confirmCheckbox ? confirmCheckbox.checked : false;

        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Moving…';

        try {
          const res = await fetch(`/admin/groups/${GROUP_ID}/students/${activeMoveStudent.studentId}/move`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': CSRF_TOKEN,
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({ targetGroupId, confirmTypeChange }),
          });

          if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            if (data.needsRepair) {
              const banner = document.getElementById('roster-inconsistent-banner');
              if (banner) banner.classList.remove('hidden');
              Toast.fire({ icon: 'warning', title: data.message || "Repair this group's roster first." });
              confirmBtn.disabled = false;
              confirmBtn.textContent = 'Confirm Move';
              modal.classList.add('hidden');
              return;
            }

            if (data.requiresTypeConfirmation) {
              // Show type mismatch alert
              const warningBox = document.getElementById('move-type-warning');
              if (warningBox) {
                warningBox.classList.remove('hidden');
                const warningMsg = document.getElementById('move-type-warning-msg');
                if (warningMsg) warningMsg.textContent = data.message;
              }
              confirmBtn.disabled = false;
              confirmBtn.textContent = 'Confirm Move';
              return;
            }

            Swal.fire({
              icon: 'error',
              title: 'Conflict Detected',
              text: data.message || 'Group was changed by another user. Please refresh.',
              confirmButtonColor: '#4f46e5',
            });
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Move';
            return;
          }

          const data = await res.json();
          if (!res.ok || !data.ok) {
            Swal.fire({
              icon: 'error',
              title: 'Error',
              text: data.message || 'Failed to move student.',
              confirmButtonColor: '#ef4444',
            });
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Move';
            return;
          }

          // Remove from local ROSTER
          ROSTER = ROSTER.filter(r => r.studentId !== activeMoveStudent.studentId);
          renderRoster();

          modal.classList.add('hidden');
          const movedName = activeMoveStudent.name;
          const targetName = targetGroup ? targetGroup.group_name : 'target group';
          activeMoveStudent = null;

          Toast.fire({
            icon: 'success',
            title: `Moved "${movedName}" to "${targetName}".`,
          });

        } catch (err) {
          console.error(err);
          Swal.fire({
            icon: 'error',
            title: 'Network Error',
            text: 'Failed to communicate with the server.',
            confirmButtonColor: '#ef4444',
          });
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm Move';
        }
      });
    }
  }

  function openMoveModal(student) {
    activeMoveStudent = student;
    const modal = document.getElementById('modal-move-student');
    if (!modal) return;

    const nameEl = document.getElementById('move-student-name');
    const codeEl = document.getElementById('move-student-code');
    const filterInput = document.getElementById('move-group-filter');
    const warningBox = document.getElementById('move-type-warning');
    const confirmCheckbox = document.getElementById('move-confirm-type-checkbox');

    if (nameEl) nameEl.textContent = student.name;
    if (codeEl) codeEl.textContent = student.studentCode ? `(${student.studentCode})` : '';
    if (filterInput) filterInput.value = '';
    if (warningBox) warningBox.classList.add('hidden');
    if (confirmCheckbox) confirmCheckbox.checked = false;

    populateMoveGroupSelect('');
    modal.classList.remove('hidden');
  }

  function populateMoveGroupSelect(filter) {
    const select = document.getElementById('move-group-select');
    if (!select) return;

    select.innerHTML = '<option value="">— Select Target Group —</option>';

    const filtered = TARGET_GROUPS.filter(g => {
      if (!filter) return true;
      const term = filter.toLowerCase();
      return (g.group_name && g.group_name.toLowerCase().includes(term)) ||
             (g.type && g.type.toLowerCase().includes(term)) ||
             (g.level && g.level.toLowerCase().includes(term));
    });

    filtered.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g._id;
      const count = g.student_count || 0;
      const lvl = g.level ? ` · ${g.level}` : '';
      opt.textContent = `${g.group_name} [${g.type}${lvl}] (${count} students)`;
      opt.dataset.type = g.type;
      select.appendChild(opt);
    });

    checkMoveTypeMismatch();
  }

  function checkMoveTypeMismatch() {
    const select = document.getElementById('move-group-select');
    const warningBox = document.getElementById('move-type-warning');
    const warningMsg = document.getElementById('move-type-warning-msg');
    const confirmCheckbox = document.getElementById('move-confirm-type-checkbox');
    if (!select || !warningBox) return;

    const opt = select.options[select.selectedIndex];
    if (!opt || !opt.value) {
      warningBox.classList.add('hidden');
      return;
    }

    const targetType = opt.dataset.type;
    if (targetType && targetType !== GROUP_TYPE) {
      if (warningMsg) {
        warningMsg.textContent = `Target group class type is "${targetType}", differing from current group type "${GROUP_TYPE}".`;
      }
      warningBox.classList.remove('hidden');
      if (confirmCheckbox) confirmCheckbox.checked = true;
    } else {
      warningBox.classList.add('hidden');
      if (confirmCheckbox) confirmCheckbox.checked = false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     REMOVE STUDENT MODAL
  ═══════════════════════════════════════════════════════════════ */
  function initRemoveModal() {
    const modal = document.getElementById('modal-remove-student');
    const cancelBtn = document.getElementById('btn-cancel-remove');
    const confirmBtn = document.getElementById('btn-confirm-remove');

    if (!modal) return;

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        activeRemoveStudent = null;
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (!activeRemoveStudent) return;

        const markInactiveBox = document.getElementById('remove-mark-inactive');
        const markInactive = markInactiveBox ? markInactiveBox.checked : false;

        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Removing…';

        try {
          const res = await fetch(`/admin/groups/${GROUP_ID}/students/${activeRemoveStudent.studentId}/remove`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': CSRF_TOKEN,
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({ markInactive }),
          });

          if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            if (data.needsRepair) {
              const banner = document.getElementById('roster-inconsistent-banner');
              if (banner) banner.classList.remove('hidden');
              Toast.fire({ icon: 'warning', title: data.message || "Repair this group's roster first." });
              confirmBtn.disabled = false;
              confirmBtn.textContent = 'Remove Student';
              modal.classList.add('hidden');
              return;
            }

            Swal.fire({
              icon: 'error',
              title: 'Conflict Detected',
              text: data.message || 'Group was changed by another user. Please refresh.',
              confirmButtonColor: '#4f46e5',
            });
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Remove Student';
            return;
          }

          const data = await res.json();
          if (!res.ok || !data.ok) {
            Swal.fire({
              icon: 'error',
              title: 'Error',
              text: data.message || 'Failed to remove student.',
              confirmButtonColor: '#ef4444',
            });
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Remove Student';
            return;
          }

          // Remove from local ROSTER
          ROSTER = ROSTER.filter(r => r.studentId !== activeRemoveStudent.studentId);
          renderRoster();

          modal.classList.add('hidden');
          const removedName = activeRemoveStudent.name;
          activeRemoveStudent = null;

          Toast.fire({
            icon: 'success',
            title: `Removed "${removedName}" from group.${data.markedInactive ? ' Marked as inactive.' : ''}`,
          });

        } catch (err) {
          console.error(err);
          Swal.fire({
            icon: 'error',
            title: 'Network Error',
            text: 'Failed to communicate with the server.',
            confirmButtonColor: '#ef4444',
          });
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Remove Student';
        }
      });
    }
  }

  function openRemoveModal(student) {
    activeRemoveStudent = student;
    const modal = document.getElementById('modal-remove-student');
    if (!modal) return;

    const nameEl = document.getElementById('remove-student-name');
    const inactiveContainer = document.getElementById('remove-inactive-container');
    const checkbox = document.getElementById('remove-mark-inactive');

    if (nameEl) nameEl.textContent = student.name;

    // Show inactive checkbox only if this is student's only group
    if (inactiveContainer) {
      if (student.isOnlyGroup) {
        inactiveContainer.classList.remove('hidden');
        if (checkbox) checkbox.checked = false;
      } else {
        inactiveContainer.classList.add('hidden');
        if (checkbox) checkbox.checked = false;
      }
    }

    modal.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════════════════════════
     DELETE GROUP BUTTON (CSP Clean)
  ═══════════════════════════════════════════════════════════════ */
  function initDeleteGroupButton() {
    const btn = document.getElementById('btn-delete-group');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteId;
      const name = btn.dataset.name;

      Swal.fire({
        title: `Delete "${name}"?`,
        text: 'This action cannot be undone. Past teaching reports are preserved.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#64748b',
        confirmButtonText: 'Yes, delete it!',
        cancelButtonText: 'Cancel',
        reverseButtons: true,
        focusCancel: true,
        customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
      }).then((result) => {
        if (!result.isConfirmed) return;
        Swal.fire({
          title: 'Deleting…',
          allowOutsideClick: false,
          showConfirmButton: false,
          didOpen: () => { Swal.showLoading(); },
        });

        fetch(`/admin/groups/${id}`, {
          method: 'DELETE',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'x-csrf-token': CSRF_TOKEN },
        }).then(res => {
          if (res.ok) {
            Swal.fire({
              title: 'Deleted!',
              icon: 'success',
              timer: 1400,
              showConfirmButton: false,
              customClass: { popup: 'rounded-2xl' },
            }).then(() => {
              window.location.href = '/admin/groups';
            });
          } else {
            Swal.fire({
              title: 'Error',
              text: 'Failed to delete. Please try again.',
              icon: 'error',
              confirmButtonColor: '#ef4444',
              customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
            });
          }
        }).catch(() => {
          Swal.fire({
            title: 'Network Error',
            text: 'Could not reach the server.',
            icon: 'error',
            confirmButtonColor: '#ef4444',
            customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
          });
        });
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     REPAIR ROSTER
  ═══════════════════════════════════════════════════════════════ */
  function initRepairRoster() {
    const btnRepair = document.getElementById('btn-repair-roster');
    if (!btnRepair) return;

    btnRepair.addEventListener('click', async () => {
      const originalHtml = btnRepair.innerHTML;
      btnRepair.disabled = true;
      btnRepair.innerHTML = `
        <svg class="animate-spin -ml-1 mr-2 h-3.5 w-3.5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        Repairing…
      `;

      try {
        const resp = await fetch(`/admin/groups/${GROUP_ID}/repair`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': CSRF_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
          },
        });

        const data = await resp.json().catch(() => ({}));

        if (resp.status === 422 || data.needsManualFix) {
          const errContainer = document.getElementById('roster-repair-error-container');
          const errList = document.getElementById('roster-repair-error-list');
          if (errContainer && errList) {
            errList.innerHTML = (data.skipped || []).map(s => `<li><strong>${escHtml(s.name)}</strong> — ${escHtml(s.reason)}</li>`).join('');
            errContainer.classList.remove('hidden');
          }
          const banner = document.getElementById('roster-inconsistent-banner');
          if (banner) banner.classList.remove('hidden');
          Toast.fire({ icon: 'warning', title: 'Manual fix required before repair.' });
          btnRepair.disabled = false;
          btnRepair.innerHTML = originalHtml;
          return;
        }

        if (resp.status === 409) {
          Toast.fire({ icon: 'warning', title: data.message || 'Group changed, refresh the page' });
          btnRepair.disabled = false;
          btnRepair.innerHTML = originalHtml;
          return;
        }

        if (!resp.ok || !data.ok) {
          throw new Error(data.message || 'Failed to repair roster.');
        }

        ROSTER = Array.isArray(data.roster) ? data.roster : [];
        renderRoster();

        const banner = document.getElementById('roster-inconsistent-banner');
        if (banner) {
          banner.classList.add('hidden');
        }

        const errContainer = document.getElementById('roster-repair-error-container');
        if (errContainer) {
          errContainer.classList.add('hidden');
        }

        let toastMsg = data.message || 'Roster repaired successfully!';
        if (data.skipped && data.skipped.length > 0) {
          toastMsg += ` (${data.skipped.length} student(s) skipped)`;
        }

        Toast.fire({
          icon: 'success',
          title: toastMsg,
        });
      } catch (err) {
        console.error('Repair roster error:', err);
        Toast.fire({
          icon: 'error',
          title: err.message || 'Failed to repair roster.',
        });
        btnRepair.disabled = false;
        btnRepair.innerHTML = originalHtml;
      }
    });
  }

})();
