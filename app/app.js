/* ClawDoc — browser app */
(function () {
  'use strict';

  const state = {
    index: null,           // raw index.json
    docs: [],              // array of doc records
    docsByPath: new Map(), // path -> doc
    tree: null,            // root tree node
    nodesByPath: new Map(),// folder path -> tree node
    expanded: new Set(),   // expanded folder paths
    currentDoc: null,
    currentFolder: '',
    sortBy: localStorage.getItem('clawdoc.sortBy') || 'date',
    sortDir: localStorage.getItem('clawdoc.sortDir') || 'desc',
    treeFilter: '',
    treeShowFilenames: localStorage.getItem('clawdoc.treeShowFilenames') === '1',
    mcMode: localStorage.getItem('clawdoc.mcMode') === '1',
    // Per-pane state for the two-pane file manager. Persisted across reloads
    // so the user comes back to the same expanded folders, focused file, and
    // filter string. lastFocused tracks which pane spacebar-preview should
    // act on when both panes have focused items.
    mcPanes: (() => {
      const empty = () => ({ expanded: new Set(['']), focused: '', filter: '' });
      try {
        const raw = localStorage.getItem('clawdoc.mcPanes');
        if (raw) {
          const p = JSON.parse(raw);
          return {
            a: {
              expanded: new Set((p.a && p.a.expanded) || ['']),
              focused: (p.a && p.a.focused) || '',
              filter: (p.a && p.a.filter) || '',
            },
            b: {
              expanded: new Set((p.b && p.b.expanded) || ['']),
              focused: (p.b && p.b.focused) || '',
              filter: (p.b && p.b.filter) || '',
            },
          };
        }
      } catch {}
      return { a: empty(), b: empty() };
    })(),
    mcLastFocusedPane: localStorage.getItem('clawdoc.mcLastFocusedPane') === 'b' ? 'b' : 'a',
  };

  // ---------- tabs + persisted ui state ----------
  // Each tab is { id, docPath, folder, expanded: string[] }. The active tab's
  // values are mirrored onto state.currentDoc / .currentFolder / .expanded so
  // the existing render code keeps working unchanged.
  state.tabs = [];
  state.activeTabId = null;
  state.isEmbed = false;
  state.suppressPersist = false;

  function newTabId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function makeTab(init) {
    return {
      id: (init && init.id) || newTabId(),
      docPath: (init && init.docPath) || null,
      folder: (init && init.folder) || '',
      expanded: Array.isArray(init && init.expanded) ? init.expanded.slice() : [''],
    };
  }

  function activeTab() { return state.tabs.find(t => t.id === state.activeTabId) || null; }

  function syncStateToActiveTab() {
    const t = activeTab();
    if (!t) return;
    t.docPath = state.currentDoc ? state.currentDoc.path : null;
    t.folder = state.currentFolder || '';
    t.expanded = Array.from(state.expanded);
  }
  function syncActiveTabToState() {
    const t = activeTab();
    if (!t) return;
    state.expanded = new Set(t.expanded && t.expanded.length ? t.expanded : ['']);
    state.currentFolder = t.folder || '';
    state.currentDoc = t.docPath ? (state.docsByPath.get(t.docPath) || null) : null;
    if (t.docPath && !state.currentDoc) {
      // Doc was removed/renamed since last save. Fall back to folder view.
      t.docPath = null;
    }
  }

  function persistTabs() {
    if (state.isEmbed || state.suppressPersist) return;
    syncStateToActiveTab();
    try {
      localStorage.setItem('clawdoc.tabs', JSON.stringify({
        tabs: state.tabs.map(t => ({
          id: t.id, docPath: t.docPath, folder: t.folder, expanded: t.expanded,
        })),
        activeId: state.activeTabId,
      }));
    } catch {}
  }

  function loadPersistedTabs() {
    // New format
    try {
      const raw = localStorage.getItem('clawdoc.tabs');
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.tabs) && obj.tabs.length) {
          return {
            tabs: obj.tabs.map(t => makeTab(t)),
            activeId: obj.activeId || obj.tabs[0].id,
          };
        }
      }
    } catch {}
    const t = makeTab({ expanded: [''] });
    return { tabs: [t], activeId: t.id };
  }

  // ---------- utilities ----------
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props, children) => {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'dataset') Object.assign(e.dataset, props[k]);
      else if (k.startsWith('on') && typeof props[k] === 'function') e.addEventListener(k.slice(2), props[k]);
      else if (k === 'html') e.innerHTML = props[k];
      else e.setAttribute(k, props[k]);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  };
  const debounce = (fn, ms) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const formatSize = (n) => {
    if (n < 1024) return n + 'B';
    if (n < 1024*1024) return (n/1024).toFixed(0) + 'K';
    return (n/1048576).toFixed(1) + 'M';
  };
  const dirname = (p) => {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  };
  const basename = (p) => {
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  };
  const normalizePath = (p) => {
    const parts = p.split('/');
    const out = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  };
  const resolveRelative = (fromDir, href) => {
    if (!href) return '';
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null; // external
    if (href.startsWith('#')) return null; // anchor only
    if (href.startsWith('/')) return normalizePath(href.slice(1));
    return normalizePath((fromDir ? fromDir + '/' : '') + href);
  };

  // ---------- icons ----------
  const ICON_FOLDER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" opacity="0.85"/></svg>';
  const ICON_FOLDER_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" opacity="0.85"/></svg>';
  const ICON_MD = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M14 3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h12zM2 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H2z"/><path fill-rule="evenodd" d="M9.146 8.146a.5.5 0 0 1 .708 0L11.5 9.793l1.646-1.647a.5.5 0 0 1 .708.708l-2 2a.5.5 0 0 1-.708 0l-2-2a.5.5 0 0 1 0-.708z"/><path fill-rule="evenodd" d="M11.5 5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 1 .5-.5z"/><path d="M3.56 11V7.01h.056l1.428 3.239h.774l1.42-3.24h.056V11h1.073V5.001h-1.2l-1.71 3.894h-.039l-1.71-3.894H2.5V11h1.06z"/></svg>';
  const ICON_HTML = '<svg width="16" height="16" viewBox="0 0 400 400" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M325,105H250a5,5,0,0,1-5-5V25a5,5,0,1,1,10,0V95h70a5,5,0,0,1,0,10Z"/><path d="M325,154.83a5,5,0,0,1-5-5V102.07L247.93,30H100A20,20,0,0,0,80,50v98.17a5,5,0,0,1-10,0V50a30,30,0,0,1,30-30H250a5,5,0,0,1,3.54,1.46l75,75A5,5,0,0,1,330,100v49.83A5,5,0,0,1,325,154.83Z"/><path d="M300,380H100a30,30,0,0,1-30-30V275a5,5,0,0,1,10,0v75a20,20,0,0,0,20,20H300a20,20,0,0,0,20-20V275a5,5,0,0,1,10,0v75A30,30,0,0,1,300,380Z"/><path d="M275,280H125a5,5,0,1,1,0-10H275a5,5,0,0,1,0,10Z"/><path d="M200,330H125a5,5,0,1,1,0-10h75a5,5,0,0,1,0,10Z"/><path d="M325,280H75a30,30,0,0,1-30-30V173.17a30,30,0,0,1,30-30h.2l250,1.66a30.09,30.09,0,0,1,29.81,30V250A30,30,0,0,1,325,280ZM75,153.17a20,20,0,0,0-20,20V250a20,20,0,0,0,20,20H325a20,20,0,0,0,20-20V174.83a20.06,20.06,0,0,0-19.88-20l-250-1.66Z"/><path d="M148.48,236h-9.61V212.84H118.52V236h-9.61V182.68h9.61v21.91h20.35V182.68h9.61Z"/><path d="M178.83,236H168.52V190.92H154.34v-8.24H193v8.24H178.83Z"/><path d="M251.17,236h-9.8V189.32L226.6,236h-5l-14.84-46.68V236h-7.85V182.68h15L225.08,217l11-34.34h15.12Z"/><path d="M295.74,236H262.93V182.68H273v44.61h22.7Z"/></svg>';
  const ICON_PDF = '<svg width="16" height="16" viewBox="-4 0 40 40" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M25.6686 26.0962C25.1812 26.2401 24.4656 26.2563 23.6984 26.145C22.875 26.0256 22.0351 25.7739 21.2096 25.403C22.6817 25.1888 23.8237 25.2548 24.8005 25.6009C25.0319 25.6829 25.412 25.9021 25.6686 26.0962ZM17.4552 24.7459C17.3953 24.7622 17.3363 24.7776 17.2776 24.7939C16.8815 24.9017 16.4961 25.0069 16.1247 25.1005L15.6239 25.2275C14.6165 25.4824 13.5865 25.7428 12.5692 26.0529C12.9558 25.1206 13.315 24.178 13.6667 23.2564C13.9271 22.5742 14.193 21.8773 14.468 21.1894C14.6075 21.4198 14.7531 21.6503 14.9046 21.8814C15.5948 22.9326 16.4624 23.9045 17.4552 24.7459ZM14.8927 14.2326C14.958 15.383 14.7098 16.4897 14.3457 17.5514C13.8972 16.2386 13.6882 14.7889 14.2489 13.6185C14.3927 13.3185 14.5105 13.1581 14.5869 13.0744C14.7049 13.2566 14.8601 13.6642 14.8927 14.2326ZM9.63347 28.8054C9.38148 29.2562 9.12426 29.6782 8.86063 30.0767C8.22442 31.0355 7.18393 32.0621 6.64941 32.0621C6.59681 32.0621 6.53316 32.0536 6.44015 31.9554C6.38028 31.8926 6.37069 31.8476 6.37359 31.7862C6.39161 31.4337 6.85867 30.8059 7.53527 30.2238C8.14939 29.6957 8.84352 29.2262 9.63347 28.8054ZM27.3706 26.1461C27.2889 24.9719 25.3123 24.2186 25.2928 24.2116C24.5287 23.9407 23.6986 23.8091 22.7552 23.8091C21.7453 23.8091 20.6565 23.9552 19.2582 24.2819C18.014 23.3999 16.9392 22.2957 16.1362 21.0733C15.7816 20.5332 15.4628 19.9941 15.1849 19.4675C15.8633 17.8454 16.4742 16.1013 16.3632 14.1479C16.2737 12.5816 15.5674 11.5295 14.6069 11.5295C13.948 11.5295 13.3807 12.0175 12.9194 12.9813C12.0965 14.6987 12.3128 16.8962 13.562 19.5184C13.1121 20.5751 12.6941 21.6706 12.2895 22.7311C11.7861 24.0498 11.2674 25.4103 10.6828 26.7045C9.04334 27.3532 7.69648 28.1399 6.57402 29.1057C5.8387 29.7373 4.95223 30.7028 4.90163 31.7107C4.87693 32.1854 5.03969 32.6207 5.37044 32.9695C5.72183 33.3398 6.16329 33.5348 6.6487 33.5354C8.25189 33.5354 9.79489 31.3327 10.0876 30.8909C10.6767 30.0029 11.2281 29.0124 11.7684 27.8699C13.1292 27.3781 14.5794 27.011 15.985 26.6562L16.4884 26.5283C16.8668 26.4321 17.2601 26.3257 17.6635 26.2153C18.0904 26.0999 18.5296 25.9802 18.976 25.8665C20.4193 26.7844 21.9714 27.3831 23.4851 27.6028C24.7601 27.7883 25.8924 27.6807 26.6589 27.2811C27.3486 26.9219 27.3866 26.3676 27.3706 26.1461ZM30.4755 36.2428C30.4755 38.3932 28.5802 38.5258 28.1978 38.5301H3.74486C1.60224 38.5301 1.47322 36.6218 1.46913 36.2428L1.46884 3.75642C1.46884 1.6039 3.36763 1.4734 3.74457 1.46908H20.263L20.2718 1.4778V7.92396C20.2718 9.21763 21.0539 11.6669 24.0158 11.6669H30.4203L30.4753 11.7218L30.4755 36.2428ZM28.9572 10.1976H24.0169C21.8749 10.1976 21.7453 8.29969 21.7424 7.92417V2.95307L28.9572 10.1976ZM31.9447 36.2428V11.1157L21.7424 0.871022V0.823357H21.6936L20.8742 0H3.74491C2.44954 0 0 0.785336 0 3.75711V36.2435C0 37.5427 0.782956 40 3.74491 40H28.2001C29.4952 39.9997 31.9447 39.2143 31.9447 36.2428Z"/></svg>';
  const ICON_CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>';
  const ICON_REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
  const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICON_FULLSCREEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9V3h6"/><path d="M21 9V3h-6"/><path d="M3 15v6h6"/><path d="M21 15v6h-6"/></svg>';
  const ICON_FULLSCREEN_EXIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6H3"/><path d="M15 3v6h6"/><path d="M9 21v-6H3"/><path d="M15 21v-6h6"/></svg>';
  const ICON_ZOOM_IN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>';
  const ICON_ZOOM_OUT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';

  // ---------- load index ----------
  async function loadIndex(opts) {
    const silent = !!(opts && opts.silent);
    if (!silent) setStatus('loading index…');
    try {
      const r = await fetch('/api/index', { cache: 'no-store' });
      if (!r.ok) {
        if (r.status === 404) {
          if (!silent) {
            setStatus('no index — click Reindex', 'error');
            renderEmpty('No index yet — click <strong>Reindex</strong> in the top-right to generate one.');
          }
          return;
        }
        throw new Error('HTTP ' + r.status);
      }
      const data = await r.json();
      state.index = data;
      state.docs = data.docs || [];
      state.docsByPath = new Map(state.docs.map(d => [d.path, d]));
      state.tree = buildTree(data.folders || [], state.docs);

      if (state.isEmbed) {
        // Embed mode: no tabs, just render whatever the URL points at.
        state.expanded = new Set(['']);
      } else if (!state.tabs.length) {
        // First load — restore tabs from localStorage (or migrate legacy keys).
        const persisted = loadPersistedTabs();
        // Filter each tab's expanded list and stale doc paths against the new index.
        state.tabs = persisted.tabs.map(t => makeTab({
          id: t.id,
          docPath: t.docPath && state.docsByPath.has(t.docPath) ? t.docPath : null,
          folder: t.folder && (t.folder === '' || state.nodesByPath.has(t.folder)) ? t.folder : '',
          expanded: (t.expanded || []).filter(p => p === '' || state.nodesByPath.has(p)),
        }));
        if (!state.tabs.length) state.tabs = [makeTab()];
        state.activeTabId = state.tabs.some(t => t.id === persisted.activeId)
          ? persisted.activeId
          : state.tabs[0].id;
        syncActiveTabToState();
      } else {
        // Reindex (Reindex button) — just drop stale paths from existing tabs.
        for (const t of state.tabs) {
          if (t.docPath && !state.docsByPath.has(t.docPath)) t.docPath = null;
          if (t.folder && !state.nodesByPath.has(t.folder)) t.folder = '';
          t.expanded = (t.expanded || []).filter(p => p === '' || state.nodesByPath.has(p));
        }
        syncActiveTabToState();
      }
      // Drop MC focus paths that no longer reference anything in the index
      // (file/folder was deleted or renamed). Otherwise spacebar would
      // re-trigger a preview for a row that's no longer visible.
      for (const pid of ['a', 'b']) {
        const f = state.mcPanes[pid].focused;
        if (f && !state.docsByPath.has(f) && !(state.nodesByPath && state.nodesByPath.has(f))) {
          state.mcPanes[pid].focused = '';
        }
      }
      persistMcPanes();
      renderTree();
      renderTabs();
      if (state.mcMode) renderMcMode();
      $('#doc-count').textContent = `${data.stats.docCount} docs · ${data.stats.md} md · ${data.stats.html} html · ${data.stats.pdf || 0} pdf · ${data.stats.folderCount} folders`;
      const gen = new Date(data.generatedAt);
      if (!silent) setStatus('indexed ' + gen.toLocaleTimeString(), 'ok');
      if (!silent) restoreFromHash();
    } catch (err) {
      console.error(err);
      if (!silent) {
        setStatus('load error', 'error');
        renderEmpty('Failed to load index: ' + escapeHtml(err.message));
      }
    }
  }

  function setStatus(msg, kind) {
    const s = $('#status');
    s.textContent = msg || '';
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- tree construction ----------
  function buildTree(folders, docs) {
    const root = { path: '', name: '/', children: new Map(), docs: [], docCount: 0 };
    state.nodesByPath = new Map([['', root]]);
    const ensure = (p) => {
      if (state.nodesByPath.has(p)) return state.nodesByPath.get(p);
      const parent = ensure(dirname(p));
      const node = { path: p, name: basename(p), children: new Map(), docs: [], docCount: 0 };
      parent.children.set(node.name, node);
      state.nodesByPath.set(p, node);
      return node;
    };
    for (const f of folders) ensure(f);
    for (const d of docs) {
      const folder = d.folder === '.' ? '' : d.folder;
      const node = ensure(folder);
      node.docs.push(d);
    }
    // compute aggregated doc counts
    const count = (n) => {
      let c = n.docs.length;
      for (const ch of n.children.values()) c += count(ch);
      n.docCount = c;
      return c;
    };
    count(root);
    return root;
  }

  function expandFolderAndAncestors(folderPath) {
    let p = folderPath;
    state.expanded.add('');
    while (p) {
      state.expanded.add(p);
      p = dirname(p);
    }
  }

  // Expand only the ancestors of folderPath, NOT folderPath itself. Used when
  // selecting a folder so that the click handler can decide whether the folder
  // itself should be open or closed (click-to-toggle behavior).
  function expandAncestorsOf(folderPath) {
    state.expanded.add('');
    let p = dirname(folderPath);
    while (p) {
      state.expanded.add(p);
      p = dirname(p);
    }
  }

  // ---------- render tree ----------
  function renderTree() {
    const root = $('#tree');
    root.innerHTML = '';
    const filter = state.treeFilter.trim().toLowerCase();
    const matches = filter ? computeTreeMatches(filter) : null;
    // Render top-level subfolders, then top-level docs (docs at workspace root).
    for (const child of sortedChildren(state.tree)) {
      const n = renderNode(child, 0, matches, filter);
      if (n) root.appendChild(n);
    }
    for (const d of sortedTreeDocs(state.tree)) {
      const n = renderDocNode(d, 0, matches, filter);
      if (n) root.appendChild(n);
    }
  }

  function sortedChildren(node) {
    return Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
  function sortedTreeDocs(node) {
    // Alphabetical by title (falling back to filename). Tree sort is independent
    // of the right-pane sort control.
    return node.docs.slice().sort((a, b) =>
      (a.title || a.name).localeCompare(b.title || b.name)
    );
  }

  function docFilterMatches(doc, filter) {
    if (!filter) return true;
    const t = (doc.title || '').toLowerCase();
    const n = doc.name.toLowerCase();
    const p = doc.path.toLowerCase();
    return t.includes(filter) || n.includes(filter) || p.includes(filter);
  }

  function docKindClass(doc) {
    if (doc.ext === 'pdf') return 'doc-pdf';
    if (doc.ext === 'html' || doc.ext === 'htm') return 'doc-html';
    return 'doc-md';
  }
  function docIcon(doc) {
    if (doc.ext === 'pdf') return ICON_PDF;
    if (doc.ext === 'html' || doc.ext === 'htm') return ICON_HTML;
    return ICON_MD;
  }

  function formatDateTime(ms) {
    if (!ms) return '';
    try {
      const d = new Date(ms);
      // 2026-05-27 14:32  — short, sortable, locale-independent
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
  }

  function docTooltip(doc) {
    const lines = [doc.name];
    if (doc.mtime) lines.push('Modified: ' + formatDateTime(doc.mtime));
    lines.push('Size: ' + formatSize(doc.size));
    return lines.join('\n');
  }

  function computeTreeMatches(filter) {
    // Match folders by name or by containing docs that match.
    const matched = new Set();
    const matchFolder = (n) => n.name.toLowerCase().includes(filter);
    const matchDoc = (d) =>
      d.name.toLowerCase().includes(filter) ||
      (d.title && d.title.toLowerCase().includes(filter)) ||
      d.path.toLowerCase().includes(filter);
    const visit = (n) => {
      let any = matchFolder(n);
      for (const d of n.docs) if (matchDoc(d)) { any = true; break; }
      for (const ch of n.children.values()) if (visit(ch)) any = true;
      if (any) {
        matched.add(n.path);
        // also auto-expand all ancestors
        let p = dirname(n.path);
        while (p) { matched.add(p); state.expanded.add(p); p = dirname(p); }
        state.expanded.add(n.path);
      }
      return any;
    };
    visit(state.tree);
    return matched;
  }

  function renderNode(node, depth, matches, filter) {
    if (matches && !matches.has(node.path)) return null;
    const hasFolders = node.children.size > 0;
    const hasDocs = node.docs.length > 0;
    const hasContent = hasFolders || hasDocs;
    const isExpanded = state.expanded.has(node.path) || !!matches;
    const isLeaf = !hasContent;
    const isActive = state.currentFolder === node.path && !state.currentDoc;

    const tnode = el('div', { class: 'tnode' + (isExpanded ? '' : ' collapsed') + (isLeaf ? ' leaf' : '') });
    const chev = el('span', { class: 'tchev', html: ICON_CHEVRON });
    const icon = el('span', { class: 'ticon', html: isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER });
    const name = el('span', { class: 'tname' });
    name.innerHTML = highlightMatch(node.name, filter);
    const count = el('span', { class: 'tcount' }, node.docCount > 0 ? String(node.docCount) : '');
    // Workspace roots ("Business", "business-shared") can't be dragged but
    // are still valid drop targets for anything dropped INTO that workspace.
    const isWorkspaceRoot = !node.path.includes('/');
    const row = el('div', {
      class: 'trow' + (isActive ? ' active' : ''),
      draggable: isWorkspaceRoot ? 'false' : 'true',
    }, [chev, icon, name, count]);
    row.addEventListener('click', (ev) => {
      const clickedChev = ev.target.closest('.tchev');
      if (clickedChev && hasContent) {
        toggleNode(node.path);
        return;
      }
      // Click-to-toggle: clicking an open folder closes it, clicking a closed
      // folder opens it. selectFolder() doesn't touch this folder's own expand
      // state — only its ancestors — so the toggle below is the source of truth.
      if (hasContent) {
        if (state.expanded.has(node.path)) state.expanded.delete(node.path);
        else state.expanded.add(node.path);
      }
      selectFolder(node.path);
    });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showFolderContextMenu(node, ev.clientX, ev.clientY);
    });
    attachMcDrag(row, node.path);
    attachMcDrop(row, node.path);
    tnode.appendChild(row);

    if (hasContent) {
      const children = el('div', { class: 'tchildren' });
      // Subfolders first
      for (const ch of sortedChildren(node)) {
        const cn = renderNode(ch, depth + 1, matches, filter);
        if (cn) children.appendChild(cn);
      }
      // Then docs as leaf nodes
      for (const d of sortedTreeDocs(node)) {
        const dn = renderDocNode(d, depth + 1, matches, filter);
        if (dn) children.appendChild(dn);
      }
      tnode.appendChild(children);
    }
    return tnode;
  }

  function renderDocNode(doc, depth, matches, filter) {
    // When the tree filter is active, hide individual docs that don't match.
    if (filter && !docFilterMatches(doc, filter)) return null;
    const isActive = state.currentDoc && state.currentDoc.path === doc.path;
    const tnode = el('div', { class: 'tnode leaf' });
    const chev = el('span', { class: 'tchev', html: ICON_CHEVRON });
    const icon = el('span', { class: 'ticon', html: docIcon(doc) });
    const name = el('span', { class: 'tname' });
    const displayText = state.treeShowFilenames ? doc.name : (doc.title || doc.name);
    name.innerHTML = highlightMatch(displayText, filter);
    const row = el('div', {
      class: 'trow doc-row ' + docKindClass(doc) + (isActive ? ' active' : ''),
      title: docTooltip(doc),
      draggable: 'true',
    }, [chev, icon, name]);
    row.addEventListener('click', () => selectDoc(doc.path));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showDocContextMenu(doc, ev.clientX, ev.clientY);
    });
    attachMcDrag(row, doc.path);
    tnode.appendChild(row);
    return tnode;
  }

  function highlightMatch(text, filter) {
    if (!filter) return escapeHtml(text);
    const re = new RegExp('(' + escapeRegex(filter) + ')', 'ig');
    return escapeHtml(text).replace(re, '<mark>$1</mark>');
  }

  function toggleNode(folderPath) {
    if (state.expanded.has(folderPath)) state.expanded.delete(folderPath);
    else state.expanded.add(folderPath);
    persistTabs();
    renderTree();
  }

  function applyTreeDisplayMode() {
    const sidebar = $('#sidebar');
    if (sidebar) sidebar.setAttribute('data-tree-display', state.treeShowFilenames ? 'filename' : 'title');
    const btn = $('#tree-display-toggle');
    if (btn) {
      btn.title = state.treeShowFilenames
        ? 'Showing filenames — click to show document titles'
        : 'Showing document titles — click to show filenames';
    }
  }

  function toggleTreeDisplay() {
    state.treeShowFilenames = !state.treeShowFilenames;
    try { localStorage.setItem('clawdoc.treeShowFilenames', state.treeShowFilenames ? '1' : '0'); } catch {}
    applyTreeDisplayMode();
    renderTree();
  }

  function expandAllFolders() {
    state.expanded = new Set(state.nodesByPath.keys());
    persistTabs();
    renderTree();
  }
  function collapseAllFolders() {
    // Keep the root + the chain leading to the current selection so the user
    // never loses sight of where they are.
    state.expanded = new Set(['']);
    let p = state.currentDoc
      ? (state.currentDoc.folder === '.' ? '' : state.currentDoc.folder)
      : (state.currentFolder || '');
    while (p) {
      state.expanded.add(p);
      p = dirname(p);
    }
    persistTabs();
    renderTree();
  }

  // ---------- selection / routing ----------
  function selectFolder(folderPath, pushHash = true) {
    if (!confirmDiscardEdits()) return;
    state.currentDoc = null;
    state.currentFolder = folderPath;
    // Make sure ancestors are open so the folder is visible in the tree, but
    // leave the folder's own expansion state alone — the click handler decides
    // whether to open or close it.
    expandAncestorsOf(folderPath);
    persistTabs();
    renderTree();
    renderTabs();
    renderFolder(folderPath);
    if (pushHash) updateHash();
    if (typeof updateChatContext === 'function') updateChatContext();
    if (typeof updateAgentContext === 'function') updateAgentContext();
  }

  function selectDoc(docPath, pushHash = true, anchor = '') {
    const doc = state.docsByPath.get(docPath);
    if (!doc) {
      renderEmpty('Document not found in index: <code>' + escapeHtml(docPath) + '</code>');
      return;
    }
    // Allow re-selecting the same doc (e.g. tab switch back) without prompting.
    if (state.editor && state.editorDoc && state.editorDoc.path !== docPath) {
      if (!confirmDiscardEdits()) return;
    }
    state.currentDoc = doc;
    state.currentFolder = doc.folder === '.' ? '' : doc.folder;
    expandFolderAndAncestors(state.currentFolder);
    persistTabs();
    renderTree();
    renderTabs();
    renderDoc(doc, anchor);
    if (pushHash) updateHash(anchor);
    if (typeof updateChatContext === 'function') updateChatContext();
    if (typeof updateAgentContext === 'function') updateAgentContext();
  }

  function buildHash(anchor) {
    if (state.currentDoc) {
      let h = '#doc=' + encodeURIComponent(state.currentDoc.path);
      if (anchor) h += '&a=' + encodeURIComponent(anchor);
      return h;
    }
    if (state.currentFolder !== null) {
      return '#folder=' + encodeURIComponent(state.currentFolder);
    }
    return '';
  }

  function updateHash(anchor = '') {
    const h = buildHash(anchor);
    if (location.hash === h) return;
    // First navigation on an empty hash replaces; subsequent ones push so the
    // browser back/forward buttons walk the navigation stack.
    if (!location.hash) history.replaceState({ clawdoc: true }, '', location.pathname + h);
    else history.pushState({ clawdoc: true }, '', location.pathname + h);
  }

  function applyHash() {
    const h = location.hash.replace(/^#/, '');
    const params = new URLSearchParams(h);
    if (params.has('doc')) {
      const p = params.get('doc');
      const a = params.get('a') || '';
      if (!state.currentDoc || state.currentDoc.path !== p) {
        selectDoc(p, false, a);
      }
    } else if (params.has('folder')) {
      const f = params.get('folder');
      if (state.currentDoc || state.currentFolder !== f) {
        selectFolder(f, false);
      }
    } else {
      if (state.currentDoc || state.currentFolder !== '') selectFolder('', false);
    }
  }

  function restoreFromHash() {
    // Embed mode: render strictly from the hash, no tab/state side-effects.
    if (state.isEmbed) {
      const h = location.hash.replace(/^#/, '');
      const params = new URLSearchParams(h);
      if (params.has('doc') && state.docsByPath.has(params.get('doc'))) {
        renderDoc(state.docsByPath.get(params.get('doc')), params.get('a') || '');
        document.title = state.docsByPath.get(params.get('doc')).title || 'ClawDoc';
      } else {
        renderEmpty('No document specified.');
      }
      return;
    }
    // On initial load we ALWAYS need to render something into the viewer —
    // applyHash() would no-op if state.currentDoc already matches the hash,
    // which happens because syncActiveTabToState() ran first. So we force
    // the render here.
    if (location.hash) {
      const h = location.hash.replace(/^#/, '');
      const params = new URLSearchParams(h);
      if (params.has('doc') && state.docsByPath.has(params.get('doc'))) {
        selectDoc(params.get('doc'), false, params.get('a') || '');
        return;
      }
      if (params.has('folder')) {
        const f = params.get('folder');
        if (f === '' || state.nodesByPath.has(f)) {
          selectFolder(f, false);
          return;
        }
      }
      // Hash points at something we no longer know — fall through.
    }
    // No hash (or unresolvable hash) — restore from the active tab.
    const t = activeTab();
    if (t && t.docPath && state.docsByPath.has(t.docPath)) {
      selectDoc(t.docPath, false);
    } else {
      selectFolder(t ? t.folder || '' : '', false);
    }
  }

  // popstate fires on back/forward through pushState entries; hashchange
  // covers the case where the user types/pastes a different hash.
  window.addEventListener('popstate', applyHash);
  window.addEventListener('hashchange', applyHash);

  // ---------- breadcrumb ----------
  function renderBreadcrumb() {
    const bc = $('#breadcrumb');
    bc.innerHTML = '';
    const rootLabel = (state.index && state.index.roots && state.index.roots.length === 1)
      ? state.index.roots[0].name
      : 'Workspaces';
    const root = el('a', { class: 'crumb', href: '#folder=' }, rootLabel);
    root.addEventListener('click', (ev) => { ev.preventDefault(); selectFolder(''); });
    bc.appendChild(root);
    const segments = [];
    if (state.currentDoc) {
      const folder = state.currentDoc.folder === '.' ? '' : state.currentDoc.folder;
      if (folder) segments.push(...folder.split('/'));
    } else if (state.currentFolder) {
      segments.push(...state.currentFolder.split('/'));
    }
    let acc = '';
    segments.forEach((seg, i) => {
      bc.appendChild(el('span', { class: 'crumb-sep' }, '/'));
      acc = acc ? acc + '/' + seg : seg;
      const c = el('a', { class: 'crumb', href: '#folder=' + encodeURIComponent(acc) }, seg);
      const accSnap = acc;
      c.addEventListener('click', (ev) => { ev.preventDefault(); selectFolder(accSnap); });
      bc.appendChild(c);
    });
    if (state.currentDoc) {
      bc.appendChild(el('span', { class: 'crumb-sep' }, '/'));
      bc.appendChild(el('span', { class: 'crumb current' }, state.currentDoc.title || state.currentDoc.name));
    }
    // actions
    const actions = el('div', { class: 'crumb-actions' });
    if (state.currentDoc) {
      const reveal = el('button', { title: 'Reveal in Finder' }, 'Reveal');
      reveal.addEventListener('click', () => {
        fetch('/api/open?path=' + encodeURIComponent(state.currentDoc.path)).catch(()=>{});
      });
      actions.appendChild(reveal);
      const copy = el('button', { title: 'Copy workspace-relative path' }, 'Copy path');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(state.currentDoc.path);
        copy.textContent = 'Copied';
        setTimeout(() => copy.textContent = 'Copy path', 1200);
      });
      actions.appendChild(copy);
      const reload = el('button', { class: 'icon-btn', title: 'Reload from filesystem' });
      reload.innerHTML = ICON_REFRESH;
      reload.addEventListener('click', () => {
        const doc = state.currentDoc;
        if (!doc) return;
        renderDoc(doc, '', { reload: true });
        // Brief check-mark confirmation, then restore the refresh icon.
        reload.innerHTML = ICON_CHECK;
        reload.classList.add('ok');
        setTimeout(() => { reload.innerHTML = ICON_REFRESH; reload.classList.remove('ok'); }, 900);
      });
      actions.appendChild(reload);
      const zOut = el('button', { class: 'icon-btn', title: 'Zoom out (⌘−)' });
      zOut.innerHTML = ICON_ZOOM_OUT;
      zOut.addEventListener('click', zoomOut);
      actions.appendChild(zOut);
      const zLabel = el('button', { class: 'icon-btn zoom-label', title: 'Reset zoom (⌘0)' }, Math.round(state.zoom * 100) + '%');
      zLabel.addEventListener('click', zoomReset);
      actions.appendChild(zLabel);
      const zIn = el('button', { class: 'icon-btn', title: 'Zoom in (⌘+)' });
      zIn.innerHTML = ICON_ZOOM_IN;
      zIn.addEventListener('click', zoomIn);
      actions.appendChild(zIn);
      const fs = el('button', { class: 'icon-btn', title: 'Fullscreen (Esc to exit)' });
      fs.innerHTML = ICON_FULLSCREEN;
      fs.addEventListener('click', toggleFullscreen);
      actions.appendChild(fs);
      const isMd = state.currentDoc.ext === 'md' || state.currentDoc.ext === 'markdown';
      // History button — only shown when the doc's workspace is a git repo.
      const wsName = splitWorkspacePath(state.currentDoc.path).workspace;
      const wsStatus = gh.perWs.get(wsName);
      if (wsStatus && wsStatus.git && wsStatus.git.isRepo) {
        const histBtn = el('button', { title: 'View document history' }, 'History');
        histBtn.addEventListener('click', () => gh.openHistory(state.currentDoc));
        actions.appendChild(histBtn);
      }
      if (isMd) {
        const edit = el('button', { class: 'btn-accent', title: 'Edit in WYSIWYG editor' }, 'Edit');
        edit.addEventListener('click', () => startEditing(state.currentDoc));
        actions.appendChild(edit);
      }
    }
    bc.appendChild(actions);
    // Keep the topbar git pill in sync with the active workspace.
    try { gh.renderPill(); } catch {}
  }

  // ---------- folder view ----------
  function renderFolder(folderPath) {
    renderBreadcrumb();
    const node = state.nodesByPath.get(folderPath);
    const viewer = $('#viewer');
    viewer.innerHTML = '';
    const view = el('div', { class: 'folder-view' });
    const head = el('div', { class: 'folder-head' });
    head.appendChild(el('h2', { class: 'folder-title' }, folderPath || 'Workspace'));
    const meta = el('span', { class: 'folder-meta' });
    if (node) meta.textContent = `${node.docCount} document${node.docCount===1?'':'s'} · ${node.children.size} folder${node.children.size===1?'':'s'}`;
    head.appendChild(meta);
    const sortCtl = el('div', { class: 'sort-controls' });
    sortCtl.appendChild(el('span', null, 'Sort:'));
    const sortSelect = el('select');
    [['date','date'],['name','name'],['type','type'],['size','size']].forEach(([v, lbl]) => {
      const opt = el('option', { value: v }, lbl);
      if (state.sortBy === v) opt.setAttribute('selected', 'selected');
      sortSelect.appendChild(opt);
    });
    sortSelect.addEventListener('change', () => {
      state.sortBy = sortSelect.value;
      localStorage.setItem('clawdoc.sortBy', state.sortBy);
      renderFolder(folderPath);
    });
    sortCtl.appendChild(sortSelect);
    const dirBtn = el('button', { title: 'Toggle sort direction' }, state.sortDir === 'asc' ? '↑' : '↓');
    dirBtn.style.cssText = 'height:26px;width:26px;border:1px solid var(--border-strong);border-radius:4px;background:var(--bg-elev);cursor:pointer;';
    dirBtn.addEventListener('click', () => {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      localStorage.setItem('clawdoc.sortDir', state.sortDir);
      renderFolder(folderPath);
    });
    sortCtl.appendChild(dirBtn);
    head.appendChild(sortCtl);
    view.appendChild(head);

    if (!node) {
      view.appendChild(el('div', { class: 'empty-folder' }, 'Folder not found.'));
      viewer.appendChild(view);
      return;
    }

    // Subfolders section
    const childFolders = sortedChildren(node);
    if (childFolders.length) {
      view.appendChild(el('div', { class: 'section-label' }, 'Folders'));
      const list = el('div', { class: 'row-list' });
      for (const ch of childFolders) {
        const row = el('a', { class: 'row folder', href: '#folder=' + encodeURIComponent(ch.path) });
        row.appendChild(el('span', { class: 'ricon', html: ICON_FOLDER }));
        const tit = el('div', { class: 'rtitle' });
        tit.appendChild(el('div', { class: 'rname' }, ch.name));
        tit.appendChild(el('div', { class: 'rsub' }, ch.path));
        row.appendChild(tit);
        row.appendChild(el('div', { class: 'rdate' }, ''));
        row.appendChild(el('div', { class: 'rtype' }, ch.docCount + ' docs'));
        row.appendChild(el('div', { class: 'rsize' }, ''));
        row.addEventListener('click', (ev) => { ev.preventDefault(); selectFolder(ch.path); });
        list.appendChild(row);
      }
      view.appendChild(list);
    }

    // Documents section
    if (node.docs.length) {
      view.appendChild(el('div', { class: 'section-label' }, 'Documents'));
      const docs = sortDocs(node.docs.slice());
      const list = el('div', { class: 'row-list' });
      for (const d of docs) list.appendChild(renderDocRow(d));
      view.appendChild(list);
    } else if (!childFolders.length) {
      view.appendChild(el('div', { class: 'empty-folder' }, 'No documents in this folder.'));
    }

    viewer.appendChild(view);
  }

  function sortDocs(docs) {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name),
      date: (a, b) => (a.date || '').localeCompare(b.date || ''),
      type: (a, b) => (a.docType || '').localeCompare(b.docType || '') || a.name.localeCompare(b.name),
      size: (a, b) => a.size - b.size,
    }[state.sortBy] || ((a, b) => a.name.localeCompare(b.name));
    return docs.sort((a, b) => cmp(a, b) * dir);
  }

  function renderDocRow(d) {
    const isHtml = d.ext === 'html' || d.ext === 'htm';
    const isPdf = d.ext === 'pdf';
    const kindClass = isPdf ? 'pdf' : isHtml ? 'html' : 'md';
    const icon = isPdf ? ICON_PDF : isHtml ? ICON_HTML : ICON_MD;
    const row = el('a', {
      class: 'row ' + kindClass,
      href: '#doc=' + encodeURIComponent(d.path),
      title: docTooltip(d),
    });
    row.appendChild(el('span', { class: 'ricon', html: icon }));
    const tit = el('div', { class: 'rtitle' });
    tit.appendChild(el('div', { class: 'rname' }, d.title || d.name));
    tit.appendChild(el('div', { class: 'rsub' }, d.name));
    row.appendChild(tit);
    row.appendChild(el('div', { class: 'rdate' }, d.date || ''));
    row.appendChild(el('div', { class: 'rtype' }, d.docType || d.ext));
    row.appendChild(el('div', { class: 'rsize' }, formatSize(d.size)));
    row.addEventListener('click', (ev) => { ev.preventDefault(); selectDoc(d.path); });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showDocContextMenu(d, ev.clientX, ev.clientY);
    });
    return row;
  }

  // ---------- document view ----------
  async function renderDoc(doc, anchor, opts) {
    renderBreadcrumb();
    const viewer = $('#viewer');
    viewer.innerHTML = '';
    const isHtml = doc.ext === 'html' || doc.ext === 'htm';
    const isPdf = doc.ext === 'pdf';
    const reload = !!(opts && opts.reload);
    // Cache-bust on explicit reload so iframes/<embed>/fetched content come
    // straight from disk rather than the browser's resource cache.
    const bust = reload ? ('_ts=' + Date.now()) : '';

    if (isHtml) {
      const wrap = el('div', { class: 'html-frame-wrap' });
      // Serve via /raw/<path> so the iframe's base URL matches the document's
      // folder — relative refs like `assets/foo.png` resolve correctly.
      const rawUrl = '/raw/' + doc.path.split('/').map(encodeURIComponent).join('/') + (bust ? '?' + bust : '');
      const iframe = el('iframe', {
        class: 'html-frame',
        src: rawUrl,
        sandbox: 'allow-same-origin allow-scripts allow-popups allow-forms allow-modals',
      });
      iframe.addEventListener('load', () => hookIframeLinks(iframe, doc));
      wrap.appendChild(iframe);
      viewer.appendChild(wrap);
      // For HTML, render a tiny doc header pinned above? We keep it minimal — breadcrumb already shows title.
      return;
    }

    if (isPdf) {
      const wrap = el('div', { class: 'pdf-frame-wrap' });
      const src = '/file?path=' + encodeURIComponent(doc.path) + (bust ? '&' + bust : '') + (anchor ? '#' + anchor : '');
      // <embed> works better than <iframe> for PDFs on Safari/Chrome —
      // they hand it off to the native PDF plugin without sandbox restrictions.
      const embed = el('embed', {
        class: 'pdf-frame',
        type: 'application/pdf',
        src,
      });
      const fallback = el('div', { class: 'pdf-fallback' });
      fallback.appendChild(el('span', null, 'If the PDF does not load inline, '));
      const dl = el('a', { href: '/file?path=' + encodeURIComponent(doc.path), target: '_blank', rel: 'noopener' }, 'open it in a new tab');
      fallback.appendChild(dl);
      fallback.appendChild(el('span', null, '.'));
      wrap.appendChild(embed);
      wrap.appendChild(fallback);
      viewer.appendChild(wrap);
      return;
    }

    // Markdown
    let text;
    try {
      const mdUrl = '/file?path=' + encodeURIComponent(doc.path) + (bust ? '&' + bust : '');
      const r = await fetch(mdUrl, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    } catch (err) {
      renderEmpty('Failed to load: ' + escapeHtml(err.message));
      return;
    }
    const view = el('div', { class: 'doc-view' });
    const head = el('div', { class: 'doc-head' });
    head.appendChild(el('h1', { class: 'doc-title' }, doc.title || doc.name));
    const meta = el('div', { class: 'doc-meta' });
    const bits = [];
    if (doc.date) bits.push(doc.date);
    if (doc.project) bits.push(doc.project);
    if (doc.docType) bits.push(doc.docType);
    bits.push(formatSize(doc.size));
    bits.push(doc.path);
    meta.textContent = bits.join('  ·  ');
    head.appendChild(meta);
    view.appendChild(head);

    const md = el('div', { class: 'markdown' });
    // Strip front-matter for display
    const body = stripFrontMatter(text);
    const html = window.marked
      ? window.marked.parse(body, { gfm: true, breaks: false, headerIds: true, mangle: false })
      : '<pre>' + escapeHtml(body) + '</pre>';
    md.innerHTML = html;
    rewriteMarkdownLinksAndImages(md, doc);
    view.appendChild(md);

    // Backlinks
    if (doc.backlinks && doc.backlinks.length) {
      const bl = el('div', { class: 'backlinks' });
      bl.appendChild(el('div', { class: 'backlinks-title' }, `${doc.backlinks.length} backlink${doc.backlinks.length===1?'':'s'}`));
      const list = el('div', { class: 'backlinks-list' });
      for (const p of doc.backlinks) {
        const link = el('a', { href: '#doc=' + encodeURIComponent(p) }, p);
        link.addEventListener('click', (ev) => { ev.preventDefault(); selectDoc(p); });
        list.appendChild(link);
      }
      bl.appendChild(list);
      view.appendChild(bl);
    }

    viewer.appendChild(view);

    // Scroll to top, then to anchor if any
    viewer.scrollTop = 0;
    if (anchor) {
      const tgt = md.querySelector('#' + CSS.escape(anchor));
      if (tgt) tgt.scrollIntoView({ block: 'start' });
    }
  }

  function stripFrontMatter(text) {
    if (!text.startsWith('---')) return text;
    const m = text.match(/^---\n([\s\S]*?)\n---\s*\n?/);
    return m ? text.slice(m[0].length) : text;
  }

  function rewriteMarkdownLinksAndImages(root, doc) {
    const fromDir = doc.folder === '.' ? '' : doc.folder;
    // Images
    root.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (/^([a-z][a-z0-9+.-]*:|\/\/|data:)/i.test(src)) return;
      const resolved = resolveRelative(fromDir, src);
      if (resolved) img.src = '/asset?path=' + encodeURIComponent(resolved);
    });
    // Links
    root.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      if (/^([a-z][a-z0-9+.-]*:|\/\/|mailto:)/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        return;
      }
      if (href.startsWith('#')) return; // in-page anchor
      const [pathPart, anchorPart] = href.split('#');
      const resolved = resolveRelative(fromDir, pathPart);
      if (resolved && state.docsByPath.has(resolved)) {
        a.setAttribute('href', '#doc=' + encodeURIComponent(resolved) + (anchorPart ? '&a=' + encodeURIComponent(anchorPart) : ''));
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          selectDoc(resolved, true, anchorPart || '');
        });
      } else {
        a.classList.add('broken');
        a.title = 'Broken link → ' + (resolved || pathPart);
        a.addEventListener('click', (ev) => ev.preventDefault());
      }
    });
  }

  function hookIframeLinks(iframe, doc) {
    let idoc;
    try { idoc = iframe.contentDocument; } catch { return; }
    if (!idoc) return;
    const fromDir = doc.folder === '.' ? '' : doc.folder;
    idoc.addEventListener('click', (ev) => {
      let a = ev.target;
      while (a && a !== idoc && a.tagName !== 'A') a = a.parentNode;
      if (!a || a.tagName !== 'A') return;
      const href = a.getAttribute('href');
      if (!href) return;
      if (/^([a-z][a-z0-9+.-]*:|\/\/|mailto:)/i.test(href)) {
        // External — let it open in new tab
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        return;
      }
      if (href.startsWith('#')) return; // in-page anchor inside iframe
      const [pathPart, anchorPart] = href.split('#');
      const resolved = resolveRelative(fromDir, pathPart);
      if (resolved && state.docsByPath.has(resolved)) {
        ev.preventDefault();
        selectDoc(resolved, true, anchorPart || '');
      }
    }, true);
  }

  function renderEmpty(htmlMsg) {
    $('#viewer').innerHTML = '<div class="empty"><div class="empty-sub">' + htmlMsg + '</div></div>';
    renderBreadcrumb();
  }

  // ---------- search ----------
  const runSearch = debounce((q) => {
    const results = $('#search-results');
    q = q.trim();
    if (!q) { results.classList.add('hidden'); results.innerHTML = ''; return; }
    const hits = searchDocs(q, 30);
    results.innerHTML = '';
    if (!hits.length) {
      results.appendChild(el('div', { class: 'search-empty' }, 'No matches'));
    } else {
      hits.forEach((h, i) => {
        const a = el('a', { class: 'search-result' + (i === 0 ? ' focus' : ''), href: '#doc=' + encodeURIComponent(h.doc.path) });
        a.appendChild(el('div', { class: 'sr-title', html: highlightTerms(h.doc.title || h.doc.name, h.terms) }));
        a.appendChild(el('div', { class: 'sr-path' }, h.doc.path));
        if (h.snippet) a.appendChild(el('div', { class: 'sr-snippet', html: h.snippet }));
        a.addEventListener('click', (ev) => { ev.preventDefault(); selectDoc(h.doc.path); closeSearch(); });
        results.appendChild(a);
      });
    }
    results.classList.remove('hidden');
  }, 80);

  function searchDocs(query, limit) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits = [];
    for (const d of state.docs) {
      const title = (d.title || '').toLowerCase();
      const name = d.name.toLowerCase();
      const pathStr = d.path.toLowerCase();
      const body = (d.body || '').toLowerCase();
      let score = 0;
      let allFound = true;
      for (const t of terms) {
        let s = 0;
        if (title.includes(t)) s += 10;
        if (name.includes(t)) s += 8;
        if (pathStr.includes(t)) s += 4;
        if (body.includes(t)) s += 2;
        if (s === 0) { allFound = false; break; }
        score += s;
      }
      if (!allFound) continue;
      // Bonus for exact-phrase match in title or body
      if (terms.length > 1) {
        const phrase = terms.join(' ');
        if (title.includes(phrase)) score += 5;
        if (body.includes(phrase)) score += 3;
      }
      hits.push({ doc: d, score, terms, snippet: makeSnippet(d.body || '', terms) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  function makeSnippet(body, terms) {
    if (!body) return '';
    const lower = body.toLowerCase();
    let idx = -1;
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i >= 0 && (idx < 0 || i < idx)) idx = i;
    }
    if (idx < 0) return '';
    const start = Math.max(0, idx - 40);
    const end = Math.min(body.length, idx + 120);
    let snip = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
    return highlightTerms(snip, terms);
  }

  function highlightTerms(s, terms) {
    let out = escapeHtml(s);
    for (const t of terms) {
      const re = new RegExp('(' + escapeRegex(t) + ')', 'ig');
      out = out.replace(re, '<mark class="hl">$1</mark>');
    }
    return out;
  }

  function closeSearch() {
    $('#search-results').classList.add('hidden');
    $('#search').value = '';
  }

  // ---------- quick open ----------
  function openQuickOpen() {
    const qo = $('#quick-open');
    qo.classList.remove('hidden');
    const input = $('#quick-open-input');
    input.value = '';
    renderQuickOpenResults('');
    setTimeout(() => input.focus(), 0);
  }
  function closeQuickOpen() {
    $('#quick-open').classList.add('hidden');
  }
  function renderQuickOpenResults(q) {
    const list = $('#quick-open-results');
    list.innerHTML = '';
    q = q.trim().toLowerCase();
    let docs;
    if (!q) {
      docs = state.docs.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    } else {
      const hits = [];
      for (const d of state.docs) {
        const score = fuzzyScore(d, q);
        if (score > 0) hits.push({ d, score });
      }
      hits.sort((a, b) => b.score - a.score);
      docs = hits.slice(0, 40).map(h => h.d);
    }
    docs.forEach((d, i) => {
      const item = el('div', { class: 'qo-item' + (i === 0 ? ' focus' : '') });
      item.appendChild(el('div', { class: 'qo-title' }, d.title || d.name));
      item.appendChild(el('div', { class: 'qo-path' }, d.path));
      item.addEventListener('click', () => { selectDoc(d.path); closeQuickOpen(); });
      list.appendChild(item);
    });
    if (!docs.length) list.appendChild(el('div', { class: 'search-empty' }, 'No matches'));
  }
  function fuzzyScore(d, q) {
    const t = (d.title || '').toLowerCase();
    const n = d.name.toLowerCase();
    const p = d.path.toLowerCase();
    let score = 0;
    if (n.includes(q)) score += 20;
    if (t.includes(q)) score += 15;
    if (p.includes(q)) score += 5;
    // Substring of consecutive chars
    if (score === 0) {
      // Subsequence match
      let i = 0;
      for (const c of n) { if (c === q[i]) i++; if (i === q.length) break; }
      if (i === q.length) score = 3;
    }
    return score;
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', (ev) => {
    if (state.isEmbed) return;
    const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    const meta = ev.metaKey || ev.ctrlKey;
    if (meta && ev.key === 's' && state.editor) {
      ev.preventDefault();
      if (state.editorSaveFn) state.editorSaveFn();
      return;
    }
    // Cmd/Ctrl + +, -, 0 — zoom controls
    if (meta && (ev.key === '=' || ev.key === '+')) { ev.preventDefault(); zoomIn(); return; }
    if (meta && ev.key === '-') { ev.preventDefault(); zoomOut(); return; }
    if (meta && ev.key === '0') { ev.preventDefault(); zoomReset(); return; }
    if (meta && ev.key === 't') {
      ev.preventDefault();
      newTab();
      return;
    }
    if (meta && ev.key === 'w') {
      ev.preventDefault();
      if (state.activeTabId) closeTab(state.activeTabId);
      return;
    }
    if (meta && /^[1-9]$/.test(ev.key)) {
      const idx = parseInt(ev.key, 10) - 1;
      if (state.tabs[idx]) { ev.preventDefault(); switchTab(state.tabs[idx].id); }
      return;
    }
    if (meta && ev.key === 'p') {
      ev.preventDefault();
      openQuickOpen();
      return;
    }
    if (meta && ev.key === 'k') {
      ev.preventDefault();
      $('#tree-filter').focus();
      $('#tree-filter').select();
      return;
    }
    if (!inField && ev.key === '/') {
      ev.preventDefault();
      $('#search').focus();
      $('#search').select();
      return;
    }
    if (ev.key === 'Escape') {
      if (previewIsOpen()) { closePreview(); return; }
      if (!$('#settings-modal').classList.contains('hidden')) { closeSettings(); return; }
      if (!$('#ctx-menu').classList.contains('hidden')) { hideCtxMenu(); return; }
      if (!$('#quick-open').classList.contains('hidden')) { closeQuickOpen(); return; }
      if (!$('#search-results').classList.contains('hidden')) { closeSearch(); return; }
      // When the terminal has focus, Esc belongs to Claude (interrupt) — don't
      // hijack it to close the panel.
      if (chat.open && !inField && !isTerminalFocused()) { closeChat(); return; }
      // Esc while the composer is focused interrupts the turn; otherwise closes.
      if (agent.open && isAgentFocused()) { if (agent.running) { agStop(); return; } }
      if (agent.open && !inField && !isAgentFocused()) { closeAgent(); return; }
      if (state.mcMode && !inField) { exitMcMode(); return; }
      if ($('#tree-filter').value) { $('#tree-filter').value = ''; state.treeFilter = ''; renderTree(); return; }
    }
    // Quick Look-style preview: spacebar toggles preview for the focused MC
    // file. Only fires in MC mode and only when no input has focus so it
    // doesn't fight with spacebar in the pane filter / global search.
    if (ev.key === ' ' && state.mcMode && !inField && !meta && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      toggleMcPreview();
      return;
    }
    // Cmd+C / Cmd+V in MC mode only — outside MC the tabbed view has text
    // selection in the markdown viewer, and we don't want to hijack that.
    if (state.mcMode && !inField && meta && !ev.shiftKey && !ev.altKey) {
      if (ev.key === 'c' || ev.key === 'C') {
        if (mcCopyFocused()) ev.preventDefault();
        return;
      }
      if (ev.key === 'v' || ev.key === 'V') {
        if (mcPasteIntoFocused()) ev.preventDefault();
        return;
      }
    }
    if (ev.key === 'Enter') {
      if (document.activeElement === $('#search')) {
        const first = $('#search-results .search-result.focus') || $('#search-results .search-result');
        if (first) first.click();
        return;
      }
      if (document.activeElement === $('#quick-open-input')) {
        const first = $('#quick-open-results .qo-item.focus') || $('#quick-open-results .qo-item');
        if (first) first.click();
        return;
      }
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const container =
        (document.activeElement === $('#search')) ? $('#search-results') :
        (document.activeElement === $('#quick-open-input')) ? $('#quick-open-results') : null;
      if (!container) return;
      ev.preventDefault();
      const items = container.querySelectorAll('.search-result, .qo-item');
      if (!items.length) return;
      let idx = -1;
      items.forEach((it, i) => { if (it.classList.contains('focus')) idx = i; });
      if (idx < 0) idx = 0;
      else idx = ev.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      items.forEach(it => it.classList.remove('focus'));
      items[idx].classList.add('focus');
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  });

  // ---------- reindex ----------
  async function doReindex() {
    const btn = $('#reindex');
    btn.disabled = true;
    setStatus('reindexing…');
    try {
      const r = await fetch('/api/reindex', { method: 'POST' });
      const data = await r.json();
      if (data.code === 0) {
        await loadIndex();
        setStatus('reindexed', 'ok');
      } else {
        console.error(data);
        setStatus('reindex failed', 'error');
      }
    } catch (err) {
      console.error(err);
      setStatus('reindex error', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- settings modal ----------
  function openSettings() {
    // Snapshot the current workspace list into an editable working copy.
    const cur = (state.index && state.index.roots) || [];
    state.editingWorkspaces = cur.map(r => r.path);
    state.settingsBusy = false;
    renderSettings();
    $('#settings-modal').classList.remove('hidden');
    $('#settings-toggle').classList.add('active');
  }
  function closeSettings() {
    delete state.editingWorkspaces;
    state.settingsBusy = false;
    $('#settings-modal').classList.add('hidden');
    $('#settings-toggle').classList.remove('active');
  }
  function toggleSettings() {
    $('#settings-modal').classList.contains('hidden') ? openSettings() : closeSettings();
  }

  async function pickFolder() {
    try {
      const r = await fetch('/api/pick-folder');
      const data = await r.json();
      return data.path || '';
    } catch { return ''; }
  }

  async function saveWorkspacesAndReindex(statusEl) {
    if (state.settingsBusy) return;
    const list = state.editingWorkspaces || [];
    if (!list.length) { statusEl.textContent = 'Need at least one workspace.'; statusEl.className = 'settings-status error'; return; }
    state.settingsBusy = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'settings-status';
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaces: list }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      statusEl.textContent = 'Reindexing…';
      const rr = await fetch('/api/reindex', { method: 'POST' });
      const rd = await rr.json();
      if (rd.code !== 0) throw new Error((rd.stderr || rd.stdout || 'Reindex failed').trim());
      // Reload the index, then refresh tabs to drop stale paths.
      delete state.editingWorkspaces;
      await loadIndex();
      statusEl.textContent = 'Saved ✓';
      statusEl.className = 'settings-status ok';
      setTimeout(() => closeSettings(), 700);
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'settings-status error';
    } finally {
      state.settingsBusy = false;
    }
  }

  function renderSettings() {
    const body = $('#settings-body');
    body.innerHTML = '';

    // ---- Workspaces (editable) ----
    const wsSection = el('div', { class: 'settings-section' });
    wsSection.appendChild(el('h3', null, 'Workspaces'));

    const wsList = el('div', { class: 'settings-list' });
    const editList = state.editingWorkspaces || [];
    const currentList = ((state.index && state.index.roots) || []).map(r => r.path);
    const minRows = Math.max(editList.length, 1);

    editList.forEach((p, i) => {
      const row = el('div', { class: 'settings-row' });
      const baseName = p.split('/').filter(Boolean).pop() || p;
      row.appendChild(el('span', { class: 'sr-key' }, baseName));
      row.appendChild(el('span', { class: 'sr-val', title: p }, p));
      const removeBtn = el('button', { class: 'danger', title: 'Remove this workspace' }, '−');
      removeBtn.disabled = minRows <= 1;
      removeBtn.addEventListener('click', () => {
        if (editList.length <= 1) return;
        editList.splice(i, 1);
        renderSettings();
      });
      row.appendChild(removeBtn);
      wsList.appendChild(row);
    });

    // Add-workspace row
    const addRow = el('div', { class: 'settings-row settings-add-row' });
    const addInput = el('input', {
      type: 'text',
      class: 'settings-input',
      placeholder: '/absolute/path/to/folder',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    addRow.appendChild(addInput);
    const browseBtn = el('button', { title: 'Pick a folder' }, 'Browse…');
    browseBtn.addEventListener('click', async () => {
      browseBtn.textContent = '…';
      const p = await pickFolder();
      browseBtn.textContent = 'Browse…';
      if (p) addInput.value = p;
    });
    addRow.appendChild(browseBtn);
    const addBtn = el('button', { title: 'Add workspace to the list' }, 'Add');
    const doAdd = () => {
      const p = addInput.value.trim();
      if (!p) return;
      if (editList.includes(p)) {
        addInput.value = '';
        return;
      }
      editList.push(p);
      addInput.value = '';
      renderSettings();
      // Re-focus the new input so the user can keep adding.
      setTimeout(() => {
        const fresh = document.querySelector('.settings-add-row .settings-input');
        if (fresh) fresh.focus();
      }, 0);
    };
    addBtn.addEventListener('click', doAdd);
    addInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); doAdd(); }
    });
    addRow.appendChild(addBtn);
    wsList.appendChild(addRow);
    wsSection.appendChild(wsList);

    // Save row — only when there are pending changes
    const dirty = JSON.stringify(currentList) !== JSON.stringify(editList);
    const statusEl = el('span', { class: 'settings-status' });
    if (dirty) {
      const saveRow = el('div', { class: 'settings-row settings-save-row' });
      const msg = el('span', { class: 'sr-val' }, 'Pending changes — applies to settings.json and reindex.');
      saveRow.appendChild(msg);
      saveRow.appendChild(statusEl);
      const resetBtn = el('button', null, 'Revert');
      resetBtn.addEventListener('click', () => {
        state.editingWorkspaces = currentList.slice();
        renderSettings();
      });
      saveRow.appendChild(resetBtn);
      const saveBtn = el('button', { class: 'btn-primary' }, 'Save & reindex');
      saveBtn.addEventListener('click', () => saveWorkspacesAndReindex(statusEl));
      saveRow.appendChild(saveBtn);
      wsSection.appendChild(saveRow);
    } else {
      wsSection.appendChild(el('div', { class: 'settings-help' },
        'Workspaces persist to settings.json next to the ClawDoc scripts. The Reindex button and the index.js CLI both read it.'
      ));
    }
    body.appendChild(wsSection);

    // GitHub section
    body.appendChild(gh.renderSettingsSection());

    // Stats
    if (state.index && state.index.stats) {
      const statsSection = el('div', { class: 'settings-section' });
      statsSection.appendChild(el('h3', null, 'Index'));
      const list = el('div', { class: 'settings-list' });
      const s = state.index.stats;
      const generated = state.index.generatedAt ? new Date(state.index.generatedAt).toLocaleString() : '—';
      const rowsData = [
        ['Documents', `${s.docCount} (${s.md} md, ${s.html} html, ${s.pdf || 0} pdf)`],
        ['Folders', String(s.folderCount)],
        ['Generated', generated],
      ];
      for (const [k, v] of rowsData) {
        const row = el('div', { class: 'settings-row' });
        row.appendChild(el('span', { class: 'sr-key' }, k));
        row.appendChild(el('span', { class: 'sr-val' }, v));
        list.appendChild(row);
      }
      statsSection.appendChild(list);
      body.appendChild(statsSection);
    }

    // Reset / storage
    const resetSection = el('div', { class: 'settings-section' });
    resetSection.appendChild(el('h3', null, 'Saved preferences'));
    const resetList = el('div', { class: 'settings-list' });
    const resetRow = (key, label, getValue) => {
      const row = el('div', { class: 'settings-row' });
      row.appendChild(el('span', { class: 'sr-key' }, label));
      const val = el('span', { class: 'sr-val' }, getValue());
      row.appendChild(val);
      const b = el('button', { class: 'danger', title: 'Clear this preference' }, 'Clear');
      b.addEventListener('click', () => {
        localStorage.removeItem(key);
        val.textContent = '(cleared — reloads on next refresh)';
      });
      row.appendChild(b);
      return row;
    };
    resetList.appendChild(resetRow('clawdoc.tabs', 'Tabs & open docs',
      () => state.tabs.length + ' tabs'));
    resetList.appendChild(resetRow('clawdoc.zoom', 'Zoom level',
      () => Math.round(state.zoom * 100) + '%'));
    resetList.appendChild(resetRow('clawdoc.sidebarWidth', 'Sidebar width',
      () => (localStorage.getItem('clawdoc.sidebarWidth') || 'default') + 'px'));
    resetList.appendChild(resetRow('clawdoc.sortBy', 'Sort by',
      () => state.sortBy));
    resetList.appendChild(resetRow('clawdoc.sortDir', 'Sort direction',
      () => state.sortDir));
    resetSection.appendChild(resetList);

    const clearAllRow = el('div', { class: 'settings-row' });
    clearAllRow.appendChild(el('span', { class: 'sr-key' }, 'Reset everything'));
    clearAllRow.appendChild(el('span', { class: 'sr-val' }, 'Clears all clawdoc.* keys and reloads'));
    const allBtn = el('button', { class: 'danger' }, 'Reset & reload');
    allBtn.addEventListener('click', () => {
      if (!confirm('Reset all saved preferences (tabs, zoom, sidebar, sort) and reload?')) return;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('clawdoc.')) localStorage.removeItem(k);
      }
      location.reload();
    });
    clearAllRow.appendChild(allBtn);
    resetSection.appendChild(clearAllRow);
    body.appendChild(resetSection);
  }

  // ---------- zoom ----------
  state.zoom = parseFloat(localStorage.getItem('clawdoc.zoom')) || 1;

  function applyZoom() {
    const v = $('#viewer');
    if (v) v.style.zoom = String(state.zoom);
    const lbl = document.querySelector('.zoom-label');
    if (lbl) lbl.textContent = Math.round(state.zoom * 100) + '%';
  }
  function setZoom(z) {
    state.zoom = Math.max(0.5, Math.min(3, Math.round(z * 100) / 100));
    localStorage.setItem('clawdoc.zoom', String(state.zoom));
    applyZoom();
  }
  function zoomIn()    { setZoom(state.zoom + 0.1); }
  function zoomOut()   { setZoom(state.zoom - 0.1); }
  function zoomReset() { setZoom(1); }

  // ---------- fullscreen + toolbar autohide ----------
  let fsHideTimer = null;
  function showFsBarBriefly(ms) {
    document.body.classList.add('fs-show-bar');
    if (fsHideTimer) clearTimeout(fsHideTimer);
    fsHideTimer = setTimeout(() => {
      document.body.classList.remove('fs-show-bar');
      fsHideTimer = null;
    }, ms);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      const target = document.documentElement;
      if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      document.body.classList.add('fullscreen');
      // Flash the toolbar so the user knows where the exit controls live.
      showFsBarBriefly(1600);
    } else {
      document.body.classList.remove('fullscreen');
      document.body.classList.remove('fs-show-bar');
      if (fsHideTimer) { clearTimeout(fsHideTimer); fsHideTimer = null; }
    }
  });
  // Trigger zone matches the toolbar height: revealing happens as soon as the
  // mouse enters the top band that the toolbar itself will occupy.
  const FS_BAR_HEIGHT = 40;          // breadcrumb height
  const FS_HIDE_BELOW = FS_BAR_HEIGHT + 12; // small buffer below the bar
  document.addEventListener('mousemove', (ev) => {
    if (!document.body.classList.contains('fullscreen')) return;
    if (ev.clientY < FS_BAR_HEIGHT) {
      // Mouse is inside the top band — reveal the toolbar.
      document.body.classList.add('fs-show-bar');
      if (fsHideTimer) { clearTimeout(fsHideTimer); fsHideTimer = null; }
    } else if (ev.clientY > FS_HIDE_BELOW) {
      // Outside the toolbar zone — schedule a hide.
      if (!fsHideTimer) {
        fsHideTimer = setTimeout(() => {
          document.body.classList.remove('fs-show-bar');
          fsHideTimer = null;
        }, 900);
      }
    } else {
      // In the small buffer just below the bar — cancel any pending hide.
      if (fsHideTimer) { clearTimeout(fsHideTimer); fsHideTimer = null; }
    }
  });

  // ---------- editor (Toast UI WYSIWYG) ----------
  state.editor = null;        // toastui.Editor instance
  state.editorDoc = null;     // doc currently being edited
  state.editorOriginal = '';  // original text for dirty check
  state.editorFrontMatter = ''; // preserved YAML front-matter, prepended on save

  function splitFrontMatter(text) {
    if (!text.startsWith('---')) return { fm: '', body: text };
    const end = text.indexOf('\n---', 3);
    if (end < 0) return { fm: '', body: text };
    return {
      fm: text.slice(0, end + 4) + '\n',
      body: text.slice(end + 4).replace(/^\n+/, ''),
    };
  }

  function isEditorDirty() {
    if (!state.editor) return false;
    const cur = state.editorFrontMatter + state.editor.getMarkdown();
    return cur !== state.editorOriginal;
  }

  function confirmDiscardEdits() {
    if (!state.editor) return true;
    if (!isEditorDirty()) { destroyEditor(); return true; }
    if (confirm('You have unsaved changes. Discard them?')) { destroyEditor(); return true; }
    return false;
  }

  function destroyEditor() {
    if (state.editor) {
      try { state.editor.destroy(); } catch {}
    }
    state.editor = null;
    state.editorDoc = null;
    state.editorOriginal = '';
    state.editorFrontMatter = '';
  }

  async function startEditing(doc) {
    if (!doc) return;
    if (typeof toastui === 'undefined' || !toastui.Editor) {
      alert('Editor failed to load — check network/CDN access.');
      return;
    }
    if (state.editor && !confirmDiscardEdits()) return;

    let text;
    try {
      const r = await fetch('/file?path=' + encodeURIComponent(doc.path) + '&_ts=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    } catch (err) {
      alert('Failed to load file: ' + err.message);
      return;
    }

    const viewer = $('#viewer');
    viewer.innerHTML = '';
    const wrap = el('div', { class: 'doc-edit' });

    const bar = el('div', { class: 'doc-edit-bar' });
    bar.appendChild(el('div', { class: 'doc-edit-title' }, 'Editing  ·  ' + doc.path));
    const status = el('span', { class: 'doc-edit-status' });
    bar.appendChild(status);
    const cancelBtn = el('button', { class: 'doc-edit-cancel' }, 'Close');
    const saveBtn = el('button', { class: 'doc-edit-save' }, 'Save  ⌘S');
    bar.appendChild(cancelBtn);
    bar.appendChild(saveBtn);
    wrap.appendChild(bar);

    const holder = el('div', { class: 'doc-edit-holder', id: 'doc-editor-holder' });
    wrap.appendChild(holder);
    viewer.appendChild(wrap);

    const { fm, body } = splitFrontMatter(text);
    state.editorFrontMatter = fm;
    state.editorOriginal = text;
    state.editorDoc = doc;

    state.editor = new toastui.Editor({
      el: holder,
      initialValue: body,
      initialEditType: 'wysiwyg',
      previewStyle: 'tab',
      height: '100%',
      autofocus: true,
      usageStatistics: false,
      hideModeSwitch: false,
      toolbarItems: [
        ['heading', 'bold', 'italic', 'strike'],
        ['hr', 'quote'],
        ['ul', 'ol', 'task'],
        ['table', 'image', 'link'],
        ['code', 'codeblock'],
      ],
    });

    cancelBtn.addEventListener('click', () => {
      if (!confirmDiscardEdits()) return;
      // Reload so iframes/embeds (HTML, PDF) fetch the freshly saved file
      // instead of the browser-cached pre-edit copy, and use the fresh doc
      // reference if the index already refreshed (front-matter / backlinks
      // may have changed).
      const fresh = state.docsByPath.get(doc.path) || doc;
      renderDoc(fresh, '', { reload: true });
    });

    const doSave = async () => {
      if (!state.editor) return;
      const md = state.editorFrontMatter + state.editor.getMarkdown();
      status.textContent = 'Saving…';
      status.className = 'doc-edit-status';
      saveBtn.disabled = true;
      try {
        const r = await fetch('/api/save?path=' + encodeURIComponent(doc.path), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: md,
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
        state.editorOriginal = md;
        status.textContent = 'Saved ✓';
        status.className = 'doc-edit-status ok';
        // Update mtime/size in the in-memory index so the tooltip stays accurate.
        const idx = state.docs.find(d => d.path === doc.path);
        if (idx) { idx.size = data.size; idx.mtime = data.mtime; }
        setTimeout(() => { if (status.textContent === 'Saved ✓') status.textContent = ''; }, 1500);
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        status.className = 'doc-edit-status error';
      } finally {
        saveBtn.disabled = false;
      }
    };
    saveBtn.addEventListener('click', doSave);
    state.editorSaveFn = doSave;
  }

  // ---------- chat panel (Claude Code terminal) ----------
  // xterm.js front-end driving a real PTY on the server. The panel chrome is
  // still called "chat" (CSS/IDs kept stable) but the content is a terminal.
  const TERM_THEMES = {
    dark: {
      background:          '#1d1f21',
      foreground:          '#e6e1cf',
      cursor:              '#f0c674',
      cursorAccent:        '#1d1f21',
      selectionBackground: 'rgba(255,255,255,0.18)',
      black:   '#1d1f21', red:     '#cc6666', green:   '#b5bd68', yellow:  '#f0c674',
      blue:    '#81a2be', magenta: '#b294bb', cyan:    '#8abeb7', white:   '#c5c8c6',
      brightBlack:   '#666666', brightRed:     '#d54e53', brightGreen:   '#b9ca4a',
      brightYellow:  '#e7c547', brightBlue:    '#7aa6da', brightMagenta: '#c397d8',
      brightCyan:    '#70c0b1', brightWhite:   '#eaeaea',
    },
    light: {
      background:          '#fdf6e3',
      foreground:          '#586e75',
      cursor:              '#cb4b16',
      cursorAccent:        '#fdf6e3',
      selectionBackground: 'rgba(0,0,0,0.12)',
      black:   '#073642', red:     '#dc322f', green:   '#859900', yellow:  '#b58900',
      blue:    '#268bd2', magenta: '#d33682', cyan:    '#2aa198', white:   '#eee8d5',
      brightBlack:   '#586e75', brightRed:     '#cb4b16', brightGreen:   '#586e75',
      brightYellow:  '#657b83', brightBlue:    '#839496', brightMagenta: '#6c71c4',
      brightCyan:    '#93a1a1', brightWhite:   '#fdf6e3',
    },
  };
  const TERM_THEME_KEY = 'clawdoc:termTheme';

  const chat = {
    open: false,
    xterm: null,
    fit: null,
    ws: null,
    ro: null,
    initialized: false,
    // Workspace name (top-level segment of state paths) that the live PTY is
    // cwd'd into. Used to decide whether an @path insertion will resolve.
    sessionWorkspace: '',
    // Set to true to send the current doc as `@path ` on the next connect
    // (used by first-open auto-prefill and by user-driven inserts).
    pendingInsert: '',
    theme: (() => {
      try {
        const v = localStorage.getItem(TERM_THEME_KEY);
        return v === 'light' ? 'light' : 'dark';
      } catch { return 'dark'; }
    })(),
  };

  // Splits "Business/Products/foo.md" → { workspace:"Business", rel:"Products/foo.md" }
  function splitWorkspacePath(p) {
    if (!p) return { workspace: '', rel: '' };
    const i = p.indexOf('/');
    if (i < 0) return { workspace: p, rel: '' };
    return { workspace: p.slice(0, i), rel: p.slice(i + 1) };
  }

  // Path the terminal can reference. Returns null if no doc/folder is selected
  // or the current selection's workspace doesn't match the live PTY session.
  function currentInsertablePath() {
    const full = state.currentDoc ? state.currentDoc.path
               : state.currentFolder ? state.currentFolder
               : '';
    if (!full) return null;
    const { workspace, rel } = splitWorkspacePath(full);
    if (!chat.sessionWorkspace || workspace !== chat.sessionWorkspace) return null;
    return rel || '.';
  }

  function insertCurrentPathIntoTerminal() {
    const rel = currentInsertablePath();
    if (!rel) return;
    if (!chat.ws || chat.ws.readyState !== 1) return;
    chat.ws.send(JSON.stringify({ t: 'in', d: '@' + rel + ' ' }));
    chat.xterm && chat.xterm.focus();
  }

  function applyTermTheme(name) {
    chat.theme = (name === 'light') ? 'light' : 'dark';
    try { localStorage.setItem(TERM_THEME_KEY, chat.theme); } catch {}
    const panel = $('#chat-panel');
    if (panel) panel.setAttribute('data-term-theme', chat.theme);
    if (chat.xterm) {
      chat.xterm.options.theme = TERM_THEMES[chat.theme];
    }
  }

  function toggleTermTheme() {
    applyTermTheme(chat.theme === 'dark' ? 'light' : 'dark');
  }

  function setChatStatus(msg, kind) {
    const s = $('#chat-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'chat-status' + (kind ? ' ' + kind : '');
  }

  function updateChatContext() {
    const ctx = $('#chat-context');
    const insertBtn = $('#chat-insert');
    if (!ctx) return;
    const full = state.currentDoc ? state.currentDoc.path
               : state.currentFolder ? state.currentFolder
               : '';
    if (!full) {
      ctx.textContent = '';
      ctx.removeAttribute('data-insertable');
      ctx.removeAttribute('title');
      if (insertBtn) {
        insertBtn.disabled = true;
        insertBtn.title = 'Select a file or folder in the tree to insert its path';
      }
      return;
    }
    const { workspace, rel } = splitWorkspacePath(full);
    const isFolder = !state.currentDoc;
    const showRel = (rel || '.') + (isFolder ? '/' : '');
    const matches = chat.sessionWorkspace && workspace === chat.sessionWorkspace;
    if (matches) {
      ctx.textContent = '@' + showRel;
      ctx.setAttribute('data-insertable', '1');
      ctx.title = 'Click to insert “@' + showRel + '” into the prompt';
      if (insertBtn) {
        insertBtn.disabled = false;
        insertBtn.title = 'Insert “@' + showRel + '” at the cursor';
      }
    } else {
      ctx.textContent = full + (isFolder ? '/' : '');
      ctx.removeAttribute('data-insertable');
      ctx.title = chat.sessionWorkspace
        ? `In workspace "${workspace}", but the terminal is rooted in "${chat.sessionWorkspace}". Restart to switch.`
        : full;
      if (insertBtn) {
        insertBtn.disabled = true;
        insertBtn.title = chat.sessionWorkspace
          ? `Selection is in "${workspace}" but the terminal is rooted in "${chat.sessionWorkspace}". Restart Claude to switch workspace.`
          : 'Open a Claude session first';
      }
    }
  }

  function ensureTerminal() {
    if (chat.initialized) return;
    if (!window.Terminal || !window.FitAddon) {
      setChatStatus('xterm failed to load', 'error');
      return;
    }
    chat.initialized = true;

    const host = $('#terminal');
    chat.xterm = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "JetBrains Mono", "Fira Code", "SF Mono", Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      scrollback: 8000,
      allowProposedApi: true,
      theme: TERM_THEMES[chat.theme],
    });
    chat.fit = new window.FitAddon.FitAddon();
    chat.xterm.loadAddon(chat.fit);
    if (window.WebLinksAddon) {
      try { chat.xterm.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch {}
    }
    chat.xterm.open(host);
    try { chat.fit.fit(); } catch {}

    chat.ro = new ResizeObserver(() => {
      if (!chat.open) return;
      try { chat.fit.fit(); } catch {}
      sendResize();
    });
    chat.ro.observe(host);

    chat.xterm.onData((d) => {
      if (chat.ws && chat.ws.readyState === 1) {
        chat.ws.send(JSON.stringify({ t: 'in', d }));
      }
    });

    connectTerminal();
  }

  function connectTerminal() {
    if (chat.ws && chat.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = new URLSearchParams();
    if (state.currentDoc) params.set('docPath', state.currentDoc.path);
    else if (state.currentFolder) params.set('folderPath', state.currentFolder);
    if (chat.xterm) {
      params.set('cols', String(chat.xterm.cols));
      params.set('rows', String(chat.xterm.rows));
    }

    // Remember which workspace the PTY is rooted in so the context label can
    // tell us whether `@path` will actually resolve against its cwd.
    const sel = state.currentDoc ? state.currentDoc.path
              : state.currentFolder ? state.currentFolder
              : '';
    const ws_name = splitWorkspacePath(sel).workspace
              || (state.index && state.index.roots && state.index.roots[0] && state.index.roots[0].name)
              || '';
    chat.sessionWorkspace = ws_name;
    updateChatContext();

    const ws = new WebSocket(proto + location.host + '/terminal?' + params.toString());
    chat.ws = ws;
    setChatStatus('connecting…');

    ws.onopen = () => {
      setChatStatus('connected');
      try { chat.fit.fit(); } catch {}
      sendResize();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'out') {
        chat.xterm.write(msg.d);
      } else if (msg.t === 'exit') {
        const code = msg.code == null ? '?' : msg.code;
        chat.xterm.write(`\r\n\x1b[2m[claude exited (code ${code})]\x1b[0m\r\n`);
        setChatStatus('session ended — click Restart');
      } else if (msg.t === 'error') {
        chat.xterm.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
        setChatStatus('failed', 'error');
      }
    };
    ws.onclose = () => {
      if (chat.ws === ws) setChatStatus('disconnected');
    };
    ws.onerror = () => setChatStatus('connection error', 'error');
  }

  function sendResize() {
    if (!chat.ws || chat.ws.readyState !== 1 || !chat.xterm) return;
    chat.ws.send(JSON.stringify({
      t: 'resize',
      cols: chat.xterm.cols,
      rows: chat.xterm.rows,
    }));
  }

  function openChat() {
    chat.open = true;
    $('#chat-panel').classList.remove('hidden');
    $('#chat-toggle').classList.add('active');
    updateChatContext();
    // Defer init until the panel is laid out so fit() gets real dimensions.
    requestAnimationFrame(() => {
      ensureTerminal();
      try { chat.fit && chat.fit.fit(); } catch {}
      sendResize();
      chat.xterm && chat.xterm.focus();
    });
  }
  function closeChat() {
    chat.open = false;
    $('#chat-panel').classList.add('hidden');
    $('#chat-toggle').classList.remove('active');
  }
  function toggleChat() { chat.open ? closeChat() : openChat(); }

  function restartChat() {
    if (chat.ws) {
      try { chat.ws.close(); } catch {}
    }
    if (chat.xterm) chat.xterm.reset();
    setChatStatus('restarting…');
    connectTerminal();
    setTimeout(() => chat.xterm && chat.xterm.focus(), 0);
  }

  function isTerminalFocused() {
    const host = $('#terminal');
    return host && host.contains(document.activeElement);
  }

  function initChatResize() {
    const handle = $('#chat-resizer');
    const panel = $('#chat-panel');
    if (!handle || !panel) return;
    let startX = 0, startW = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const w = Math.max(380, Math.min(window.innerWidth - 200, startW + dx));
      panel.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      try { chat.fit && chat.fit.fit(); } catch {}
      sendResize();
    });
  }

  // ---------- rich Claude client (#agent-panel) ----------
  // A structured front-end over `claude` in stream-json mode (server: /agent).
  // Independent of the PTY panel (`chat`) above — both can be open at once so
  // the two can be compared. Event shapes: docs/roadmap/stream-json-notes.md.
  const AGENT_THEME_KEY = 'clawdoc:agentTheme';
  const MODE_LABELS = {
    acceptEdits: 'Edit automatically',
    default: 'Ask before edits',
    plan: 'Plan mode',
    bypassPermissions: 'Auto (no prompts)',
  };
  const agent = {
    open: false,
    ws: null,
    initialized: false,
    sessionWorkspace: '',  // top-level workspace name the session is rooted in
    sessionId: '',         // captured from system/init, used for --resume
    model: '',             // captured from system/init, shown in the ready status
    cwd: '',               // absolute cwd reported by the server (for path links)
    running: false,        // a turn is in flight
    // Default to auto-accepting edits so the common "make me a file" case works.
    // (The installed CLI has no headless permission-prompt mechanism, so the
    // "Ask before edits" / default mode can't show a prompt — it just denies.)
    mode: 'acceptEdits',
    activeAssistant: null, // current streaming assistant .msg-body element
    activeText: '',        // accumulated markdown for the active assistant block
    toolCards: {},         // tool_use id -> { card, result }
    queued: '',            // message typed while a turn was running
    working: null,         // the "Claude is working…" indicator element
    allowedTools: [],      // tools the user approved after a block (--allowedTools)
    lastUserText: '',      // last message sent, for one-click retry after approval
    theme: (() => {
      try { return localStorage.getItem(AGENT_THEME_KEY) === 'dark' ? 'dark' : 'light'; }
      catch { return 'light'; }
    })(),
  };

  const agLog = () => $('#agent-log');

  function agNearBottom() {
    const l = agLog();
    return l && (l.scrollHeight - l.scrollTop - l.clientHeight < 80);
  }
  function agScroll(force) {
    const l = agLog();
    if (l && (force || agNearBottom())) l.scrollTop = l.scrollHeight;
  }
  function agClear() {
    const l = agLog();
    if (l) l.innerHTML = '<div class="agent-empty">Structured Claude session. Type below to start. '
      + 'This is the rich client — the <code>Claude</code> button is the PTY terminal.</div>';
    agent.activeAssistant = null;
    agent.activeText = '';
    agent.toolCards = {};
  }
  function agClearEmpty() {
    const e = agLog() && agLog().querySelector('.agent-empty');
    if (e) e.remove();
  }
  function agAppend(node) {
    const stick = agNearBottom();
    agClearEmpty();
    agLog().appendChild(node);
    agBumpWorking();   // keep the "working…" row at the very bottom
    agScroll(stick);
  }

  function setAgentStatus(msg, kind) {
    const s = $('#agent-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'chat-status' + (kind ? ' ' + kind : '');
  }

  // Render markdown into a .msg-body and turn workspace file paths into links.
  function agMarkdownBody(text) {
    const body = el('div', { class: 'msg-body' });
    try { body.innerHTML = window.marked.parse(text || '', { gfm: true, breaks: false, mangle: false, headerIds: false }); }
    catch { body.textContent = text || ''; }
    linkifyPaths(body);
    return body;
  }

  // Resolve a path token from Claude's output to an index doc path, or null.
  function agResolveDoc(token) {
    let p = token;
    if (agent.cwd && p.startsWith(agent.cwd + '/')) p = p.slice(agent.cwd.length + 1);
    else if (p.startsWith('/')) return null;            // absolute, outside cwd
    const full = (agent.sessionWorkspace ? agent.sessionWorkspace + '/' : '') + p.replace(/^\.\//, '');
    return state.docsByPath.has(full) ? full : null;
  }

  const PATH_RE = /((?:[\w.\-]+\/)*[\w.\-]+\.(?:md|markdown|html?|pdf|txt|json|csv|js|ts|css))(?::(\d+))?/g;
  function linkifyPaths(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentNode;
      if (!p) continue;
      const tag = p.nodeName;
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE') continue;
      if (PATH_RE.test(n.nodeValue)) targets.push(n);
      PATH_RE.lastIndex = 0;
    }
    for (const node of targets) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const s = node.nodeValue;
      let m;
      PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(s))) {
        const full = agResolveDoc(m[1]);
        if (!full) continue;
        if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        const a = el('a', { class: 'agent-file-link', title: 'Open in ClawDoc' }, m[0]);
        a.addEventListener('click', (ev) => { ev.preventDefault(); selectDoc(full); });
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last > 0) {
        if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  // ---- tool cards ----
  const TOOL_ICONS = {
    read: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    bash: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    task: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    todo: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.8-.7-.7-2.8z"/>',
  };
  function toolIconKey(name) {
    const n = (name || '').toLowerCase();
    if (n === 'read' || n === 'notebookread') return 'read';
    if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'notebookedit') return 'edit';
    if (n === 'bash' || n === 'bashoutput' || n === 'killshell') return 'bash';
    if (n === 'grep' || n === 'glob') return 'search';
    if (n === 'task' || n === 'agent') return 'task';
    if (n === 'webfetch' || n === 'websearch') return 'web';
    if (n === 'todowrite') return 'todo';
    return 'wrench';
  }
  function toolSummary(name, input) {
    if (!input) return '';
    const n = (name || '').toLowerCase();
    if (input.file_path) return input.file_path;
    if (n === 'bash') return input.command || '';
    if (n === 'grep') return input.pattern || '';
    if (n === 'glob') return input.pattern || '';
    if (n === 'task') return input.description || input.subagent_type || '';
    if (n === 'webfetch') return input.url || '';
    if (n === 'websearch') return input.query || '';
    try { return JSON.stringify(input).slice(0, 120); } catch { return ''; }
  }
  function agToolCard(block) {
    const name = block.name || 'tool';
    const ico = TOOL_ICONS[toolIconKey(name)] || TOOL_ICONS.wrench;
    const card = el('div', { class: 'tool-card running' });
    const head = el('div', { class: 'tool-card-head' }, [
      el('span', { class: 'tool-ico', html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ico + '</svg>' }),
      el('span', { class: 'tool-name' }, name),
      el('span', { class: 'tool-summary' }, toolSummary(name, block.input)),
      el('span', { class: 'tool-chevron', html: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>' }),
    ]);
    const bodyEl = el('div', { class: 'tool-card-body' });
    // For Edit/Write/MultiEdit, the diff IS the readable view — don't also dump
    // the raw input JSON (which duplicated the whole file content and was the
    // unreadable "json blob" in the feedback). For other tools, show a compact
    // input block, collapsed inside the card.
    const diff = agBuildDiff(name, block.input);
    if (diff) {
      const host = el('div', { class: 'tool-diff' });
      bodyEl.appendChild(host);
      try { new window.Diff2HtmlUI(host, diff, { drawFileList: false, matching: 'lines', outputFormat: 'line-by-line' }).draw(); }
      catch { host.remove(); }
    } else {
      let inputStr = '';
      try { inputStr = JSON.stringify(block.input, null, 1); } catch {}
      if (inputStr && inputStr !== '{}') bodyEl.appendChild(el('div', { class: 'tool-input' }, inputStr));
    }
    head.addEventListener('click', () => card.classList.toggle('open'));
    card.appendChild(head);
    card.appendChild(bodyEl);
    // Everything starts collapsed (a clean list of what Claude did); click any
    // card header to expand its diff/result. The chevron signals it's clickable.
    agent.toolCards[block.id] = { card, bodyEl, name };
    agAppend(card);
    agent.activeAssistant = null; // a tool ends the current text bubble
  }
  function agAttachResult(toolUseId, content, isError) {
    const ref = agent.toolCards[toolUseId];
    if (!ref) return;
    ref.card.classList.remove('running');
    if (isError) ref.card.classList.add('error');
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.map(c => (c && c.type === 'text') ? c.text : (typeof c === 'string' ? c : '')).join('\n');
    else if (content != null) { try { text = JSON.stringify(content, null, 1); } catch { text = String(content); } }
    const MAX = 4000;
    const truncated = text.length > MAX;
    const shown = truncated ? text.slice(0, MAX) : text;
    const result = el('div', { class: 'tool-result' + (isError ? ' is-error' : '') });
    const rhead = el('div', { class: 'tool-result-head' }, (isError ? '⚠ result' : 'result') + ' (' + text.split('\n').length + ' lines)');
    const rbody = el('div', { class: 'tool-result-body' }, shown);
    if (truncated) rbody.appendChild(el('div', { class: 'tool-result-more' }, '… ' + (text.length - MAX) + ' more chars truncated'));
    rhead.addEventListener('click', () => result.classList.toggle('open'));
    result.appendChild(rhead);
    result.appendChild(rbody);
    ref.bodyEl.appendChild(result);
  }

  // Build a unified-diff string for Edit/Write so diff2html can render it.
  function agBuildDiff(name, input) {
    const n = (name || '').toLowerCase();
    if (!input) return '';
    const file = input.file_path || 'file';
    const mk = (oldS, newS) => {
      const o = (oldS == null || oldS === '') ? [] : String(oldS).split('\n');
      const nw = (newS == null || newS === '') ? [] : String(newS).split('\n');
      const oStart = o.length ? 1 : 0;
      const nStart = nw.length ? 1 : 0;
      const head = '--- a/' + file + '\n+++ b/' + file +
        '\n@@ -' + oStart + ',' + o.length + ' +' + nStart + ',' + nw.length + ' @@\n';
      const lines = o.map(l => '-' + l).concat(nw.map(l => '+' + l));
      return head + lines.join('\n') + '\n';
    };
    if (n === 'edit') return mk(input.old_string, input.new_string);
    if (n === 'write') return mk('', input.content);
    if (n === 'multiedit' && Array.isArray(input.edits)) {
      return input.edits.map(e => mk(e.old_string, e.new_string)).join('\n');
    }
    return '';
  }

  // ---- thinking + todos ----
  function agThinking(text) {
    if (!text) return;
    const block = el('div', { class: 'thinking-block collapsed' });
    const toggle = el('div', { class: 'tb-toggle' }, '✦ thinking');
    const body = el('div', { class: 'tb-text' }, text);
    toggle.addEventListener('click', () => block.classList.toggle('collapsed'));
    block.appendChild(toggle);
    block.appendChild(body);
    agAppend(block);
    agent.activeAssistant = null;
  }
  function agTodos(input) {
    const todos = (input && input.todos) || [];
    if (!todos.length) return;
    const list = el('div', { class: 'todo-list' }, el('div', { class: 'todo-list-title' }, 'Todos'));
    for (const t of todos) {
      const box = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐';
      list.appendChild(el('div', { class: 'todo-item ' + (t.status || '') }, [
        el('span', { class: 'ti-box' }, box),
        el('span', {}, t.content || ''),
      ]));
    }
    agAppend(list);
    agent.activeAssistant = null;
  }

  // ---- inline permission prompt (M6, defensive — fires only if the CLI asks) ----
  function agPermPrompt(reqId, toolName, input) {
    const box = el('div', { class: 'perm-prompt' });
    box.appendChild(el('div', { class: 'perm-title' }, 'Allow ' + (toolName || 'tool') + '?'));
    let detail = '';
    try { detail = JSON.stringify(input).slice(0, 240); } catch {}
    if (detail) box.appendChild(el('div', { class: 'perm-detail' }, detail));
    const decide = (decision) => {
      if (agent.ws && agent.ws.readyState === 1) {
        agent.ws.send(JSON.stringify({ t: 'permission', requestId: reqId, decision }));
      }
      box.classList.add('answered');
      box.appendChild(el('div', { class: 'perm-detail' }, '→ ' + decision));
    };
    const actions = el('div', { class: 'perm-actions' }, [
      el('button', { class: 'perm-allow', onclick: () => decide('allow') }, 'Allow'),
      el('button', { class: 'perm-deny', onclick: () => decide('deny') }, 'Deny'),
    ]);
    box.appendChild(actions);
    agAppend(box);
  }

  // ---- event dispatch ----
  function agHandleEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) agent.sessionId = ev.session_id;
      if (ev.model) agent.model = ev.model;
      if (ev.permissionMode) agent.mode = ev.permissionMode;
      // We're mid-turn here (init only arrives after the first message), so
      // don't flip the footer to "ready" — agEndTurn shows it when the turn ends.
      return;
    }
    if (ev.type === 'rate_limit_event') return;
    if (ev.type === 'control_request' && ev.request && ev.request.subtype === 'can_use_tool') {
      agPermPrompt(ev.request_id, ev.request.tool_name, ev.request.input);
      return;
    }
    if (ev.type === 'assistant') {
      const blocks = (ev.message && ev.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'thinking') agThinking(b.thinking);
        else if (b.type === 'text') agAssistantText(b.text);
        else if (b.type === 'tool_use') {
          if ((b.name || '').toLowerCase() === 'todowrite') agTodos(b.input);
          else agToolCard(b);
        }
      }
      return;
    }
    if (ev.type === 'user') {
      const blocks = (ev.message && ev.message.content) || [];
      for (const b of blocks) {
        if (b && b.type === 'tool_result') {
          agAttachResult(b.tool_use_id, b.content, b.is_error === true);
        }
      }
      return;
    }
    if (ev.type === 'result') {
      agEndTurn();
      if (ev.session_id) agent.sessionId = ev.session_id;
      const denials = ev.permission_denials || [];
      if (denials.length) agDenialNotice(denials);
      if (ev.is_error) agSystem('Turn ended with an error' + (ev.subtype ? ' (' + ev.subtype + ')' : ''), true);
      return;
    }
  }

  function agAssistantText(text) {
    // Skip empty / whitespace-only text blocks. Claude often emits these between
    // tool calls; rendered, they became tiny empty bubbles — the stack of faint
    // "horizontal lines" in the conversation.
    if (text == null || !String(text).trim()) return;
    // Each assistant text block is a complete chunk; append as its own bubble.
    agent.activeText = text;
    const body = agMarkdownBody(text);
    const msg = el('div', { class: 'msg msg-assistant' }, body);
    agent.activeAssistant = msg;
    agAppend(msg);
  }

  function agSystem(text, isError) {
    agAppend(el('div', { class: 'msg msg-system' + (isError ? ' error' : '') },
      el('div', { class: 'msg-body' }, text)));
  }

  // One clear, actionable card when Claude was blocked from using a tool — this
  // headless panel can't show a live approval prompt, so the tool was denied
  // regardless of mode (acceptEdits only auto-allows edits; things like WebFetch
  // still need approval). The fix is to pre-allow the *specific* tool for this
  // session (--allowedTools) and retry — not to change the edit mode.
  function agDenialNotice(denials) {
    const tools = [...new Set(denials.map(d => d.tool_name).filter(Boolean))];
    if (!tools.length) tools.push('a tool');
    const list = tools.join(', ');
    const many = tools.length > 1;
    const box = el('div', { class: 'perm-prompt' });
    box.appendChild(el('div', { class: 'perm-title' }, '✋ Claude needs permission to use ' + list));
    box.appendChild(el('div', { class: 'perm-detail' },
      'This panel can’t show a live approval prompt, so ' + (many ? 'these tools were' : 'this tool was') +
      ' blocked. Allow ' + (many ? 'them' : 'it') + ' for this session and Claude will retry automatically.'));
    const allowBtn = el('button', { class: 'perm-allow' }, 'Allow ' + list + ' & retry');
    allowBtn.addEventListener('click', () => {
      tools.forEach(t => { if (/^[A-Za-z][A-Za-z0-9_]*$/.test(t) && !agent.allowedTools.includes(t)) agent.allowedTools.push(t); });
      box.classList.add('answered');
      box.appendChild(el('div', { class: 'perm-detail' }, '→ allowed: ' + list + '. Retrying…'));
      // Respawn so --allowedTools takes effect, keeping the session (resume),
      // then re-send the last request so it just continues.
      if (agent.ws) { try { agent.ws.close(); } catch {} }
      agent.ws = null;
      if (agent.lastUserText) agSendText(agent.lastUserText);
    });
    const dismiss = el('button', { class: 'perm-deny' }, 'Not now');
    dismiss.addEventListener('click', () => box.classList.add('answered'));
    box.appendChild(el('div', { class: 'perm-actions' }, [allowBtn, dismiss]));
    agAppend(box);
  }

  // A visible "Claude is working…" row pinned to the bottom of the log while a
  // turn runs, so it's obvious the AI is busy (status text alone was too quiet).
  function agShowWorking() {
    if (agent.working) return;
    agent.working = el('div', { class: 'agent-working' }, [
      el('span', { class: 'aw-dots', html: '<span></span><span></span><span></span>' }),
      el('span', { class: 'aw-label' }, 'Claude is working…'),
    ]);
    agClearEmpty();
    agLog().appendChild(agent.working);
    agScroll(true);
  }
  function agHideWorking() {
    if (agent.working) { agent.working.remove(); agent.working = null; }
  }
  // Keep the working row last as new messages stream in.
  function agBumpWorking() {
    if (agent.working && agent.working.parentNode) agLog().appendChild(agent.working);
  }

  function agStartTurn() {
    agent.running = true;
    agent.stopping = false;
    const btn = $('#agent-submit');
    btn.classList.add('is-running');
    btn.title = 'Stop (interrupt the current turn)';
    setAgentStatus('working…', 'run');
    agShowWorking();
  }
  function agEndTurn() {
    agent.running = false;
    agHideWorking();
    const btn = $('#agent-submit');
    btn.classList.remove('is-running');
    btn.title = 'Send (Enter)';
    const pm = agent.mode;
    setAgentStatus('ready · ' + (agent.model || '') + ' · ' + (MODE_LABELS[pm] || pm));
    if (agent.queued) {
      const q = agent.queued;
      agent.queued = '';
      agSendText(q);
    }
  }

  // ---- transport ----
  function connectAgent() {
    if (agent.ws && agent.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = new URLSearchParams();
    if (state.currentDoc) params.set('docPath', state.currentDoc.path);
    else if (state.currentFolder) params.set('folderPath', state.currentFolder);
    params.set('mode', agent.mode);
    if (agent.sessionId) params.set('resume', agent.sessionId);
    if (agent.allowedTools.length) params.set('allow', agent.allowedTools.join(','));

    const sel = state.currentDoc ? state.currentDoc.path
              : state.currentFolder ? state.currentFolder : '';
    agent.sessionWorkspace = splitWorkspacePath(sel).workspace
      || (state.index && state.index.roots && state.index.roots[0] && state.index.roots[0].name) || '';
    updateAgentContext();

    const ws = new WebSocket(proto + location.host + '/agent?' + params.toString());
    agent.ws = ws;
    setAgentStatus('connecting…');
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'started') { agent.cwd = m.cwd || ''; if (!agent.running) setAgentStatus('connecting…'); }
      else if (m.t === 'event') agHandleEvent(m.ev);
      else if (m.t === 'error') { agSystem(m.message, true); agEndTurn(); }
      else if (m.t === 'exit') {
        if (agent.stopping) {
          agent.stopping = false;
          agSystem('Stopped. Send another message to continue.');
        } else {
          agSystem('Session ended (code ' + (m.code == null ? '?' : m.code) + '). Send a message to resume, or click Restart.', m.code !== 0 && m.code != null);
        }
        agEndTurn(); setAgentStatus('ready');
      }
    };
    ws.onclose = () => { if (agent.ws === ws) { agent.ws = null; if (agent.running) agEndTurn(); } };
    ws.onerror = () => setAgentStatus('connection error', 'error');
  }

  function agSendText(text) {
    const t = (text || '').trim();
    if (!t) return;
    agent.lastUserText = t;
    if (!agent.ws || agent.ws.readyState !== 1) connectAgent();
    // If still connecting, wait until open.
    const fire = () => {
      agent.ws.send(JSON.stringify({ t: 'input', text: t }));
      agAppend(el('div', { class: 'msg msg-user' }, el('div', { class: 'msg-body' }, t)));
      agStartTurn();
    };
    if (agent.ws.readyState === 1) fire();
    else agent.ws.addEventListener('open', fire, { once: true });
  }

  function agSendFromComposer() {
    const ta = $('#agent-input');
    const text = ta.value;
    if (!text.trim()) return;
    ta.value = '';
    autoGrowAgentInput();
    if (agent.running) {
      // queue (replace) the next turn until the current one finishes
      agent.queued = (agent.queued ? agent.queued + '\n' : '') + text.trim();
      setAgentStatus('queued — will send after this turn', 'run');
      agAppend(el('div', { class: 'msg msg-user' }, el('div', { class: 'msg-body' }, text.trim())));
      return;
    }
    agSendText(text);
  }

  function agStop() {
    agent.stopping = true;   // so the resulting exit reads as a deliberate stop
    if (agent.ws && agent.ws.readyState === 1) agent.ws.send(JSON.stringify({ t: 'interrupt' }));
    setAgentStatus('stopping…', 'run');
  }

  const AGENT_INPUT_MAX = 160;
  function autoGrowAgentInput() {
    const ta = $('#agent-input');
    if (!ta) return;
    ta.style.height = 'auto';
    const needed = ta.scrollHeight;
    ta.style.height = Math.min(AGENT_INPUT_MAX, needed) + 'px';
    // Only show the scrollbar once the content actually exceeds the max height;
    // while it's still growing the bar is useless and just clutters the box.
    ta.style.overflowY = needed > AGENT_INPUT_MAX ? 'auto' : 'hidden';
  }

  // ---- context / @-insert ----
  // The session can access every mounted workspace (server adds --add-dir for
  // all roots), so any selected file is insertable: a path relative to the
  // session's cwd root when it lives there, an absolute path otherwise.
  function rootAbsPath(workspaceName) {
    const roots = (state.index && state.index.roots) || [];
    const r = roots.find(x => x.name === workspaceName);
    return r ? r.path : '';
  }
  // Returns { insert, display } for the current selection, or null if nothing
  // is selected / the path can't be resolved.
  function agentInsertInfo() {
    const full = state.currentDoc ? state.currentDoc.path
               : state.currentFolder ? state.currentFolder : '';
    if (!full) return null;
    const { workspace, rel } = splitWorkspacePath(full);
    const isFolder = !state.currentDoc;
    const slash = isFolder ? '/' : '';
    if (agent.sessionWorkspace && workspace === agent.sessionWorkspace) {
      const r = rel || '.';
      return { insert: r, display: r + slash };
    }
    const abs = rootAbsPath(workspace);
    if (!abs) return null;
    const p = rel ? abs + '/' + rel : abs;
    return { insert: p, display: p + slash };
  }
  function updateAgentContext() {
    const ctx = $('#agent-context');
    const insertBtn = $('#agent-insert');
    if (!ctx) return;
    const info = agentInsertInfo();
    if (!info) {
      ctx.textContent = '';
      ctx.removeAttribute('data-insertable');
      ctx.removeAttribute('title');
      if (insertBtn) { insertBtn.disabled = true; insertBtn.title = 'Select a file or folder in the tree first'; }
      return;
    }
    ctx.textContent = '@' + info.display;
    ctx.setAttribute('data-insertable', '1');
    ctx.title = 'Click to add “@' + info.display + '” to your message';
    if (insertBtn) { insertBtn.disabled = false; insertBtn.title = 'Add “@' + info.display + '” to your message'; }
  }
  function agentInsertPath() {
    const info = agentInsertInfo();
    if (!info) return;
    const ta = $('#agent-input');
    const ins = '@' + info.insert + ' ';
    ta.value = ta.value + (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + ins;
    ta.focus();
    autoGrowAgentInput();
  }

  // ---- theme ----
  function applyAgentTheme(name) {
    agent.theme = name === 'light' ? 'light' : 'dark';
    try { localStorage.setItem(AGENT_THEME_KEY, agent.theme); } catch {}
    const panel = $('#agent-panel');
    if (panel) panel.setAttribute('data-term-theme', agent.theme);
  }

  // ---- dual-dock bookkeeping ----
  function syncBothClaude() {
    const both = agent.open && chat.open;
    document.body.classList.toggle('both-claude', both);
    if (both) {
      const w = $('#agent-panel').getBoundingClientRect().width;
      document.body.style.setProperty('--agent-w', w + 'px');
    }
  }

  // ---- lifecycle ----
  function ensureAgent() {
    if (agent.initialized) return;
    agent.initialized = true;
    applyAgentTheme(agent.theme);
    agClear();
    // Lazy: don't spawn a claude process just because the panel opened. claude
    // stays silent (no system/init) until the first user message, so connecting
    // early would leave the footer stuck on "starting…". We connect on the
    // first send instead (agSendText -> connectAgent).
    setAgentStatus('idle');
  }
  function openAgent() {
    agent.open = true;
    $('#agent-panel').classList.remove('hidden');
    $('#agent-toggle').classList.add('active');
    updateAgentContext();
    ensureAgent();
    syncBothClaude();
    setTimeout(() => { $('#agent-input') && $('#agent-input').focus(); }, 0);
  }
  function closeAgent() {
    agent.open = false;
    $('#agent-panel').classList.add('hidden');
    $('#agent-toggle').classList.remove('active');
    syncBothClaude();
  }
  function toggleAgent() { agent.open ? closeAgent() : openAgent(); }
  function restartAgent() {
    if (agent.ws) { try { agent.ws.close(); } catch {} }
    agent.ws = null;
    agent.sessionId = '';   // fresh conversation
    agent.running = false;
    agClear();
    // Stay lazy — a fresh process spawns on the next message, not now.
    setAgentStatus('idle');
  }
  function isAgentFocused() {
    const p = $('#agent-panel');
    return p && p.contains(document.activeElement);
  }

  function initAgentResize() {
    const handle = $('#agent-resizer');
    const panel = $('#agent-panel');
    if (!handle || !panel) return;
    let startX = 0, startW = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(380, Math.min(window.innerWidth - 200, startW + (startX - e.clientX)));
      panel.style.width = w + 'px';
      syncBothClaude();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; document.body.style.cursor = '';
      syncBothClaude();
    });
  }

  function initAgent() {
    $('#agent-toggle').addEventListener('click', toggleAgent);
    $('#agent-close').addEventListener('click', closeAgent);
    $('#agent-restart').addEventListener('click', restartAgent);
    $('#agent-theme').addEventListener('click', () => applyAgentTheme(agent.theme === 'dark' ? 'light' : 'dark'));
    $('#agent-submit').addEventListener('click', () => { agent.running ? agStop() : agSendFromComposer(); });
    $('#agent-insert').addEventListener('click', agentInsertPath);
    $('#agent-context').addEventListener('click', () => { if ($('#agent-context').hasAttribute('data-insertable')) agentInsertPath(); });
    const modeSel = $('#agent-mode');
    modeSel.value = agent.mode;
    modeSel.addEventListener('change', () => {
      agent.mode = modeSel.value;
      // mode changes apply on the next session; restart to take effect now
      restartAgent();
    });
    const ta = $('#agent-input');
    ta.addEventListener('input', autoGrowAgentInput);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agSendFromComposer(); }
    });
    initAgentResize();
  }

  // ---------- live reload (SSE from /api/events) ----------
  // Server watches the workspace roots via chokidar; on any change it
  // debounces, reindexes, and emits an `index-changed` event. We refetch
  // the index silently, then decide what to refresh in the viewer.
  const live = {
    es: null,
    retryMs: 1000,
    // Track inflight refetches so two events arriving close together don't
    // double-render the viewer.
    refreshing: false,
  };

  function connectLiveEvents() {
    try {
      const es = new EventSource('/api/events');
      live.es = es;
      es.addEventListener('open', () => { live.retryMs = 1000; });
      es.addEventListener('index-changed', (ev) => handleIndexChanged(ev));
      es.addEventListener('index-error', (ev) => {
        let data; try { data = JSON.parse(ev.data); } catch {}
        console.warn('clawdoc: reindex failed', data);
      });
      es.addEventListener('git-changed', () => { gh.refresh(); });
      es.addEventListener('git-pushed',  () => { gh.refresh(); });
      es.addEventListener('git-error', (ev) => {
        let data; try { data = JSON.parse(ev.data); } catch {}
        console.warn('clawdoc: git error', data);
        gh.refresh();
      });
      es.onerror = () => {
        // EventSource auto-reconnects, but a fast retry loop spams the server
        // if the route disappears (e.g. user upgraded ClawDoc). Back off.
        try { es.close(); } catch {}
        live.es = null;
        live.retryMs = Math.min(live.retryMs * 2, 30000);
        setTimeout(connectLiveEvents, live.retryMs);
      };
    } catch (err) {
      console.warn('clawdoc: live updates unavailable', err);
    }
  }

  async function handleIndexChanged(ev) {
    if (live.refreshing) return;
    live.refreshing = true;
    let data;
    try { data = JSON.parse(ev.data); } catch { data = { paths: [] }; }
    const changedPaths = new Set(data.paths || []);

    // Capture pre-reload state so we can compare and restore scroll.
    const prevDoc = state.currentDoc;
    const prevFolder = state.currentFolder;
    const editingDoc = state.editor && state.editorDoc;
    const viewer = $('#viewer');
    const scrollTop = viewer ? viewer.scrollTop : 0;

    try {
      await loadIndex({ silent: true });
    } catch (err) {
      console.warn('clawdoc: silent reindex load failed', err);
      live.refreshing = false;
      return;
    }

    // Drain any queued follow-ups (e.g. post-rename navigation). They run
    // against the freshly loaded index and may short-circuit the rest of the
    // handler when they navigate.
    if (typeof reindexFollowups !== 'undefined' && reindexFollowups.length) {
      const queue = reindexFollowups.splice(0);
      for (const fn of queue) {
        try { fn(); } catch (err) { console.warn('reindex follow-up failed', err); }
      }
    }

    // --- editor is open: never blow away unsaved work ---
    if (editingDoc) {
      const fresh = state.docsByPath.get(editingDoc.path);
      const stillExists = !!fresh;
      // The watcher fires for *every* write, including our own save. To avoid
      // flagging the user's own save as a foreign change, compare the freshly
      // indexed mtime against editingDoc.mtime (which doSave bumped to the
      // mtime the server returned). Equal → it was our write; skip the banner.
      const wasTouched = stillExists
        && changedPaths.has(editingDoc.path)
        && fresh.mtime !== editingDoc.mtime;
      if (!stillExists) {
        showEditorStaleBanner({ deleted: true });
      } else if (wasTouched) {
        showEditorStaleBanner({ deleted: false });
      }
      live.refreshing = false;
      return;
    }

    // --- viewing a doc ---
    if (prevDoc) {
      const stillExists = state.docsByPath.get(prevDoc.path);
      if (!stillExists) {
        renderEmpty(
          'This document was removed or renamed on disk.<br>' +
          '<code>' + escapeHtml(prevDoc.path) + '</code>'
        );
        state.currentDoc = null;
        live.refreshing = false;
        return;
      }
      // If the current doc is in the changed set, re-render with cache-bust.
      // We also re-render if any sibling changed (folder listing affected).
      if (changedPaths.has(prevDoc.path)) {
        // Use the fresh doc object from the new index (mtime/size up to date).
        state.currentDoc = stillExists;
        await renderDoc(stillExists, '', { reload: true });
        // Restore approximate scroll position so the user doesn't lose place.
        if (viewer) viewer.scrollTop = scrollTop;
      }
      live.refreshing = false;
      return;
    }

    // --- viewing a folder listing ---
    if (prevFolder !== undefined && prevFolder !== null) {
      // Always re-render the folder — adds/removes in it are common.
      try { renderFolder(prevFolder); } catch {}
      if (viewer) viewer.scrollTop = scrollTop;
    }

    live.refreshing = false;
  }

  function showEditorStaleBanner(opts) {
    // Replace any existing banner before adding a new one.
    const wrap = document.querySelector('.doc-edit');
    if (!wrap) return;
    const existing = wrap.querySelector('.doc-edit-stale');
    if (existing) existing.remove();

    const banner = el('div', { class: 'doc-edit-stale' + (opts.deleted ? ' deleted' : '') });
    const msg = el('span', { class: 'doc-edit-stale-msg' },
      opts.deleted
        ? 'This file was deleted on disk. Your unsaved changes are still here.'
        : 'This file changed on disk while you were editing.'
    );
    banner.appendChild(msg);

    const actions = el('div', { class: 'doc-edit-stale-actions' });
    if (!opts.deleted) {
      const reloadBtn = el('button', { class: 'doc-edit-stale-reload' }, 'Reload from disk');
      reloadBtn.addEventListener('click', () => {
        if (!confirm('Discard your unsaved edits and reload from disk?')) return;
        const doc = state.editorDoc;
        if (!doc) return;
        destroyEditor();
        const fresh = state.docsByPath.get(doc.path) || doc;
        // Re-open the editor on the fresh content.
        startEditing(fresh);
      });
      actions.appendChild(reloadBtn);
    }
    const keepBtn = el('button', { class: 'doc-edit-stale-keep' }, opts.deleted ? 'Keep' : 'Keep my edits');
    keepBtn.addEventListener('click', () => banner.remove());
    actions.appendChild(keepBtn);
    banner.appendChild(actions);

    // Insert under the toolbar.
    const bar = wrap.querySelector('.doc-edit-bar');
    if (bar && bar.nextSibling) wrap.insertBefore(banner, bar.nextSibling);
    else wrap.insertBefore(banner, wrap.firstChild);
  }

  // ---------- two-pane "midnight commander" mode ----------
  // Two independent file trees side by side, with drag-and-drop to move
  // files/folders between them. Each pane has its own expanded set + filter;
  // both panes are rebuilt from the same state.tree on every reindex/SSE
  // event. Drop targets are folder rows only (and the pane background, which
  // maps to the source workspace's root).

  function persistMcPanes() {
    try {
      localStorage.setItem('clawdoc.mcPanes', JSON.stringify({
        a: {
          expanded: Array.from(state.mcPanes.a.expanded),
          focused: state.mcPanes.a.focused || '',
          filter:  state.mcPanes.a.filter || '',
        },
        b: {
          expanded: Array.from(state.mcPanes.b.expanded),
          focused: state.mcPanes.b.focused || '',
          filter:  state.mcPanes.b.filter || '',
        },
      }));
      localStorage.setItem('clawdoc.mcLastFocusedPane', state.mcLastFocusedPane || 'a');
    } catch {}
  }

  // Track which row got the most recent click so spacebar knows which file
  // to preview when both panes have something focused.
  function setMcFocus(paneId, prefixedPath) {
    state.mcPanes[paneId].focused = prefixedPath;
    state.mcLastFocusedPane = paneId;
    persistMcPanes();
  }

  function applyMcMode() {
    document.body.classList.toggle('mc-on', !!state.mcMode);
    const btn = $('#mc-toggle');
    if (btn) btn.classList.toggle('active', !!state.mcMode);
    const panel = $('#mc-mode');
    if (panel) panel.classList.toggle('hidden', !state.mcMode);
    if (state.mcMode) renderMcMode();
  }

  function enterMcMode() {
    state.mcMode = true;
    try { localStorage.setItem('clawdoc.mcMode', '1'); } catch {}
    applyMcMode();
  }
  function exitMcMode() {
    state.mcMode = false;
    try { localStorage.setItem('clawdoc.mcMode', '0'); } catch {}
    applyMcMode();
  }
  function toggleMcMode() { state.mcMode ? exitMcMode() : enterMcMode(); }

  function renderMcMode() {
    if (!state.tree) return; // index not loaded yet
    renderMcPane('a');
    renderMcPane('b');
  }

  function renderMcPane(paneId) {
    const treeEl = document.querySelector(`[data-pane-tree="${paneId}"]`);
    if (!treeEl) return;
    treeEl.innerHTML = '';
    const pane = state.mcPanes[paneId];
    // Reflect the persisted filter into the input on first render.
    const filterInput = document.querySelector(`[data-pane-filter="${paneId}"]`);
    if (filterInput && filterInput.value !== (pane.filter || '')) {
      filterInput.value = pane.filter || '';
    }
    const filter = (pane.filter || '').trim().toLowerCase();
    // Drop target for the pane background = the source workspace's root.
    // We can't know the workspace at drop-time without inspecting the drag
    // payload, so we set destFolder to '' and let the server resolve it
    // against the source's workspace.
    attachMcDrop(treeEl, '');

    for (const child of sortedChildren(state.tree)) {
      const n = renderMcFolderNode(child, 0, paneId, filter);
      if (n) treeEl.appendChild(n);
    }
    // Root-level docs (rare in this codebase but handle them)
    for (const d of sortedTreeDocs(state.tree)) {
      const dn = renderMcDocNode(d, 0, paneId, filter);
      if (dn) treeEl.appendChild(dn);
    }
  }

  function mcFolderHasMatch(node, filter) {
    if (!filter) return true;
    if (node.name.toLowerCase().includes(filter)) return true;
    for (const d of node.docs) {
      if (d.name.toLowerCase().includes(filter)
        || (d.title && d.title.toLowerCase().includes(filter))) return true;
    }
    for (const ch of node.children.values()) {
      if (mcFolderHasMatch(ch, filter)) return true;
    }
    return false;
  }

  function renderMcFolderNode(node, depth, paneId, filter) {
    if (filter && !mcFolderHasMatch(node, filter)) return null;
    const pane = state.mcPanes[paneId];
    const hasContent = node.children.size > 0 || node.docs.length > 0;
    const isExpanded = pane.expanded.has(node.path) || !!filter;
    const isFocused = pane.focused === node.path;

    const tnode = el('div', { class: 'mctnode' + (isExpanded ? '' : ' collapsed') });
    const chev = el('span', { class: 'tchev', html: ICON_CHEVRON });
    const icon = el('span', { class: 'ticon', html: isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER });
    const name = el('span', { class: 'tname' }, node.name);
    const row = el('div', {
      class: 'mctrow folder-row' + (isFocused ? ' focused' : ''),
      'data-mc-path': node.path,
      'data-mc-kind': 'folder',
      draggable: node.path.includes('/') ? 'true' : 'false', // don't drag workspace roots
    }, [chev, icon, name]);

    row.addEventListener('click', () => {
      // Focus this folder (cheap row-class update, no full re-render).
      setMcFocus(paneId, node.path);
      document.querySelectorAll(`[data-pane-tree="${paneId}"] .mctrow.focused`)
        .forEach(r => r.classList.remove('focused'));
      row.classList.add('focused');
      // Single click also toggles expansion for non-empty folders — matches
      // the main tree's behavior.
      if (hasContent) toggleMcNode(paneId, node.path);
    });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      setMcFocus(paneId, node.path);
      showFolderContextMenu(node, ev.clientX, ev.clientY);
    });

    attachMcDrag(row, node.path);
    attachMcDrop(row, node.path);

    tnode.appendChild(row);

    if (hasContent && isExpanded) {
      const children = el('div', { class: 'mctchildren' });
      for (const ch of sortedChildren(node)) {
        const cn = renderMcFolderNode(ch, depth + 1, paneId, filter);
        if (cn) children.appendChild(cn);
      }
      for (const d of sortedTreeDocs(node)) {
        const dn = renderMcDocNode(d, depth + 1, paneId, filter);
        if (dn) children.appendChild(dn);
      }
      tnode.appendChild(children);
    }
    return tnode;
  }

  function renderMcDocNode(doc, depth, paneId, filter) {
    if (filter && !docFilterMatches(doc, filter)) return null;
    const isFocused = state.mcPanes[paneId].focused === doc.path;
    const tnode = el('div', { class: 'mctnode leaf' });
    const chev = el('span', { class: 'tchev', html: ICON_CHEVRON });
    const icon = el('span', { class: 'ticon', html: docIcon(doc) });
    const displayText = state.treeShowFilenames ? doc.name : (doc.title || doc.name);
    const name = el('span', { class: 'tname' }, displayText);
    const row = el('div', {
      class: 'mctrow doc-row ' + docKindClass(doc) + (isFocused ? ' focused' : ''),
      title: docTooltip(doc),
      'data-mc-path': doc.path,
      'data-mc-kind': 'file',
      draggable: 'true',
    }, [chev, icon, name]);

    row.addEventListener('click', () => {
      setMcFocus(paneId, doc.path);
      // Cheap visual update — just toggle classes within this pane rather
      // than re-rendering the whole tree.
      document.querySelectorAll(`[data-pane-tree="${paneId}"] .mctrow.focused`)
        .forEach(r => r.classList.remove('focused'));
      row.classList.add('focused');
    });
    row.addEventListener('dblclick', () => {
      exitMcMode();
      selectDoc(doc.path);
    });
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      // Right-click also focuses, so spacebar after dismissing the menu
      // previews the file the user just gestured at.
      setMcFocus(paneId, doc.path);
      showDocContextMenu(doc, ev.clientX, ev.clientY);
    });

    attachMcDrag(row, doc.path);

    tnode.appendChild(row);
    return tnode;
  }

  function toggleMcNode(paneId, folderPath) {
    const pane = state.mcPanes[paneId];
    if (pane.expanded.has(folderPath)) pane.expanded.delete(folderPath);
    else pane.expanded.add(folderPath);
    persistMcPanes();
    renderMcPane(paneId);
  }

  function expandAllInMcPane(paneId) {
    const pane = state.mcPanes[paneId];
    // Every folder in the index becomes expanded; matches main-tree behavior.
    pane.expanded = new Set(state.nodesByPath ? state.nodesByPath.keys() : ['']);
    persistMcPanes();
    renderMcPane(paneId);
  }

  function collapseAllInMcPane(paneId) {
    const pane = state.mcPanes[paneId];
    // Keep just the virtual root entry so workspace roots remain at top level
    // (collapsed, but visible) — matches the main tree's collapse-all.
    pane.expanded = new Set(['']);
    persistMcPanes();
    renderMcPane(paneId);
  }

  // ---- drag and drop wiring ----
  // Use a single in-memory drag payload alongside dataTransfer so we can
  // refuse cross-workspace drops at hover time (the path tells us the
  // workspace via its first segment).
  let mcDragPath = '';

  function attachMcDrag(row, prefixedPath) {
    if (row.getAttribute('draggable') === 'false') return;
    row.addEventListener('dragstart', (ev) => {
      mcDragPath = prefixedPath;
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/x-clawdoc-path', prefixedPath); } catch {}
      // Plain-text fallback for browsers that don't accept the custom type.
      try { ev.dataTransfer.setData('text/plain', prefixedPath); } catch {}
      row.classList.add('mc-dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('mc-dragging');
      mcDragPath = '';
      // Clear any leftover drop highlights.
      document.querySelectorAll('.mc-drop-ok, .mc-drop-bad').forEach(e =>
        e.classList.remove('mc-drop-ok', 'mc-drop-bad'));
    });
  }

  function dropWorkspace(p) { return p ? p.split('/')[0] : ''; }
  // True if dropping `src` onto `destFolder` looks valid client-side. We still
  // let the server have final say.
  function mcDropAcceptable(src, destFolder) {
    if (!src) return false;
    if (src === destFolder) return false;
    // Don't drop into your own parent (no-op).
    const lastSlash = src.lastIndexOf('/');
    const srcParent = lastSlash > 0 ? src.slice(0, lastSlash) : '';
    if (srcParent === destFolder) return false;
    // Don't drop a folder into itself or a descendant.
    if (destFolder === src) return false;
    if (destFolder.startsWith(src + '/')) return false;
    return true;
  }

  function attachMcDrop(el, destFolderPath) {
    el.addEventListener('dragover', (ev) => {
      if (!mcDragPath) return;
      // For the blank pane background, dest = '' which resolves server-side
      // to the source's workspace root — accept those without checking.
      const ok = destFolderPath === ''
        ? !!mcDragPath
        : mcDropAcceptable(mcDragPath, destFolderPath);
      if (!ok) {
        ev.dataTransfer.dropEffect = 'none';
        el.classList.add('mc-drop-bad');
        el.classList.remove('mc-drop-ok');
        return;
      }
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      el.classList.add('mc-drop-ok');
      el.classList.remove('mc-drop-bad');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('mc-drop-ok', 'mc-drop-bad');
    });
    el.addEventListener('drop', (ev) => {
      el.classList.remove('mc-drop-ok', 'mc-drop-bad');
      ev.preventDefault();
      ev.stopPropagation();
      const src = mcDragPath
        || ev.dataTransfer.getData('text/x-clawdoc-path')
        || ev.dataTransfer.getData('text/plain');
      if (!src) return;
      if (destFolderPath !== '' && !mcDropAcceptable(src, destFolderPath)) return;
      mcMove(src, destFolderPath);
    });
  }

  // ---------- file preview (Quick-Look-style modal) ----------
  // Reachable from the doc context menu (always) and from spacebar in MC mode
  // (acts on the currently focused file in the last-focused pane). Renders
  // markdown via marked, HTML in a sandboxed iframe, PDF via <embed>, and
  // images directly. Closes on Esc, click backdrop, or spacebar (toggle).
  const preview = { open: false, currentPath: '' };

  function previewIsOpen() { return preview.open; }

  function closePreview() {
    if (!preview.open) return;
    preview.open = false;
    preview.currentPath = '';
    const modal = $('#preview-modal');
    if (modal) modal.classList.add('hidden');
    const body = $('#preview-body');
    if (body) body.innerHTML = ''; // unmount any iframe/embed so it stops loading
  }

  async function previewDoc(doc) {
    if (!doc) return;
    preview.open = true;
    preview.currentPath = doc.path;
    const modal = $('#preview-modal');
    const title = $('#preview-title');
    const sub = $('#preview-sub');
    const body = $('#preview-body');
    if (!modal || !body) return;

    title.textContent = doc.title || doc.name;
    const subBits = [];
    if (doc.date) subBits.push(doc.date);
    subBits.push(doc.path);
    subBits.push(formatSize(doc.size));
    sub.textContent = subBits.join('  ·  ');

    body.innerHTML = '<div class="preview-loading">Loading…</div>';
    modal.classList.remove('hidden');

    const ext = (doc.ext || '').toLowerCase();
    const bust = '_ts=' + Date.now();

    if (ext === 'html' || ext === 'htm') {
      const src = '/raw/' + doc.path.split('/').map(encodeURIComponent).join('/') + '?' + bust;
      const iframe = el('iframe', {
        class: 'preview-iframe',
        src,
        sandbox: 'allow-same-origin allow-scripts allow-popups allow-forms allow-modals',
      });
      body.innerHTML = '';
      body.appendChild(iframe);
      return;
    }
    if (ext === 'pdf') {
      const src = '/file?path=' + encodeURIComponent(doc.path) + '&' + bust;
      const embed = el('embed', { class: 'preview-pdf', type: 'application/pdf', src });
      body.innerHTML = '';
      body.appendChild(embed);
      return;
    }
    if (['png','jpg','jpeg','gif','svg','webp'].includes(ext)) {
      const src = '/file?path=' + encodeURIComponent(doc.path) + '&' + bust;
      const img = el('img', { class: 'preview-img', src, alt: doc.name });
      body.innerHTML = '';
      body.appendChild(img);
      return;
    }

    // Default: markdown (and txt / unknown text) — fetch and render.
    try {
      const r = await fetch('/file?path=' + encodeURIComponent(doc.path) + '&' + bust, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const stripped = stripFrontMatter(text);
      const isMd = ext === 'md' || ext === 'markdown' || !ext;
      const wrap = el('div', { class: 'preview-md' });
      if (isMd && window.marked) {
        wrap.innerHTML = window.marked.parse(stripped, {
          gfm: true, breaks: false, headerIds: false, mangle: false,
        });
      } else {
        wrap.appendChild(el('pre', { class: 'preview-pre' }, stripped));
      }
      body.innerHTML = '';
      body.appendChild(wrap);
    } catch (err) {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'preview-error' }, 'Failed to load: ' + err.message));
    }
  }

  // Preview whatever's focused in the last-used pane. Dispatches by type:
  // file → content preview, folder → stats preview. No cross-pane fallback —
  // if the active pane has nothing focused, do nothing (user expects "what's
  // focused = what I see highlighted").
  function previewFocusedMcItem() {
    if (!state.mcMode) return false;
    const paneId = state.mcLastFocusedPane || 'a';
    const focused = state.mcPanes[paneId] && state.mcPanes[paneId].focused;
    if (!focused) return false;
    const doc = state.docsByPath.get(focused);
    if (doc) { previewDoc(doc); return true; }
    const node = state.nodesByPath && state.nodesByPath.get(focused);
    if (node) { previewFolder(node); return true; }
    // Stale path (file/folder was deleted or renamed) — clear it so the next
    // spacebar press doesn't re-trigger the same dead reference.
    state.mcPanes[paneId].focused = '';
    persistMcPanes();
    renderMcPane(paneId);
    return false;
  }

  function toggleMcPreview() {
    if (previewIsOpen()) { closePreview(); return; }
    previewFocusedMcItem();
  }

  // Walk a tree node and roll up totals so the folder preview can show
  // recursive stats. Cheap — runs over already-loaded index data.
  function computeFolderStats(node) {
    let folders = 0, docs = 0, totalSize = 0, latestMtime = 0;
    const byKind = { md: 0, html: 0, pdf: 0, other: 0 };
    const visit = (n) => {
      for (const d of n.docs) {
        docs++;
        totalSize += d.size || 0;
        if (d.mtime && d.mtime > latestMtime) latestMtime = d.mtime;
        const ext = (d.ext || '').toLowerCase();
        if (ext === 'md' || ext === 'markdown') byKind.md++;
        else if (ext === 'html' || ext === 'htm') byKind.html++;
        else if (ext === 'pdf') byKind.pdf++;
        else byKind.other++;
      }
      for (const ch of n.children.values()) {
        folders++;
        visit(ch);
      }
    };
    visit(node);
    return { folders, docs, totalSize, byKind, latestMtime };
  }

  function previewFolder(node) {
    preview.open = true;
    preview.currentPath = node.path;
    const modal = $('#preview-modal');
    const title = $('#preview-title');
    const sub = $('#preview-sub');
    const body = $('#preview-body');
    if (!modal || !body) return;

    title.textContent = node.path || 'Workspace root';
    const stats = computeFolderStats(node);
    const subBits = [
      `${stats.folders} folder${stats.folders === 1 ? '' : 's'}`,
      `${stats.docs} doc${stats.docs === 1 ? '' : 's'}`,
      formatSize(stats.totalSize),
    ];
    if (stats.latestMtime) subBits.push('newest: ' + formatDateTime(stats.latestMtime));
    sub.textContent = subBits.join('  ·  ');

    // Body: a couple of summary rows + direct-children listing.
    body.innerHTML = '';
    const wrap = el('div', { class: 'preview-folder' });

    // Breakdown by file type
    const breakdown = el('div', { class: 'preview-folder-breakdown' });
    const kinds = [
      ['Markdown', stats.byKind.md],
      ['HTML',     stats.byKind.html],
      ['PDF',      stats.byKind.pdf],
      ['Other',    stats.byKind.other],
    ];
    for (const [label, n] of kinds) {
      if (n === 0) continue;
      const chip = el('span', { class: 'preview-folder-chip' });
      chip.appendChild(el('strong', null, String(n)));
      chip.appendChild(el('span', null, ' ' + label));
      breakdown.appendChild(chip);
    }
    if (breakdown.children.length) wrap.appendChild(breakdown);

    // Direct-children listings: folders first, then docs (sorted by name).
    const immediateFolders = Array.from(node.children.values())
      .sort((a, b) => a.name.localeCompare(b.name));
    const immediateDocs = node.docs.slice()
      .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));

    if (immediateFolders.length) {
      wrap.appendChild(el('h3', { class: 'preview-folder-h' },
        `${immediateFolders.length} folder${immediateFolders.length === 1 ? '' : 's'} here`));
      const list = el('ul', { class: 'preview-folder-list' });
      for (const ch of immediateFolders) {
        const chStats = computeFolderStats(ch);
        const li = el('li', { class: 'preview-folder-row folder' });
        li.appendChild(el('span', { class: 'preview-folder-name' }, ch.name + '/'));
        li.appendChild(el('span', { class: 'preview-folder-meta' },
          `${chStats.docs} doc${chStats.docs === 1 ? '' : 's'} · ${formatSize(chStats.totalSize)}`));
        list.appendChild(li);
      }
      wrap.appendChild(list);
    }

    if (immediateDocs.length) {
      wrap.appendChild(el('h3', { class: 'preview-folder-h' },
        `${immediateDocs.length} doc${immediateDocs.length === 1 ? '' : 's'} here`));
      const list = el('ul', { class: 'preview-folder-list' });
      for (const d of immediateDocs) {
        const li = el('li', { class: 'preview-folder-row doc' });
        li.appendChild(el('span', { class: 'preview-folder-name' }, d.title || d.name));
        const metaBits = [];
        if (d.date) metaBits.push(d.date);
        metaBits.push(formatSize(d.size));
        li.appendChild(el('span', { class: 'preview-folder-meta' }, metaBits.join(' · ')));
        list.appendChild(li);
      }
      wrap.appendChild(list);
    }

    if (!immediateFolders.length && !immediateDocs.length) {
      wrap.appendChild(el('div', { class: 'preview-folder-empty' },
        'This folder is empty.'));
    }

    body.appendChild(wrap);
    modal.classList.remove('hidden');
  }

  async function mcMove(srcPath, destFolderPath) {
    try {
      const r = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ srcPath, destFolder: destFolderPath }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      if (data.unchanged) return;
      setStatus('moved → ' + (destFolderPath || data.newPath.split('/')[0] + '/'), 'ok');
      // SSE/chokidar will refresh the panes once the indexer catches up;
      // until then, optimistically auto-expand the destination in both panes
      // so the moved file is visible when the new index arrives.
      const dest = destFolderPath || dropWorkspace(srcPath);
      state.mcPanes.a.expanded.add(dest);
      state.mcPanes.b.expanded.add(dest);
      persistMcPanes();
    } catch (err) {
      setStatus('move failed', 'error');
      alert('Move failed: ' + err.message);
    }
  }

  // ---------- tabs ----------
  function tabLabel(t) {
    if (t.docPath) {
      const d = state.docsByPath.get(t.docPath);
      if (d) return d.title || d.name;
      return t.docPath.split('/').pop();
    }
    if (t.folder) return t.folder.split('/').pop() || t.folder;
    return 'New tab';
  }

  function tabIconHtml(t) {
    if (t.docPath) {
      const d = state.docsByPath.get(t.docPath);
      if (d) {
        if (d.ext === 'pdf') return ICON_PDF;
        if (d.ext === 'html' || d.ext === 'htm') return ICON_HTML;
        return ICON_MD;
      }
    }
    return ICON_FOLDER;
  }

  function renderTabs() {
    if (state.isEmbed) return;
    const bar = $('#tabs');
    bar.innerHTML = '';
    for (const t of state.tabs) {
      const tab = el('div', {
        class: 'tab' + (t.id === state.activeTabId ? ' active' : ''),
        dataset: { tabId: t.id },
        title: tabLabel(t),
      });
      tab.appendChild(el('span', { class: 'tab-icon', html: tabIconHtml(t) }));
      tab.appendChild(el('span', { class: 'tab-title' }, tabLabel(t)));
      const close = el('button', { class: 'tab-close', title: 'Close tab (Cmd+W)' }, '✕');
      close.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(t.id); });
      tab.appendChild(close);
      tab.addEventListener('click', () => switchTab(t.id));
      tab.addEventListener('mousedown', (ev) => {
        // Middle-click closes the tab (browser convention).
        if (ev.button === 1) { ev.preventDefault(); closeTab(t.id); }
      });
      bar.appendChild(tab);
    }
  }

  function switchTab(id) {
    if (id === state.activeTabId) return;
    if (!state.tabs.some(t => t.id === id)) return;
    if (!confirmDiscardEdits()) return;
    syncStateToActiveTab();
    state.activeTabId = id;
    syncActiveTabToState();
    renderTree();
    renderTabs();
    state.suppressPersist = true;
    try {
      if (state.currentDoc) selectDoc(state.currentDoc.path, true);
      else selectFolder(state.currentFolder || '', true);
    } finally {
      state.suppressPersist = false;
    }
    persistTabs();
  }

  function newTab(docPath, opts) {
    syncStateToActiveTab();
    const t = makeTab({
      docPath: docPath || null,
      folder: opts && opts.folder ? opts.folder : '',
    });
    state.tabs.push(t);
    state.activeTabId = t.id;
    syncActiveTabToState();
    renderTabs();
    state.suppressPersist = true;
    try {
      if (t.docPath) selectDoc(t.docPath, true);
      else selectFolder(t.folder || '', true);
    } finally {
      state.suppressPersist = false;
    }
    persistTabs();
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    if (id === state.activeTabId && !confirmDiscardEdits()) return;
    const wasActive = id === state.activeTabId;
    state.tabs.splice(idx, 1);
    if (!state.tabs.length) {
      // Always keep at least one tab.
      const t = makeTab();
      state.tabs.push(t);
      state.activeTabId = t.id;
    } else if (wasActive) {
      // Activate the neighbor (prefer the one to the right, fall back left).
      const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
      state.activeTabId = next.id;
    }
    syncActiveTabToState();
    renderTabs();
    renderTree();
    state.suppressPersist = true;
    try {
      if (state.currentDoc) selectDoc(state.currentDoc.path, true);
      else selectFolder(state.currentFolder || '', true);
    } finally {
      state.suppressPersist = false;
    }
    persistTabs();
  }

  // ---------- context menu ----------
  function buildEmbedUrl(docPath, anchor) {
    return location.origin + location.pathname + '?embed=1#doc=' + encodeURIComponent(docPath) + (anchor ? '&a=' + encodeURIComponent(anchor) : '');
  }
  function openInBrowserTab(docPath) {
    window.open(buildEmbedUrl(docPath), '_blank', 'noopener');
  }
  function openInBrowserWindow(docPath) {
    const w = Math.min(1100, screen.availWidth - 100);
    const h = Math.min(820, screen.availHeight - 100);
    window.open(buildEmbedUrl(docPath), '_blank', `noopener,width=${w},height=${h}`);
  }

  function hideCtxMenu() { $('#ctx-menu').classList.add('hidden'); }
  function showCtxMenu(x, y, items, headerText) {
    const menu = $('#ctx-menu');
    menu.innerHTML = '';
    if (headerText) {
      const h = el('div', { class: 'ctx-header' }, headerText);
      menu.appendChild(h);
    }
    items.forEach((it) => {
      if (it === '-') { menu.appendChild(document.createElement('hr')); return; }
      const b = el('button', { class: it.danger ? 'ctx-danger' : null }, it.label);
      b.addEventListener('click', () => { hideCtxMenu(); try { it.onClick(); } catch (e) { console.error(e); } });
      menu.appendChild(b);
    });
    // Place — flip if it would overflow the viewport.
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - rect.width - 8);
    const py = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(8, px) + 'px';
    menu.style.top = Math.max(8, py) + 'px';
  }

  function showDocContextMenu(doc, x, y) {
    const isRoot = !doc.path.includes('/'); // workspace name only — shouldn't be a doc, but defensive
    const items = [
      { label: 'Preview  ␣', onClick: () => previewDoc(doc) },
      { label: 'Open in this tab', onClick: () => selectDoc(doc.path) },
      { label: 'Open in new tab', onClick: () => newTab(doc.path) },
      '-',
      { label: 'Open in browser tab', onClick: () => openInBrowserTab(doc.path) },
      { label: 'Open in new browser window', onClick: () => openInBrowserWindow(doc.path) },
      '-',
      { label: 'Copy', onClick: () => copyToClipboard(doc.path, 'file', doc.name) },
      '-',
      { label: 'Reveal in Finder', onClick: () => { fetch('/api/open?path=' + encodeURIComponent(doc.path)).catch(() => {}); } },
      { label: 'Copy path', onClick: () => navigator.clipboard.writeText(doc.path) },
    ];
    if (!isRoot) {
      items.push(
        '-',
        { label: 'Rename…', onClick: () => renameNode(doc.path, doc.name, false) },
        { label: 'Move to Trash', danger: true, onClick: () => deleteNode(doc.path, doc.name, false) },
      );
    }
    showCtxMenu(x, y, items, doc.title || doc.name);
  }

  function showFolderContextMenu(node, x, y) {
    const isExpanded = state.expanded.has(node.path);
    // Workspace roots have no slash in their path ("Business", "business-shared").
    const isWorkspaceRoot = !node.path.includes('/');
    const items = [
      { label: 'New folder…',          onClick: () => createFolderIn(node.path) },
      { label: 'New markdown file…',   onClick: () => createMarkdownIn(node.path) },
      '-',
      { label: 'Open in this tab', onClick: () => selectFolder(node.path) },
      { label: 'Open in new tab', onClick: () => newTab(null, { folder: node.path }) },
      '-',
      { label: isExpanded ? 'Collapse' : 'Expand', onClick: () => toggleNode(node.path) },
      { label: 'Reveal in Finder', onClick: () => { fetch('/api/open?path=' + encodeURIComponent(node.path)).catch(() => {}); } },
    ];
    // Copy folder — but never the workspace root pseudo-folder.
    if (!isWorkspaceRoot) {
      items.push(
        '-',
        { label: 'Copy folder', onClick: () => copyToClipboard(node.path, 'folder', node.name) },
      );
    }
    // Paste here — only show when there's something on the clipboard.
    if (state.clipboard) {
      items.push({
        label: `Paste “${state.clipboard.name}” here`,
        onClick: () => pasteIntoFolder(node.path),
      });
    }
    if (!isWorkspaceRoot) {
      items.push(
        '-',
        { label: 'Rename folder…', onClick: () => renameNode(node.path, node.name, true) },
        { label: 'Move folder to Trash', danger: true, onClick: () => deleteNode(node.path, node.name, true) },
      );
    }
    showCtxMenu(x, y, items, node.path || 'Workspace');
  }

  // ---------- file/folder mutations ----------
  // Both wait for the SSE-driven reindex to refresh the tree/viewer. We don't
  // optimistically patch state — the server-side index is the source of truth.
  async function renameNode(prefixedPath, currentName, isFolder) {
    const newName = window.prompt(
      `Rename ${isFolder ? 'folder' : 'file'} "${currentName}" to:`,
      currentName
    );
    if (newName == null) return; // user cancelled
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) return;
    try {
      const r = await fetch('/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: prefixedPath, newName: trimmed }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      setStatus('renamed', 'ok');
      // If we were viewing the renamed file, hop to the new path so the user
      // doesn't get bounced to a "removed" empty state when SSE fires.
      if (!isFolder && state.currentDoc && state.currentDoc.path === prefixedPath) {
        // Defer the navigation until the reindex completes — selectDoc looks
        // up the new path in state.docsByPath which isn't populated yet.
        followupAfterReindex(() => {
          if (state.docsByPath.has(data.newPath)) selectDoc(data.newPath);
        });
      } else if (isFolder && state.currentFolder === prefixedPath) {
        followupAfterReindex(() => {
          if (state.nodesByPath && state.nodesByPath.has(data.newPath)) selectFolder(data.newPath);
        });
      }
    } catch (err) {
      alert('Rename failed: ' + err.message);
    }
  }

  async function deleteNode(prefixedPath, name, isFolder) {
    const trashWord = (navigator.platform || '').includes('Mac') ? 'Trash' : 'trash';
    const ok = window.confirm(
      `Move ${isFolder ? 'folder' : 'file'} "${name}" to ${trashWord}?` +
      (isFolder ? '\n\nAll files inside will be moved with it.' : '')
    );
    if (!ok) return;
    try {
      const r = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: prefixedPath }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      setStatus(data.trashed ? 'moved to Trash' : 'deleted', 'ok');
      // SSE reindex will re-render the tree; the live-reload handler will
      // also show the "this doc was removed" empty state if the user was
      // viewing the deleted file.
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  // Queue a callback to run the next time SSE delivers an `index-changed`
  // event. Used after rename to navigate to the new path once it exists in
  // the freshly loaded index.
  const reindexFollowups = [];
  function followupAfterReindex(fn) { reindexFollowups.push(fn); }

  // ---------- copy / paste clipboard ----------
  // In-memory only; intentionally doesn't touch the OS clipboard (which
  // would need permissions and can't carry filesystem semantics anyway).
  // Survives only the current session, like Finder.
  state.clipboard = null; // { path, kind: 'file'|'folder', name }

  function copyToClipboard(prefixedPath, kind, displayName) {
    state.clipboard = { path: prefixedPath, kind, name: displayName || prefixedPath.split('/').pop() };
    setStatus('copied: ' + state.clipboard.name, 'ok');
  }

  async function pasteIntoFolder(destFolderPath) {
    if (!state.clipboard) return;
    const clip = state.clipboard;
    try {
      const r = await fetch('/api/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ srcPath: clip.path, destFolder: destFolderPath }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      setStatus(
        data.renamed
          ? `pasted as ${data.newPath.split('/').pop()}`
          : 'pasted',
        'ok'
      );
      // Expand destination in both panes + main tree so the new item is
      // visible the moment the index update arrives.
      state.expanded.add(destFolderPath);
      state.mcPanes.a.expanded.add(destFolderPath);
      state.mcPanes.b.expanded.add(destFolderPath);
      persistMcPanes();
      // After reindex, focus the new item in the active MC pane (or open
      // it in the viewer if a file in tabbed view).
      followupAfterReindex(() => {
        const isFile = clip.kind === 'file';
        const exists = isFile ? state.docsByPath.has(data.newPath)
                              : state.nodesByPath && state.nodesByPath.has(data.newPath);
        if (!exists) return;
        if (state.mcMode) {
          const paneId = state.mcLastFocusedPane || 'a';
          setMcFocus(paneId, data.newPath);
          renderMcPane(paneId);
        } else if (isFile) {
          selectDoc(data.newPath);
        } else {
          selectFolder(data.newPath);
        }
      });
    } catch (err) {
      setStatus('paste failed', 'error');
      alert('Paste failed: ' + err.message);
    }
  }

  // For Cmd+C/Cmd+V in MC mode: resolve which path the user means.
  function mcCopyFocused() {
    if (!state.mcMode) return false;
    const paneId = state.mcLastFocusedPane || 'a';
    const focused = state.mcPanes[paneId] && state.mcPanes[paneId].focused;
    if (!focused) return false;
    const doc = state.docsByPath.get(focused);
    if (doc) { copyToClipboard(doc.path, 'file', doc.name); return true; }
    const node = state.nodesByPath && state.nodesByPath.get(focused);
    if (node) {
      // Don't allow copying workspace roots (they're not real folders in the
      // filesystem sense from the user's point of view).
      if (!node.path.includes('/')) { setStatus('cannot copy a workspace root', 'error'); return false; }
      copyToClipboard(node.path, 'folder', node.name);
      return true;
    }
    return false;
  }

  function mcPasteIntoFocused() {
    if (!state.mcMode || !state.clipboard) return false;
    const paneId = state.mcLastFocusedPane || 'a';
    const focused = state.mcPanes[paneId] && state.mcPanes[paneId].focused;
    let destFolder = '';
    if (focused) {
      const doc = state.docsByPath.get(focused);
      if (doc) {
        // File focused → paste into its containing folder.
        const lastSlash = doc.path.lastIndexOf('/');
        destFolder = lastSlash > 0 ? doc.path.slice(0, lastSlash) : '';
      } else if (state.nodesByPath && state.nodesByPath.has(focused)) {
        // Folder focused → paste into it.
        destFolder = focused;
      }
    }
    if (!destFolder) { setStatus('select a folder to paste into', 'error'); return false; }
    pasteIntoFolder(destFolder);
    return true;
  }

  async function createFolderIn(parentPath) {
    const name = window.prompt('New folder name:', '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const r = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: parentPath, name: trimmed }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      setStatus('folder created', 'ok');
      // Optimistically expand the parent + the new folder in main tree and
      // both MC panes so the next reindex paints it open.
      state.expanded.add(parentPath);
      state.expanded.add(data.path);
      state.mcPanes.a.expanded.add(parentPath); state.mcPanes.a.expanded.add(data.path);
      state.mcPanes.b.expanded.add(parentPath); state.mcPanes.b.expanded.add(data.path);
      persistMcPanes();
    } catch (err) {
      alert('Create folder failed: ' + err.message);
    }
  }

  async function createMarkdownIn(parentPath) {
    const name = window.prompt('New markdown file (`.md` will be added if omitted):', '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const r = await fetch('/api/touch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: parentPath, name: trimmed }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      setStatus('file created', 'ok');
      // Expand the parent in main tree + MC panes so the new file is visible.
      state.expanded.add(parentPath);
      state.mcPanes.a.expanded.add(parentPath);
      state.mcPanes.b.expanded.add(parentPath);
      persistMcPanes();
      // After the index catches up, open the new file in the appropriate
      // surface: focus it in MC mode (last-focused pane), or open it in the
      // viewer in normal mode.
      followupAfterReindex(() => {
        if (!state.docsByPath.has(data.path)) return;
        if (state.mcMode) {
          const paneId = state.mcLastFocusedPane || 'a';
          setMcFocus(paneId, data.path);
          renderMcPane(paneId);
        } else {
          selectDoc(data.path);
        }
      });
    } catch (err) {
      alert('Create file failed: ' + err.message);
    }
  }

  // ---------- sidebar resize ----------
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 720;
  const SIDEBAR_DEFAULT = 320;

  function applySidebarWidth(w) {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
    $('#sidebar').style.width = clamped + 'px';
    return clamped;
  }

  function initSidebarResize() {
    const stored = parseInt(localStorage.getItem('clawdoc.sidebarWidth'), 10);
    if (stored && !Number.isNaN(stored)) applySidebarWidth(stored);

    const resizer = $('#sidebar-resizer');
    const sidebar = $('#sidebar');
    let startX = 0;
    let startW = 0;
    let activePointerId = null;

    const endDrag = () => {
      if (activePointerId === null) return;
      try { resizer.releasePointerCapture(activePointerId); } catch {}
      activePointerId = null;
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing-sidebar');
      const w = parseInt(sidebar.style.width, 10);
      if (w) localStorage.setItem('clawdoc.sidebarWidth', String(w));
    };

    resizer.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      activePointerId = ev.pointerId;
      startX = ev.clientX;
      startW = sidebar.getBoundingClientRect().width;
      resizer.setPointerCapture(ev.pointerId);
      resizer.classList.add('dragging');
      document.body.classList.add('resizing-sidebar');
      ev.preventDefault();
    });

    resizer.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== activePointerId) return;
      applySidebarWidth(startW + (ev.clientX - startX));
      ev.preventDefault();
    });

    resizer.addEventListener('pointerup', endDrag);
    resizer.addEventListener('pointercancel', endDrag);
    resizer.addEventListener('lostpointercapture', endDrag);

    resizer.addEventListener('dblclick', () => {
      applySidebarWidth(SIDEBAR_DEFAULT);
      localStorage.setItem('clawdoc.sidebarWidth', String(SIDEBAR_DEFAULT));
    });
  }

  // ---------- wire up ----------
  function init() {
    // Embed mode — strip chrome and bypass tabs/chat/resize.
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.has('embed')) {
      state.isEmbed = true;
      document.body.classList.add('embed');
      loadIndex();
      return;
    }

    $('#search').addEventListener('input', (e) => runSearch(e.target.value));
    $('#search').addEventListener('focus', () => {
      if ($('#search').value.trim()) runSearch($('#search').value);
    });
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.search-wrap')) $('#search-results').classList.add('hidden');
    });
    $('#tree-filter').addEventListener('input', debounce((e) => {
      state.treeFilter = e.target.value;
      renderTree();
    }, 80));
    $('#tree-expand-all').addEventListener('click', expandAllFolders);
    $('#tree-collapse-all').addEventListener('click', collapseAllFolders);
    applyTreeDisplayMode();
    $('#tree-display-toggle').addEventListener('click', toggleTreeDisplay);
    $('#reindex').addEventListener('click', doReindex);
    $('#quick-open').addEventListener('click', (ev) => {
      if (ev.target.id === 'quick-open') closeQuickOpen();
    });
    $('#quick-open-input').addEventListener('input', (e) => renderQuickOpenResults(e.target.value));

    // MC two-pane mode
    $('#mc-toggle').addEventListener('click', toggleMcMode);
    $('#mc-exit').addEventListener('click', exitMcMode);
    document.querySelectorAll('[data-pane-filter]').forEach((inp) => {
      const paneId = inp.getAttribute('data-pane-filter');
      inp.addEventListener('input', debounce((ev) => {
        state.mcPanes[paneId].filter = ev.target.value;
        persistMcPanes();
        renderMcPane(paneId);
      }, 80));
    });
    document.querySelectorAll('[data-pane-expand-all]').forEach((btn) => {
      btn.addEventListener('click', () => expandAllInMcPane(btn.getAttribute('data-pane-expand-all')));
    });
    document.querySelectorAll('[data-pane-collapse-all]').forEach((btn) => {
      btn.addEventListener('click', () => collapseAllInMcPane(btn.getAttribute('data-pane-collapse-all')));
    });
    applyMcMode(); // restore persisted mc state

    // Preview modal
    $('#preview-close').addEventListener('click', closePreview);
    $('#preview-modal').addEventListener('click', (ev) => {
      if (ev.target.id === 'preview-modal') closePreview();
    });
    $('#preview-open').addEventListener('click', () => {
      if (!preview.currentPath) return;
      const p = preview.currentPath;
      closePreview();
      if (state.mcMode) exitMcMode();
      // Dispatch by type so the Open button works for folder previews too.
      if (state.docsByPath.has(p)) selectDoc(p);
      else if (state.nodesByPath && state.nodesByPath.has(p)) selectFolder(p);
    });

    // chat panel (Claude Code terminal)
    $('#chat-toggle').addEventListener('click', toggleChat);
    $('#chat-close').addEventListener('click', closeChat);
    $('#chat-restart').addEventListener('click', restartChat);
    $('#chat-theme').addEventListener('click', toggleTermTheme);
    $('#chat-context').addEventListener('click', insertCurrentPathIntoTerminal);
    $('#chat-insert').addEventListener('click', insertCurrentPathIntoTerminal);
    applyTermTheme(chat.theme); // set initial data-term-theme on the panel
    initChatResize();

    // rich Claude client (structured, stream-json) — 2nd button
    initAgent();
    window.addEventListener('beforeunload', () => {
      if (chat.ws) try { chat.ws.close(); } catch {}
    });

    initSidebarResize();
    applyZoom();

    // Settings
    $('#settings-toggle').addEventListener('click', toggleSettings);
    $('#settings-close').addEventListener('click', closeSettings);
    $('#settings-modal').addEventListener('click', (ev) => {
      if (ev.target.id === 'settings-modal') closeSettings();
    });

    // Tabs
    $('#tab-new').addEventListener('click', () => newTab());

    // Context menu — close on outside click / escape / scroll
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('#ctx-menu')) hideCtxMenu();
    });
    document.addEventListener('scroll', hideCtxMenu, true);
    window.addEventListener('blur', hideCtxMenu);

    // Browser-level prompt if the user tries to close the tab with unsaved
    // edits (the browser ignores the custom message but still shows a prompt).
    window.addEventListener('beforeunload', (ev) => {
      if (state.editor && isEditorDirty()) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });

    loadIndex();
    connectLiveEvents();
    gh.init();
  }

  // ---------- GitHub / Git integration ----------
  // Client-side coordinator: keeps per-workspace git status fresh, drives the
  // topbar pill, renders the settings GitHub section, and powers the document
  // history modal (commits list + diff2html viewer).
  const gh = {
    github: { connected: false, login: null, name: null, deviceFlow: false },
    perWs: new Map(),       // workspace name -> last status payload
    deviceSession: null,    // { id, timer }
    refreshing: false,
    historyOpen: false,
    historyCommits: [],
    historyDoc: null,
    historyActiveOid: null,
  };

  gh.init = function init() {
    const pill = $('#git-pill');
    pill.addEventListener('click', () => {
      openSettings();
      // Scroll to the GitHub section after the modal opens.
      setTimeout(() => {
        const section = document.querySelector('.settings-section[data-section="github"]');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    });
    const histClose = $('#history-close');
    if (histClose) histClose.addEventListener('click', closeHistoryModal);
    const histModal = $('#history-modal');
    if (histModal) histModal.addEventListener('click', (ev) => {
      if (ev.target.id === 'history-modal') closeHistoryModal();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && gh.historyOpen) {
        ev.preventDefault();
        closeHistoryModal();
      }
    });
    // Initial fetch.
    gh.refresh();
    // Periodic refresh as a safety net for status drift (push from another
    // device, manual git operations from the terminal, etc).
    setInterval(() => gh.refresh(), 60_000);
  };

  gh.refresh = async function refresh() {
    if (gh.refreshing) return;
    gh.refreshing = true;
    try {
      const meR = await fetch('/api/github/me');
      gh.github = await meR.json();
      const roots = (state.index && state.index.roots) || [];
      for (const r of roots) {
        try {
          const s = await fetch('/api/git/status?workspace=' + encodeURIComponent(r.name)).then(r => r.json());
          if (s && s.ok) gh.perWs.set(r.name, s);
        } catch {}
      }
      gh.renderPill();
      // If the settings modal is open, repaint its github section.
      if (!$('#settings-modal').classList.contains('hidden')) renderSettings();
    } finally {
      gh.refreshing = false;
    }
  };

  // The pill reflects the workspace of the currently-viewed doc/folder (so the
  // user sees what's relevant to what they're looking at). Falls back to the
  // first workspace if nothing is selected.
  gh.renderPill = function renderPill() {
    const pill = $('#git-pill');
    const text = pill.querySelector('.git-pill-text');
    const wsName = currentWorkspaceName();
    const s = wsName ? gh.perWs.get(wsName) : null;
    if (!s) { pill.classList.add('hidden'); return; }
    pill.classList.remove('hidden');
    let state_, label;
    if (!s.git.isRepo) {
      state_ = 'disconnected'; label = wsName + ' · not a git repo';
    } else if (!gh.github.connected || !s.git.remote) {
      state_ = 'disconnected';
      label = wsName + ' · ' + (gh.github.connected ? 'no remote' : 'not connected');
    } else if (s.git.dirty) {
      state_ = 'dirty';
      label = wsName + ' · ' + s.git.changed + s.git.untracked + s.git.staged + ' uncommitted';
    } else if (s.git.ahead) {
      state_ = 'syncing'; label = wsName + ' · ' + s.git.ahead + ' to push';
    } else {
      state_ = 'synced'; label = wsName + ' · synced';
    }
    pill.dataset.state = state_;
    text.textContent = label;
    pill.title = `Workspace: ${wsName}\nBranch: ${s.git.branch || '—'}\nRemote: ${s.git.remote || '—'}\nGitHub: ${gh.github.connected ? gh.github.login : 'not connected'}\nClick for settings.`;
  };

  function currentWorkspaceName() {
    const p = state.currentDoc ? state.currentDoc.path : state.currentFolder || '';
    if (p) return splitWorkspacePath(p).workspace;
    const roots = (state.index && state.index.roots) || [];
    return roots[0] ? roots[0].name : null;
  }

  // Called from renderSettings — returns the DOM for the GitHub settings
  // section (account + per-workspace cards).
  gh.renderSettingsSection = function renderSettingsSection() {
    const section = el('div', { class: 'settings-section', dataset: { section: 'github' } });
    section.appendChild(el('h3', null, 'GitHub'));

    // ---- account
    if (gh.github.connected) {
      const card = el('div', { class: 'gh-account' });
      card.appendChild(el('div', null, [
        el('div', { class: 'gh-login' }, '@' + (gh.github.login || '?')),
        el('div', { class: 'gh-status ok' }, 'Connected'),
      ]));
      const actions = el('div', { class: 'gh-actions' });
      const disc = el('button', { class: 'danger' }, 'Disconnect');
      disc.addEventListener('click', async () => {
        await fetch('/api/github/disconnect', { method: 'POST' });
        await gh.refresh();
      });
      actions.appendChild(disc);
      card.appendChild(actions);
      section.appendChild(card);
    } else {
      const card = el('div', { class: 'gh-connect-area' });
      card.appendChild(el('div', { class: 'settings-help' },
        'Connect a GitHub account to push your workspaces and view document history.'));
      // PAT path
      const tokenRow = el('div', { class: 'gh-row' });
      const tokenInput = el('input', {
        type: 'password',
        class: 'gh-token',
        placeholder: 'Paste a personal access token (scope: repo)',
        autocomplete: 'off',
        spellcheck: 'false',
      });
      tokenRow.appendChild(tokenInput);
      const tokenBtn = el('button', { class: 'btn-primary' }, 'Connect');
      const statusLine = el('div', { class: 'gh-status' });
      const doTokenConnect = async () => {
        const t = tokenInput.value.trim();
        if (!t) return;
        statusLine.textContent = 'Validating…'; statusLine.className = 'gh-status';
        try {
          const r = await fetch('/api/github/connect', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ token: t }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
          statusLine.textContent = 'Connected as @' + j.login;
          statusLine.className = 'gh-status ok';
          tokenInput.value = '';
          await gh.refresh();
        } catch (err) {
          statusLine.textContent = err.message;
          statusLine.className = 'gh-status error';
        }
      };
      tokenBtn.addEventListener('click', doTokenConnect);
      tokenInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doTokenConnect(); } });
      tokenRow.appendChild(tokenBtn);
      card.appendChild(tokenRow);
      card.appendChild(el('div', { class: 'settings-help' },
        'Create one at github.com/settings/tokens (classic) with the “repo” scope, or use a fine-grained token with read+write Contents on the repos you want to sync.'));
      card.appendChild(statusLine);

      // Device flow (only if server has client_id)
      if (gh.github.deviceFlow) {
        const sep = el('div', { class: 'settings-help' }, 'Or use Device Flow:');
        sep.style.marginTop = '10px';
        card.appendChild(sep);
        const dfBtn = el('button', null, 'Connect via Device Flow');
        const dfCard = el('div', { class: 'gh-device-card', style: 'display:none;' });
        dfBtn.addEventListener('click', () => gh.startDeviceFlow(dfCard, statusLine));
        card.appendChild(dfBtn);
        card.appendChild(dfCard);
      }
      section.appendChild(card);
    }

    // ---- per-workspace cards
    const roots = (state.index && state.index.roots) || [];
    for (const r of roots) {
      section.appendChild(gh.renderWorkspaceCard(r));
    }
    return section;
  };

  gh.renderWorkspaceCard = function renderWorkspaceCard(root) {
    const s = gh.perWs.get(root.name);
    const card = el('div', { class: 'git-ws-card', dataset: { ws: root.name } });
    const head = el('div', { class: 'git-ws-head' });
    head.appendChild(el('div', { class: 'git-ws-name' }, root.name));
    head.appendChild(el('div', { class: 'git-ws-status' }, gh.statusSummary(s)));
    card.appendChild(head);

    if (!s) {
      card.appendChild(el('div', { class: 'settings-help' }, 'Loading…'));
      return card;
    }
    const cfg = s.config || {};

    if (!s.git.isRepo) {
      const help = el('div', { class: 'settings-help' },
        'Not a git repository. Click Initialize to create one and start tracking changes.');
      card.appendChild(help);
      const actions = el('div', { class: 'git-ws-actions' });
      const initBtn = el('button', { class: 'btn-primary' }, 'Initialize git');
      initBtn.addEventListener('click', () => gh.initRepo(root));
      actions.appendChild(initBtn);
      card.appendChild(actions);
      return card;
    }

    // is-repo
    if (s.git.remote) {
      card.appendChild(el('div', { class: 'settings-help' }, 'Remote: ' + s.git.remote));
    } else {
      card.appendChild(el('div', { class: 'settings-help' },
        gh.github.connected
          ? 'No remote configured. Connect this workspace to a GitHub repo to enable push.'
          : 'No remote configured. Connect GitHub first, then attach a repo.'));
    }
    // toggles
    const t1 = el('label', { class: 'git-toggle-row' });
    const cb1 = el('input', { type: 'checkbox' });
    if (cfg.autoCommit) cb1.setAttribute('checked', '');
    cb1.addEventListener('change', () => gh.setConfig(root.name, { autoCommit: cb1.checked }));
    t1.appendChild(cb1);
    t1.appendChild(document.createTextNode('Auto-commit changes (debounced)'));
    card.appendChild(t1);
    const t2 = el('label', { class: 'git-toggle-row' });
    const cb2 = el('input', { type: 'checkbox' });
    if (cfg.autoPush) cb2.setAttribute('checked', '');
    cb2.addEventListener('change', () => gh.setConfig(root.name, { autoPush: cb2.checked }));
    t2.appendChild(cb2);
    t2.appendChild(document.createTextNode('Auto-push after commit'));
    card.appendChild(t2);

    // actions
    const actions = el('div', { class: 'git-ws-actions' });
    if (!s.git.remote && gh.github.connected) {
      const createBtn = el('button', null, 'Create GitHub repo…');
      createBtn.addEventListener('click', () => gh.promptCreateRepo(root));
      actions.appendChild(createBtn);
      const attachBtn = el('button', null, 'Attach existing repo URL…');
      attachBtn.addEventListener('click', () => gh.promptAttachRepo(root));
      actions.appendChild(attachBtn);
    }
    if (s.git.remote) {
      const pushBtn = el('button', null, s.git.ahead ? `Push (${s.git.ahead})` : 'Push');
      pushBtn.disabled = !gh.github.connected;
      pushBtn.addEventListener('click', () => gh.push(root.name, pushBtn));
      actions.appendChild(pushBtn);
      const pullBtn = el('button', null, s.git.behind ? `Pull (${s.git.behind})` : 'Pull');
      pullBtn.disabled = !gh.github.connected;
      pullBtn.addEventListener('click', () => gh.pull(root.name, pullBtn));
      actions.appendChild(pullBtn);
    }
    if (s.git.dirty) {
      const commitBtn = el('button', null, 'Commit now');
      commitBtn.addEventListener('click', () => gh.commitNow(root.name, commitBtn));
      actions.appendChild(commitBtn);
    }
    card.appendChild(actions);
    return card;
  };

  gh.statusSummary = function statusSummary(s) {
    if (!s) return '—';
    if (!s.git.isRepo) return 'not a repo';
    const bits = [];
    if (s.git.branch) bits.push(s.git.branch);
    if (s.git.dirty) bits.push((s.git.changed + s.git.untracked + s.git.staged) + ' changed');
    else bits.push('clean');
    if (s.git.ahead) bits.push(s.git.ahead + '↑');
    if (s.git.behind) bits.push(s.git.behind + '↓');
    return bits.join(' · ');
  };

  gh.initRepo = async function initRepo(root) {
    const r = await fetch('/api/git/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: root.name }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert('Init failed: ' + (j.error || r.status));
      return;
    }
    await gh.refresh();
  };

  gh.setConfig = async function setConfig(wsName, patch) {
    await fetch('/api/git/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: wsName, ...patch }),
    });
    await gh.refresh();
  };

  gh.commitNow = async function commitNow(wsName, btn) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Committing…';
    try {
      const r = await fetch('/api/git/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: wsName, message: 'clawdoc: manual commit' }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('Commit failed: ' + (j.error || r.status));
      }
    } finally {
      btn.disabled = false; btn.textContent = orig;
      await gh.refresh();
    }
  };

  gh.push = async function push(wsName, btn) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Pushing…';
    try {
      const r = await fetch('/api/git/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: wsName }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('Push failed: ' + (j.error || r.status));
      }
    } finally {
      btn.disabled = false; btn.textContent = orig;
      await gh.refresh();
    }
  };

  gh.pull = async function pull(wsName, btn) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Pulling…';
    try {
      const r = await fetch('/api/git/pull', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: wsName }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('Pull failed: ' + (j.error || r.status));
      }
    } finally {
      btn.disabled = false; btn.textContent = orig;
      await gh.refresh();
    }
  };

  gh.promptCreateRepo = async function promptCreateRepo(root) {
    const name = prompt('Repo name on GitHub:', root.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-'));
    if (!name) return;
    const isPriv = confirm('Make this repo private? (Cancel = public)');
    try {
      const r = await fetch('/api/github/repo/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, private: isPriv, description: 'ClawDoc workspace: ' + root.name }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      // Init local repo (if not already) + add remote.
      await fetch('/api/git/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: root.name, repoUrl: j.cloneUrl, branch: j.defaultBranch }),
      });
      await gh.setConfig(root.name, { repo: j.fullName });
      await gh.refresh();
    } catch (err) {
      alert('Create failed: ' + err.message);
    }
  };

  gh.promptAttachRepo = async function promptAttachRepo(root) {
    const url = prompt('GitHub repo URL (https://github.com/owner/repo.git):');
    if (!url) return;
    try {
      await fetch('/api/git/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: root.name, repoUrl: url }),
      });
      // Try to extract owner/name for repo label.
      const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m) await gh.setConfig(root.name, { repo: m[1] + '/' + m[2] });
      await gh.refresh();
    } catch (err) {
      alert('Attach failed: ' + err.message);
    }
  };

  gh.startDeviceFlow = async function startDeviceFlow(cardEl, statusEl) {
    cardEl.style.display = '';
    cardEl.innerHTML = 'Starting…';
    try {
      const r = await fetch('/api/github/device/start', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      gh.deviceSession = { id: j.id };
      gh.pollDeviceFlow(cardEl, statusEl);
    } catch (err) {
      cardEl.textContent = 'Failed to start device flow: ' + err.message;
      cardEl.classList.add('error');
    }
  };

  gh.pollDeviceFlow = async function pollDeviceFlow(cardEl, statusEl) {
    if (!gh.deviceSession) return;
    try {
      const r = await fetch('/api/github/device/poll?id=' + encodeURIComponent(gh.deviceSession.id));
      const j = await r.json();
      if (j.done && j.login) {
        cardEl.innerHTML = '';
        statusEl.textContent = 'Connected as @' + j.login;
        statusEl.className = 'gh-status ok';
        gh.deviceSession = null;
        await gh.refresh();
        return;
      }
      const v = j.verification;
      if (v) {
        cardEl.innerHTML = '';
        cardEl.appendChild(el('div', null, 'Visit:'));
        const a = el('a', { href: v.verification_uri, target: '_blank', rel: 'noopener' }, v.verification_uri);
        cardEl.appendChild(a);
        cardEl.appendChild(el('div', { style: 'margin-top:6px;' }, 'Enter code:'));
        cardEl.appendChild(el('div', { class: 'gh-code' }, v.user_code));
        cardEl.appendChild(el('div', { class: 'gh-status' }, 'Waiting for you to authorize…'));
      }
      setTimeout(() => gh.pollDeviceFlow(cardEl, statusEl), Math.max(2, (v && v.interval) || 5) * 1000);
    } catch (err) {
      cardEl.textContent = 'Poll failed: ' + err.message;
    }
  };

  // ---------- document history ----------
  gh.openHistory = async function openHistory(doc) {
    gh.historyDoc = doc;
    gh.historyCommits = [];
    gh.historyActiveOid = null;
    gh.historyOpen = true;
    $('#history-modal').classList.remove('hidden');
    $('#history-doc').textContent = doc.path;
    $('#history-commits').innerHTML = '<div class="empty" style="padding:20px;color:var(--text-dim);font-size:13px;">Loading commits…</div>';
    $('#history-diff').innerHTML = '<div class="empty">Select a commit on the left to see what changed.</div>';
    const { workspace, rel } = splitWorkspacePath(doc.path);
    try {
      const r = await fetch('/api/git/log?workspace=' + encodeURIComponent(workspace) +
                           '&path=' + encodeURIComponent(rel) + '&limit=200');
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'log failed');
      gh.historyCommits = j.commits || [];
      gh.renderHistoryCommits();
      if (gh.historyCommits.length) {
        gh.showHistoryDiff(gh.historyCommits[0].oid, gh.historyCommits[0].parents[0] || null);
      } else {
        $('#history-diff').innerHTML = '<div class="empty">No commits found for this file. ' +
          (gh.perWs.get(workspace) && gh.perWs.get(workspace).git.isRepo
            ? 'It may not have been committed yet.'
            : 'Initialize git for this workspace to start tracking history.') + '</div>';
      }
    } catch (err) {
      $('#history-commits').innerHTML = '';
      $('#history-diff').innerHTML = '<div class="empty">Error: ' + escapeHtml(err.message) + '</div>';
    }
  };

  gh.renderHistoryCommits = function renderHistoryCommits() {
    const host = $('#history-commits');
    host.innerHTML = '';
    if (!gh.historyCommits.length) {
      host.innerHTML = '<div class="empty" style="padding:20px;color:var(--text-dim);font-size:13px;">No commits.</div>';
      return;
    }
    for (const c of gh.historyCommits) {
      const row = el('div', { class: 'history-commit' + (c.oid === gh.historyActiveOid ? ' active' : '') });
      const when = new Date((c.author.timestamp || 0) * 1000);
      const ago = relativeTime(when);
      row.appendChild(el('div', { class: 'hc-msg' }, (c.message || '').split('\n')[0]));
      row.appendChild(el('div', { class: 'hc-meta' }, [
        el('code', null, c.oid.slice(0, 7)),
        document.createTextNode(' · ' + (c.author.name || '?') + ' · ' + ago),
      ]));
      row.addEventListener('click', () => {
        gh.showHistoryDiff(c.oid, c.parents[0] || null);
      });
      host.appendChild(row);
    }
  };

  gh.showHistoryDiff = async function showHistoryDiff(oid, parentOid) {
    gh.historyActiveOid = oid;
    gh.renderHistoryCommits();
    const { workspace, rel } = splitWorkspacePath(gh.historyDoc.path);
    const host = $('#history-diff');
    host.innerHTML = '<div class="empty">Loading diff…</div>';
    try {
      const q = '/api/git/diff?workspace=' + encodeURIComponent(workspace) +
                '&path=' + encodeURIComponent(rel) +
                '&oid=' + encodeURIComponent(oid) +
                (parentOid ? '&parent=' + encodeURIComponent(parentOid) : '');
      const r = await fetch(q);
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'diff failed');
      if (j.unchanged || !j.patch) {
        host.innerHTML = '<div class="empty">No changes to this file in this commit.</div>';
        return;
      }
      host.innerHTML = '';
      const ui = new window.Diff2HtmlUI(host, j.patch, {
        drawFileList: false,
        matching: 'lines',
        outputFormat: 'side-by-side',
        synchronisedScroll: true,
      });
      ui.draw();
    } catch (err) {
      host.innerHTML = '<div class="empty">Error: ' + escapeHtml(err.message) + '</div>';
    }
  };

  function closeHistoryModal() {
    gh.historyOpen = false;
    $('#history-modal').classList.add('hidden');
  }

  function relativeTime(d) {
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
