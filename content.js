// Claude Voice Bridge — content script
// claude.ai / Gemini のページ内で動作し、サイドパネル(sidepanel.js)からのメッセージを
// 受けて、入力欄への文字流し込み・送信・応答テキストの抽出だけを行う。音声認識・読み上げは
// サイドパネル側の担当。この1つのcontent.jsが両サイトへ同じmatchesで注入される
// (manifest.json参照)。
//
// 両サイトともDOM構造は非公開・可変のため、要素の特定はheuristic(推測)+
// localStorageでの手動セレクタ上書きの二段構えにしてある。localStorageはオリジン単位で
// 分離されている(claude.aiとgemini.google.comは別オリジン)ため、サイトごとに
// キー名を分ける必要はなく、下記の同じkeyがサイトごとに独立して効く。動かない場合は
// DevToolsで実際の要素を調べ、下記のkeyでlocalStorageに手動セレクタを設定してください。
//   localStorage.setItem('cvb_input_selector', '<入力欄のCSSセレクタ>')
//   localStorage.setItem('cvb_send_selector', '<送信ボタンのCSSセレクタ>')
//   localStorage.setItem('cvb_message_selector', '<メッセージブロックのCSSセレクタ>')

(function () {
  "use strict";

  const SITE = location.hostname.includes("gemini.google.com") ? "gemini" : "claude";

  const STORAGE_KEYS = {
    input: "cvb_input_selector",
    send: "cvb_send_selector",
    message: "cvb_message_selector",
  };

  let seenMessageCount = 0;
  // 2026-09-13追加(不具合修正): ボイスモードでの会話ターン(listenOnce由来のcvb-send-text)と、
  // 「🔍 ルームタスク一覧を抽出」ボタンでの監査ターン(audit由来のcvb-send-text)が、
  // 同じseenMessageCount/waitForResponseの仕組みを共有しているため、片方の応答待ち中に
  // もう片方が割り込むと、seenMessageCountの上書き・MutationObserverの二重起動で
  // 応答の取り違え(無関係なUI文言を誤って抽出する等)が起きる不具合があった
  // (ユーザー指摘「ボイス側の機能が作動しているときに起きる」)。このフラグで
  // 送信〜応答受信までの間は新規の送信を拒否し、同時に2つの送信サイクルが
  // 走らないようにする。
  let sendInFlight = false;

  function bySelectorOverride(key) {
    const sel = localStorage.getItem(key);
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch (e) {
      console.warn(`[cvb:${SITE}] invalid selector override for`, key, sel, e);
      return null;
    }
  }

  function describeEl(el) {
    if (!el) return "(none)";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  // 自分自身から`root`までの祖先を辿り、いずれかがposition:fixed/stickyなら
  // trueを返す(画面に固定表示される操作バー・ヘッダー等を検出するため)。
  function isFixedPositioned(el, root) {
    let node = el;
    while (node && node !== root && node !== document.body) {
      const pos = window.getComputedStyle(node).position;
      if (pos === "fixed" || pos === "sticky") return true;
      node = node.parentElement;
    }
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    // offsetParentは position:fixed の要素でnullになる既知の仕様があり、
    // 画面下部に固定された入力欄を誤って「非表示」と判定してしまうため使わない。
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findComposerInput() {
    const override = bySelectorOverride(STORAGE_KEYS.input);
    if (override) return override;
    const candidates = Array.from(
      document.querySelectorAll('div[contenteditable="true"], textarea')
    ).filter(isVisible);
    console.info(
      `[cvb:${SITE}] findComposerInput: ${candidates.length}件の候補 -> `,
      candidates.map(describeEl)
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
    );
    console.info(`[cvb:${SITE}] findComposerInput: 選択した要素 = ${describeEl(candidates[0])}`);
    return candidates[0];
  }

  // 2026-09-13不具合修正: 以前はページ内の最初に見つかった「send/送信」ラベルの
  // ボタンを無条件で採用していたが、claude.ai/codeにはヘッダー付近に「フィードバックを
  // 送信」ボタン(aria-labelに"送信"を含む)が別に存在し、そちらがDOM順で先に来る場合が
  // あり、誤ってそちらをクリックしてしまうと実際のメッセージは送信されず、代わりに
  // フィードバック送信用のダイアログが開いてしまう不具合があった(ユーザー報告
  // 「抽出ボタンを押すとフィードバックの小ウィンドウが開く」)。対策として、
  // 該当ラベルのボタンが複数見つかった場合は、入力欄(composer)の座標に最も近い
  // ものを選ぶ(実際の送信ボタンは常に入力欄のすぐそば(通常は右下)にあるのに対し、
  // 「フィードバックを送信」ボタンはページ上部など離れた位置にあるため)。
  function findSendButton(inputEl) {
    const override = bySelectorOverride(STORAGE_KEYS.send);
    if (override) return override;
    const buttons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    const bySendLabel = buttons.filter((b) => {
      const label = (b.getAttribute("aria-label") || b.title || "").toLowerCase();
      return label.includes("send") || label.includes("送信");
    });
    let chosen = null;
    if (bySendLabel.length > 1 && inputEl) {
      const inputRect = inputEl.getBoundingClientRect();
      const inputCenter = { x: inputRect.left + inputRect.width / 2, y: inputRect.top + inputRect.height / 2 };
      chosen = bySendLabel.reduce((closest, b) => {
        const r = b.getBoundingClientRect();
        const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const dist = Math.hypot(c.x - inputCenter.x, c.y - inputCenter.y);
        if (!closest || dist < closest.dist) return { el: b, dist };
        return closest;
      }, null).el;
      console.info(
        `[cvb:${SITE}] findSendButton: "送信"系ラベルのボタンが${bySendLabel.length}件見つかったため、入力欄に最も近いものを採用 -> `,
        bySendLabel.map(describeEl)
      );
    } else {
      chosen = bySendLabel[0] || null;
    }
    console.info(`[cvb:${SITE}] findSendButton: ${chosen ? describeEl(chosen) : "見つからず(Enterキー送信にフォールバック)"}`);
    return chosen;
  }

  function findMessageBlocks() {
    const override = localStorage.getItem(STORAGE_KEYS.message);
    if (override) {
      try {
        const matched = Array.from(document.querySelectorAll(override));
        console.info(`[cvb:${SITE}] findMessageBlocks: 手動セレクタ"${override}"で${matched.length}件`);
        return matched;
      } catch (e) {
        console.warn(`[cvb:${SITE}] invalid selector override for message`, e);
      }
    }
    const root = document.querySelector("main") || document.body;
    let candidates = Array.from(root.querySelectorAll("div, article")).filter((el) => {
      const text = el.textContent || "";
      return text.trim().length > 20 && text.trim().length < 20000;
    });
    // 2026-09-13追加(不具合修正): モデル名・高速モード切替・編集承認ボタン等が
    // まとまった、常に画面に居座る操作バー(position:fixed/sticky)が、会話の
    // 進行と無関係に「新しいブロック」として毎回検出されてしまい、実際の返答の
    // 代わりに抽出されてしまう不具合があった(ユーザー報告「編集を受け入れる
    // Sonnet 5高速モード：オフ」が返答として抽出される)。実際の発言は通常の
    // 文書フロー内でスクロールする(position:staticまたはrelative)のに対し、
    // この種の操作バーは画面に固定表示するためfixed/stickyが使われることが
    // 多いため、祖先を含めて固定配置されている要素は候補から除外する。
    candidates = candidates.filter((el) => !isFixedPositioned(el, root));
    // 入れ子になった要素(親が子の内容をまるごと含んでいる場合)は内側(子)だけ残し、
    // 同じ内容が親・子の両方で二重に数えられるのを防ぐ(2026-09-13、ユーザー指摘
    // 「抽出結果が重複だらけで使い物にならない」への対応。特にclaude.ai/codeの
    // ような複雑な画面構成でduplicateが目立っていた)。
    const beforeCount = candidates.length;
    candidates = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other))
    );
    // 仮想化・アクセシビリティ用の隠し複製など、DOM構造は別でも中身が完全一致する
    // 要素も重複としてまとめて除去する。
    //
    // 2026-09-13追記(不具合修正): 当初は単純にtextContentの完全一致だけで重複判定
    // していたが、これだと「room-task-auditへの返答が前回と一字一句同じ」という
    // 正当なケース(ルームの内容が変わっていない場合、同じ監査結果を返すのは仕様通り)
    // まで「重複」として除去してしまい、実際には新しく増えた返答ブロックが消えて
    // ブロック総数が増えなかったことになり(件数が増えないため無関係な末尾要素を
    // 誤って抽出する不具合の原因になっていた)。アクセシビリティ用の隠し複製は
    // 同じ画面位置(同じbounding rect)に重なって存在するのに対し、時間的に離れた
    // 別ターンの正当な同一テキストは画面上の位置(特に縦位置)が異なるはずなので、
    // テキストが一致し、かつ画面上でほぼ同じ位置(top/leftの差が2px未満)にある
    // 場合のみ重複として除去するよう変更した。
    const seen = [];
    const matched = candidates.filter((el) => {
      const text = (el.textContent || "").trim();
      const rect = el.getBoundingClientRect();
      const isDup = seen.some(
        (s) => s.text === text && Math.abs(s.rect.top - rect.top) < 2 && Math.abs(s.rect.left - rect.left) < 2
      );
      if (isDup) return false;
      seen.push({ text, rect });
      return true;
    });
    console.info(
      `[cvb:${SITE}] findMessageBlocks: 自動検出で${matched.length}件(重複除去前${beforeCount}件)`
    );
    return matched;
  }

  // テキストノードを1つずつ辿り、needleを含む最初のノードの親要素を返す
  // (leaf-levelで探すことで、巨大な祖先要素ではなく実際にその文言がある
  // 最小限の要素を特定できる)。2026-09-13追加。
  function findElementContainingText(root, needle) {
    if (!needle) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(needle)) {
        return node.parentElement;
      }
    }
    return null;
  }

  function setComposerText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }
  }

  function submitComposer(el) {
    const sendBtn = findSendButton(el);
    if (sendBtn && sendBtn.disabled) {
      console.warn(`[cvb:${SITE}] submitComposer: 送信ボタンは見つかったがdisabled状態(入力欄の状態更新が反映される前に押している可能性)`);
    }
    if (sendBtn && !sendBtn.disabled) {
      console.info(`[cvb:${SITE}] submitComposer: 送信ボタンをクリック`);
      sendBtn.click();
      return true;
    }
    // 送信ボタンが見つからない/disabledの場合のフォールバック。ただし合成KeyboardEventは
    // isTrusted=falseになるため、React等のイベントハンドラが無視して実際には送信されない
    // ことがある(既知の制約。この場合は手動セレクタで送信ボタンを明示指定するのが確実)。
    console.warn(`[cvb:${SITE}] submitComposer: 送信ボタンが押せないためEnterキーをシミュレート(効かない場合は手動セレクタ設定で送信ボタンを指定してください)`);
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    el.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    return false;
  }

  function waitForResponse(onSettled) {
    const root = document.querySelector("main") || document.body;
    const startCount = seenMessageCount;

    function startSettleWatch() {
      let timer = null;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, 700);
      });
      function finish() {
        observer.disconnect();
        onSettled();
      }
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(finish, 30000);
    }

    // フェーズ1: 新しい応答ブロックが実際に現れるまで待つ。生成開始前の「考え中」の
    // 沈黙時間中に旧ロジックの1.2秒無変化判定が誤って早期成立し、まだ存在しない
    // 新しい返答の代わりに直前の返答を拾ってしまう不具合があったための対策。
    const appearTimeout = setTimeout(() => {
      appearObserver.disconnect();
      console.warn(`[cvb:${SITE}] waitForResponse: 新規ブロック出現待ちがタイムアウトしたため現状で判定します`);
      startSettleWatch();
    }, 15000);
    const appearObserver = new MutationObserver(() => {
      if (findMessageBlocks().length > startCount) {
        clearTimeout(appearTimeout);
        appearObserver.disconnect();
        console.info(`[cvb:${SITE}] waitForResponse: 新規ブロック出現を確認、完了判定(フェーズ2)を開始`);
        startSettleWatch();
      }
    });
    appearObserver.observe(root, { childList: true, subtree: true });
  }

  function extractLatestResponseText() {
    const blocks = findMessageBlocks();
    if (blocks.length <= seenMessageCount) {
      const last = blocks[blocks.length - 1];
      console.info(`[cvb:${SITE}] extractLatestResponseText: 件数が増えなかったため末尾ブロックを採用 -> ${describeEl(last)}`);
      return last ? last.textContent.trim() : "";
    }
    const newBlocks = blocks.slice(seenMessageCount);
    console.info(
      `[cvb:${SITE}] extractLatestResponseText: 新規ブロック${newBlocks.length}件を採用 -> `,
      newBlocks.map(describeEl)
    );
    return newBlocks
      .map((b) => b.textContent.trim())
      .filter(Boolean)
      .join("\n");
  }

  // サイドパネルからのメッセージを受ける
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "cvb-set-selector") {
      // 拡張機能ページ(サイドパネル)のlocalStorageとclaude.aiページのlocalStorageは
      // 別物なので、手動セレクタはこのメッセージ経由でページ側に書き込む。
      if (msg.value) localStorage.setItem(msg.key, msg.value);
      else localStorage.removeItem(msg.key);
      console.info(`[cvb:${SITE}] cvb-set-selector: ${msg.key} = "${msg.value}"`);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "cvb-get-selectors") {
      sendResponse({
        input: localStorage.getItem(STORAGE_KEYS.input) || "",
        send: localStorage.getItem(STORAGE_KEYS.send) || "",
        message: localStorage.getItem(STORAGE_KEYS.message) || "",
      });
      return true;
    }
    if (msg.type === "cvb-extract-room-text") {
      // 「ルームタスク一覧」ボタン用: 常時監視(cvb-passive-message)を待たず、
      // 今このタブに見えている発言を全てその場で抽出して返す(2026-09-13追加、
      // ユーザー指示「ボタンを押したらルーム内の文言を吸い出し、タスクを一覧化」)。
      const blocks = findMessageBlocks();
      const text = blocks.map((b) => b.textContent.trim()).filter(Boolean).join("\n");
      sendResponse({ ok: true, text, title: document.title, url: location.href });
      return true;
    }
    if (msg.type === "cvb-scroll-to-quote") {
      // トラッカー表の項目番号クリック用: room-task-auditスキルが返した「引用」
      // (会話中の一意なフレーズ)をページ内のテキストノードから探し、その要素へ
      // スクロールする(2026-09-13追加、ユーザー指示「相談番号をクリックしたら
      // ルーム内のその箇所に遷移するようにしろ」)。
      const el = findElementContainingText(document.body, msg.quote || "");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, reason: "quote-not-found" });
      }
      return true;
    }
    if (msg.type === "cvb-insert-text") {
      // 定例文ボタン用: 入力欄へ反映するだけで送信はしない(送信は自分で押す想定)
      const input = findComposerInput();
      if (!input) {
        sendResponse({ ok: false, reason: "input-not-found" });
        return true;
      }
      setComposerText(input, msg.text);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "cvb-send-text") {
      if (sendInFlight) {
        // ボイスモードの会話ターンと監査ターンが同時に走ると応答を取り違えるため、
        // 既に送信〜応答待ち中なら今回は送らずbusyを返す(2026-09-13追加)。
        console.warn(`[cvb:${SITE}] cvb-send-text: 既に別の送信が応答待ち中のため今回はスキップします(ボイスモードが会話中の可能性があります)`);
        sendResponse({ ok: false, reason: "busy" });
        return true;
      }
      const input = findComposerInput();
      if (!input) {
        console.warn(`[cvb:${SITE}] cvb-send-text: 入力欄が見つかりませんでした`);
        sendResponse({ ok: false, reason: "input-not-found" });
        return true;
      }
      sendInFlight = true;
      seenMessageCount = findMessageBlocks().length;
      console.info(`[cvb:${SITE}] cvb-send-text: ${describeEl(input)} へ入力 -> "${msg.text}"`);
      setComposerText(input, msg.text);
      // 入力直後だとProseMirror/React側の状態更新(送信ボタンの有効化)が
      // まだ反映されておらず、disabled状態のボタンを掴んでEnterキー
      // フォールバックに落ちてしまうことがあったため、少し間を置く。
      setTimeout(() => {
        submitComposer(input);
        waitForResponse(() => {
          const responseText = extractLatestResponseText();
          console.info(`[cvb:${SITE}] waitForResponse: 応答テキスト(${responseText.length}文字)`, responseText.slice(0, 80));
          sendInFlight = false;
          chrome.runtime.sendMessage(
            { type: "cvb-response-ready", text: responseText, title: document.title, url: location.href },
            () => {
              if (chrome.runtime.lastError) {
                // サイドパネルが閉じている等で受け手がいないと失敗する。応答自体の取得は
                // 成功しているので、原因切り分けのためにログだけ残す。
                console.warn(`[cvb:${SITE}] cvb-response-ready の送信に失敗:`, chrome.runtime.lastError.message);
              } else {
                console.info(`[cvb:${SITE}] cvb-response-ready を送信済み`);
              }
            }
          );
        });
      }, 80);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // ---- 常時監視(声で操作していない別タブの内容も、トラッカー表に反映するため) ----
  // 2026-09-12追加: 「workerルーム等、他のルームへの依頼もこの表に出してほしい」という
  // ユーザー指示のため追加。上のwaitForResponse(声で送信した直後の応答待ち、ログ表示・
  // 読み上げ用)とは完全に別の仕組みで、このタブが開かれている間ずっと動く。
  // ここで拾った内容は「cvb-passive-message」としてサイドパネルへ送り、トラッカーの
  // マーカー検出にのみ使う(ログ表示・読み上げはしない。それらは音声操作した
  // アクティブタブのcvb-response-ready経路のみで行う)。
  let passiveSeenCount = 0;
  let passiveDebounceTimer = null;

  function passiveCheckAndSend() {
    const blocks = findMessageBlocks();
    if (blocks.length <= passiveSeenCount) return;
    const newBlocks = blocks.slice(passiveSeenCount);
    passiveSeenCount = blocks.length;
    const text = newBlocks.map((b) => b.textContent.trim()).filter(Boolean).join("\n");
    if (!text) return;
    chrome.runtime.sendMessage(
      { type: "cvb-passive-message", text, title: document.title, url: location.href },
      () => {
        if (chrome.runtime.lastError) {
          // サイドパネルが閉じている間は届かないだけなので無視してよい
        }
      }
    );
  }

  function startPassiveWatch() {
    passiveSeenCount = findMessageBlocks().length; // 監視開始時点の既存発言は対象外
    const root = document.querySelector("main") || document.body;
    const observer = new MutationObserver(() => {
      clearTimeout(passiveDebounceTimer);
      passiveDebounceTimer = setTimeout(passiveCheckAndSend, 1500);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    console.info(`[cvb:${SITE}] startPassiveWatch: 常時監視を開始(baseline=${passiveSeenCount}件)`);
  }
  startPassiveWatch();
})();
