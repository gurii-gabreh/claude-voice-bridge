// Claude Voice Bridge — tracker store (data layer)
//
// 2026-09-13大幅改修: 【相談NNN】【処理開始NNN】【処理完了NNN】マーカーの正規表現
// スキャン方式を完全に廃止した(ユーザー指摘: AI側が毎回マーカーを付け忘れるため
// 信頼できない)。代わりに、「🔍 ルームタスク一覧を抽出」ボタンが room-task-audit
// スキル(progress-tracker-dashboardの.claude/skills/room-task-audit/)を起動し、
// AIがその場でルームを読み返して判断した結果(setItems()で渡される)を保持する
// だけのシンプルなデータ層にした。
//
// スキーマ: { items: [{ id, kind("相談"|"未完了作業"), summary, quote, uncertain,
//   status("active"|"done"), source({mode,title,url}), createdAt }] }
// 1回の監査(抽出)ごとに setItems() が呼ばれ、現在のitemsを丸ごと置き換える
// (古い監査結果は自然に上書きされる。個々のitemを維持し続ける必要は無い —
// 次に抽出すれば、まだ未解決ならAIが改めて拾い直すため)。
//
// このファイルが唯一のデータ所有者(chrome.storage.localへの読み書きも含む)になり、
// sidepanel.js側はTrackerStore.getData()が返すJSONを描画するだけにする
// (2026-09-12、ユーザー指示「一覧のところだけjson化し、サイドパネルは見せるだけにしろ」
// という方針自体は継続)。
(function () {
  "use strict";

  const tracker = { items: [] };
  const listeners = [];
  let nextId = 1;

  function notify() {
    listeners.forEach((fn) => fn(tracker));
  }

  function save() {
    chrome.storage.local.set({ cvb_tracker: { items: tracker.items, nextId } });
  }

  // rawItems: room-task-audit スキルの出力をパースした配列
  // [{ kind, summary, quote, uncertain, taskIdMarker }, ...]。source: {mode, title, url}(任意)。
  function setItems(rawItems, source) {
    const now = Date.now();
    tracker.items = (rawItems || []).map((raw) => ({
      id: nextId++,
      kind: raw.kind,
      summary: raw.summary,
      quote: raw.quote || "",
      uncertain: !!raw.uncertain,
      status: "active",
      source: source || null,
      createdAt: now,
      // 2026-09-25追加: 【タスクID:回答MM/DD HH:MM:SS-N】のページ内検索キー。
      // 旧形式の監査結果(数字のみ)から来た場合はnullのまま(表示順連番にフォールバック)。
      taskIdMarker: raw.taskIdMarker || null,
    }));
    save();
    notify();
  }

  // ✕ボタンでの手動非表示。次に抽出すれば、まだ未解決ならAIが改めて拾い直す
  // (このデータは「今回の抽出結果」でしかないため、削除ではなくstatus変更のみ)。
  function dismissItem(id) {
    const item = tracker.items.find((i) => i.id === id);
    if (item) item.status = "done";
    save();
    notify();
  }

  async function load() {
    const stored = await chrome.storage.local.get("cvb_tracker");
    if (stored.cvb_tracker) {
      tracker.items = stored.cvb_tracker.items || [];
      nextId = stored.cvb_tracker.nextId || tracker.items.length + 1;
    }
    notify();
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  // 全件(active/doneを問わず)を返す。表示用に「対応中のみ」へ絞り込むのは
  // 描画側(sidepanel.js)の責務とする。
  function getData() {
    return tracker;
  }

  // data/tracker.json(claude-voice-bridgeリポジトリのGitHub上のファイル)から
  // 取得した、既に完成形のitems配列でそのまま置き換える(2026-09-13追加)。
  // 経緯: ブラウザの自動抽出(ページのDOM構造を推測して応答を捕まえる仕組み)は
  // 対象サイトの表示変更に弱く、繰り返し誤抽出が発生していた。一方でAI(Claude)が
  // このルームを直接確認してdata/tracker.jsonへ書き込む経路は確実に機能して
  // いたため、ユーザー指示により「ボタンを押したらGitHub上のJSONを読み込んで
  // 一覧化するだけ」の経路を追加した。ブラウザの自動抽出とは完全に独立している。
  function loadFromGithubItems(items) {
    const now = Date.now();
    tracker.items = (items || []).map((it, idx) => ({
      id: it.id || `${now}_${idx}`,
      kind: it.kind,
      summary: it.summary,
      quote: it.quote || "",
      uncertain: !!it.uncertain,
      status: it.status || "active",
      source: it.source || null,
      createdAt: it.createdAt || now,
      taskIdMarker: it.taskIdMarker || null,
    }));
    save();
    notify();
  }

  window.TrackerStore = { setItems, dismissItem, load, onChange, getData, loadFromGithubItems };
})();
