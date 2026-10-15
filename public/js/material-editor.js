/**
 * public/js/material-editor.js
 *
 * Client-side logic for the Material Editor.
 * - Quill 2.x rich-text editor setup
 * - Direct signed file upload to Cloudinary (no server buffering)
 * - Resource management (ordering, deletion, labeling)
 * - Base version conflict check (409 handling)
 * - Unsaved changes guard (beforeunload)
 */

(function () {
  'use strict';

  // 1. Load initial data
  const dataEl = document.getElementById('material-editor-data');
  if (!dataEl) return;

  let config = {};
  try {
    config = JSON.parse(dataEl.textContent);
  } catch (e) {
    console.error('Failed to parse editor data:', e);
    return;
  }

  const materialId = config.materialId;
  let currentVersion = Number(config.baseVersion) || 1;
  let resources = Array.isArray(config.resources) ? [...config.resources] : [];
  const maxFileMb = config.maxFileMb || 10;
  const allowedExtensions = config.allowedExtensions || [];
  function getCsrfToken() {
    if (config.csrfToken) return config.csrfToken;
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.getAttribute('content')) return meta.getAttribute('content');
    const input = document.querySelector('input[name="_csrf"]');
    if (input && input.value) return input.value;
    return '';
  }
  const csrfToken = getCsrfToken();

  let isDirty = false;

  // DOM Elements
  const saveBtn = document.getElementById('btn-save-content');
  const saveSpinner = document.getElementById('save-spinner');
  const saveStatus = document.getElementById('save-status');
  const revisionNoteInput = document.getElementById('revision-note');
  const resourceCountEl = document.getElementById('resource-count');
  const resourcesContainer = document.getElementById('resources-container');
  const resourcesEmpty = document.getElementById('resources-empty');

  // File Upload Elements
  const btnShowAddFile = document.getElementById('btn-show-add-file');
  const uploadPanel = document.getElementById('upload-panel');
  const fileInput = document.getElementById('file-input');
  const btnBrowseFile = document.getElementById('btn-browse-file');
  const uploadProgressWrap = document.getElementById('upload-progress-wrap');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const uploadPercent = document.getElementById('upload-percent');
  const uploadFilename = document.getElementById('upload-filename');
  const uploadError = document.getElementById('upload-error');

  // Link Elements
  const btnShowAddLink = document.getElementById('btn-show-add-link');
  const linkPanel = document.getElementById('link-panel');
  const linkUrl = document.getElementById('link-url');
  const linkLabel = document.getElementById('link-label');
  const btnSubmitLink = document.getElementById('btn-submit-link');
  const btnCancelLink = document.getElementById('btn-cancel-link');
  const linkError = document.getElementById('link-error');

  // Conflict Modal
  const conflictModal = document.getElementById('conflict-modal');
  const btnCopyContent = document.getElementById('btn-copy-content');

  // 2. Initialize Quill 2.x
  let quill = null;
  const quillEl = document.getElementById('quill-editor');
  if (quillEl && typeof Quill !== 'undefined') {
    quill = new Quill('#quill-editor', {
      theme: 'snow',
      placeholder: 'Write lesson instructions, summaries, rules, practice materials, or vocabulary...',
      modules: {
        toolbar: [
          [{ 'header': [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ 'list': 'ordered' }, { 'list': 'bullet' }],
          ['blockquote', 'link'],
          ['clean']
        ]
      }
    });

    quill.on('text-change', function () {
      markDirty();
    });
  }

  function getEditorHtml() {
    if (!quill) return '';
    if (typeof quill.getSemanticHTML === 'function') {
      return quill.getSemanticHTML();
    }
    return quill.root.innerHTML;
  }

  function markDirty() {
    isDirty = true;
    if (saveStatus) {
      saveStatus.textContent = 'Unsaved changes';
      saveStatus.className = 'text-xs font-medium text-amber-600';
    }
  }

  function markClean() {
    isDirty = false;
    if (saveStatus) {
      saveStatus.textContent = 'All changes saved';
      saveStatus.className = 'text-xs font-medium text-slate-400';
    }
  }

  // Guard against accidental tab close
  window.addEventListener('beforeunload', function (e) {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // 3. Render Resources List
  function renderResources() {
    if (resourceCountEl) {
      resourceCountEl.textContent = resources.length;
    }

    if (btnShowAddFile) btnShowAddFile.disabled = resources.length >= 20;
    if (btnShowAddLink) btnShowAddLink.disabled = resources.length >= 20;

    if (!resourcesContainer) return;
    resourcesContainer.innerHTML = '';

    if (resources.length === 0) {
      if (resourcesEmpty) resourcesEmpty.classList.remove('hidden');
      return;
    }

    if (resourcesEmpty) resourcesEmpty.classList.add('hidden');

    resources.forEach(function (res, idx) {
      const itemEl = document.createElement('div');
      itemEl.className = 'p-2.5 rounded-xl border border-slate-100 bg-slate-50/70 hover:bg-white hover:border-slate-200 transition flex items-center justify-between gap-2 text-xs';

      const isFile = res.kind === 'file';
      const badgeText = isFile ? ((res.file && res.file.format) || 'FILE').toUpperCase() : 'LINK';
      const badgeClass = isFile ? 'bg-indigo-100 text-indigo-700' : 'bg-teal-100 text-teal-700';

      const leftCol = document.createElement('div');
      leftCol.className = 'flex items-center gap-2 min-w-0 flex-1';

      const badge = document.createElement('span');
      badge.className = 'text-[9px] font-extrabold px-1.5 py-0.5 rounded font-mono flex-shrink-0 ' + badgeClass;
      badge.textContent = badgeText;
      leftCol.appendChild(badge);

      if (isFile && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(((res.file && res.file.format) || '').toLowerCase()) && res._id) {
        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'w-8 h-8 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 flex-shrink-0';
        const img = document.createElement('img');
        img.src = `/materials/${materialId}/resources/${res._id}/open`;
        img.alt = res.label || 'Image';
        img.className = 'w-full h-full object-cover';
        img.loading = 'lazy';
        thumbWrap.appendChild(img);
        leftCol.appendChild(thumbWrap);
      }

      const title = document.createElement('span');
      title.className = 'font-semibold text-slate-800 truncate';
      title.textContent = res.label || (isFile ? res.file?.originalFilename : res.url);
      leftCol.appendChild(title);

      itemEl.appendChild(leftCol);

      // Reorder & Delete controls
      const controls = document.createElement('div');
      controls.className = 'flex items-center gap-1 flex-shrink-0';

      // Up arrow
      if (idx > 0) {
        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'p-1 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-100';
        upBtn.title = 'Move up';
        upBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd" /></svg>';
        upBtn.onclick = function () {
          const temp = resources[idx - 1];
          resources[idx - 1] = resources[idx];
          resources[idx] = temp;
          markDirty();
          renderResources();
        };
        controls.appendChild(upBtn);
      }

      // Down arrow
      if (idx < resources.length - 1) {
        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.className = 'p-1 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-100';
        downBtn.title = 'Move down';
        downBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>';
        downBtn.onclick = function () {
          const temp = resources[idx + 1];
          resources[idx + 1] = resources[idx];
          resources[idx] = temp;
          markDirty();
          renderResources();
        };
        controls.appendChild(downBtn);
      }

      // Remove button
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'p-1 text-slate-400 hover:text-red-500 rounded hover:bg-red-50 ml-1';
      delBtn.title = 'Remove resource';
      delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>';
      delBtn.onclick = async function () {
        if (res._id) {
          try {
            const resp = await fetch(`/materials/${materialId}/resources/${res._id}?baseVersion=${Number(currentVersion) || 1}`, {
              method: 'DELETE',
              headers: {
                'X-CSRF-Token': csrfToken,
                'Accept': 'application/json'
              }
            });
            if (resp.status === 409) {
              if (conflictModal) conflictModal.classList.remove('hidden');
              return;
            }
            if (!resp.ok) {
              const errJson = await resp.json().catch(() => ({}));
              alert(errJson.error || 'Failed to remove resource.');
              return;
            }
            const json = await resp.json();
            if (json && json.version) {
              currentVersion = json.version;
            }
          } catch (delErr) {
            console.error('Delete resource error:', delErr);
            alert('Network error removing resource.');
            return;
          }
        }
        resources.splice(idx, 1);
        markDirty();
        renderResources();
      };
      controls.appendChild(delBtn);

      itemEl.appendChild(controls);
      resourcesContainer.appendChild(itemEl);
    });
  }

  renderResources();

  // 4. Link Panel Toggle & Add Link
  if (btnShowAddLink && linkPanel) {
    btnShowAddLink.addEventListener('click', function () {
      linkPanel.classList.toggle('hidden');
      if (uploadPanel) uploadPanel.classList.add('hidden');
      if (linkUrl) linkUrl.focus();
    });
  }

  if (btnCancelLink && linkPanel) {
    btnCancelLink.addEventListener('click', function () {
      linkPanel.classList.add('hidden');
      if (linkError) linkError.classList.add('hidden');
    });
  }

  if (btnSubmitLink) {
    btnSubmitLink.addEventListener('click', async function () {
      const url = (linkUrl.value || '').trim();
      const label = (linkLabel.value || '').trim();

      if (!url) {
        showLinkError('Please enter a valid URL.');
        return;
      }

      btnSubmitLink.disabled = true;
      if (linkError) linkError.classList.add('hidden');

      try {
        const resp = await fetch(`/materials/${materialId}/resources`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'Accept': 'application/json'
          },
          body: JSON.stringify({ kind: 'link', url, label, baseVersion: Number(currentVersion) || 1 })
        });

        if (resp.status === 409) {
          if (conflictModal) conflictModal.classList.remove('hidden');
          btnSubmitLink.disabled = false;
          return;
        }

        const json = await resp.json();
        if (!resp.ok) {
          showLinkError(json.error || 'Failed to add link.');
          btnSubmitLink.disabled = false;
          return;
        }

        if (json.version) {
          currentVersion = json.version;
        }
        resources.push(json.resource);
        linkUrl.value = '';
        linkLabel.value = '';
        linkPanel.classList.add('hidden');
        markDirty();
        renderResources();
      } catch (err) {
        showLinkError('Network error adding link.');
      } finally {
        btnSubmitLink.disabled = false;
      }
    });
  }

  function showLinkError(msg) {
    if (linkError) {
      linkError.textContent = msg;
      linkError.classList.remove('hidden');
    }
  }

  // 5. File Panel Toggle & Direct Cloudinary Upload
  if (btnShowAddFile && uploadPanel) {
    btnShowAddFile.addEventListener('click', function () {
      uploadPanel.classList.toggle('hidden');
      if (linkPanel) linkPanel.classList.add('hidden');
      if (uploadError) uploadError.classList.add('hidden');
    });
  }

  if (btnBrowseFile && fileInput) {
    btnBrowseFile.addEventListener('click', function () {
      fileInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', async function () {
      const file = fileInput.files[0];
      if (!file) return;

      if (uploadError) uploadError.classList.add('hidden');

      // Client validate ext
      const ext = file.name.split('.').pop().toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        showUploadError(`File type .${ext} is not supported.`);
        fileInput.value = '';
        return;
      }

      // Client validate size
      if (file.size > maxFileMb * 1024 * 1024) {
        showUploadError(`File size exceeds ${maxFileMb} MB.`);
        fileInput.value = '';
        return;
      }

      // Step A: Request signature from our server
      let signData;
      try {
        const signResp = await fetch(`/materials/${materialId}/uploads/sign`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'Accept': 'application/json'
          },
          body: JSON.stringify({ filename: file.name, size: file.size })
        });

        if (!signResp.ok) {
          console.error('Sign upload failed with status:', signResp.status);
          let errJson = {};
          try {
            errJson = await signResp.json();
          } catch (_) {}
          showUploadError(errJson.error || 'Failed to sign upload.');
          fileInput.value = '';
          return;
        }
        signData = await signResp.json();
      } catch (err) {
        console.error('Sign upload error:', err);
        showUploadError('Error connecting to upload service.');
        fileInput.value = '';
        return;
      }

      // Step B: Upload directly to Cloudinary using XMLHttpRequest with progress
      if (uploadProgressWrap) {
        uploadProgressWrap.classList.remove('hidden');
        if (uploadFilename) uploadFilename.textContent = file.name;
        if (uploadProgressBar) uploadProgressBar.style.width = '0%';
        if (uploadPercent) uploadPercent.textContent = '0%';
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('api_key', signData.apiKey);
      formData.append('timestamp', signData.timestamp);
      formData.append('signature', signData.signature);
      formData.append('folder', signData.folder);
      formData.append('type', signData.type);
      if (signData.allowed_formats) {
        formData.append('allowed_formats', signData.allowed_formats);
      }

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `https://api.cloudinary.com/v1_1/${signData.cloudName}/auto/upload`);

      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          if (uploadProgressBar) uploadProgressBar.style.width = percent + '%';
          if (uploadPercent) uploadPercent.textContent = percent + '%';
        }
      };

      xhr.onload = async function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          let cloudRes;
          try {
            cloudRes = JSON.parse(xhr.responseText);
          } catch (_) {}

          if (!cloudRes || !cloudRes.public_id) {
            showUploadError('Failed to parse cloud response.');
            if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
            return;
          }

          // Step C: Register resource with backend
          try {
            const regResp = await fetch(`/materials/${materialId}/resources`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
                'Accept': 'application/json'
              },
              body: JSON.stringify({
                kind: 'file',
                label: file.name,
                publicId: cloudRes.public_id,
                resourceType: cloudRes.resource_type,
                deliveryType: 'authenticated',
                format: cloudRes.format,
                baseVersion: Number(currentVersion) || 1
              })
            });

            if (regResp.status === 409) {
              if (conflictModal) conflictModal.classList.remove('hidden');
              if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
              return;
            }

            let regJson = {};
            try {
              regJson = await regResp.json();
            } catch (_) {}

            if (!regResp.ok) {
              console.error('Attach resource failed with status:', regResp.status);
              showUploadError(regJson.error || 'Failed to attach file.');
              if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
              return;
            }

            if (regJson.version) {
              currentVersion = regJson.version;
            }
            resources.push(regJson.resource);
            uploadPanel.classList.add('hidden');
            if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
            fileInput.value = '';
            markDirty();
            renderResources();
          } catch (regErr) {
            console.error('Attach resource error:', regErr);
            showUploadError('Error finalizing file attachment.');
            if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
          }
        } else {
          let parsedBody = null;
          try {
            parsedBody = JSON.parse(xhr.responseText);
          } catch (_) {}

          console.error('Cloud storage upload error:', xhr.status, parsedBody);

          const errorMessage =
            (parsedBody && parsedBody.error && parsedBody.error.message) ||
            (xhr.responseText ? xhr.responseText.trim().slice(0, 200) : '') ||
            'Cloud storage upload failed.';

          showUploadError(errorMessage);
          if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
        }
      };

      const handleNetworkError = function () {
        console.error('Upload network error');
        showUploadError('Network error while uploading.');
        if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
      };

      xhr.onerror = handleNetworkError;
      xhr.ontimeout = handleNetworkError;

      xhr.send(formData);
    });
  }

  function showUploadError(msg) {
    if (uploadError) {
      uploadError.textContent = msg;
      uploadError.classList.remove('hidden');
    }
    if (uploadProgressWrap) uploadProgressWrap.classList.add('hidden');
  }

  // 6. Save Content (Quill HTML + Resources + Note)
  if (saveBtn) {
    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      if (saveSpinner) saveSpinner.classList.remove('hidden');
      if (saveStatus) {
        saveStatus.textContent = 'Saving changes...';
        saveStatus.className = 'text-xs font-medium text-slate-500';
      }

      const bodyHtml = getEditorHtml();
      const note = revisionNoteInput ? revisionNoteInput.value.trim() : '';
      const resourcesPayload = resources.map(function (r) {
        return {
          _id: r._id,
          label: (r.label || '').trim().slice(0, 100)
        };
      });

      try {
        const resp = await fetch(`/materials/${materialId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            body: bodyHtml,
            resources: resourcesPayload,
            note: note,
            baseVersion: Number(currentVersion) || 1
          })
        });

        if (resp.status === 409) {
          // Version conflict
          if (conflictModal) conflictModal.classList.remove('hidden');
          saveBtn.disabled = false;
          if (saveSpinner) saveSpinner.classList.add('hidden');
          return;
        }

        const json = await resp.json();
        if (!resp.ok) {
          alert(json.error || 'Failed to save material.');
          saveBtn.disabled = false;
          if (saveSpinner) saveSpinner.classList.add('hidden');
          if (saveStatus) saveStatus.textContent = 'Save failed';
          return;
        }

        currentVersion = json.version;
        markClean();

        // Redirect back to viewer to see saved changes
        window.location.href = `/materials/${materialId}`;
      } catch (err) {
        console.error('Save error:', err);
        alert('A network error occurred while saving.');
        saveBtn.disabled = false;
        if (saveSpinner) saveSpinner.classList.add('hidden');
      }
    });
  }

  // Copy HTML helper in conflict modal
  if (btnCopyContent) {
    btnCopyContent.addEventListener('click', function () {
      const bodyHtml = getEditorHtml();
      navigator.clipboard.writeText(bodyHtml).then(function () {
        btnCopyContent.textContent = 'Copied to Clipboard!';
        setTimeout(function () {
          btnCopyContent.textContent = 'Copy My Text';
        }, 2500);
      }).catch(function () {
        alert('Could not auto-copy. Please manually select and copy your text.');
      });
    });
  }

})();
