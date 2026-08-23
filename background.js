// 拡張機能アイコンをクリックしたら、ポップアップではなくサイドパネルを開く。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
  console.error("[cvb] setPanelBehavior failed", e);
});
