// Claude Voice Bridge — マイク許可専用ページ
// サイドパネルではgetUserMediaの許可ダイアログが正しく出ないChromeの制限があるため、
// 拡張機能のページを通常のタブとして開いた状態でここから許可を取る。
// 許可は拡張機能のオリジン(chrome-extension://<id>)単位で記録されるため、
// 一度ここで許可すればサイドパネル側の音声認識でも使えるようになる。

(function () {
  "use strict";

  const btn = document.getElementById("allow-btn");
  const resultEl = document.getElementById("result");

  btn.addEventListener("click", async () => {
    resultEl.className = "";
    resultEl.textContent = "許可を確認中…";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      resultEl.className = "ok";
      resultEl.textContent = "マイクが許可されました。このタブは閉じて、サイドパネルに戻ってお使いください。";
    } catch (e) {
      resultEl.className = "ng";
      resultEl.textContent =
        "許可されませんでした(" + e.name + ")。Chromeのアドレスバー左側のアイコンや、" +
        "chrome://settings/content/microphone からこの拡張機能を許可に変更してから、再度お試しください。";
    }
  });
})();
