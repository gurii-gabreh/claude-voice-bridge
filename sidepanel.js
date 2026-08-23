// Claude Voice Bridge — side panel script
// マイクの音声認識・応答の読み上げはここで行い、実際のページ操作(入力欄への
// 流し込み・送信・応答テキストの取得)はcontent.js側へメッセージで依頼する。

(function () {
  "use strict";

  const micBtn = document.getElementById("mic-btn");
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");
  const selInput = document.getElementById("sel-input");
  const selSend = document.getElementById("sel-send");
  const selMessage = document.getElementById("sel-message");
  const phraseButtonsEl = document.getElementById("phrase-buttons");
  const phraseEditorEl = document.getElementById("phrase-editor");
  const phraseSaveBtn = document.getElementById("phrase-save");

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

  function setStatus(text, cls) {
    statusEl.textContent = text;
    micBtn.classList.remove("listening", "speaking", "error");
    if (cls) micBtn.classList.add(cls);
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
    if (!activeTabId) {
      setStatus("claude.aiのタブを開いて、アクティブにしてください", "error");
      return false;
    }
    try {
      const res = await chrome.tabs.sendMessage(activeTabId, { type: "cvb-send-text", text });
      if (!res || !res.ok) {
        setStatus("入力欄が見つかりませんでした。下の手動セレクタ設定を確認してください", "error");
        return false;
      }
      return true;
    } catch (e) {
      setStatus("claude.aiのページとの通信に失敗しました(ページを再読み込みしてください)", "error");
      return false;
    }
  }

  // content.jsからの「応答が準備できた」通知を待つ
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "cvb-response-ready") {
      addLog("claude", msg.text || "(応答テキストを取得できませんでした)");
      speak(msg.text, () => {
        if (conversationMode) listenOnce();
        else setStatus("停止中");
      });
    }
  });

  function speak(text, onDone) {
    if (!text) {
      onDone && onDone();
      return;
    }
    setStatus("読み上げ中…", "speaking");
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    utter.onend = () => onDone && onDone();
    utter.onerror = () => onDone && onDone();
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
    if (window.speechSynthesis.speaking) return; // フィードバックループ防止
    recognition = createRecognition();
    if (!recognition) return;
    recognizing = true;
    setStatus("聞いています…", "listening");

    recognition.onresult = async (event) => {
      const transcript = event.results[0][0].transcript;
      recognizing = false;
      addLog("user", transcript);
      setStatus("送信中…");
      const ok = await sendTextToPage(transcript);
      if (!ok && conversationMode) {
        listenOnce();
      }
      // ok === true の場合、応答はcvb-response-readyメッセージを待って処理する
    };

    recognition.onerror = (event) => {
      recognizing = false;
      if (event.error === "no-speech" || event.error === "aborted") {
        if (conversationMode) listenOnce();
        return;
      }
      setStatus(`音声認識エラー: ${event.error}`, "error");
    };

    recognition.onend = () => {
      recognizing = false;
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
