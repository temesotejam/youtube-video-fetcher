# youtube-video-fetcher

YouTube URL から動画または指定区間を取得し、GitHub Actions Artifact を経由して ChatGPT などの後段解析へ渡すためのFetcherです。

このリポジトリの主目的は**文字起こしではなく、YouTube動画そのものを解析側まで運ぶこと**です。映像理解、フレーム解析、部品・装置・UIの確認、時系列比較などはFetcherではなく後段のChatGPT側で行います。

## 主経路

```text
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
video.mp4 + video.info.json + download.log + manifest.json
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

## 使い方A: ChatGPTから起動

`request.json` はChatGPTなど、GitHubへの書き込み権限を持つクライアントからFetcherを起動する入口です。

```json
{
  "youtube_url": "https://youtu.be/...",
  "start_time": "00:03:20",
  "end_time": "00:03:40",
  "note": "optional note"
}
```

`request.json` がmainへ更新されると **Fetch YouTube request** が自動起動します。

- `start_time` と `end_time` を両方空欄にすると全編取得
- 両方指定するとその区間だけ取得
- 取得後はArtifactをChatGPT側から再取得可能

2026-08-30の統合テストでは、ChatGPT側から `request.json` を更新して5秒クリップの取得を起動し、生成されたArtifactをChatGPT側へ再取得しました。取得MP4はH.264 1920x1080 + AAC、長さ5.005秒として確認しています。

## 使い方B: GitHub画面から手動実行

1. Runnerを `Listening for Jobs` の状態にします。
2. GitHubの **Actions** を開きます。
3. **Fetch YouTube video** を選びます。
4. **Run workflow** を押します。
5. `youtube_url` を入力します。
6. 必要なら `start_time` と `end_time` を指定します。
7. 実行後、`youtube-video-*` Artifactを利用します。

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

この確認は字幕テキストではなく、取得MP4から直接切り出した映像に基づいています。

### test B: `https://youtu.be/ZhMakZuBU-o?list=RDZhMakZuBU-o`

- 全編 332.44秒を取得
- itag 18 MP4 26,104,002 bytes の取得実績あり
- Awakestで得たgooglevideo直リンクは別環境からHTTP 403になったが、このself-hosted経路では成功
- 30秒: 無人の教室
- 120秒: 雪の積もったブランコ
- 240秒: 夕景の中を進む人物
- 320秒: 踏切・線路を俯瞰する終盤映像

この動画でも、歌詞やYouTube字幕を使わず映像内容を直接確認できています。

## 解析の考え方

FetcherはAI解析をしません。解析側で必要に応じて次を行います。

- 動画全体の代表フレーム抽出
- 指定時刻周辺を高密度に抽出
- 物体・部品・装置・CAD・UI・グラフの確認
- 前後フレームによる動き・姿勢変化の追跡
- 必要ならPython/OpenCV等による数値解析
- CSV / RWLOG / センサログなどとの同期比較
- 音声内容が必要な場合だけ字幕やASRを補助的に利用

## 補助経路: YouTube字幕

`transcript_request.json` と **Optional: Fetch YouTube captions** Workflowは、YouTubeに既存字幕・自動字幕がある場合の補助機能です。

字幕は誤認識を含むことがあるため、映像理解の正解データとは扱いません。必要な場合の参考情報として利用します。

## 実験経路: 独立ASR

`audio_transcript_request.json` と **Experimental: Transcribe media audio** Workflowは、MP4音声そのものから字幕に依存せず音声認識できるかを検証するための実験機能です。

- faster-whisper / Whisper系を使用
- YouTube字幕は入力しない
- CPU推論でも動作確認済み
- 通常運用では実行不要

主経路はあくまで **動画取得 → Artifact → ChatGPTによる直接解析** です。

## Version 0.1 / 現在の到達点

- Windows self-hosted runner
- 手動 `workflow_dispatch`
- ChatGPT等からの `request.json` push起動
- YouTube URL入力
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
- YouTube字幕は任意の補助経路
- 独立ASRは実験経路

## セキュリティ

このリポジトリは現在publicです。Self-hosted runnerをpublic repositoryに接続する場合、第三者由来のコードをRunnerで実行しないことが重要です。現在の主実行トリガーは、手動の `workflow_dispatch` と、書き込み権限を持つ利用者がmainの `request.json` を更新した場合に限定しています。`pull_request` や第三者のforkは実行トリガーにしていません。

`request.json` の内容とGit履歴はpublicになるため、非公開URLや秘密情報を入れないでください。長時間の無人運用、非公開URLの利用、将来的なPR自動実行を行う場合は、リポジトリをprivateにするか、self-hosted runner用の実行部分をprivate repositoryへ分離する構成を推奨します。

必要な権利・許可があるコンテンツのみを扱い、適用されるサービス規約や法令に従って利用してください。
