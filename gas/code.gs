/**
 * claude-voice-bridge — GitHub同期リレー(Google Apps Script Web App)
 *
 * 経緯(2026-09-13、ユーザー指示):
 * サイドパネルのトラッカー(相談・作業タスク一覧)はchrome.storage.localのみに
 * 保存されており、この拡張機能が入っているブラウザ・端末に閉じていた。
 * 「他ブラウザ・他端末でも見られるように、GitHubリポジトリにJSONで保存したい」
 * という指示のため、study-app(gurii-gabreh/study-app/gas/code.gs)と同じ
 * GAS中継パターンで新規に立てる。PATはこのGASのスクリプト プロパティにのみ
 * 保存し、拡張機能側(ブラウザ)には一切持たせない。
 *
 * study-app用のGASプロジェクトとは完全に別物(このプロジェクト専用に新規作成する
 * 方針をユーザーが選択)。PATもclaude-voice-bridgeリポジトリのみのアクセス権限で
 * 発行し、study-app用PATとは分離する(最小権限・影響範囲の分離のため)。
 *
 * このGASは2つのアクションを扱う:
 * 1. saveTracker: 「☁️ GitHubへ同期」ボタンを押した時だけ、その時点のトラッカー
 *    全体(TrackerStore.getData())をdata/tracker.jsonへまるごと上書き保存する
 *    (継続的な自動同期にすると、常時監視で頻繁に更新されるデータの度に大量の
 *    commitが発生してしまうため、あえて手動トリガーのみにしている)。
 * 2. saveKnowledge: 「🔍 ルームタスク一覧を抽出」ボタンを押した時、その1回分の
 *    抽出結果(要約せず全文)をdata/knowledge-log.jsonへ1件追記する(study-appの
 *    saveHistory_と同じ、1件ずつ追記するパターン。ボタンを押すたびに全件を
 *    まるごと送るとcommitがどんどん肥大化するため、あえて1件ずつにしている)。
 *    音声応答(Voiceモード)・常時監視からはこのアクションは呼ばない(2026-09-13、
 *    ユーザー指示「Voiceモードは今まで通りに」「音声は除外してよい」)。
 *
 * ---- デプロイ手順 ----
 * 1. https://script.google.com で新規プロジェクトを作成し、このファイルの内容を貼る。
 * 2. 「プロジェクトの設定」→「スクリプト プロパティ」に以下を追加する:
 *      GITHUB_TOKEN = (GitHubで発行したfine-grained PAT。
 *                       claude-voice-bridgeリポジトリのみ、Contents: Read and write権限。
 *                       study-app用PATとは別に新規発行すること)
 *      REPO_OWNER   = gurii-gabreh
 *      REPO_NAME    = claude-voice-bridge
 * 3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」を選択し、
 *    実行ユーザー「自分」、アクセスできるユーザー「全員」で公開する。
 * 4. 発行されたウェブアプリのURLを、sidepanel.js内のGAS_URL定数に設定する
 *    (Claudeに伝えれば反映できます)。
 */

const GITHUB_API = 'https://api.github.com';
const TRACKER_PATH = 'data/tracker.json';
const KNOWLEDGE_LOG_PATH = 'data/knowledge-log.json';

function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    token: p.getProperty('GITHUB_TOKEN'),
    owner: p.getProperty('REPO_OWNER'),
    repo: p.getProperty('REPO_NAME'),
  };
}

function ghGetSha_(path) {
  const cfg = getConfig_();
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 404) return null; // ファイルがまだ無い(初回)
  if (res.getResponseCode() !== 200) {
    throw new Error(`GET ${path} failed: ${res.getResponseCode()} ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText()).sha;
}

// saveKnowledge_のように既存の中身に追記する場合はこちら(sha+パース済みJSON)を使う。
// saveTracker_のように毎回まるごと上書きするだけの場合はghGetSha_で十分。
function ghGetJson_(path) {
  const cfg = getConfig_();
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 404) return { sha: null, data: null }; // ファイルがまだ無い(初回)
  if (res.getResponseCode() !== 200) {
    throw new Error(`GET ${path} failed: ${res.getResponseCode()} ${res.getContentText()}`);
  }
  const json = JSON.parse(res.getContentText());
  const content = Utilities.newBlob(
    Utilities.base64Decode(json.content.replace(/\n/g, ''))
  ).getDataAsString('utf-8');
  return { sha: json.sha, data: JSON.parse(content) };
}

function ghPut_(path, dataObj, sha, message) {
  const cfg = getConfig_();
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  const body = {
    message: message,
    content: Utilities.base64Encode(JSON.stringify(dataObj, null, 2) + '\n', Utilities.Charset.UTF_8),
  };
  if (sha) body.sha = sha; // 既存ファイルの更新時のみ付与(新規作成時は付けない)
  const res = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 201) {
    throw new Error(`PUT ${path} failed: ${res.getResponseCode()} ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText());
}

// GitHub側のshaが他の更新で既に進んでいた場合(409)は再取得してリトライする
function withRetry_(fn, times) {
  let lastErr;
  for (let i = 0; i < (times || 3); i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (!String(e).includes('409')) throw e;
      Utilities.sleep(300 * (i + 1));
    }
  }
  throw lastErr;
}

function saveTracker_(tracker) {
  return withRetry_(() => {
    const sha = ghGetSha_(TRACKER_PATH);
    ghPut_(TRACKER_PATH, tracker, sha, 'tracker: サイドパネルからの手動同期');
  });
}

// 「🔍 ルームタスク一覧を抽出」ボタン1回分の抽出結果(要約せず全文)を、
// data/knowledge-log.jsonのentries配列へ1件だけ追記する(study-appのsaveHistory_と
// 同じ、1件ずつ追記するパターン。まるごと送り直すとcommitが肥大化し続けるため)。
function saveKnowledge_(entry) {
  return withRetry_(() => {
    const { sha, data } = ghGetJson_(KNOWLEDGE_LOG_PATH);
    const knowledge = data || { entries: [] };
    knowledge.entries = knowledge.entries || [];
    const idx = knowledge.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) knowledge.entries[idx] = entry; // 同じidの再送(通信リトライ等)は上書き
    else knowledge.entries.push(entry);
    ghPut_(KNOWLEDGE_LOG_PATH, knowledge, sha, `knowledge: ${entry.room && entry.room.title || entry.id}`);
  });
}

function doPost(e) {
  let result = { status: 'error', message: 'unknown action' };
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'saveTracker') {
      saveTracker_(body.tracker || {});
      result = { status: 'ok' };
    } else if (body.action === 'saveKnowledge') {
      saveKnowledge_(body.entry || {});
      result = { status: 'ok' };
    }
  } catch (err) {
    result = { status: 'error', message: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
