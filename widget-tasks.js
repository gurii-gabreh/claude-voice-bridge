// Claude Voice Bridge — タスク一覧ウィジェット(2026-09-27追加)
//
// sidepanel.htmlのタスク一覧部分をそのまま単体ページとして切り出したもの。
// サイドパネル本体からは<iframe src="widget-tasks.html">として呼び出される
// (ユーザー指示「タスク一覧のみを1つのウィジェット(見える部分のみをビューアーとして
// 呼び出すだけ)にしたい」)。
//
// 抽出トリガー(🔄 タスク一覧を更新)・GitHub同期・GitHubからの読み込みは
// サイドパネル本体(sidepanel.js)側に残したまま(pendingAuditRequestによる
// 音声モードとの排他制御が必要なため)。このウィジェットは表示専用で、
// tracker-store.jsのchrome.storage.onChangedリスナー経由で他ページ(サイドパネル
// 本体)での更新を自動的に受け取る。

(function () {
  "use strict";

  const { SITE_LABELS, getActiveTabId, makeStatusSetter, reportHeightToParent } = window.CvbWidgetCommon;

  const trackerTableEl = document.getElementById("tracker-table");
  const trackerTbodyEl = document.getElementById("tracker-tbody");
  const trackerEmptyEl = document.getElementById("tracker-empty");
  const trackerRepoFilterEl = document.getElementById("tracker-repo-filter");
  const statusEl = document.getElementById("widget-status");
  const setStatus = makeStatusSetter(statusEl);

  let trackerRepoFilter = "";
  let lastFindMarker = null; // navigateToTaskId用。content.js側のカーソルとは別に、こちら側でも前回の検索語を覚えて先頭からやり直すか判定する。

  function roomLabel(source) {
    if (!source) return "-";
    const siteLabel = source.mode ? (SITE_LABELS[source.mode] || source.mode) : "";
    const title = (source.title || "").trim();
    const shortTitle = title.length > 20 ? title.slice(0, 20) + "…" : title;
    return [siteLabel, shortTitle].filter(Boolean).join(": ") || "-";
  }

  function buildJumpSearchText(item, displayTaskId) {
    const marker = item.taskIdMarker;
    if (marker) {
      const m = marker.match(/^(回答|発言)(.+?)-\d+$/);
      if (m && m[1] === "回答") {
        return { text: `【回答${m[2]}】`, label: `タスクID: ${displayTaskId}(元の回答)` };
      }
    }
    if (item.quote) {
      return { text: item.quote, label: `タスクID: ${displayTaskId}(引用箇所)` };
    }
    return { text: `【タスクID:${marker || displayTaskId}】`, label: `タスクID: ${displayTaskId}` };
  }

  async function navigateToTaskId(searchText, statusLabel) {
    const active = await getActiveTabId();
    if (!active) {
      setStatus("claude.ai/Geminiのタブを開いて、アクティブにしてください", "error");
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(active.tabId, { type: "cvb-scroll-to-occurrence", text: searchText });
      if (!res || !res.ok) {
        setStatus(`「${searchText}」がルーム内に見つかりませんでした`, "error");
        return;
      }
      setStatus(`${statusLabel}の箇所へ移動しました(クリックのたびに次の出現箇所へ)`);
    } catch (e) {
      setStatus(`${SITE_LABELS[active.mode]}のタブをリロードしてください`, "error");
    }
  }

  function copyItemToClipboard(item) {
    const text = `【${item.kind}】${item.summary}`;
    navigator.clipboard.writeText(text).then(
      () => setStatus("内容をコピーしました"),
      () => setStatus("コピーに失敗しました", "error")
    );
  }

  function renderTrackerRepoFilterOptions(allItems) {
    const repos = new Set(allItems.map((item) => item.repo || "不明"));
    const prevValue = trackerRepoFilterEl.value;
    trackerRepoFilterEl.innerHTML = `<option value="">すべてのアプリ</option>`;
    Array.from(repos)
      .sort((a, b) => a.localeCompare(b, "ja"))
      .forEach((repo) => {
        const opt = document.createElement("option");
        opt.value = repo;
        opt.textContent = repo;
        trackerRepoFilterEl.appendChild(opt);
      });
    if (repos.has(prevValue) || prevValue === "") {
      trackerRepoFilterEl.value = prevValue;
      trackerRepoFilter = prevValue;
    } else {
      trackerRepoFilterEl.value = "";
      trackerRepoFilter = "";
    }
  }

  trackerRepoFilterEl.addEventListener("change", () => {
    trackerRepoFilter = trackerRepoFilterEl.value;
    renderTracker();
  });

  function renderTracker() {
    const tracker = window.TrackerStore.getData();
    trackerTbodyEl.innerHTML = "";
    const allActiveItems = (tracker.items || []).filter((item) => item.status !== "done");
    renderTrackerRepoFilterOptions(allActiveItems);
    const activeItems = trackerRepoFilter
      ? allActiveItems.filter((item) => (item.repo || "不明") === trackerRepoFilter)
      : allActiveItems;

    activeItems.forEach((item, index) => {
      const tr = document.createElement("tr");
      const isConsult = item.kind === "相談";
      tr.innerHTML =
        `<td></td>` +
        `<td class="tracker-text"></td>` +
        `<td class="tracker-room"></td>` +
        `<td><span class="tracker-badge ${isConsult ? "waiting" : "working"}">${isConsult ? "回答待ち" : "作業中"}${item.uncertain ? "・不確実" : ""}</span></td>` +
        `<td></td>`;

      const numCell = tr.firstElementChild;
      const numBtn = document.createElement("button");
      numBtn.className = "tracker-num";
      numBtn.type = "button";
      const displayTaskId = index + 1;
      const jump = buildJumpSearchText(item, displayTaskId);
      numBtn.textContent = `タスクID: ${displayTaskId}`;
      numBtn.title = "クリックでルーム内の該当箇所(元の回答)へ移動(連続クリックで次の出現箇所へ)";
      numBtn.onclick = () => navigateToTaskId(jump.text, jump.label);
      numCell.appendChild(numBtn);

      const textCell = tr.querySelector(".tracker-text");
      const repoBadge = document.createElement("span");
      repoBadge.className = "tracker-repo-badge";
      repoBadge.textContent = item.repo || "不明";
      textCell.appendChild(repoBadge);
      textCell.appendChild(document.createTextNode(item.summary || "(内容不明)"));
      tr.querySelector(".tracker-room").textContent = roomLabel(item.source);

      const actionsCell = tr.lastElementChild;
      const copyBtn = document.createElement("button");
      copyBtn.className = "tracker-copy";
      copyBtn.type = "button";
      copyBtn.textContent = "📋";
      copyBtn.title = "内容をコピー";
      copyBtn.onclick = () => copyItemToClipboard(item);
      actionsCell.appendChild(copyBtn);

      const dismissBtn = document.createElement("button");
      dismissBtn.className = "tracker-dismiss";
      dismissBtn.type = "button";
      dismissBtn.textContent = "✕";
      dismissBtn.title = "一覧から外す(次回の抽出でまだ未解決なら再度出ます)";
      dismissBtn.onclick = () => window.TrackerStore.dismissItem(item.id);
      actionsCell.appendChild(dismissBtn);

      trackerTbodyEl.appendChild(tr);
    });

    trackerTableEl.classList.toggle("has-items", activeItems.length > 0);
    trackerEmptyEl.style.display = activeItems.length ? "none" : "block";
  }

  window.TrackerStore.onChange(renderTracker);
  window.TrackerStore.load();
  reportHeightToParent();
})();
