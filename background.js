// 拡張機能アイコンをクリックしたら、ポップアップではなくサイドパネルを開く。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
  console.error("[cvb] setPanelBehavior failed", e);
});

// ---- ルームログ(RoomLogStore)の自動GitHub同期 ----
// 2026-09-17追加、ユーザー指示: 「①スクリプトで開いているclaudeのやり取りを
// ローカルストレージに保存(=RoomLogStore、既存実装) ②別途スクリプトにより
// ローカルデータをGitHub上のJSONデータ1に集約」という3段構成のうち②を担う。
// 手動の「☁️ GitHubへ同期」ボタン(サイドパネル)とは別に、chrome.alarms APIで
// 1日1回、拡張機能自身が自動でRoomLogStoreの新着分をGitHub(claude-voice-bridge
// リポジトリのdata/room-log.json)へ送信する。CVB_GAS_URLが未設定の間は何もしない。
//
// sidepanel.jsのCVB_GAS_URLと同じ値をここにも定義する(service workerは
// sidepanel.jsとJSの実行コンテキストが別のため、定数を共有できない。デプロイ後は
// 両方の値を揃えて更新すること)。
const CVB_GAS_URL = ""; // デプロイ後、発行されたWebアプリURLをここにも設定する

const ALARM_NAME = "cvb-daily-room-log-sync";
const ROOM_LOG_KEY = "cvb_room_log";
const LAST_SYNCED_ID_KEY = "cvb_room_log_last_synced_id";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 24 * 60 });
});
// Chromeがサービスワーカーを休止から復帰させた際、onInstalledが再度発火しない
// ケースがあるため、起動時にもアラームの存在を保証しておく。
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 24 * 60 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) syncRoomLogToGithub();
});

async function syncRoomLogToGithub() {
  if (!CVB_GAS_URL) {
    console.log("[cvb-bg] room-log自動同期: CVB_GAS_URL未設定のためスキップ");
    return;
  }
  const stored = await chrome.storage.local.get([ROOM_LOG_KEY, LAST_SYNCED_ID_KEY]);
  const entries = (stored[ROOM_LOG_KEY] && stored[ROOM_LOG_KEY].entries) || [];
  const lastSyncedId = stored[LAST_SYNCED_ID_KEY] || 0;
  const newEntries = entries.filter((e) => e.id > lastSyncedId);
  if (newEntries.length === 0) {
    console.log("[cvb-bg] room-log自動同期: 新着なし");
    return;
  }
  try {
    const res = await fetch(CVB_GAS_URL, {
      method: "POST",
      body: JSON.stringify({ action: "saveRoomLog", entries: newEntries }),
    });
    const json = await res.json();
    if (json.status === "ok") {
      const maxId = Math.max(...newEntries.map((e) => e.id));
      await chrome.storage.local.set({ [LAST_SYNCED_ID_KEY]: maxId });
      console.log(`[cvb-bg] room-log自動同期: ${newEntries.length}件をGitHubへ送信済み`);
    } else {
      console.warn("[cvb-bg] room-log自動同期エラー:", json.message);
    }
  } catch (e) {
    console.warn("[cvb-bg] room-log自動同期エラー(通信失敗):", e);
  }
}
