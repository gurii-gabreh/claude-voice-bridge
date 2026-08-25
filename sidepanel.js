// Claude Voice Bridge — side panel script
// マイクの音声認識・応答の読み上げはここで行い、実際のページ操作(入力欄への
// 流し込み・送信・応答テキストの取得)はcontent.js側へメッセージで依頼する。

(function () {
  "use strict";

  const micBtn = document.getElementById("mic-btn");
  const statusEl = document.getElementById("status");
  const stateTagEl = document.getElementById("state-tag");
  const radarCanvas = document.getElementById("radar");
  const radarCtx = radarCanvas.getContext("2d");
  const logEl = document.getElementById("log");
  const selInput = document.getElementById("sel-input");
  const selSend = document.getElementById("sel-send");
  const selMessage = document.getElementById("sel-message");
  const phraseButtonsEl = document.getElementById("phrase-buttons");
  const phraseEditorEl = document.getElementById("phrase-editor");
  const phraseSaveBtn = document.getElementById("phrase-save");
  const micPermissionBtn = document.getElementById("mic-permission-btn");

  micPermissionBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  });

  // テンプレートは { label, text } の配列。textは複数行の長文も可。
  // エディタ上では "---" だけの行で区切り、各ブロックの1行目をlabel、
  // 残りをtextとして扱う(長いテンプレートも「ごろっと」登録できるようにするため)。
  const DEFAULT_TEMPLATES = [
    { label: "役割・基本ルールを確認", text: "まずdata/claude-core-rules.mdを読んでから回答してください。" },
    { label: "仮想的な話であることを明示", text: "これは仮想的な話です。" },
    { label: "根拠を明示させる", text: "根拠となる情報を明示した上で回答してください。" },
  ];

  function parseTemplatesText(raw) {
    const lines = raw.split("\n");
    const blocks = [];
    let current = [];
    for (const line of lines) {
      if (line.trim() === "---") {
        blocks.push(current);
        current = [];
      } else {
        current.push(line);
      }
    }
    blocks.push(current);
    return blocks
      .map((blockLines) => blockLines.join("\n").trim())
      .filter(Boolean)
      .map((block) => {
        const blockLines = block.split("\n");
        const label = blockLines[0].trim();
        const text = blockLines.slice(1).join("\n").trim() || label;
        return { label, text };
      });
  }

  function templatesToText(templates) {
    return templates.map((t) => `${t.label}\n${t.text}`).join("\n---\n");
  }

  let conversationMode = false;
  let recognizing = false;
  let recognition = null;
  let activeTabId = null;
  let restartTimer = null;
  const RESTART_DELAY_MS = 350;

  // 音声認識の再開は必ずこの関数経由にする。エラー直後に間を置かずrecognition.start()を
  // 呼ぶと、ブラウザがマイクを解放し切る前の再開衝突で即座に"aborted"エラーとなり、
  // 再開→即エラー→再開…の無限ループになる不具合があったため、必ず一定時間空ける。
  function scheduleRestart(delayMs) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (conversationMode) listenOnce();
    }, delayMs != null ? delayMs : RESTART_DELAY_MS);
  }

  // ---- レーダー風ビジュアル(JARVIS風演出。見た目のみで機能には影響しない) ----
  const STATE_COLORS = {
    idle: "120, 140, 150",
    listening: "46, 204, 113",
    speaking: "41, 121, 255",
    error: "231, 76, 60",
  };
  let visualState = "idle";

  function drawRadar(t) {
    const w = radarCanvas.width;
    const h = radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const active = visualState === "listening" || visualState === "speaking";
    const color = STATE_COLORS[visualState] || STATE_COLORS.idle;
    const baseR = Math.min(w, h) / 2 - 8;

    radarCtx.clearRect(0, 0, w, h);

    // 外側の回転する破線リング
    radarCtx.save();
    radarCtx.translate(cx, cy);
    radarCtx.rotate((t / (active ? 4000 : 14000)) % (Math.PI * 2));
    radarCtx.strokeStyle = `rgba(${color}, 0.55)`;
    radarCtx.lineWidth = 1;
    radarCtx.setLineDash([4, 7]);
    radarCtx.beginPath();
    radarCtx.arc(0, 0, baseR, 0, Math.PI * 2);
    radarCtx.stroke();
    radarCtx.restore();

    // 内側の固定リング
    radarCtx.setLineDash([]);
    radarCtx.strokeStyle = `rgba(${color}, 0.3)`;
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, baseR * 0.72, 0, Math.PI * 2);
    radarCtx.stroke();

    // 中心の発光コア(状態に応じて脈動)
    const pulse = active ? (Math.sin(t / 220) + 1) / 2 : 0.12;
    const coreR = baseR * (0.22 + pulse * 0.12);
    const grad = radarCtx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
    grad.addColorStop(0, `rgba(${color}, 0.85)`);
    grad.addColorStop(0.5, `rgba(${color}, 0.22)`);
    grad.addColorStop(1, `rgba(${color}, 0)`);
    radarCtx.fillStyle = grad;
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, coreR * 2.4, 0, Math.PI * 2);
    radarCtx.fill();

    // 周回する粒子
    const dotCount = 8;
    for (let i = 0; i < dotCount; i++) {
      const angle = (i / dotCount) * Math.PI * 2 + t / (active ? 1300 : 7000);
      const r = baseR * 0.9;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      radarCtx.fillStyle = `rgba(${color}, ${0.4 + 0.35 * Math.sin(t / 300 + i)})`;
      radarCtx.beginPath();
      radarCtx.arc(x, y, 1.6, 0, Math.PI * 2);
      radarCtx.fill();
    }

    requestAnimationFrame(drawRadar);
  }
  requestAnimationFrame(drawRadar);

  function setStatus(text, cls) {
    statusEl.textContent = text;
    micBtn.classList.remove("listening", "speaking", "error");
    stateTagEl.classList.remove("listening", "speaking", "error");
    if (cls) {
      micBtn.classList.add(cls);
      stateTagEl.classList.add(cls);
    }
    visualState = cls || "idle";
    stateTagEl.textContent = (cls || "idle").toUpperCase();
  }

  function addLog(role, text) {
    const item = document.createElement("div");
    item.className = `log-item ${role}`;
    item.textContent = (role === "user" ? "🗣 " : "🤖 ") + text;
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function getActiveClaudeTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith("https://claude.ai/")) {
      return null;
    }
    return tab.id;
  }

  async function sendTextToPage(text) {
    activeTabId = await getActiveClaudeTabId();
    console.log("[cvb-panel] sendTextToPage activeTabId=", activeTabId, "text=", text);
    if (!activeTabId) {
      setStatus("claude.aiのタブを開いて、アクティブにしてください", "error");
      return false;
    }
    try {
      const res = await chrome.tabs.sendMessage(activeTabId, { type: "cvb-send-text", text });
      console.log("[cvb-panel] cvb-send-text の応答:", res);
      if (!res || !res.ok) {
        setStatus("入力欄が見つかりませんでした。下の手動セレクタ設定を確認してください", "error");
        return false;
      }
      return true;
    } catch (e) {
      console.log("[cvb-panel] cvb-send-text 送信失敗:", e);
      // "Could not establish connection..."は、拡張機能を更新/再読み込みした後に
      // claude.aiのタブ自体をリロードしていない場合に必ず出る(content.jsが未注入のため)。
      setStatus("claude.aiのタブをリロード(F5)してください(拡張機能更新後は毎回タブの再読み込みが必要です)", "error");
      return false;
    }
  }

  // content.jsからの「応答が準備できた」通知を待つ
  chrome.runtime.onMessage.addListener((msg) => {
    console.log("[cvb-panel] onMessage受信:", msg.type, msg);
    if (msg.type === "cvb-response-ready") {
      addLog("claude", msg.text || "(応答テキストを取得できませんでした)");
      speak(msg.text, () => {
        if (conversationMode) scheduleRestart();
        else setStatus("停止中");
      });
    }
  });

  function speak(text, onDone) {
    console.log("[cvb-panel] speak() text=", JSON.stringify(text));
    if (!text) {
      onDone && onDone();
      return;
    }
    setStatus("読み上げ中…", "speaking");
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    utter.onend = () => {
      console.log("[cvb-panel] speak() onend");
      onDone && onDone();
    };
    utter.onerror = (e) => {
      console.log("[cvb-panel] speak() onerror", e.error);
      onDone && onDone();
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  function createRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      setStatus("このブラウザは音声認識に対応していません", "error");
      return null;
    }
    const r = new Ctor();
    r.lang = "ja-JP";
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    return r;
  }

  function listenOnce() {
    if (window.speechSynthesis.speaking) {
      console.log("[cvb-panel] listenOnce: 読み上げ中のためスキップ");
      return; // フィードバックループ防止
    }
    recognition = createRecognition();
    if (!recognition) return;
    recognizing = true;
    micPermissionBtn.style.display = "none";
    setStatus("聞いています…", "listening");
    console.log("[cvb-panel] listenOnce: recognition.start()");

    // onresult/onerrorのどちらかで既に後続処理(再開 or 停止)を決めた場合はtrueにする。
    // falseのままonendを迎えたら「エラーも結果も無いまま終了」という想定外パターンなので、
    // conversationMode中なら明示的に再開する(でないとマイクが無言のまま止まって見える)。
    let handled = false;

    recognition.onresult = async (event) => {
      handled = true;
      const transcript = event.results[0][0].transcript;
      console.log("[cvb-panel] onresult:", transcript);
      recognizing = false;
      addLog("user", transcript);
      setStatus("送信中…");
      const ok = await sendTextToPage(transcript);
      if (!ok && conversationMode) {
        scheduleRestart();
      }
      // ok === true の場合、応答はcvb-response-readyメッセージを待って処理する
    };

    recognition.onerror = (event) => {
      console.log("[cvb-panel] onerror:", event.error);
      recognizing = false;
      if (event.error === "no-speech" || event.error === "aborted") {
        handled = true;
        if (conversationMode) scheduleRestart();
        return;
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        handled = true;
        conversationMode = false;
        micBtn.textContent = "🎤";
        setStatus("マイクが許可されていません。下の「マイクの許可ページを開く」から許可してください", "error");
        micPermissionBtn.style.display = "block";
        return;
      }
      // それ以外のエラーは一旦表示するが、handledはtrueにしない(onendでの
      // 再開判断に委ねる。会話モード中なら止まりきりにしない)
      setStatus(`音声認識エラー: ${event.error}`, "error");
    };

    recognition.onend = () => {
      console.log("[cvb-panel] onend recognizing=false conversationMode=", conversationMode, "handled=", handled);
      recognizing = false;
      if (!handled && conversationMode) {
        console.log("[cvb-panel] onend: 未処理のまま終了したため再開します");
        scheduleRestart();
      }
    };

    recognition.start();
  }

  function startConversation() {
    conversationMode = true;
    micBtn.textContent = "⏹";
    listenOnce();
  }

  function stopConversation() {
    conversationMode = false;
    micBtn.textContent = "🎤";
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (recognition && recognizing) recognition.abort();
    window.speechSynthesis.cancel();
    setStatus("停止中");
  }

  micBtn.addEventListener("click", () => {
    if (conversationMode) stopConversation();
    else startConversation();
  });

  // ---- 手動セレクタ設定のUI配線 ----
  async function sendSelectorUpdate(key, value) {
    const tabId = await getActiveClaudeTabId();
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: "cvb-set-selector", key, value }).catch(() => {});
  }

  selInput.addEventListener("change", () => sendSelectorUpdate("cvb_input_selector", selInput.value));
  selSend.addEventListener("change", () => sendSelectorUpdate("cvb_send_selector", selSend.value));
  selMessage.addEventListener("change", () => sendSelectorUpdate("cvb_message_selector", selMessage.value));

  (async function loadExistingSelectors() {
    const tabId = await getActiveClaudeTabId();
    if (!tabId) return;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-get-selectors" });
      if (res) {
        selInput.value = res.input || "";
        selSend.value = res.send || "";
        selMessage.value = res.message || "";
      }
    } catch (e) {
      // claude.aiのタブがまだ無い/読み込み中の場合は無視
    }
  })();

  // ---- 定例文ボタン ----
  async function insertTextToPage(text) {
    const tabId = await getActiveClaudeTabId();
    if (!tabId) {
      setStatus("claude.aiのタブを開いて、アクティブにしてください", "error");
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-insert-text", text });
      if (!res || !res.ok) {
        setStatus("入力欄が見つかりませんでした。手動セレクタ設定を確認してください", "error");
      }
    } catch (e) {
      setStatus("claude.aiのページとの通信に失敗しました(ページを再読み込みしてください)", "error");
    }
  }

  function renderTemplateButtons(templates) {
    phraseButtonsEl.innerHTML = "";
    templates.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "phrase-btn";
      btn.textContent = t.label;
      btn.title = t.text.length > 40 ? t.text.slice(0, 40) + "…" : t.text;
      btn.addEventListener("click", () => insertTextToPage(t.text));
      phraseButtonsEl.appendChild(btn);
    });
  }

  async function loadTemplates() {
    const stored = await chrome.storage.local.get("cvb_templates");
    const templates = stored.cvb_templates && stored.cvb_templates.length
      ? stored.cvb_templates
      : DEFAULT_TEMPLATES;
    renderTemplateButtons(templates);
    phraseEditorEl.value = templatesToText(templates);
  }

  phraseSaveBtn.addEventListener("click", async () => {
    const templates = parseTemplatesText(phraseEditorEl.value);
    await chrome.storage.local.set({ cvb_templates: templates });
    renderTemplateButtons(templates);
  });

  loadTemplates();

  setStatus("停止中");
})();
