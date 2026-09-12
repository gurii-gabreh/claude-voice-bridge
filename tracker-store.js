// Claude Voice Bridge — tracker store (data layer)
//
// 2026-09-12追加: 【相談NNN】【処理開始NNN】【処理完了NNN】(CLAUDE.mdルール14マーカー)の
// 検出・状態管理(= データ)を、表示(sidepanel.js)から分離するために切り出したモジュール。
// ユーザー指示: 「一覧のところだけjson化し、サイドパネルは見せるだけにしろ」。
// このファイルが唯一のデータ所有者(chrome.storage.localへの読み書きも含む)になり、
// sidepanel.js側はTrackerStore.getData()が返すJSONを描画するだけにする。
//
// 注: 「同じ番号のマーカーが再出現した場合にスニペットを上書きするか」の挙動は、
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

  function scan(text) {
    if (!text) return;
    const re = /【(相談|処理開始|処理完了)(\d{3})】/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const kind = m[1];
      const num = m[2];
      const after = text.slice(m.index + m[0].length).trim();
      const snippet = after.slice(0, 60).replace(/\s+/g, " ");
      const now = Date.now();
      if (kind === "相談") {
        if (!tracker.consultations[num]) {
          tracker.consultations[num] = { snippet, firstSeen: now };
        } else {
          tracker.consultations[num].snippet = snippet;
        }
      } else if (kind === "処理開始") {
        if (!tracker.tasks[num]) {
          tracker.tasks[num] = { snippet, startedAt: now };
        } else {
          tracker.tasks[num].snippet = snippet;
        }
      } else if (kind === "処理完了") {
        // 完了したタスクは一覧から自動削除する(ユーザー指示、2026-09-12)
        delete tracker.tasks[num];
      }
    }
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
