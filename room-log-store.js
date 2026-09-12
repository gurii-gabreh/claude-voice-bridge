// Claude Voice Bridge — room log store (data layer)
//
// 2026-09-12追加: 「マーカー(【相談】【処理開始】【処理完了】)の有無に関わらず、
// ルーム内の発言を全てJSONデータに逐次追記して残せ」というユーザー指示のため追加。
// tracker-store.js(マーカー検出・対応中/完了の管理専用)とは別物で、こちらは
// 捕捉できた応答テキストを全文そのままchrome.storage.local(キー: cvb_room_log)へ
// 蓄積するだけ(表示への反映は今回要求されていないため行わない。データ保持のみ)。
//
// 制約(ユーザーには別途説明済み):
// - 保存先はこのブラウザ・端末のchrome.storage.localのみ。他デバイスやGitHubへの
//   同期は含まない(別課題として保留中)。
// - content.jsが捕捉できた範囲(声で操作したアクティブタブ、または常時監視している
//   別タブ)に出てきた応答のみが対象。捕捉自体の限界はtracker-store.js/content.jsと同じ。
// - chrome.storage.localは既定で拡張機能ごと合計10MBの容量上限があるため、
//   manifest.jsonに"unlimitedStorage"権限を追加した("全て"残すにはこれが前提になる。
//   拡張機能の再読み込み時に権限の再確認が必要になる場合がある)。
(function () {
  "use strict";

  const STORAGE_KEY = "cvb_room_log";
  let entries = [];
  let nextId = 1;

  function save() {
    chrome.storage.local.set({ [STORAGE_KEY]: { entries, nextId } });
  }

  function append(partial) {
    const entry = Object.assign(
      { id: nextId++, ts: Date.now(), title: "", url: "", mode: "", source: "" },
      partial
    );
    entries.push(entry);
    save();
    return entry;
  }

  async function load() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) {
      entries = stored[STORAGE_KEY].entries || [];
      nextId = stored[STORAGE_KEY].nextId || entries.length + 1;
    }
  }

  function getData() {
    return entries;
  }

  window.RoomLogStore = { append, load, getData };
})();
