// Claude Voice Bridge — content script
// claude.aiのページ内で動作し、サイドパネル(sidepanel.js)からのメッセージを受けて、
// 入力欄への文字流し込み・送信・応答テキストの抽出だけを行う。音声認識・読み上げは
// サイドパネル側の担当。
//
// claude.ai側のDOM構造は非公開・可変のため、要素の特定はheuristic(推測)+
// localStorageでの手動セレクタ上書きの二段構えにしてある。動かない場合はDevToolsで
// 実際の要素を調べ、下記のkeyでlocalStorageに手動セレクタを設定してください。
//   localStorage.setItem('cvb_input_selector', '<入力欄のCSSセレクタ>')
//   localStorage.setItem('cvb_send_selector', '<送信ボタンのCSSセレクタ>')
//   localStorage.setItem('cvb_message_selector', '<メッセージブロックのCSSセレクタ>')

(function () {
  "use strict";

  const STORAGE_KEYS = {
    input: "cvb_input_selector",
    send: "cvb_send_selector",
    message: "cvb_message_selector",
  };

  let seenMessageCount = 0;

  function bySelectorOverride(key) {
    const sel = localStorage.getItem(key);
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch (e) {
      console.warn("[cvb] invalid selector override for", key, sel, e);
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
      `[cvb] findComposerInput: ${candidates.length}件の候補 -> `,
      candidates.map(describeEl)
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
    );
    console.info(`[cvb] findComposerInput: 選択した要素 = ${describeEl(candidates[0])}`);
    return candidates[0];
  }

  function findSendButton() {
    const override = bySelectorOverride(STORAGE_KEYS.send);
    if (override) return override;
    const buttons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    const bySendLabel = buttons.find((b) => {
      const label = (b.getAttribute("aria-label") || b.title || "").toLowerCase();
      return label.includes("send") || label.includes("送信");
    });
    console.info(`[cvb] findSendButton: ${bySendLabel ? describeEl(bySendLabel) : "見つからず(Enterキー送信にフォールバック)"}`);
    return bySendLabel || null;
  }

  function findMessageBlocks() {
    const override = localStorage.getItem(STORAGE_KEYS.message);
    if (override) {
      try {
        const matched = Array.from(document.querySelectorAll(override));
        console.info(`[cvb] findMessageBlocks: 手動セレクタ"${override}"で${matched.length}件`);
        return matched;
      } catch (e) {
        console.warn("[cvb] invalid selector override for message", e);
      }
    }
    const root = document.querySelector("main") || document.body;
    const matched = Array.from(root.querySelectorAll("div, article")).filter((el) => {
      const text = el.textContent || "";
      return text.trim().length > 20 && text.trim().length < 20000;
    });
    console.info(`[cvb] findMessageBlocks: 自動検出(div,article)で${matched.length}件`);
    return matched;
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
    const sendBtn = findSendButton();
    if (sendBtn && sendBtn.disabled) {
      console.warn("[cvb] submitComposer: 送信ボタンは見つかったがdisabled状態(入力欄の状態更新が反映される前に押している可能性)");
    }
    if (sendBtn && !sendBtn.disabled) {
      console.info("[cvb] submitComposer: 送信ボタンをクリック");
      sendBtn.click();
      return true;
    }
    // 送信ボタンが見つからない/disabledの場合のフォールバック。ただし合成KeyboardEventは
    // isTrusted=falseになるため、React等のイベントハンドラが無視して実際には送信されない
    // ことがある(既知の制約。この場合は手動セレクタで送信ボタンを明示指定するのが確実)。
    console.warn("[cvb] submitComposer: 送信ボタンが押せないためEnterキーをシミュレート(効かない場合は手動セレクタ設定で送信ボタンを指定してください)");
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
      console.warn("[cvb] waitForResponse: 新規ブロック出現待ちがタイムアウトしたため現状で判定します");
      startSettleWatch();
    }, 15000);
    const appearObserver = new MutationObserver(() => {
      if (findMessageBlocks().length > startCount) {
        clearTimeout(appearTimeout);
        appearObserver.disconnect();
        console.info("[cvb] waitForResponse: 新規ブロック出現を確認、完了判定(フェーズ2)を開始");
        startSettleWatch();
      }
    });
    appearObserver.observe(root, { childList: true, subtree: true });
  }

  function extractLatestResponseText() {
    const blocks = findMessageBlocks();
    if (blocks.length <= seenMessageCount) {
      const last = blocks[blocks.length - 1];
      return last ? last.textContent.trim() : "";
    }
    const newBlocks = blocks.slice(seenMessageCount);
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
      console.info(`[cvb] cvb-set-selector: ${msg.key} = "${msg.value}"`);
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
      const input = findComposerInput();
      if (!input) {
        console.warn("[cvb] cvb-send-text: 入力欄が見つかりませんでした");
        sendResponse({ ok: false, reason: "input-not-found" });
        return true;
      }
      seenMessageCount = findMessageBlocks().length;
      console.info(`[cvb] cvb-send-text: ${describeEl(input)} へ入力 -> "${msg.text}"`);
      setComposerText(input, msg.text);
      // 入力直後だとProseMirror/React側の状態更新(送信ボタンの有効化)が
      // まだ反映されておらず、disabled状態のボタンを掴んでEnterキー
      // フォールバックに落ちてしまうことがあったため、少し間を置く。
      setTimeout(() => {
        submitComposer(input);
        waitForResponse(() => {
          const responseText = extractLatestResponseText();
          console.info(`[cvb] waitForResponse: 応答テキスト(${responseText.length}文字)`, responseText.slice(0, 80));
          chrome.runtime.sendMessage({ type: "cvb-response-ready", text: responseText }, () => {
            if (chrome.runtime.lastError) {
              // サイドパネルが閉じている等で受け手がいないと失敗する。応答自体の取得は
              // 成功しているので、原因切り分けのためにログだけ残す。
              console.warn("[cvb] cvb-response-ready の送信に失敗:", chrome.runtime.lastError.message);
            } else {
              console.info("[cvb] cvb-response-ready を送信済み");
            }
          });
        });
      }, 80);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
