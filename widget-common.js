// Claude Voice Bridge — ウィジェット共通スクリプト(2026-09-27追加)
//
// サイドパネル(sidepanel.html)のタスク一覧・定例文・スキル呼び出し文言を、それぞれ
// 単体ページ(widget-tasks.html/widget-phrases.html/widget-skill-phrases.html)へ切り出し、
// サイドパネル側からiframeで呼び出す構成にした。各ウィジェットページは拡張機能内では
// それぞれ別々のJS実行コンテキストになるため、sidepanel.jsが持っていたmode(Claude/Gemini
// どちらのタブを対象にするか)などの状態を直接共有できない。代わりにchrome.storage.local
// (cvb_mode)を経由して読み取る。
//
// ユーザー指示: 「タスク一覧のみを1つのウィジェット(見える部分のみをビューアーとして
// 呼び出すだけ)にしたい」「スキル呼び出し文言と定例文も同じ様にウィジェット管理として」。
// 各ウィジェットは表示・クリック操作のみを担当し、抽出トリガー・GitHub同期・定例文編集
// などの「管理」操作はサイドパネル本体(host)側に残す(cvb-response-readyの受信待ち
// (pendingAuditRequest)は音声モードとの排他制御が絡むため、hostだけが持つ設計を維持)。

(function () {
  "use strict";

  const SITE_ORIGINS = { claude: "https://claude.ai/", gemini: "https://gemini.google.com/" };
  const SITE_LABELS = { claude: "claude.ai", gemini: "Gemini" };

  // sidepanel.js側のmode(音声モードで選択中のAI)をchrome.storage.localから読む。
  // 未設定ならデフォルトのclaudeとする(sidepanel.js側の初期値と同じ)。
  async function getMode() {
    const stored = await chrome.storage.local.get("cvb_mode");
    return stored.cvb_mode === "gemini" ? "gemini" : "claude";
  }

  async function getActiveTabId() {
    const mode = await getMode();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith(SITE_ORIGINS[mode])) {
      return null;
    }
    return { tabId: tab.id, mode };
  }

  // statusElへ状態文言を表示する。sidepanel.jsのsetStatus()の簡易版(オーブ・音量表示は無い)。
  function makeStatusSetter(statusEl) {
    return function setStatus(text, kind) {
      statusEl.textContent = text || "";
      statusEl.classList.toggle("error", kind === "error");
    };
  }

  // key(chrome.storage.localのキー)が他のページ(サイドパネル本体や他のウィジェット)
  // から変更されたときにcallbackを呼ぶ。ウィジェットは独立したJSコンテキストのため、
  // これが無いと他ページでの更新(抽出結果・定例文保存等)が反映されない。
  function watchStorageKey(key, callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[key]) return;
      callback(changes[key].newValue);
    });
  }

  // ウィジェットはサイドパネル本体からiframeとして呼び出されるため、内容量(タスクの
  // 件数、定例文の件数)に応じてiframeの高さを親側で調整できるよう、自分のbodyの
  // 高さをpostMessageで報告し続ける(ResizeObserverで内容の増減を監視)。
  function reportHeightToParent() {
    if (window.parent === window) return; // 単体で開かれた場合は何もしない
    const send = () => {
      window.parent.postMessage({ type: "cvb-widget-resize", height: document.body.scrollHeight }, "*");
    };
    new ResizeObserver(send).observe(document.body);
    send();
  }

  window.CvbWidgetCommon = { SITE_LABELS, getActiveTabId, makeStatusSetter, watchStorageKey, reportHeightToParent };
})();
