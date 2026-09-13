// Claude Voice Bridge — side panel script
// マイクの音声認識・応答の読み上げはここで行い、実際のページ操作(入力欄への
// 流し込み・送信・応答テキストの取得)はcontent.js側へメッセージで依頼する。
//
// v0.6.0: claude.ai / Gemini の2サイト対応。「Claude」「Gemini」と呼びかけると
// 対象AIが切り替わり、そのまま会話モードへ入る(キーワード待ち受け→会話の2フェーズ)。

(function () {
  "use strict";

  const radarCanvas = document.getElementById("radar");
  const radarCtx = radarCanvas.getContext("2d");
  const telemetryTL = document.getElementById("telemetry-tl");
  const telemetryBL = document.getElementById("telemetry-bl");
  const statusEl = document.getElementById("status");
  const stateTagEl = document.getElementById("state-tag");
  const logEl = document.getElementById("log");
  const selInput = document.getElementById("sel-input");
  const selSend = document.getElementById("sel-send");
  const selMessage = document.getElementById("sel-message");
  const phraseButtonsEl = document.getElementById("phrase-buttons");
  const phraseEditorEl = document.getElementById("phrase-editor");
  const phraseSaveBtn = document.getElementById("phrase-save");
  const micPermissionBtn = document.getElementById("mic-permission-btn");
  const modeClaudeBtn = document.getElementById("mode-claude-btn");
  const modeGeminiBtn = document.getElementById("mode-gemini-btn");
  const extractRoomBtn = document.getElementById("extract-room-btn");
  const syncGithubBtn = document.getElementById("sync-github-btn");
  const panelTabVoiceBtn = document.getElementById("panel-tab-voice");
  const panelTabListBtn = document.getElementById("panel-tab-list");
  const voiceModePanelEl = document.getElementById("voice-mode-panel");
  const listModePanelEl = document.getElementById("list-mode-panel");
  const rateSliderEl = document.getElementById("rate-slider");
  const rateValueEl = document.getElementById("rate-value");
  const voiceSelectEl = document.getElementById("voice-select");

  micPermissionBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  });

  // ---- 対象AI(claude / gemini)のモード管理 ----
  const SITE_ORIGINS = { claude: "https://claude.ai/", gemini: "https://gemini.google.com/" };
  const SITE_LABELS = { claude: "claude.ai", gemini: "Gemini" };
  const MODE_COLORS = { claude: "217, 119, 87", gemini: "138, 180, 248" };
  // キーワード待ち受け中に拾う語(誤検出を避けるため日英どちらでも判定できるようにしてある)
  const KEYWORD_PATTERNS = {
    claude: [/クロード/, /claude/i],
    gemini: [/ジェミナイ/, /ジェミニ/, /gemini/i],
  };

  let mode = "claude";

  function detectKeywordMode(transcript) {
    for (const key of Object.keys(KEYWORD_PATTERNS)) {
      if (KEYWORD_PATTERNS[key].some((re) => re.test(transcript))) return key;
    }
    return null;
  }

  function updateModeUI() {
    modeClaudeBtn.classList.toggle("active", mode === "claude");
    modeGeminiBtn.classList.toggle("active", mode === "gemini");
  }

  function setMode(newMode) {
    if (newMode !== "claude" && newMode !== "gemini") return;
    mode = newMode;
    updateModeUI();
    chrome.storage.local.set({ cvb_mode: mode });
  }

  modeClaudeBtn.addEventListener("click", () => setMode("claude"));
  modeGeminiBtn.addEventListener("click", () => setMode("gemini"));

  // ---- パネル切り替え(ボイスモード / 一覧モード) ----
  // 2026-09-13追加、ユーザー指示「ボイスモードと一覧モードは、上部タブにより
  // 切り替えられるようにしろ」。
  function setPanelMode(panel) {
    const isVoice = panel === "voice";
    panelTabVoiceBtn.classList.toggle("active", isVoice);
    panelTabListBtn.classList.toggle("active", !isVoice);
    voiceModePanelEl.style.display = isVoice ? "flex" : "none";
    listModePanelEl.style.display = isVoice ? "none" : "flex";
    chrome.storage.local.set({ cvb_panel_mode: panel });
  }
  panelTabVoiceBtn.addEventListener("click", () => setPanelMode("voice"));
  panelTabListBtn.addEventListener("click", () => setPanelMode("list"));

  // ---- claude-voice-bridge専用のGAS中継(gas/README.md参照) ----
  // GitHubのdata/tracker.json・data/knowledge-log.jsonへの書き込みを担う。
  // study-appのGAS_URLとは別の、この拡張機能専用のGASプロジェクトのURLを設定する。
  // 2026-09-13追加、ユーザー指示。
  const CVB_GAS_URL = ''; // デプロイ後、発行されたWebアプリURLをここに設定する

  // 「🔍 ルームタスク一覧を抽出」ボタン1回分の抽出結果を、data/knowledge-log.jsonへ
  // 1件だけ追記する(要約せず全文。「次同じようなことや開発に活かしたい、無駄な
  // 確認や実績としてナレッジ化しておきたい」というユーザー指示)。CVB_GAS_URLが
  // 未設定の間は何もしない。音声応答(Voiceモード)・常時監視からは呼ばない
  // (ユーザー指示「Voiceモードは今まで通りに」「音声は除外してよい」)。
  async function syncKnowledgeToGithub(text, source) {
    if (!CVB_GAS_URL) return;
    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      room: source,
      text,
    };
    try {
      const res = await fetch(CVB_GAS_URL, {
        method: "POST",
        body: JSON.stringify({ action: "saveKnowledge", entry }),
      });
      const json = await res.json();
      if (json.status !== "ok") console.warn("[cvb-panel] ナレッジのGitHub同期エラー:", json.message);
    } catch (e) {
      console.warn("[cvb-panel] ナレッジのGitHub同期エラー(通信失敗):", e);
    }
  }

  // ---- ルームタスク監査(room-task-auditスキル、AI直接確認方式) ----
  // 2026-09-13大幅改修: 【相談NNN】等のマーカー正規表現スキャンは完全廃止した
  // (ユーザー指摘: AI側がタグを付け忘れるため信頼できない)。代わりに、ボタンを
  // 押すとチャット入力欄へ固定フレーズを送信し、AI自身にこのルームを直接読み返させて
  // 未解決の相談・未完了作業を判定させる。
  // これは通常の会話ターンとして送受信される(音声モードと同じ送信の仕組みを
  // 流用するだけで、別料金のAPIは呼ばない。通常のClaude Code利用量として消費される)。
  //
  // 2026-09-13追記(不具合修正): 当初は"/room-task-audit"(先頭が"/")を送信していたが、
  // claude.ai/codeの入力欄は先頭が"/"だとClaude Code側の組み込みスラッシュコマンド/
  // スキル選択ポップアップ(候補一覧のドロップダウン)を開く仕様になっており、
  // execCommand("insertText")で流し込んだ直後にこのポップアップが開いてしまい、
  // 送信ボタンクリックやEnterキーがポップアップの選択操作に奪われて実際には
  // メッセージが送信されない(抽出ボタンを押しても応答が来ず固まる)不具合があった。
  // そのため先頭に"/"を置かない、スキル名を平文で明示する言い回しに変更した
  // (Skillツールは「ユーザーが名前を明示した場合」もスラッシュ無しの呼び出しとして
  // 有効なため、この言い回しでも同じスキルが呼び出される)。
  const AUDIT_TRIGGER_TEXT = "room-task-auditスキルを呼び出して実行してください。";
  let pendingAuditRequest = false;

  // room-task-auditスキルの出力([ROOM-TASK-AUDIT-START]...[ROOM-TASK-AUDIT-END])を
  // パースする。フォーマットが想定と違えばnullを返す(スキルが呼ばれなかった、
  // 応答が途中で切れた等)。
  function parseAuditResponse(text) {
    const block = (text || "").match(/\[ROOM-TASK-AUDIT-START\]([\s\S]*?)\[ROOM-TASK-AUDIT-END\]/);
    if (!block) return null;
    const body = block[1].trim();
    if (!body || body.includes("未解決の項目はありません")) return [];
    const lineRe = /種別:\s*(相談|未完了作業)\s*\|\s*内容:\s*(.+?)\s*\|\s*引用:\s*"(.*?)"\s*\|\s*不確実:\s*(はい|いいえ)/;
    const items = [];
    body.split(/\r?\n/).forEach((line) => {
      const m = line.match(lineRe);
      if (m) items.push({ kind: m[1], summary: m[2].trim(), quote: m[3], uncertain: m[4] === "はい" });
    });
    return items;
  }

  function handleAuditResponse(text, source) {
    const items = parseAuditResponse(text);
    if (items === null) {
      setStatus("監査結果の解析に失敗しました(想定した形式で応答されませんでした)", "error");
      return;
    }
    window.TrackerStore.setItems(items, source);
    if (items.length > 0) {
      setStatus(`${SITE_LABELS[mode]}: 未解決の項目を${items.length}件検出しました`);
    } else {
      setStatus(`${SITE_LABELS[mode]}: 未解決の項目はありませんでした`);
    }
  }

  // 「🔍 ルームタスク一覧を抽出」ボタン: 2つの処理を行う。
  // (1) 生の内容(要約せず全文)をRoomLogStore・ナレッジログへ記録(従来通り、
  //     「実際にやり取りした内容をナレッジとして残したい」というユーザー指示のため)。
  // (2) room-task-auditスキルをこのルーム上で起動し、AI自身に未解決項目を判定させる
  //     (新方式。結果はcvb-response-ready経由で非同期に届く)。
  extractRoomBtn.addEventListener("click", async () => {
    const tabId = await getActiveTabId();
    if (!tabId) {
      setStatus(`${SITE_LABELS[mode]}のタブを開いて、アクティブにしてください`, "error");
      return;
    }

    // (1) 生ログ・ナレッジ化(失敗しても致命的ではないので、失敗時はwarnのみ)
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-extract-room-text" });
      if (res && res.ok && res.text) {
        const source = { mode, title: res.title || "", url: res.url || "" };
        window.RoomLogStore.append({ text: res.text, source: "manual-extract", mode });
        syncKnowledgeToGithub(res.text, source);
      }
    } catch (e) {
      console.warn("[cvb-panel] 生ログ抽出に失敗:", e);
    }

    // (2) AIへ直接確認を依頼
    pendingAuditRequest = true;
    setStatus(`${SITE_LABELS[mode]}: ルームを確認中…(AIへ問い合わせています)`);
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-send-text", text: AUDIT_TRIGGER_TEXT });
      if (!res || !res.ok) {
        pendingAuditRequest = false;
        if (res && res.reason === "busy") {
          // ボイスモードが会話中(応答待ち)の場合、監査を同時に送ると応答を取り違える
          // ため送信自体を見送っている(2026-09-13追加、content.jsのsendInFlightガード)。
          setStatus(`${SITE_LABELS[mode]}: ボイスモードが会話の応答待ち中のため、少し待ってから抽出し直してください`, "error");
        } else {
          setStatus("入力欄が見つかりませんでした。手動セレクタ設定を確認してください", "error");
        }
      }
      // res.ok===trueの場合、結果はcvb-response-ready(onMessageリスナー)で処理される
    } catch (e) {
      pendingAuditRequest = false;
      setStatus(`${SITE_LABELS[mode]}のタブをリロードしてください(拡張機能更新後は毎回タブの再読み込みが必要です)`, "error");
    }
  });

  // ---- トラッカーのGitHub同期(手動トリガーのみ) ----
  // その時点のトラッカー全体をdata/tracker.json(claude-voice-bridgeリポジトリ)へ
  // 上書き保存する。自動同期はしない(常時監視で頻繁に更新されるたびcommitすると
  // 履歴が大量になるため、ボタンを押した時だけ)。2026-09-13追加、ユーザー指示。
  syncGithubBtn.addEventListener("click", async () => {
    if (!CVB_GAS_URL) {
      setStatus("GitHub同期は未設定です(gas/README.mdの手順でデプロイしてください)", "error");
      return;
    }
    setStatus("GitHubへ同期中…");
    try {
      const res = await fetch(CVB_GAS_URL, {
        method: "POST",
        body: JSON.stringify({ action: "saveTracker", tracker: window.TrackerStore.getData() }),
      });
      const json = await res.json();
      if (json.status === "ok") {
        setStatus("GitHubへ同期しました");
      } else {
        setStatus(`GitHub同期エラー: ${json.message || "不明なエラー"}`, "error");
      }
    } catch (e) {
      setStatus("GitHub同期エラー(通信失敗)", "error");
    }
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

  // ---- 状態管理 ----
  // active: オーブが起動中(true)か停止中(false)か
  // phase: "keyword"(キーワード待ち受け中) | "conversation"(本格的な聞き取り中)
  let active = false;
  let phase = "keyword";
  let recognizing = false;
  let recognition = null;
  let restartTimer = null;
  const RESTART_DELAY_MS = 350;

  // 音声認識の再開は必ずこの関数経由にする。エラー直後に間を置かずrecognition.start()を
  // 呼ぶと、ブラウザがマイクを解放し切る前の再開衝突で即座に"aborted"エラーとなり、
  // 再開→即エラー→再開…の無限ループになる不具合があったため、必ず一定時間空ける。
  function scheduleRestart(fn, delayMs) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (active) fn();
    }, delayMs != null ? delayMs : RESTART_DELAY_MS);
  }

  // ---- HUD風ビジュアル(近未来のトラッキングHUD演出。見た目のみで機能には影響しない) ----
  const STATE_COLORS = {
    idle: "111, 147, 168",
    listening: "46, 204, 113",
    speaking: "41, 121, 255",
    keyword: "41, 230, 255",
    error: "231, 76, 60",
  };
  let visualState = "idle";

  // テレメトリー表示用(SYSTEM/MODEL/VOICE/SESSION/TOKENS/EST. COST/FPSおよび
  // LAT/LON/ALT/HDG)は、参考にした演出動画の雰囲気に寄せた**装飾目的のダミー表示**。
  // LAT/LON/ALT/HDGは実際のGeolocationは一切使わず(manifest.jsonにgeolocation権限も
  // 無い)、時間に応じて緩やかに揺れるだけの架空の値。FPSのみ実際の描画フレームレート。
  // TOKENSは送受信したテキストの文字数からの粗い概算(目安表示)。
  const sessionStartMs = Date.now();
  let estTokens = 0;
  let fps = 0;
  let lastFrameTs = null;
  let telemetryTick = 0;

  function formatSession() {
    const s = Math.floor((Date.now() - sessionStartMs) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function currentVoiceLabel() {
    if (!selectedVoiceName) return "SYSTEM DEFAULT";
    return selectedVoiceName.length > 18 ? selectedVoiceName.slice(0, 18) + "…" : selectedVoiceName;
  }

  function updateTelemetry(t) {
    const pseudoLat = 35.0 + Math.sin(t / 9000) * 0.4;
    const pseudoLon = 139.0 + Math.cos(t / 11000) * 0.4;
    const pseudoAlt = 1200 + Math.sin(t / 5000) * 80;
    const pseudoHdg = (t / 50) % 360;
    telemetryTL.innerHTML =
      `SYSTEM: <b>ONLINE</b><br>` +
      `MODEL: <b>${mode.toUpperCase()}</b><br>` +
      `VOICE: <b>${currentVoiceLabel()}</b><br>` +
      `SESSION: <b>${formatSession()}</b><br>` +
      `TOKENS: <b>~${estTokens}</b><br>` +
      `EST. COST: <b>$0.00</b><br>` +
      `FPS: <b>${fps.toFixed(0)}</b>`;
    telemetryBL.innerHTML =
      `LAT: <b>${pseudoLat.toFixed(4)}</b><br>` +
      `LON: <b>${pseudoLon.toFixed(4)}</b><br>` +
      `ALT: <b>${pseudoAlt.toFixed(0)}m</b><br>` +
      `HDG: <b>${pseudoHdg.toFixed(0)}°</b>`;
  }

  function drawRadar(t) {
    if (lastFrameTs != null) {
      const dt = t - lastFrameTs;
      if (dt > 0) fps = fps * 0.9 + (1000 / dt) * 0.1;
    }
    lastFrameTs = t;

    const w = radarCanvas.width;
    const h = radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const glowActive = visualState === "listening" || visualState === "speaking";
    const color = STATE_COLORS[visualState] || STATE_COLORS.idle;
    const modeColor = MODE_COLORS[mode];
    const baseR = Math.min(w, h) / 2 - 10;

    radarCtx.clearRect(0, 0, w, h);

    // 最外周: 目盛り付きのダイヤルリング(モードカラーで着色し、今どちらのAIが
    // 対象かを視覚的にも示す)
    radarCtx.save();
    radarCtx.translate(cx, cy);
    radarCtx.strokeStyle = `rgba(${modeColor}, 0.5)`;
    radarCtx.lineWidth = 1;
    radarCtx.beginPath();
    radarCtx.arc(0, 0, baseR, 0, Math.PI * 2);
    radarCtx.stroke();
    const tickCount = 48;
    for (let i = 0; i < tickCount; i++) {
      const angle = (i / tickCount) * Math.PI * 2;
      const long = i % 4 === 0;
      const r0 = baseR - (long ? 8 : 4);
      radarCtx.strokeStyle = `rgba(${modeColor}, ${long ? 0.65 : 0.3})`;
      radarCtx.beginPath();
      radarCtx.moveTo(Math.cos(angle) * r0, Math.sin(angle) * baseR);
      radarCtx.lineTo(Math.cos(angle) * baseR, Math.sin(angle) * baseR);
      radarCtx.moveTo(Math.cos(angle) * r0, Math.sin(angle) * r0);
      radarCtx.lineTo(Math.cos(angle) * baseR, Math.sin(angle) * baseR);
      radarCtx.stroke();
    }
    radarCtx.restore();

    // 回転する破線リング(状態色)
    radarCtx.save();
    radarCtx.translate(cx, cy);
    radarCtx.rotate((t / (glowActive ? 4000 : 14000)) % (Math.PI * 2));
    radarCtx.strokeStyle = `rgba(${color}, 0.6)`;
    radarCtx.lineWidth = 1;
    radarCtx.setLineDash([4, 7]);
    radarCtx.beginPath();
    radarCtx.arc(0, 0, baseR * 0.85, 0, Math.PI * 2);
    radarCtx.stroke();
    radarCtx.restore();

    // 内側の固定リング
    radarCtx.setLineDash([]);
    radarCtx.strokeStyle = `rgba(${color}, 0.32)`;
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, baseR * 0.62, 0, Math.PI * 2);
    radarCtx.stroke();

    // レーダースイープ(会話モードでのみくっきり、待ち受け中は控えめ)
    const sweepSpeed = phase === "conversation" ? 1800 : 5000;
    const sweepAngle = (t / sweepSpeed) % (Math.PI * 2);
    radarCtx.save();
    radarCtx.beginPath();
    radarCtx.moveTo(cx, cy);
    radarCtx.arc(cx, cy, baseR * 0.85, sweepAngle - 0.5, sweepAngle);
    radarCtx.closePath();
    radarCtx.fillStyle = `rgba(${color}, 0.12)`;
    radarCtx.fill();
    radarCtx.restore();

    // 中心の発光コア(状態に応じて脈動)
    const pulse = glowActive ? (Math.sin(t / 220) + 1) / 2 : 0.14;
    const coreR = baseR * (0.2 + pulse * 0.13);
    const grad = radarCtx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.6);
    grad.addColorStop(0, `rgba(${color}, 0.9)`);
    grad.addColorStop(0.5, `rgba(${color}, 0.22)`);
    grad.addColorStop(1, `rgba(${color}, 0)`);
    radarCtx.fillStyle = grad;
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, coreR * 2.6, 0, Math.PI * 2);
    radarCtx.fill();

    // 周回する粒子(2層)
    [{ n: 8, r: 0.92, speed: 1300, size: 1.6 }, { n: 5, r: 0.5, speed: -2100, size: 1.2 }].forEach((layer) => {
      for (let i = 0; i < layer.n; i++) {
        const angle = (i / layer.n) * Math.PI * 2 + t / (glowActive ? layer.speed : layer.speed * 4);
        const r = baseR * layer.r;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        radarCtx.fillStyle = `rgba(${color}, ${0.4 + 0.35 * Math.sin(t / 300 + i)})`;
        radarCtx.beginPath();
        radarCtx.arc(x, y, layer.size, 0, Math.PI * 2);
        radarCtx.fill();
      }
    });

    telemetryTick++;
    if (telemetryTick % 6 === 0) updateTelemetry(t);

    requestAnimationFrame(drawRadar);
  }
  requestAnimationFrame(drawRadar);

  function setStatus(text, cls) {
    statusEl.textContent = text;
    stateTagEl.classList.remove("listening", "speaking", "error", "keyword");
    if (cls) stateTagEl.classList.add(cls);
    visualState = cls || "idle";
    stateTagEl.textContent = (cls || "idle").toUpperCase();
  }

  function addLog(role, text) {
    const item = document.createElement("div");
    item.className = `log-item ${role}`;
    const icon = role === "user" ? "🗣" : role === "gemini" ? "✨" : "🤖";
    item.textContent = `${icon} ${text}`;
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith(SITE_ORIGINS[mode])) {
      return null;
    }
    return tab.id;
  }

  async function sendTextToPage(text) {
    const tabId = await getActiveTabId();
    console.log("[cvb-panel] sendTextToPage mode=", mode, "tabId=", tabId, "text=", text);
    if (!tabId) {
      setStatus(`${SITE_LABELS[mode]}のタブを開いて、アクティブにしてください`, "error");
      return false;
    }
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-send-text", text });
      console.log("[cvb-panel] cvb-send-text の応答:", res);
      if (!res || !res.ok) {
        if (res && res.reason === "busy") {
          // 監査ボタン(一覧モード)とボイスモードの会話ターンが同時に走らないための
          // ガード(2026-09-13追加)。この状態はエラーではなく単なる一時待ちなので、
          // errorスタイルにはしない。
          setStatus("他の送信が応答待ち中のため少し待ってから再度お試しください", "listening");
        } else {
          setStatus("入力欄が見つかりませんでした。下の手動セレクタ設定を確認してください", "error");
        }
        return false;
      }
      return true;
    } catch (e) {
      console.log("[cvb-panel] cvb-send-text 送信失敗:", e);
      // "Could not establish connection..."は、拡張機能を更新/再読み込みした後に
      // 対象タブ自体をリロードしていない場合に必ず出る(content.jsが未注入のため)。
      setStatus(`${SITE_LABELS[mode]}のタブをリロード(F5)してください(拡張機能更新後は毎回タブの再読み込みが必要です)`, "error");
      return false;
    }
  }

  // ---- 相談・処理タスクの見逃し防止トラッカー(表示のみ) ----
  // CLAUDE.mdルール14の【相談NNN】【処理開始NNN】【処理完了NNN】マーカーの検出・
  // 状態管理(データ)はtracker-store.js(TrackerStore)側に分離した。
  // ここ(sidepanel.js)はTrackerStore.getData()が返すJSONを描画するだけにする
  // (2026-09-12、ユーザー指示「一覧のところだけjson化し、サイドパネルは見せるだけにしろ」)。
  const trackerSectionEl = document.getElementById("tracker-section");
  const trackerTbodyEl = document.getElementById("tracker-tbody");

  // 表示用の短いラベルのみ組み立てる(URLはtracker-store.js側にsource.urlとして
  // 「ルームID」的に保持するが、表には出さない。2026-09-13、ユーザー指示)。
  function roomLabel(source) {
    if (!source) return "-";
    const siteLabel = source.mode ? (SITE_LABELS[source.mode] || source.mode) : "";
    const title = (source.title || "").trim();
    const shortTitle = title.length > 20 ? title.slice(0, 20) + "…" : title;
    return [siteLabel, shortTitle].filter(Boolean).join(": ") || "-";
  }

  // トラッカー項目の番号をクリックした時、ルーム内の該当箇所へスクロールする
  // (2026-09-13追加、ユーザー指示「相談番号をクリックしたらルーム内のその箇所に
  // 遷移するようにしろ」)。item.quoteが無い/見つからない場合は何もしない。
  async function navigateToItem(item) {
    if (!item.quote) return;
    const tabId = await getActiveTabId();
    if (!tabId) {
      setStatus(`${SITE_LABELS[mode]}のタブを開いて、アクティブにしてください`, "error");
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-scroll-to-quote", quote: item.quote });
      if (!res || !res.ok) {
        setStatus("該当箇所が見つかりませんでした(ページが更新された可能性があります)", "error");
      }
    } catch (e) {
      setStatus(`${SITE_LABELS[mode]}のタブをリロードしてください`, "error");
    }
  }

  function copyItemToClipboard(item) {
    const text = `【${item.kind}】${item.summary}`;
    navigator.clipboard.writeText(text).then(
      () => setStatus("内容をコピーしました"),
      () => setStatus("コピーに失敗しました", "error")
    );
  }

  function renderTracker() {
    const tracker = window.TrackerStore.getData();
    trackerTbodyEl.innerHTML = "";
    // 表示は「対応中(status!=="done")」のみ。完了・解決済みはJSON(chrome.storage.local)
    // には残すが表には出さない(2026-09-12、ユーザー指示)。
    const activeItems = (tracker.items || []).filter((item) => item.status !== "done");

    activeItems.forEach((item) => {
      const tr = document.createElement("tr");
      const isConsult = item.kind === "相談";
      tr.innerHTML =
        `<td></td>` +
        `<td class="tracker-text"></td>` +
        `<td class="tracker-room"></td>` +
        `<td><span class="tracker-badge ${isConsult ? "waiting" : "working"}">${isConsult ? "回答待ち" : "作業中"}${item.uncertain ? "・不確実" : ""}</span></td>` +
        `<td></td>`;

      const numCell = tr.firstElementChild;
      const numBtn = document.createElement("button");
      numBtn.className = "tracker-num";
      numBtn.type = "button";
      numBtn.textContent = item.kind;
      if (item.quote) {
        numBtn.title = "クリックでルーム内の該当箇所へ移動";
        numBtn.onclick = () => navigateToItem(item);
      } else {
        numBtn.disabled = true;
        numBtn.title = "引用が無いため移動できません";
      }
      numCell.appendChild(numBtn);

      tr.querySelector(".tracker-text").textContent = item.summary || "(内容不明)";
      tr.querySelector(".tracker-room").textContent = roomLabel(item.source);

      const actionsCell = tr.lastElementChild;
      const copyBtn = document.createElement("button");
      copyBtn.className = "tracker-copy";
      copyBtn.type = "button";
      copyBtn.textContent = "📋";
      copyBtn.title = "内容をコピー";
      copyBtn.onclick = () => copyItemToClipboard(item);
      actionsCell.appendChild(copyBtn);

      const dismissBtn = document.createElement("button");
      dismissBtn.className = "tracker-dismiss";
      dismissBtn.type = "button";
      dismissBtn.textContent = "✕";
      dismissBtn.title = "一覧から外す(次回の抽出でまだ未解決なら再度出ます)";
      dismissBtn.onclick = () => window.TrackerStore.dismissItem(item.id);
      actionsCell.appendChild(dismissBtn);

      trackerTbodyEl.appendChild(tr);
    });

    trackerSectionEl.classList.toggle("has-items", activeItems.length > 0);
  }

  window.TrackerStore.onChange(renderTracker);

  // content.jsからの「応答が準備できた」通知を待つ
  chrome.runtime.onMessage.addListener((msg) => {
    console.log("[cvb-panel] onMessage受信:", msg.type, msg);
    if (msg.type === "cvb-response-ready") {
      const responseText = msg.text || "(応答テキストを取得できませんでした)";
      if (pendingAuditRequest) {
        // room-task-auditスキルへの問い合わせの返信。通常のログ表示・読み上げは
        // せず、監査結果のパース・トラッカー更新だけを行う(2026-09-13追加)。
        pendingAuditRequest = false;
        handleAuditResponse(responseText, { mode, title: msg.title || "", url: msg.url || "" });
        return;
      }
      addLog(mode, responseText);
      // マーカーの有無に関わらず、捕捉できた発言は全文をJSONに逐次追記して残す
      // (2026-09-12、ユーザー指示「全て拾え」)。
      window.RoomLogStore.append({ text: responseText, source: "active", mode });
      estTokens += Math.round(responseText.length / 4);
      speak(responseText, () => {
        if (active) {
          phase = "keyword";
          scheduleRestart(enterKeywordWait);
        } else {
          setStatus("停止中(オーブをクリックして開始)");
        }
      });
    } else if (msg.type === "cvb-passive-message") {
      // 声で操作していない別タブ(workerルーム等)からの常時監視による通知。
      // ログ表示・読み上げはしないが、全文のJSON記録(RoomLogStore)には使う
      // (2026-09-12、ユーザー指示「マーカーの有無に関わらず全て拾え」)。
      // マーカー正規表現によるトラッカー検出は2026-09-13に廃止済み(room-task-audit
      // スキルへ一本化。このメッセージ自体はトラッカーには使わない)。
      window.RoomLogStore.append({ text: msg.text || "", source: "passive", title: msg.title || "", url: msg.url || "" });
    }
  });

  // ---- 読み上げ(速度・音声の選択に対応) ----
  let rate = 1.0;
  let voices = [];
  let selectedVoiceName; // undefined = 未初期化(初回起動時の自動選定トリガー), "" = システム標準

  function speak(text, onDone) {
    console.log("[cvb-panel] speak() text=", JSON.stringify(text), "rate=", rate, "voice=", selectedVoiceName);
    if (!text) {
      onDone && onDone();
      return;
    }
    setStatus("読み上げ中…", "speaking");
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    utter.rate = rate;
    if (selectedVoiceName) {
      const v = voices.find((v) => v.name === selectedVoiceName);
      if (v) utter.voice = v;
    }
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

  function loadVoices() {
    voices = window.speechSynthesis.getVoices();
    populateVoiceSelect();
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
  }

  function populateVoiceSelect() {
    if (!voices.length) return;
    voiceSelectEl.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "システム標準";
    voiceSelectEl.appendChild(defaultOpt);
    voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.name;
      const quality = /enhanced|natural|premium|neural/i.test(v.name) ? " ★高品質" : "";
      opt.textContent = `${v.name} (${v.lang})${quality}`;
      voiceSelectEl.appendChild(opt);
    });

    if (selectedVoiceName === undefined) {
      // 初回起動時のみ: 利用可能な範囲で高品質な日本語音声があれば初期選択にする
      const preferred =
        voices.find((v) => /^ja/i.test(v.lang) && /enhanced|natural|premium|neural/i.test(v.name)) ||
        voices.find((v) => /enhanced|natural|premium|neural/i.test(v.name));
      selectedVoiceName = preferred ? preferred.name : "";
      chrome.storage.local.set({ cvb_voice_name: selectedVoiceName });
    }
    voiceSelectEl.value = voices.some((v) => v.name === selectedVoiceName) ? selectedVoiceName : "";
  }

  voiceSelectEl.addEventListener("change", () => {
    selectedVoiceName = voiceSelectEl.value;
    chrome.storage.local.set({ cvb_voice_name: selectedVoiceName });
  });

  rateSliderEl.addEventListener("input", () => {
    rate = parseFloat(rateSliderEl.value);
    rateValueEl.textContent = rate.toFixed(1) + "x";
    chrome.storage.local.set({ cvb_rate: rate });
  });

  // ---- 音声認識: 共通ヘルパー ----
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

  function handlePermissionError() {
    active = false;
    setOrbActive(false);
    setStatus("マイクが許可されていません。下の「マイクの許可ページを開く」から許可してください", "error");
    micPermissionBtn.style.display = "block";
  }

  // ---- フェーズ1: キーワード待ち受け(軽量ループ) ----
  // 「Claude」「Gemini」のどちらかが聞こえるまで、短い認識セッションを繰り返す。
  function enterKeywordWait() {
    if (!active) return;
    phase = "keyword";
    setStatus("待ち受け中: 「Claude」または「Gemini」と話しかけてください", "keyword");
    listenForKeyword();
  }

  function listenForKeyword() {
    if (!active || phase !== "keyword") return;
    if (window.speechSynthesis.speaking) {
      // 読み上げ中にマイクが自分の声を拾わないよう待つ(フィードバックループ防止)
      scheduleRestart(listenForKeyword, 300);
      return;
    }
    recognition = createRecognition();
    if (!recognition) return;
    recognizing = true;
    micPermissionBtn.style.display = "none";

    let handled = false;

    recognition.onresult = (event) => {
      handled = true;
      const transcript = event.results[0][0].transcript;
      console.log("[cvb-panel] keyword onresult:", transcript);
      recognizing = false;
      const matched = detectKeywordMode(transcript);
      if (matched) {
        setMode(matched);
        addLog("user", transcript);
        enterConversation();
      } else if (active) {
        scheduleRestart(listenForKeyword);
      }
    };

    recognition.onerror = (event) => {
      console.log("[cvb-panel] keyword onerror:", event.error);
      recognizing = false;
      if (event.error === "no-speech" || event.error === "aborted") {
        handled = true;
        if (active && phase === "keyword") scheduleRestart(listenForKeyword);
        return;
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        handled = true;
        handlePermissionError();
        return;
      }
      setStatus(`音声認識エラー: ${event.error}`, "error");
    };

    recognition.onend = () => {
      recognizing = false;
      if (!handled && active && phase === "keyword") {
        scheduleRestart(listenForKeyword);
      }
    };

    recognition.start();
  }

  // ---- フェーズ2: 通常の会話モード(実際に発話内容を聞き取って送信) ----
  function enterConversation() {
    if (!active) return;
    phase = "conversation";
    listenOnce();
  }

  function listenOnce() {
    if (!active || phase !== "conversation") return;
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
    // 会話モード中なら明示的に再開する(でないとマイクが無言のまま止まって見える)。
    let handled = false;

    recognition.onresult = async (event) => {
      handled = true;
      const transcript = event.results[0][0].transcript;
      console.log("[cvb-panel] onresult:", transcript);
      recognizing = false;
      addLog("user", transcript);
      estTokens += Math.round(transcript.length / 4);
      setStatus("送信中…");
      const ok = await sendTextToPage(transcript);
      if (!ok && active) {
        scheduleRestart(listenOnce);
      }
      // ok === true の場合、応答はcvb-response-readyメッセージを待って処理する
      // (受信後、フェーズはkeyword待ち受けへ戻る。上のonMessageリスナー参照)
    };

    recognition.onerror = (event) => {
      console.log("[cvb-panel] onerror:", event.error);
      recognizing = false;
      if (event.error === "no-speech" || event.error === "aborted") {
        handled = true;
        if (active && phase === "conversation") scheduleRestart(listenOnce);
        return;
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        handled = true;
        handlePermissionError();
        return;
      }
      // それ以外のエラーは一旦表示するが、handledはtrueにしない(onendでの
      // 再開判断に委ねる。会話モード中なら止まりきりにしない)
      setStatus(`音声認識エラー: ${event.error}`, "error");
    };

    recognition.onend = () => {
      console.log("[cvb-panel] onend recognizing=false active=", active, "phase=", phase, "handled=", handled);
      recognizing = false;
      if (!handled && active && phase === "conversation") {
        console.log("[cvb-panel] onend: 未処理のまま終了したため再開します");
        scheduleRestart(listenOnce);
      }
    };

    recognition.start();
  }

  // ---- オーブの起動/停止 ----
  function setOrbActive(isActive) {
    radarCanvas.setAttribute("aria-pressed", String(isActive));
  }

  function startAll() {
    active = true;
    setOrbActive(true);
    enterKeywordWait();
  }

  function stopAll() {
    active = false;
    setOrbActive(false);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (recognition && recognizing) recognition.abort();
    window.speechSynthesis.cancel();
    setStatus("停止中(オーブをクリックして開始)");
  }

  function toggleOrb() {
    if (active) stopAll();
    else startAll();
  }

  radarCanvas.addEventListener("click", toggleOrb);
  radarCanvas.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleOrb();
    }
  });

  // ---- 手動セレクタ設定のUI配線 ----
  async function sendSelectorUpdate(key, value) {
    const tabId = await getActiveTabId();
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: "cvb-set-selector", key, value }).catch(() => {});
  }

  selInput.addEventListener("change", () => sendSelectorUpdate("cvb_input_selector", selInput.value));
  selSend.addEventListener("change", () => sendSelectorUpdate("cvb_send_selector", selSend.value));
  selMessage.addEventListener("change", () => sendSelectorUpdate("cvb_message_selector", selMessage.value));

  async function loadExistingSelectors() {
    const tabId = await getActiveTabId();
    if (!tabId) return;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-get-selectors" });
      if (res) {
        selInput.value = res.input || "";
        selSend.value = res.send || "";
        selMessage.value = res.message || "";
      }
    } catch (e) {
      // 対象タブがまだ無い/読み込み中の場合は無視
    }
  }

  // ---- 定例文ボタン ----
  async function insertTextToPage(text) {
    const tabId = await getActiveTabId();
    if (!tabId) {
      setStatus(`${SITE_LABELS[mode]}のタブを開いて、アクティブにしてください`, "error");
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cvb-insert-text", text });
      if (!res || !res.ok) {
        setStatus("入力欄が見つかりませんでした。手動セレクタ設定を確認してください", "error");
      }
    } catch (e) {
      setStatus("ページとの通信に失敗しました(ページを再読み込みしてください)", "error");
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

  // ---- 初期化 ----
  async function init() {
    const stored = await chrome.storage.local.get(["cvb_mode", "cvb_rate", "cvb_voice_name", "cvb_panel_mode"]);
    if (stored.cvb_mode === "claude" || stored.cvb_mode === "gemini") mode = stored.cvb_mode;
    updateModeUI();
    setPanelMode(stored.cvb_panel_mode === "list" ? "list" : "voice");

    await window.TrackerStore.load(); // renderTrackerはonChangeで自動的に呼ばれる
    await window.RoomLogStore.load();

    rate = typeof stored.cvb_rate === "number" ? stored.cvb_rate : 1.0;
    rateSliderEl.value = String(rate);
    rateValueEl.textContent = rate.toFixed(1) + "x";

    selectedVoiceName = stored.cvb_voice_name; // undefinedなら初回起動時の自動選定へ
    if (voices.length) populateVoiceSelect();

    loadExistingSelectors();
    loadTemplates();
    setStatus("停止中(オーブをクリックして開始)");
  }

  init();
})();
