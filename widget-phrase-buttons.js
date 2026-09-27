// Claude Voice Bridge — 定例文/スキル呼び出し文言ウィジェット共通スクリプト(2026-09-27追加)
//
// sidepanel.htmlの「📌 定例文」「🔧 スキル呼び出し文言」ボタン一覧を単体ページとして
// 切り出したもの。両方とも同じ`cvb_templates`(chrome.storage.local)を読み、
// t.type==="skill"かどうかで表示対象を分けるだけの違いのため、1本のスクリプトを
// widget-phrases.html/widget-skill-phrases.htmlの両方から<body data-phrase-type="...">
// で使い分けて読み込む。
//
// 編集(textarea+保存)はサイドパネル本体側に残す(このウィジェットは表示・クリックのみ)。

(function () {
  "use strict";

  const { getActiveTabId, makeStatusSetter, watchStorageKey, reportHeightToParent } = window.CvbWidgetCommon;
  const showSkillOnly = document.body.dataset.phraseType === "skill";

  const buttonsEl = document.getElementById("phrase-buttons");
  const emptyEl = document.getElementById("phrase-empty");
  const statusEl = document.getElementById("widget-status");
  const setStatus = makeStatusSetter(statusEl);

  // sidepanel.jsのDEFAULT_TEMPLATESと同じ既定値だが、ウィジェット単体でも初回表示が
  // 空にならないよう最小限だけ持つ(cvb_templatesが未設定の場合のフォールバック)。
  const DEFAULT_TEMPLATES_FALLBACK = [];

  async function insertTextToPage(text) {
    const active = await getActiveTabId();
    if (!active) {
      setStatus("claude.ai/Geminiのタブを開いて、アクティブにしてください", "error");
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(active.tabId, { type: "cvb-insert-text", text });
      if (!res || !res.ok) {
        setStatus("入力欄が見つかりませんでした。手動セレクタ設定を確認してください", "error");
      }
    } catch (e) {
      setStatus("ページとの通信に失敗しました(ページを再読み込みしてください)", "error");
    }
  }

  function renderButtons(templates) {
    buttonsEl.innerHTML = "";
    const targets = (templates || []).filter((t) => (t.type === "skill") === showSkillOnly);
    emptyEl.style.display = targets.length ? "none" : "block";
    targets.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "phrase-btn";
      btn.textContent = t.text;
      btn.title = t.text;
      btn.addEventListener("click", () => insertTextToPage(t.text));

      if (showSkillOnly && t.description) {
        const row = document.createElement("div");
        row.className = "phrase-row";
        const helpBtn = document.createElement("button");
        helpBtn.type = "button";
        helpBtn.className = "phrase-help-btn";
        helpBtn.textContent = "❓";
        helpBtn.title = "この文言の使いどころを表示";
        const descEl = document.createElement("div");
        descEl.className = "phrase-desc";
        descEl.textContent = t.description;
        descEl.style.display = "none";
        helpBtn.addEventListener("click", () => {
          descEl.style.display = descEl.style.display === "none" ? "block" : "none";
        });
        row.appendChild(btn);
        row.appendChild(helpBtn);
        buttonsEl.appendChild(row);
        buttonsEl.appendChild(descEl);
      } else {
        buttonsEl.appendChild(btn);
      }
    });
  }

  async function load() {
    const stored = await chrome.storage.local.get("cvb_templates");
    renderButtons(stored.cvb_templates && stored.cvb_templates.length ? stored.cvb_templates : DEFAULT_TEMPLATES_FALLBACK);
  }

  // サイドパネル本体側での保存・GitHub読み込みによる更新を反映する。
  watchStorageKey("cvb_templates", (newValue) => renderButtons(newValue || DEFAULT_TEMPLATES_FALLBACK));

  load();
  reportHeightToParent();
})();
