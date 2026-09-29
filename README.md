# youtube-video-fetcher

YouTube URL から動画または指定区間を取得し、GitHub Actions Artifact を経由して ChatGPT などの後段解析へ渡すためのFetcherです。

このリポジトリの主目的は**文字起こしではなく、YouTube動画そのものを解析側まで運ぶこと**です。映像理解、フレーム解析、部品・装置・UIの確認、時系列比較などはFetcherではなく後段のChatGPT側で行います。

> ChatGPT / AI agent向けの正式な操作手順は [`CHATGPT_WORKFLOW.md`](CHATGPT_WORKFLOW.md) にあります。エージェント向け入口として [`AGENTS.md`](AGENTS.md) も用意しています。

## 主経路

```text
user question + YouTube URL
      |
      v
ChatGPT / GitHub Actions UI
      |
      | request.json push または workflow_dispatch
      v
GitHub repository
      |
      v
Windows self-hosted runner
      |
      | repositoryを自動checkout
      | 一時venvを作成
      | yt-dlp / Deno / FFmpegをWorkflow内で準備
      v
YouTube
      |
      v
video.mp4 + metadata + request context
      |
      v
GitHub Actions Artifact (1 day)
      |
      v
ChatGPT
      |
      | 必要な時刻・区間からフレームを抽出
      | 映像を直接確認
      v
映像理解 / 時系列解析 / 画像計測 / 他データとの比較
```

GitHub-hosted runnerでは、2026-08-30の実験時にYouTubeから `Sign in to confirm you're not a bot` と判定されたため、通常回線を使えるself-hosted runnerへ切り替えています。

## PC側に必要なもの

- GitHub Actions Runner
- Python 3.12 (`py -3.12` で起動できるもの)

このリポジトリのソースコードを手動でcloneして保守する必要はありません。Deno、FFmpeg、yt-dlpはWorkflow実行時にRunnerの作業領域へ用意します。取得動画や一時ツールもArtifactアップロード後に削除します。

Runner管理下の `_work` には実行中だけリポジトリの作業コピーが展開されます。正本はGitHubです。

## Windows Runner の初回登録

1. このリポジトリで **Settings → Actions → Runners → New self-hosted runner** を開きます。
2. OSは **Windows**、Architectureは **x64** を選びます。
3. GitHubに表示されるダウンロード・展開・`config.cmd` のコマンドを実行します。
4. Runner名とwork folderは任意です。追加ラベルは不要です。
5. 最初は `run.cmd` でRunnerを起動します。

WorkflowはWindows x64の標準ラベルを使います。

```text
self-hosted
Windows
X64
```

別PCへ移行する場合も、そのPCをこのリポジトリのWindows x64 self-hosted runnerとして登録すれば、ソースコードを手動コピーする必要はありません。

## 使い方A: ChatGPT / AI agentから起動

`request.json` が汎用的な入口です。

```json
{
  "request_id": "2026-08-30T14-35-00Z-a1b2",
  "youtube_url": "https://youtu.be/...",
  "start_time": "00:03:20",
  "end_time": "00:03:40",
  "question": "この区間で何を変更し、挙動がどう変化したか説明して",
  "note": "Triggered for direct video analysis"
}
```

- `request_id` は**毎回必ず変更**します。同じURL・同じ質問の再実行でも新しい値にします。
- `start_time` と `end_time` を両方空欄にすると全編取得です。
- 両方指定するとその区間だけ取得します。
- `question` はユーザーの解析目的です。取得Artifact内にも `analysis_request.json` として保存されます。
- `request.json` の構造は [`request.schema.json`](request.schema.json) で定義しています。

`request.json` がmainへ更新されると **Fetch YouTube request** が自動起動します。Runnerがオンラインなら、URL取得、Artifact作成、後段でのArtifact取得まで一連の経路を実行できます。

将来のChatGPTや別エージェントは [`CHATGPT_WORKFLOW.md`](CHATGPT_WORKFLOW.md) を読めば、コミット→Workflow runの特定→Artifact取得→直接動画解析まで再現できます。

## 使い方B: GitHub画面から手動実行

1. Runnerを `Listening for Jobs` の状態にします。
2. GitHubの **Actions** を開きます。
3. **Fetch YouTube video** を選びます。
4. **Run workflow** を押します。
5. `youtube_url` を入力します。
6. 必要なら `start_time` と `end_time` を指定します。
7. 実行後、`youtube-video-*` Artifactを利用します。


## Web UI / API

Cloudflare WorkerにはWeb UIとAPIもあります。

```text
https://youtube-cloudflare-browser-fetch.temesotejam-t265.workers.dev/
```

Web UI/APIから取得ジョブを投入するには、Worker側に次の2つのCloudflare Secretsを設定します。

- `GITHUB_FETCH_TOKEN`
  - GitHub fine-grained personal access token
  - Repository access: `temesotejam/youtube-video-fetcher` のみ
  - Repository permissions:
    - Contents: Read and write
    - Actions: Read-only
- `FETCH_API_KEY`
  - Web UI/APIの利用者認証用の任意の長いランダム文字列
  - ブラウザ側コードには埋め込まれず、リクエスト時の `X-API-Key` と照合します

API:

```http
POST /api/fetch
X-API-Key: <FETCH_API_KEY>
Content-Type: application/json

{
  "youtube_url": "https://youtu.be/...",
  "question": "任意の解析メモ"
}
```

成功時は `request_id`、GitHub commit SHA、status endpointを返します。

```http
GET /api/status?sha=<commit_sha>
X-API-Key: <FETCH_API_KEY>
```

status APIは対応するGitHub Actions runを探し、実行状態、完了結果、Actions/Artifactへのリンクを返します。

ページ/APIからGitHubを直接workflow dispatchするのではなく、`cloudflare_request.json` をGitHub Contents APIで更新します。そのcommitが既存のpush triggerを起動するため、ChatGPTからの運用とWeb UIからの運用が同じ取得パイプラインに合流します。

## Version 0.3 / Cloudflare Browser RunによるPC不要経路

2026-09-29に、Cloudflare Browser Runを使った取得経路で、**ローカルPC・self-hosted runner・YouTube Cookieなし**のフル動画取得を確認しました。

実測テストでは次まで成功しています。

- video-only: 80,955,133 bytes
- audio-only: 17,927,026 bytes
- H.264 + AACへremuxした最終MP4: 99,593,135 bytes
- duration: 1107.661497 s
- GitHub Actions Artifactへの保存成功

Cloudflare Browser Runの新規ブラウザ開始レート制限を避けるため、取得は最大16 MiBの範囲に分割し、Browserセッション間に20秒の間隔を設けます。各16 MiBは同一Browserセッション内で4 MiB単位にストリーミングします。

通常のPC不要運用では `cloudflare_request.json` を更新します。

```json
{
  "request_id": "2026-09-29T09-00-00Z-example",
  "youtube_url": "https://youtu.be/...",
  "question": "この動画の設計変更を説明して",
  "note": "Cloudflare Browser Run fetch"
}
```

main上の `.github/workflows/fetch-youtube-cloudflare.yml` が自動起動し、

```text
ChatGPT
  -> cloudflare_request.json
  -> GitHub-hosted runner
  -> Cloudflare Browser Run
  -> YouTube
  -> 16 MiB bounded ranges
  -> GitHubでvideo/audioを結合
  -> video.mp4
  -> GitHub Actions Artifact
  -> ChatGPT
```

の順に処理します。

必要なGitHub Actions Secretsは既存の以下2つです。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

既存のWindows self-hosted runner経路はフォールバックとして残しています。

## Version 0.2 / PC不要のクラウド取得経路

GitHub-hosted Ubuntu runnerで動画を取得する `.github/workflows/fetch-video-cloud.yml` を追加しています。通常はユーザーPCを起動しておく必要はありません。

クラウドIPがYouTubeのbot判定に入る場合に備え、Workflowは次の順で動作します。

1. GitHub Actions Secret `YOUTUBE_COOKIES_B64` が設定されていれば、そこから一時的な `cookies.txt` を復元して認証付きで取得します。
2. Secretがない場合は、匿名の `web_embedded` 経路を試します。
3. PO Token Providerも同じrunner内で起動します。
4. CookieファイルはArtifactへ含めず、最後に必ず削除します。

Secretへ入れる値は、Netscape形式の `cookies.txt` 全体をBase64化した文字列です。Cookie本文をリポジトリ、request JSON、Issue、ログへ直接貼らないでください。

この設計では、認証情報を一度GitHub Secretへ登録した後の通常運用は、

```text
YouTube URL -> ChatGPT -> GitHub Actions -> GitHub-hosted runner -> Artifact -> ChatGPT
```

となり、取得用PCやself-hosted runnerの常時起動は不要です。

## Artifactに含まれるもの

ChatGPT起動の主経路では、原則として次がArtifactへ入ります。

```text
video.mp4                # 実際の取得動画（形式により拡張子は変わる場合あり）
video.info.json          # yt-dlp metadata
download.log             # 取得ログ
manifest.json            # Fetcher側manifest
analysis_request.json    # request_id / URL / 区間 / ユーザー質問
```

`analysis_request.json` に解析目的を同梱することで、別チャットや別の後段クライアントでも「なぜこの動画を取得したのか」を復元できます。

## ChatGPTによる直接動画解析の確認

2026-08-30に、取得した全編MP4をChatGPT側へArtifactから取り込み、YouTube字幕を使わず動画本体からフレームを抽出して内容を確認しました。

### test A: `https://youtu.be/udrtKw3Fljk`

- 全編 612.8秒を取得
- Artifact 約270 MB
- 30秒: 初期の簡易エアボート＋水中翼
- 75秒: 船首が持ち上がった不安定な試作状態
- 150秒: 前翼と左右フラップ機構
- 255秒: 3Dプリント船体の水上走行
- 390秒: 流線型船体内部の3Dプリント形状
- 500秒: 前翼変更後に船体が明確に水面から浮上
- 570秒: 完成形に近い水中翼走行

### test B: `https://youtu.be/ZhMakZuBU-o?list=RDZhMakZuBU-o`

- 全編 332.44秒を取得
- itag 18 MP4 26,104,002 bytes の取得実績あり
- Awakestで得たgooglevideo直リンクは別環境からHTTP 403になったが、このself-hosted経路では成功
- 30秒: 無人の教室
- 120秒: 雪の積もったブランコ
- 240秒: 夕景の中を進む人物
- 320秒: 踏切・線路を俯瞰する終盤映像

これらは字幕テキストではなく、取得したMP4そのものから確認しています。

## 解析の考え方

FetcherはAI解析をしません。解析側で必要に応じて次を行います。

- 動画全体の代表フレーム抽出
- 指定時刻周辺を高密度に抽出
- 物体・部品・装置・CAD・UI・グラフの確認
- 前後フレームによる動き・姿勢変化の追跡
- Python/OpenCV等による位置・角度・軌跡などの数値解析
- CSV / RWLOG / センサログなどとの同期比較
- 音声内容が必要な場合だけ字幕やASRを補助的に利用

## 補助経路: YouTube字幕

`transcript_request.json` と **Optional: Fetch YouTube captions** Workflowは、YouTubeに既存字幕・自動字幕がある場合の補助機能です。

字幕は誤認識を含むことがあるため、映像理解の正解データとは扱いません。

## 実験経路: 独立ASR

`audio_transcript_request.json` と **Experimental: Transcribe media audio** Workflowは、MP4音声そのものから字幕に依存せず音声認識できるかを検証するための実験機能です。

- faster-whisper / Whisper系を使用
- YouTube字幕は入力しない
- CPU推論での動作実績あり
- 通常運用では実行不要

主経路はあくまで **動画取得 → Artifact → ChatGPTによる直接解析** です。

## Version 0.1 / 現在の到達点

- Windows self-hosted runner
- 手動 `workflow_dispatch`
- ChatGPT等からの `request.json` push起動
- 一意な `request_id` による反復実行
- ユーザー質問をArtifactへ同梱
- 全編取得または部分取得
- yt-dlp
- Deno + yt-dlp EJS challenge support
- FFmpeg
- H.264/AAC MP4を優先
- `--no-playlist`
- metadata / download log / manifest出力
- Artifact保持期間 1日
- Artifactアップロード後にRunnerの取得動画・一時ツールを削除
- ChatGPT側からArtifactを直接取得
- ChatGPT側で取得MP4からフレームを直接確認
- `CHATGPT_WORKFLOW.md` による再利用可能なエージェント手順
- YouTube字幕は任意の補助経路
- 独立ASRは実験経路

## セキュリティ

このリポジトリは現在publicです。Self-hosted runnerをpublic repositoryに接続する場合、第三者由来のコードをRunnerで実行しないことが重要です。現在の主実行トリガーは、手動の `workflow_dispatch` と、書き込み権限を持つ利用者がmainの `request.json` を更新した場合に限定しています。`pull_request` や第三者のforkは実行トリガーにしていません。

`request.json` の内容とGit履歴はpublicになるため、非公開URLや秘密情報を入れないでください。長時間の無人運用、非公開URLの利用、将来的なPR自動実行を行う場合は、リポジトリをprivateにするか、self-hosted runner用の実行部分をprivate repositoryへ分離する構成を推奨します。

必要な権利・許可があるコンテンツのみを扱い、適用されるサービス規約や法令に従って利用してください。
