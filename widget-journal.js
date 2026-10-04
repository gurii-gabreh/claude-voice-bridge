// Claude Voice Bridge — 「📓 ジャーナル面談」ウィジェット共通スクリプト(2026-09-27追加、CVB-002)
//
// 面談そのものはGeminiアプリ(Gemini Live+Gem)側で行う。このウィジェットが担当するのは
// (1)Gem設定用プロンプトの提供・コピー、(2)面談後トランスクリプトの貼り付け→GAS経由での
// data/journal.jsonへの保存、(3)過去記録の一覧表示のみ。AIによる要約・構造化はしない
// (ユーザー指示「変にまとめてほしくない」)。webapp/index.htmlの同機能と同じロジックの移植。

(function () {
  "use strict";

  const { makeStatusSetter, reportHeightToParent } = window.CvbWidgetCommon;

  // sidepanel.jsのCVB_GAS_URLと同じ値(2026-09-18デプロイ)。
  const CVB_GAS_URL = "https://script.google.com/macros/s/AKfycbwo94DdC2eg0LFpfISBtca7gfZt0CuUnI4fb7apfxE2mP256AAD39S_6NxyzGrL6ps/exec";
  const JOURNAL_RAW_URL = "https://raw.githubusercontent.com/gurii-gabreh/claude-voice-bridge/main/data/journal.json";

  const GEM_PROMPT_TEXT = `あなたは「1日の振り返り面談」を担当するAIです。ユーザーと音声で自然に会話してください。

## 進め方
1. まず今日あった出来事を、決まった質問を1つずつ聞きながら振り返る(一度に複数質問しない、1つ答えが返ってきたら次へ)。
   決まった質問:
   - 今日できたことは?(できたことについて、良かった点・悪かった点の両方を聞く)
   - 今日できなかったことは?(できなかったことについて、良かった点・悪かった点の両方を聞く)
   - 明日の目標は?
2. 決まった質問が終わったら、そのまま自然に雑談・相談へ移ってよい。ユーザーが話したい話題があればそちらを優先する。
3. 相談・質問された内容には、添付されているナレッジ(参考ファイル)があればそれを踏まえて答える。ナレッジに無い最新情報が必要な場合は検索して確認し、不確かなことは「確認できていません」と正直に伝える。推測で断定しない。

## 聞き方のルール
- 「できたこと」「できなかったこと」それぞれについて、良かった点・悪かった点の両方を必ず言ってもらう(片方しか出てこなければ、もう片方も聞く)。
  例:「できなかったこと」に対しても、単に悪い面だけでなく「その中で良かった面(気づけた、途中まではできた等)」も聞く。
- 答えが曖昧・抽象的だと感じたら、そこで終わらせず「具体的には?」「例えば?」のように深掘りする。
- 「悪かった点・できなかったこと」が出てきたら、必ずその対策(次どうするか)まで聞く。指摘して終わりにしない。
- 話していて落ち込んでいる・元気がないと感じたら、指摘や深掘りより先に励ましの言葉をかける(無理に前向きな結論へ誘導はしない、まず気持ちを受け止める)。

## 話し方
- フランクに、友達と話すような口調で接する(敬語・丁寧語は基本使わない)。
- 相手の話を遮らず、相槌や短い共感を挟みながら、聞き役中心で進める。
- 1回の発言は長すぎないようにする(講義調にならないように)。

## やらないこと
- 会話の途中や最後に、内容を勝手に要約・まとめようとしない(記録は会話終了後の文字起こしで別途行うため、要約は不要)。
- 決めつけ・説教めいた助言をしない。`;

  const gemPromptEl = document.getElementById("gem-prompt");
  const copyGemPromptBtn = document.getElementById("copy-gem-prompt-btn");
  const journalDateEl = document.getElementById("journal-date");
  const journalTranscriptEl = document.getElementById("journal-transcript");
  const saveJournalBtn = document.getElementById("save-journal-btn");
  const journalListEl = document.getElementById("journal-list");
  const journalEmptyEl = document.getElementById("journal-empty");
  const statusEl = document.getElementById("widget-status");
  const setStatus = makeStatusSetter(statusEl);
  const claudeHandoffEl = document.getElementById("claude-handoff");
  const claudeHandoffTextEl = document.getElementById("claude-handoff-text");
  const copyHandoffBtn = document.getElementById("copy-handoff-btn");

  gemPromptEl.value = GEM_PROMPT_TEXT;

  copyGemPromptBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(GEM_PROMPT_TEXT);
      const original = copyGemPromptBtn.textContent;
      copyGemPromptBtn.textContent = "コピーしました";
      setTimeout(() => { copyGemPromptBtn.textContent = original; }, 1200);
    } catch (e) {
      setStatus("コピーに失敗しました: " + e.message, "error");
    }
  });

  function todayLocalISODate() {
    const d = new Date();
    const tzOffsetMs = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
  }
  // 2026-10-05追加(不具合修正): 日付欄はページ読み込み時に1回だけtodayLocalISODate()を
  // セットするため、サイドパネルを開いたまま日付をまたぐと古い日付が残ってしまう
  // (ユーザー指摘)。保存時、この欄が読み込み時の値のまま変更されていなければ、
  // 実際の「今日」へ自動で補正する(ユーザーが意図的に別の日付へ変更した場合は尊重する)。
  let autoSetDate = todayLocalISODate();
  journalDateEl.value = autoSetDate;

  function renderJournalList(entries) {
    journalListEl.innerHTML = "";
    const sorted = (entries || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    journalEmptyEl.style.display = sorted.length ? "none" : "block";
    sorted.forEach((entry) => {
      const card = document.createElement("div");
      card.className = "journal-card";
      const dateEl = document.createElement("div");
      dateEl.className = "journal-card-date";
      dateEl.textContent = entry.date || "(日付不明)";
      const bodyEl = document.createElement("div");
      bodyEl.className = "journal-card-body";
      bodyEl.textContent = entry.rawTranscript || "";
      bodyEl.title = "クリックで全文表示/折りたたみ";
      bodyEl.addEventListener("click", () => bodyEl.classList.toggle("expanded"));
      card.appendChild(dateEl);
      card.appendChild(bodyEl);
      journalListEl.appendChild(card);
    });
  }

  async function loadJournalHistory() {
    try {
      const res = await fetch(`${JOURNAL_RAW_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) {
        renderJournalList([]);
        return;
      }
      const data = await res.json();
      renderJournalList(data.entries || []);
    } catch (e) {
      renderJournalList([]);
      setStatus("過去記録の取得に失敗しました: " + e.message, "error");
    }
  }

  saveJournalBtn.addEventListener("click", async () => {
    const transcript = journalTranscriptEl.value.trim();
    if (!transcript) {
      setStatus("貼り付け内容が空です", "error");
      return;
    }
    const realToday = todayLocalISODate();
    if (journalDateEl.value === autoSetDate && autoSetDate !== realToday) {
      // 日付欄が未編集のまま日をまたいでいたので、実際の今日へ補正する。
      autoSetDate = realToday;
      journalDateEl.value = realToday;
    }
    const entry = {
      id: `${Date.now()}`,
      date: journalDateEl.value || realToday,
      rawTranscript: transcript,
      createdAt: Date.now(),
      analyzed: false,
    };
    setStatus("保存中…");
    try {
      const res = await fetch(CVB_GAS_URL, {
        method: "POST",
        body: JSON.stringify({ action: "saveJournal", entry }),
      });
      const json = await res.json();
      if (json.status === "ok") {
        setStatus("保存しました");
        showClaudeHandoff(entry);
        journalTranscriptEl.value = "";
        loadJournalHistory();
      } else {
        setStatus("保存エラー: " + (json.message || "不明なエラー"), "error");
      }
    } catch (e) {
      setStatus("通信エラー(保存失敗): " + e.message, "error");
    }
  });

  function showClaudeHandoff(entry) {
    if (!claudeHandoffEl || !claudeHandoffTextEl) return;
    const handoffText =
      "【ジャーナル面談】この内容を分析して、mirai-journalのdata/journals.json・data/profile.jsonへ記録してください。\n\n" +
      `日付: ${entry.date}\n\n` +
      entry.rawTranscript;
    claudeHandoffTextEl.value = handoffText;
    claudeHandoffEl.style.display = "block";
    reportHeightToParent();
  }

  if (copyHandoffBtn) {
    copyHandoffBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(claudeHandoffTextEl.value);
        const original = copyHandoffBtn.textContent;
        copyHandoffBtn.textContent = "コピーしました";
        setTimeout(() => { copyHandoffBtn.textContent = original; }, 1200);
      } catch (e) {
        setStatus("コピーに失敗しました: " + e.message, "error");
      }
    });
  }

  loadJournalHistory();
  reportHeightToParent();
})();
