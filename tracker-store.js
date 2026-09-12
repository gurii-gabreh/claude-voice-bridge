// Claude Voice Bridge — tracker store (data layer)
//
// 2026-09-12追加: 【相談NNN】【処理開始NNN】【処理完了NNN】(CLAUDE.mdルール14マーカー)の
// 検出・状態管理(= データ)を、表示(sidepanel.js)から分離するために切り出したモジュール。
// ユーザー指示: 「一覧のところだけjson化し、サイドパネルは見せるだけにしろ」。
// このファイルが唯一のデータ所有者(chrome.storage.localへの読み書きも含む)になり、
// sidepanel.js側はTrackerStore.getData()が返すJSONを描画するだけにする。
//
// 2026-09-12追記: 「ルーム内のタスクは全てJSONに残す。サイドパネルに見せるのは対応中のみ、
// 完了したものは表示しないがJSONは保持する」というユーザー指示により、完了時に
// エントリを削除するのをやめ、status: "active"/"done" を持たせる方式に変更した。
// 「done」になったエントリをJSONから消すか表示から隠すかはsidepanel.js側の
// 描画フィルタ(status!=="done"のみ表示)の責務とする(このファイルは常に全件を保持)。
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

  // 改行ごとに1項目の箇条書き配列にする(2026-09-12、ユーザー指示「内容も箇条書きに」)。
  function extractBullets(block) {
    return block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // 【処理完了NNN】の本文を「対応内容:」「残課題:」の見出しで振り分ける
  // (2026-09-12、ユーザー指示「作業時に対応した内容と、問題箇所や残課題があれば
  // それぞれ欄を作り管理しろ」。見出しの書き方は今後AI側が統一する運用とする)。
  // 見出しが無い場合は全文を対応内容側に入れる(後方互換・書き忘れ対策)。
  const COMPLETION_HEADERS = [
    { key: "doneBullets", re: /^対応(?:した)?内容[:：]\s*(.*)$/ },
    { key: "issueBullets", re: /^(?:残課題|問題点|問題箇所)[:：]\s*(.*)$/ },
  ];

  function extractCompletionSections(block) {
    const lines = extractBullets(block);
    const result = { doneBullets: [], issueBullets: [] };
    let current = null;
    lines.forEach((line) => {
      const header = COMPLETION_HEADERS.find((h) => h.re.test(line));
      if (header) {
        current = header.key;
        const rest = line.match(header.re)[1].trim();
        if (rest) result[current].push(rest);
        return;
      }
      if (!current) {
        result.doneBullets.push(line); // 見出し未着の行は対応内容側の既定値
      } else {
        result[current].push(line);
      }
    });
    return result;
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
      const block = text.slice(start, end);

      if (kind === "相談") {
        const prev = tracker.consultations[num];
        tracker.consultations[num] = {
          bullets: extractBullets(block),
          status: "active", // マーカーが(再)出現した時点では常に「対応中」に戻す
          firstSeen: prev ? prev.firstSeen : now,
        };
      } else if (kind === "処理開始") {
        const prev = tracker.tasks[num];
        tracker.tasks[num] = {
          bullets: extractBullets(block),
          doneBullets: prev ? prev.doneBullets || [] : [],
          issueBullets: prev ? prev.issueBullets || [] : [],
          status: "active",
          startedAt: prev ? prev.startedAt : now,
        };
      } else if (kind === "処理完了") {
        const prev = tracker.tasks[num];
        const sections = extractCompletionSections(block);
        tracker.tasks[num] = {
          bullets: prev ? prev.bullets || [] : [],
          doneBullets: sections.doneBullets,
          issueBullets: sections.issueBullets,
          status: "done", // 表示からは隠すが、JSON(chrome.storage.local)には残す
          startedAt: prev ? prev.startedAt : now,
          completedAt: now,
        };
      }
    });
    save();
    notify();
  }

  // ✕ボタンでの手動解決/手動終了。削除はせず、status: "done" にして
  // JSONには残したまま表示から隠す(2026-09-12、ユーザー指示「相談も一律、
  // ✗で解決済みにしたらJSONには残し、表示からは隠す」)。
  function dismissConsultation(num) {
    if (tracker.consultations[num]) {
      tracker.consultations[num].status = "done";
      tracker.consultations[num].resolvedAt = Date.now();
    }
    save();
    notify();
  }

  function dismissTask(num) {
    if (tracker.tasks[num]) {
      tracker.tasks[num].status = "done";
      tracker.tasks[num].resolvedAt = Date.now();
    }
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

  // 全件(active/doneを問わず)を返す。表示用に「対応中のみ」へ絞り込むのは
  // 描画側(sidepanel.js)の責務とする(このファイルは常に全件を保持するデータ層)。
  function getData() {
    return tracker;
  }

  window.TrackerStore = { scan, dismissConsultation, dismissTask, load, onChange, getData };
})();
