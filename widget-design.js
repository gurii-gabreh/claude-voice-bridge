// Claude Voice Bridge — 「📐 基本設計」ウィジェット共通スクリプト(2026-09-27追加)
//
// Knowledge-Dashboardの「📐 アプリ基本設計」タブと同じロジックの移植。
// progress-tracker-dashboardの data/requirements.json を直接fetchし、
// アプリ選択ドロップダウン・10項目Q&A・懸念点照合(concernReview)・
// 懸念点マスタ一覧(concerns)を表示するだけのビューアー(編集はしない)。

(function () {
  "use strict";

  const { makeStatusSetter, reportHeightToParent } = window.CvbWidgetCommon;

  const REQUIREMENTS_URL =
    "https://raw.githubusercontent.com/gurii-gabreh/progress-tracker-dashboard/main/data/requirements.json";

  const statsEl = document.getElementById("design-stats");
  const selEl = document.getElementById("design-app-sel");
  const emptyEl = document.getElementById("design-empty");
  const detailEl = document.getElementById("design-detail");
  const genNoteEl = document.getElementById("design-gen-note");
  const statusEl = document.getElementById("widget-status");
  const setStatus = makeStatusSetter(statusEl);

  let designData = null;
  let selectedId = null;

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function appLabel(req) {
    return `${req.repo} — ${req.title}`;
  }

  function renderStats() {
    const reqs = (designData && designData.requirements) || [];
    const statusCounts = {};
    reqs.forEach((r) => {
      const s = r.status || "不明";
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const tiles = [
      { num: reqs.length, label: "登録アプリ数" },
      ...Object.entries(statusCounts).map(([status, num]) => ({ num, label: status })),
    ];
    statsEl.innerHTML = tiles
      .map((t) => `<div class="design-stat-tile"><div class="num">${t.num}</div><div class="label">${escapeHtml(t.label)}</div></div>`)
      .join("");
  }

  function renderAppOptions() {
    const reqs = (designData && designData.requirements) || [];
    selEl.innerHTML = "";
    reqs.forEach((req) => {
      const opt = document.createElement("option");
      opt.value = req.id;
      opt.textContent = appLabel(req);
      selEl.appendChild(opt);
    });
    if (reqs.length) {
      if (!selectedId || !reqs.some((r) => r.id === selectedId)) {
        selectedId = reqs[0].id;
      }
      selEl.value = selectedId;
    }
  }

  function findConcernById(concernsItems, id) {
    return (concernsItems || []).find((c) => c.id === id);
  }

  function renderConcernCard(review, concernsItems) {
    if (review.concernId) {
      const master = findConcernById(concernsItems, review.concernId);
      const trend = master ? master.trend : "(懸念点マスタに見つかりません)";
      return `
        <div class="concern-card">
          <span class="concern-id">${escapeHtml(review.concernId)}</span>
          <div class="concern-trend">${escapeHtml(trend || "")}</div>
          <dl>
            <dt>該当した理由</dt><dd>${escapeHtml(review.matchedBecause || "")}</dd>
            <dt>相談した結果・最終的な結論</dt><dd>${escapeHtml(review.resolution || "")}</dd>
          </dl>
        </div>`;
    }
    return `
      <div class="concern-card novel">
        <span class="concern-id">新規懸念(concerns未登録)</span>
        <div class="concern-trend">${escapeHtml(review.description || "")}</div>
        <dl>
          <dt>相談した結果・最終的な結論</dt><dd>${escapeHtml(review.resolution || "")}</dd>
        </dl>
      </div>`;
  }

  function renderDetail() {
    const reqs = (designData && designData.requirements) || [];
    const concernsItems = (designData && designData.concerns && designData.concerns.items) || [];

    if (!reqs.length) {
      detailEl.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    const req = reqs.find((r) => r.id === selectedId) || reqs[0];

    const qaHtml = (req.answers || [])
      .map(
        (a) => `
        <div class="design-qa-item">
          <div class="q"><span class="n">${a.n}.</span>${escapeHtml(a.question || "")}</div>
          <div class="a">${escapeHtml(a.answer || "")}</div>
        </div>`
      )
      .join("");

    const reviewItems = req.concernReview || [];
    const reviewHtml = reviewItems.length
      ? reviewItems.map((r) => renderConcernCard(r, concernsItems)).join("")
      : `<p id="design-no-concern-note" style="font-size:11px;color:var(--ink-soft);margin:0;">このアプリで該当した懸念点はありません。</p>`;

    const masterHtml = concernsItems
      .map(
        (c) => `
        <div class="concern-card">
          <span class="concern-id">${escapeHtml(c.id)}</span>
          <div class="concern-trend">${escapeHtml(c.trend || "")}</div>
          <dl>
            <dt>対策</dt><dd>${escapeHtml(c.mitigation || "")}</dd>
          </dl>
        </div>`
      )
      .join("");

    detailEl.innerHTML = `
      <div class="design-head">
        <h2>${escapeHtml(req.title || req.repo || "")}</h2>
        <span class="design-tag repo">${escapeHtml(req.repo || "")}</span>
        <span class="design-tag">${escapeHtml(req.status || "不明")}</span>
      </div>
      <div class="design-flow-bar">① 標準10項目に回答<span class="arrow">→</span>② まとめて懸念点(concerns)と照合</div>
      <div class="design-qa-list">${qaHtml}</div>
      <div class="design-section-title">⚠️ このアプリで該当した懸念点(concernReview)</div>
      ${reviewHtml}
      <div class="design-section-title">📖 懸念点マスタ一覧(concerns)</div>
      ${masterHtml}
    `;
  }

  selEl.addEventListener("change", (e) => {
    selectedId = e.target.value;
    renderDetail();
  });

  async function load() {
    try {
      const res = await fetch(`${REQUIREMENTS_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      designData = await res.json();
    } catch (e) {
      designData = null;
      setStatus("要件定義データの取得に失敗しました。時間を置いて再度お試しください", "error");
    }
    renderStats();
    renderAppOptions();
    renderDetail();
    genNoteEl.textContent = designData
      ? "取得元: raw.githubusercontent.com(progress-tracker-dashboard、キャッシュ無し毎回取得)"
      : "";
  }

  load();
  reportHeightToParent();
})();
