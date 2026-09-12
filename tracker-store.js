// Claude Voice Bridge — tracker store (data layer)
//
// 2026-09-12追加: 【相談NNN】【処理開始NNN】【処理完了NNN】(CLAUDE.mdルール14マーカー)の
// 検出・状態管理(= データ)を、表示(sidepanel.js)から分離するために切り出したモジュール。
// ユーザー指示: 「一覧のところだけjson化し、サイドパネルは見せるだけにしろ」。
// このファイルが唯一のデータ所有者(chrome.storage.localへの読み書きも含む)になり、
// sidepanel.js側はTrackerStore.getData()が返すJSONを描画するだけにする。
//
// 注: 「同じ番号のマーカーが再出現した場合に内容(箇条書き)を上書きするか」の挙動は、
// このリファクタでは変更していない(従来通り上書きする)。その挙動自体を変えるかは別途。
(function () {
  "use strict";

  const tracker = { consultations: {}, tasks: {} };
  const listeners = [];

  function notify() {
    listeners.forEach((fn) => fn(tracker));
  }

  function save() {
    chrome.storage.local.set({ cvb_tracker: tracker });
  }

  // マーカー直後〜次のマーカー(または応答末尾)までの本文を、改行ごとに1項目の
  // 箇条書き配列にする(2026-09-12、ユーザー指示「内容も箇条書きにして表示してほしい」)。
  function extractBullets(block) {
    return block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function scan(text) {
    if (!text) return;
    const re = /【(相談|処理開始|処理完了)(\d{3})】/g;
    const matches = Array.from(text.matchAll(re));
    const now = Date.now();
    matches.forEach((m, i) => {
      const kind = m[1];
      const num = m[2];
      const start = m.index + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const bullets = extractBullets(text.slice(start, end));
      if (kind === "相談") {
        if (!tracker.consultations[num]) {
          tracker.consultations[num] = { bullets, firstSeen: now };
        } else {
          tracker.consultations[num].bullets = bullets;
        }
      } else if (kind === "処理開始") {
        if (!tracker.tasks[num]) {
          tracker.tasks[num] = { bullets, startedAt: now };
        } else {
          tracker.tasks[num].bullets = bullets;
        }
      } else if (kind === "処理完了") {
        // 完了したタスクは一覧から自動削除する(ユーザー指示、2026-09-12)
        delete tracker.tasks[num];
      }
    });
    save();
    notify();
  }

  function dismissConsultation(num) {
    delete tracker.consultations[num];
    save();
    notify();
  }

  function dismissTask(num) {
    delete tracker.tasks[num];
    save();
    notify();
  }

  async function load() {
    const stored = await chrome.storage.local.get("cvb_tracker");
    if (stored.cvb_tracker) {
      tracker.consultations = stored.cvb_tracker.consultations || {};
      tracker.tasks = stored.cvb_tracker.tasks || {};
    }
    notify();
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  function getData() {
    return tracker;
  }

  window.TrackerStore = { scan, dismissConsultation, dismissTask, load, onChange, getData };
})();
