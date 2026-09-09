// ==UserScript==
// @name         学习通视频连播助手
// @namespace    local.chaoxing.study
// @version      1.1.0
// @description  视频连播、新旧目录自动下一节、视频页签切换、视频弹题选项逐项尝试、暂停及故障提示。
// @match        https://*.chaoxing.com/*
// @match        http://*.chaoxing.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self || document.getElementById('cx-study-helper')) return;
  if (!/\/(?:mycourse|mooc-ans)\//i.test(location.pathname)) return;

  const KEY = 'cx-study-helper-v1';
  const read = (storage, key, fallback) => {
    try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (storage, key, value) => {
    try { storage.setItem(key, JSON.stringify(value)); } catch { /* Private mode may block storage. */ }
  };
  const rates = [1, 1.25, 1.5, 1.75, 2];
  const saved = read(localStorage, KEY, {});
  const prefs = {
    rate: rates.includes(saved.rate) ? saved.rate : 1,
    muted: saved.muted === true,
    next: saved.next !== false,
    quiz: saved.quiz !== false,
  };
  const courseKey = () => {
    const p = new Map(Array.from(new URLSearchParams(location.search), ([k, v]) => [k.toLowerCase(), v]));
    const course = p.get('courseid') || document.querySelector('input#courseId,input#courseid,input[name="courseId"],input[name="courseid"]')?.value;
    const clazz = p.get('clazzid') || '';
    // Chapter/step query parameters are not a course identity.
    return course ? `${course}:${clazz}` : location.pathname;
  };
  let initialCourse = courseKey();
  const session = read(sessionStorage, KEY, {});
  let active = session.active === true && session.course === initialCourse && Date.now() - session.time < 4 * 3600000;
  let current = null;
  let docs = [];
  let videos = [];
  let inaccessible = 0;
  let generation = 0;
  let startedAt = Date.now();
  let transition = null;
  let advanceAt = 0;
  let lastSignature = '';
  let stableAt = Date.now();
  let lastPosition = -1;
  let lastProgressAt = Date.now();
  let eventCleanup = () => {};
  let dismissed = false;
  let stepAttempt = '';
  let quizState = null;
  const quizHistory = new Map();
  const completed = new WeakMap();
  const identities = new WeakMap();
  let identityCounter = 0;
  const identity = (node) => {
    if (!identities.has(node)) identities.set(node, ++identityCounter);
    return identities.get(node);
  };
  const source = (v) => v.currentSrc || v.src || v.querySelector('source')?.src || '';
  const mediaKey = v => chapterKey() + '|' + source(v);
  const isCompleted = (v) => completed.has(v) && completed.get(v) === mediaKey(v);
  const persist = () => write(sessionStorage, KEY, { active, course: initialCourse, time: Date.now() });
  const savePrefs = () => write(localStorage, KEY, prefs);

  const host = document.createElement('div');
  host.id = 'cx-study-helper';
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:calc(100vw - 24px)';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial;color-scheme:light;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:14px;color:#17253b}
      *{box-sizing:border-box}section{width:300px;max-width:calc(100vw - 24px);border:1px solid #dbe4ed;border-radius:16px;background:#fff;box-shadow:0 10px 42px #12243b2e;overflow:hidden}
      header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#edf5ff}strong{font-size:15px}button,select{font:inherit}
      button{border:1px solid #ccd9e6;border-radius:8px;padding:8px 12px;background:#fff;color:#17253b;cursor:pointer}button:hover{background:#edf5ff}
      header button{padding:1px 8px;border:0;background:transparent}main{padding:14px 16px}p{margin:0 0 12px;line-height:1.6;overflow-wrap:anywhere}
      #status{min-height:44px}#progress{color:#66758b;font-size:12px}label{display:flex;align-items:center;justify-content:space-between;margin:12px 0;gap:10px}
      select{padding:4px;border:1px solid #ccd9e6;border-radius:6px}input{accent-color:#2269cf}.buttons{display:flex;gap:8px;margin-top:14px}
      #toggle{background:#2269cf;color:#fff;border-color:#2269cf;flex:1}#diagnostic{font-size:12px;margin-top:10px;width:100%}small{display:block;color:#66758b;line-height:1.5;margin-top:12px}
      pre{white-space:pre-wrap;font-size:11px;color:#52657e;max-height:130px;overflow:auto} [hidden]{display:none!important}
    </style>
    <section aria-label="学习通视频连播助手">
      <header><strong>学习通 · 视频连播</strong><button id="fold" aria-label="收起面板">−</button></header>
      <main>
        <p id="status" role="status" aria-live="polite">就绪，点击开始。</p>
        <p id="progress">等待识别视频</p>
        <label>播放速度<select id="rate" aria-label="播放速度">${rates.map(r => `<option value="${r}">${r} 倍</option>`).join('')}</select></label>
        <label>静音播放<input id="muted" type="checkbox"></label>
        <label>播完后自动下一节<input id="next" type="checkbox"></label>
        <label>视频弹题逐项尝试<input id="quiz" type="checkbox"></label>
        <div class="buttons"><button id="toggle">开始连播</button><button id="rescan">重新识别</button></div>
        <button id="diagnostic">查看诊断信息</button><pre id="details" hidden></pre>
        <small>倍速以课程允许范围为准。完成状态请查看平台任务点。</small>
      </main>
    </section>`;
  document.body.appendChild(host);
  const $ = id => root.getElementById(id);
  const status = message => { if (!dismissed) $('status').textContent = message; };
  const syncButton = () => { $('toggle').textContent = active ? '暂停连播' : '开始连播'; };
  $('rate').value = String(prefs.rate);
  $('muted').checked = prefs.muted;
  $('next').checked = prefs.next;
  $('quiz').checked = prefs.quiz;
  syncButton();

  function visible(el) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    const css = el.ownerDocument.defaultView.getComputedStyle(el);
    return css.display !== 'none' && css.visibility !== 'hidden';
  }

  function scan() {
    docs = []; videos = []; inaccessible = 0;
    const visit = (doc, depth) => {
      if (depth > 10 || docs.includes(doc)) return;
      docs.push(doc);
      for (const v of doc.querySelectorAll('video')) if (visible(v)) videos.push(v);
      for (const frame of doc.querySelectorAll('iframe,frame')) {
        if (!visible(frame)) continue;
        try {
          const child = frame.contentWindow.document;
          if (child) visit(child, depth + 1);
        } catch { inaccessible++; }
      }
    };
    visit(document, 0);
    const sig = videos.map(v => `${identity(v)}:${source(v)}`).join('|');
    if (sig !== lastSignature) { lastSignature = sig; stableAt = Date.now(); advanceAt = 0; }
  }

  function needsAttention() {
    return docs.some(doc => Array.from(doc.querySelectorAll(
      '[role="dialog"],.layui-layer,.vjs-modal-dialog,#captcha,#validate,.chapterVideoFaceMaskDiv'
    )).some(el => visible(el) && /验证|人脸|未完成|异常|错误|重新登录|登录失效/.test(el.textContent || '') &&
      !el.matches('.ans-videoquiz,.ans-videoquiz-container,#videoquiz') &&
      !el.closest('.ans-videoquiz,.ans-videoquiz-container,#videoquiz') &&
      (!el.querySelector('.ans-videoquiz,.ans-videoquiz-container,#videoquiz') || /验证|人脸|重新登录|登录失效/.test(el.textContent || ''))));
  }

  function detach() { eventCleanup(); eventCleanup = () => {}; current = null; generation++; }

  function stop(message, pause = true) {
    active = false; advanceAt = 0; transition = null; generation++;
    persist(); syncButton();
    clearQuiz();
    if (pause && current && !current.paused) current.pause();
    status(message);
  }

  function applyPreferences(v) {
    v.muted = prefs.muted;
    // Set only on selection/user change, so a platform-enforced reset is respected.
    try { v.playbackRate = prefs.rate; } catch { status('课程播放器未接受所选倍速，将使用当前速度。'); }
  }

  function selectVideo(v) {
    detach();
    current = v;
    advanceAt = 0;
    const token = generation;
    const handlers = {
      ended: () => {
        if (!active || current !== v || !v.ended || !Number.isFinite(v.duration)) return;
        completed.set(v, mediaKey(v));
        detach();
        status('本段视频已结束，正在检查后续视频。');
      },
      pause: () => {
        // Ending a media resource emits pause before ended; inspect in the next task.
        setTimeout(() => {
          if (active && current === v && generation === token && v.paused && !v.ended) {
            scan();
            if (prefs.quiz && (quizState || findVideoQuiz())) return;
            stop('播放已暂停。处理页面提示后，点击开始连播。', false);
          }
        }, 1200);
      },
      error: () => { if (active && current === v) stop('视频加载失败，请检查网络或刷新课程页。'); },
      timeupdate: () => {
        if (v.currentTime !== lastPosition) { lastPosition = v.currentTime; lastProgressAt = Date.now(); }
      },
      ratechange: () => {
        if (active && current === v && v.playbackRate !== prefs.rate) status(`播放器当前使用 ${v.playbackRate} 倍速。`);
      },
      loadstart: () => {
        if (current === v) { completed.delete(v); detach(); stableAt = Date.now(); startedAt = Date.now(); }
      },
    };
    for (const [name, handler] of Object.entries(handlers)) v.addEventListener(name, handler);
    eventCleanup = () => { for (const [name, handler] of Object.entries(handlers)) v.removeEventListener(name, handler); };
    lastPosition = v.currentTime;
    lastProgressAt = Date.now();
    startedAt = Date.now();
    applyPreferences(v);
    status('正在启动视频…');
    try {
      const pending = v.play();
      Promise.resolve(pending).then(() => {
        if (!active || generation !== token || current !== v) {
          if (!active && !v.paused) v.pause();
          return;
        }
        status('正在播放，播完后将检查后续视频。');
      }).catch(error => {
        if (generation !== token || current !== v || !active) return;
        stop(error?.name === 'NotAllowedError'
          ? '浏览器阻止了自动播放。请先点击视频播放按钮，再点击开始连播。'
          : '播放器未能启动。请手动播放一次后重试。', false);
      });
    } catch { stop('播放器未能启动，请手动播放一次后重试。', false); }
  }

  function enabled(el) {
    return visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
      !el.closest('.disabled,.locked,[disabled],[aria-disabled="true"]');
  }

  function nextLink() {
    // Chapter trees identify a section; the footer often identifies only a learning step.
    for (const doc of docs) {
      const entries = Array.from(doc.querySelectorAll('#coursetree .posCatalog_select:not(.firstLayer)'));
      const index = entries.findIndex(el => el.classList.contains('posCatalog_active'));
      if (index >= 0) {
        const entry = entries[index + 1];
        if (!entry) return null;
        const target = entry.querySelector('.posCatalog_name') || entry.querySelector('a');
        // Collapsed chapter contents may be hidden, but still have a working click handler.
        if (target && !entry.closest('.locked,.disabled,[disabled],[aria-disabled="true"]')) return target;
        return null;
      }
    }
    for (const doc of docs) {
      const cells = Array.from(doc.querySelectorAll('.ncells'));
      const index = cells.findIndex(cell => cell.querySelector('h4.currents'));
      if (index < 0) continue;
      const next = cells[index + 1]?.querySelector('h4 > a');
      if (next && !next.closest('.locked,.disabled,[disabled],[aria-disabled="true"]')) return next;
      return null;
    }
    for (const doc of docs) {
      const direct = Array.from(doc.querySelectorAll('#prevNextFocusNext,#right1,.nextChapter')).find(enabled);
      if (direct) return direct;
    }
    return null;
  }

  function chapterKey() {
    const p = new Map(Array.from(new URLSearchParams(location.search), ([k, v]) => [k.toLowerCase(), v]));
    for (const doc of docs) {
      const entries = Array.from(doc.querySelectorAll('#coursetree .posCatalog_select:not(.firstLayer),.ncells'));
      const index = entries.findIndex(el => el.classList.contains('posCatalog_active') || el.querySelector('h4.currents'));
      if (index >= 0) return `${index}:${entries[index].id}`;
    }
    return p.get('chapterid') || p.get('knowledgeid') || '';
  }

  function enterVideoStep() {
    const key = chapterKey() + '|' + (transition?.time || startedAt);
    if (stepAttempt === key) return false;
    for (const doc of docs) {
      const candidates = Array.from(doc.querySelectorAll('.prev_white,.tabtags li,.tabtags span,[role="tab"]'));
      const tab = candidates.find(el => enabled(el) && /^(?:\d+[.、]?)?视频$/.test((el.textContent || '').replace(/\s/g, '')) &&
        !el.matches('.currents,.active,[aria-selected="true"]'));
      if (!tab) continue;
      stepAttempt = key;
      status('正在进入本节的“视频”页签…');
      tab.click();
      return true;
    }
    return false;
  }

  const QUIZ_BOX = '.ans-videoquiz,.ans-videoquiz-container,#videoquiz';
  const QUIZ_FEEDBACK = '.ans-videoquiz-tip,.ans-videoquiz-tips,.ans-videoquiz-result,.ans-videoquiz-feedback,.ans-videoquiz-error,[role="alert"]';

  function findVideoQuiz() {
    for (const doc of docs) {
      if (!doc.querySelector('video')) continue;
      const boxes = Array.from(doc.querySelectorAll(QUIZ_BOX)).filter(visible);
      // Prefer the inner dialog when platform versions nest quiz containers.
      const box = boxes.find(el => !boxes.some(other => other !== el && el.contains(other)));
      if (box) return box;
    }
    return null;
  }

  function clearQuiz() {
    quizState?.observer?.disconnect();
    quizState = null;
  }

  function quizFeedback(box) {
    return Array.from(box.querySelectorAll(QUIZ_FEEDBACK)).filter(visible).map(el => el.textContent.trim()).join(' ');
  }

  function quizOptions(box) {
    const inputs = Array.from(box.querySelectorAll('input[type="radio"],input[type="checkbox"]'));
    if (!inputs.length) return [];
    return inputs.map(input => {
      const label = Array.from(input.labels || []).find(el => box.contains(el) && visible(el));
      const target = label || (visible(input) ? input : null);
      return { input, target, text: (label?.textContent || input.closest('.ans-videoquiz-opt')?.textContent || input.getAttribute('aria-label') || input.value).trim() };
    });
  }

  function quizPlans(options) {
    if (options.every(o => o.input.type === 'radio')) return options.map((_, i) => [i]);
    if (!options.every(o => o.input.type === 'checkbox') || options.length > 5) return [];
    // Try individual choices first, then larger combinations; at most 31 submissions.
    return Array.from({ length: (1 << options.length) - 1 }, (_, mask) =>
      options.flatMap((_, i) => ((mask + 1) & (1 << i)) ? [i] : []))
      .sort((a, b) => a.length - b.length);
  }

  function watchQuiz(state, box) {
    state.observer?.disconnect(); state.box = box; state.revision++;
    state.observer = new MutationObserver(records => {
      if (records.some(r => {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        return el?.closest(QUIZ_FEEDBACK) || Array.from(r.addedNodes || []).some(n =>
          n.nodeType === 1 && (n.matches(QUIZ_FEEDBACK) || n.querySelector(QUIZ_FEEDBACK)));
      })) state.revision++;
    });
    state.observer.observe(box, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
  }

  function handleVideoQuiz() {
    const box = findVideoQuiz();
    if (!box) {
      if (!quizState) return false;
      // Allow transient DOM replacement; a closed quiz is not recorded as a completed task.
      if (!quizState.absentAt) quizState.absentAt = Date.now();
      if (Date.now() - quizState.absentAt < 1500) return true;
      const v = quizState.video;
      clearQuiz();
      if (active && v?.isConnected && !v.ended && visible(v)) selectVideo(v);
      return true;
    }
    if (!prefs.quiz) { stop('检测到视频答题弹窗，请手动作答或开启“视频弹题逐项尝试”。'); return true; }
    const options = quizOptions(box);
    const submit = box.querySelector('#videoquiz-submit,.ans-videoquiz-submit,button[type="submit"]');
    const video = box.closest('.video-js')?.querySelector('video') || box.ownerDocument.querySelector('video');
    const stem = box.querySelector('.ans-videoquiz-tit,.ans-videoquiz-title,.videoquiz-title,.tkTopic')?.textContent.trim() || '';
    const resultOnly = !options.length && quizState && ['waiting', 'accepted'].includes(quizState.phase) && quizState.video === video;
    const key = resultOnly ? quizState.key : `${chapterKey()}|${source(video)}|${box.getAttribute('data-question-id') || ''}|${stem}|${options.map(o => o.text).join('|')}`;
    if (!quizState || quizState.key !== key) {
      clearQuiz();
      if (options.length < 2 || options.length > 8 || options.some(o => !o.target) || !submit) {
        stop('视频弹题结构暂不支持，请手动作答并提供弹窗结构。'); return true;
      }
      const groups = new Set(options.filter(o => o.input.type === 'radio').map(o => o.input.name));
      const plans = quizPlans(options);
      if (!plans.length || groups.size > 1) { stop('弹窗含多个题组或过多多选组合，请手动作答。'); return true; }
      const history = quizHistory.get(key) || { attempts: 0 };
      quizHistory.set(key, history);
      if (quizHistory.size > 100) quizHistory.delete(quizHistory.keys().next().value);
      quizState = { key, box, video, plans, history, phase: 'choose', nextAt: Date.now() + 1000,
        revision: 0, observer: null, absentAt: 0, createdAt: Date.now() };
      watchQuiz(quizState, box);
      if (video && !video.paused) video.pause();
    }
    const q = quizState;
    q.absentAt = 0;
    if (q.box !== box) watchQuiz(q, box);
    lastProgressAt = Date.now();
    advanceAt = 0;
    const feedback = quizFeedback(box);
    if (/次数.{0,6}(?:用完|上限|不足)|不允许.{0,4}(?:重试|作答)|无法再次|已锁定/.test(feedback)) {
      stop('弹题已限制重试，请手动处理。'); return true;
    }
    if (Date.now() - q.createdAt > 180000) { stop('弹题处理超过 3 分钟，已暂停。'); return true; }
    if (q.phase === 'choose') {
      if (Date.now() < q.nextAt) return true;
      if (q.history.attempts >= q.plans.length) { stop('视频弹题的候选选项已尝试完，请手动作答。'); return true; }
      if (options.some(o => o.input.disabled) || !enabled(submit)) {
        if (Date.now() - q.nextAt > 15000) stop('弹题选项或提交按钮不可用，请手动处理。');
        return true;
      }
      const plan = q.plans[q.history.attempts];
      for (let i = 0; i < options.length; i++) {
        const { input, target } = options[i];
        if (input.type === 'checkbox' ? input.checked !== plan.includes(i) : plan.includes(i) && !input.checked) target.click();
      }
      const actual = options.flatMap((o, i) => o.input.checked ? [i] : []);
      if (actual.join(',') !== plan.join(',')) { stop('选项未成功选中，已停止提交，请手动作答。'); return true; }
      q.phase = 'submit'; q.nextAt = Date.now() + 800;
      status(`视频弹题：已选择 ${plan.map(i => String.fromCharCode(65 + i)).join('+')}，等待提交。`);
      return true;
    }
    if (q.phase === 'submit') {
      if (Date.now() < q.nextAt) return true;
      const plan = q.plans[q.history.attempts];
      const actual = options.flatMap((o, i) => o.input.checked ? [i] : []);
      if (actual.join(',') !== plan.join(',') || !enabled(submit)) {
        stop('提交前选项或按钮状态发生变化，请手动处理。'); return true;
      }
      q.phase = 'waiting'; q.submittedAt = Date.now();
      q.feedbackBefore = feedback; q.revisionBefore = q.revision;
      q.history.attempts++;
      submit.click();
      status(`视频弹题：第 ${q.history.attempts} 次提交，等待页面反馈…`);
      return true;
    }
    if (q.phase === 'waiting') {
      const elapsed = Date.now() - q.submittedAt;
      if (elapsed < 1800) return true;
      const fresh = q.revision > q.revisionBefore || feedback !== q.feedbackBefore;
      if (fresh && /回答错误|答题错误|答案错误|回答不正确|答案不正确|答错|不正确|请重新(?:选择|作答)|再试一次/.test(feedback)) {
        q.phase = 'choose'; q.nextAt = Date.now() + 1000;
        status('视频弹题：当前选择未通过，准备尝试下一项。');
      } else if (fresh && /回答正确|答题正确|答案正确|恭喜|回答成功/.test(feedback)) {
        q.phase = 'accepted'; q.nextAt = Date.now();
        status('视频弹题：页面提示回答正确，等待继续播放。');
      } else if (elapsed > 15000) stop('弹题提交后未识别到结果，已暂停以避免重复提交。');
      return true;
    }
    if (q.phase === 'accepted') {
      const proceed = Array.from(box.querySelectorAll('button,a,input[type="button"],.ans-videoquiz-submit')).find(el =>
        enabled(el) && /^(?:继续播放|继续学习|继续|确定)$/.test((el.textContent || el.value || '').trim()));
      if (proceed && !q.continued) { q.continued = true; proceed.click(); }
      if (Date.now() - q.nextAt > 15000) stop('弹题已通过，但弹窗尚未关闭，请手动继续。');
      return true;
    }
    return true;
  }

  function formatTime(n) {
    if (!Number.isFinite(n) || n < 0) return '--:--';
    return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  }

  function tick() {
    if (dismissed) return;
    scan();
    const liveCourse = courseKey();
    if (initialCourse.startsWith('/') && !liveCourse.startsWith('/')) { initialCourse = liveCourse; persist(); }
    else if (liveCourse !== initialCourse) { stop('课程已改变，请刷新页面后开始。'); return; }
    if (current && !videos.includes(current)) { detach(); startedAt = Date.now(); }
    $('progress').textContent = current
      ? `${formatTime(current.currentTime)} / ${formatTime(current.duration)} · ${current.playbackRate} 倍 · 本页 ${videos.length} 段视频`
      : `识别到 ${videos.length} 段视频${inaccessible ? ` · ${inaccessible} 个内嵌页面无法访问` : ''}`;
    if (!active) return;
    if (needsAttention()) { stop('页面有待处理的验证、测验或提示，请处理后继续。'); return; }
    if (handleVideoQuiz()) return;
    if (transition) {
      const changedMedia = lastSignature !== transition.signature && videos.some(v => v.readyState >= 1 && !isCompleted(v));
      const reusedMedia = chapterKey() !== transition.chapter && videos.some(v => v.readyState >= 1 && !v.ended && !isCompleted(v));
      if (changedMedia || reusedMedia) {
        transition = null; startedAt = Date.now();
      } else if (Date.now() - transition.time > 20000) {
        stop('下一节未加载出新视频，请手动进入视频页后重新开始。');
        return;
      } else {
        if (!videos.some(v => !v.ended && !isCompleted(v))) enterVideoStep();
        return;
      }
    }
    // Poll the native ended flag as well: some players replace listeners or finish before attachment.
    for (const v of videos) {
      if (v.ended && Number.isFinite(v.duration) && v.duration > 0) completed.set(v, mediaKey(v));
    }
    if (current?.ended) detach();
    if (current) {
      if (Date.now() - lastProgressAt > 90000) stop('视频超过 90 秒没有推进，请检查网络或页面提示。');
      return;
    }
    const candidate = videos.find(v => !isCompleted(v) && !v.ended);
    if (candidate) {
      if (candidate.readyState < 1) {
        if (Date.now() - startedAt > 45000) stop('视频信息加载超时，请手动检查播放器。');
        return;
      }
      selectVideo(candidate); return;
    }
    if (!videos.length) {
      if (enterVideoStep()) return;
      if (Date.now() - startedAt > 20000) stop(inaccessible
        ? '播放器可能位于跨域内嵌页，当前版本无法访问。请提供播放页网址以适配。'
        : '此页未识别到视频，请手动进入视频任务后重新开始。');
      else status('等待课程视频加载…');
      return;
    }
    if (!videos.every(isCompleted)) { stop('视频状态尚未确认，请重新识别后继续。'); return; }
    if (!prefs.next) { stop('本页视频已播完，自动下一节已关闭。', false); return; }
    // Unrelated cross-origin widgets must not prevent navigation when the video is accessible.
    if (Date.now() - stableAt < 3000) return;
    if (!advanceAt) { advanceAt = Date.now() + 5000; status('本页视频已播完，5 秒后进入下一节。可点击暂停取消。'); return; }
    if (Date.now() < advanceAt) return;
    const target = nextLink();
    if (!target) { stop('未找到可用的下一节入口，可能已到末节或目录结构不同。', false); return; }
    transition = { signature: lastSignature, chapter: chapterKey(), time: Date.now() };
    advanceAt = 0; persist();
    status('已点击下一节，等待新视频加载…');
    target.click();
  }

  $('toggle').addEventListener('click', () => {
    if (active) { stop('已暂停。'); return; }
    detach(); active = true; startedAt = Date.now(); stableAt = Date.now(); stepAttempt = '';
    persist(); syncButton(); tick();
  });
  $('rescan').addEventListener('click', () => { scan(); status(`已识别 ${videos.length} 段视频。${active ? '连播运行中。' : '点击开始连播。'}`); });
  $('rate').addEventListener('change', () => {
    prefs.rate = Number($('rate').value); savePrefs(); if (active && current) applyPreferences(current);
  });
  $('muted').addEventListener('change', () => {
    prefs.muted = $('muted').checked; savePrefs(); if (active && current) current.muted = prefs.muted;
  });
  $('next').addEventListener('change', () => { prefs.next = $('next').checked; advanceAt = 0; savePrefs(); });
  $('quiz').addEventListener('change', () => {
    prefs.quiz = $('quiz').checked; savePrefs();
    if (!prefs.quiz && quizState) stop('已关闭视频弹题尝试，请手动作答。');
  });
  $('fold').addEventListener('click', () => {
    const main = root.querySelector('main'); main.hidden = !main.hidden;
    $('fold').textContent = main.hidden ? '+' : '−';
    $('fold').setAttribute('aria-label', main.hidden ? '展开面板' : '收起面板');
  });
  $('diagnostic').addEventListener('click', () => {
    const details = $('details'); details.hidden = !details.hidden;
    // Deliberately omit query strings, media URLs, account data and cookies.
    details.textContent = JSON.stringify({ version: '1.1.0', page: location.origin + location.pathname,
      accessibleDocuments: docs.length, inaccessibleFrames: inaccessible, videos: videos.length,
      navigation: { modernEntries: docs.reduce((n, d) => n + d.querySelectorAll('#coursetree .posCatalog_select:not(.firstLayer)').length, 0),
        legacyEntries: docs.reduce((n, d) => n + d.querySelectorAll('.ncells').length, 0),
        nextFound: !!nextLink(), waitingForChapter: !!transition },
      quiz: { enabled: prefs.quiz, detected: !!findVideoQuiz(), phase: quizState?.phase || null, attempts: quizState?.history.attempts || 0 },
      active, media: videos.map(v => ({ readyState: v.readyState, paused: v.paused, ended: v.ended,
        time: Math.round(v.currentTime), duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        rate: v.playbackRate, errorCode: v.error?.code || null })) }, null, 2);
  });
  const timer = setInterval(() => {
    try { tick(); } catch { stop('页面结构出现异常，请刷新或提供诊断信息。'); }
  }, 1000);
  window.addEventListener('pagehide', () => { persist(); clearInterval(timer); clearQuiz(); detach(); dismissed = true; });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  tick();
})();
