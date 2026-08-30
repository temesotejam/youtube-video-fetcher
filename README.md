# youtube-video-fetcher

YouTube URL から動画または指定区間を取得し、GitHub Actions Artifact として短時間だけ保存するためのFetcherです。

現在の構成は **GitHubを司令塔、Windows PCを交換可能な実行ノード**として使います。ソースコードはGitHubに置き、Workflow実行時にself-hosted runnerへ自動checkoutします。

## 現在の構成

```text
GitHub repository
      |
      | workflow_dispatch
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
video.mp4 + metadata + download.log + manifest.json
      |
      v
GitHub Actions Artifact (1 day)
      |
      v
ChatGPT等の後段処理
```

GitHub-hosted runnerでは、2026-08-30の実験時にYouTubeから `Sign in to confirm you're not a bot` と判定されたため、通常回線を使えるself-hosted runnerへ切り替えています。

## PC側に必要なもの

- GitHub Actions Runner
- Python 3.12 (`py -3.12` で起動できるもの)

このリポジトリのソースコードを手動でcloneして保守する必要はありません。Deno、FFmpeg、yt-dlpは各Workflow実行時にRunnerの作業領域へ用意し、終了時に一時ファイルと動画出力を削除します。

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

## 動画取得

1. Runnerをオンラインにして `Listening for Jobs` の状態にします。
2. GitHubの **Actions** を開きます。
3. **Fetch YouTube video** を選びます。
4. **Run workflow** を押します。
5. `youtube_url` にYouTube URLを入力します。
6. 必要なら `start_time` と `end_time` を `00:03:20` のように指定します。両方を空欄にすると全編を取得します。
7. 実行後、Workflow runのArtifactsにある `youtube-video-*` を利用します。

## 動作確認済み

2026-08-30にself-hosted runnerで次を確認しています。

- `https://youtu.be/udrtKw3Fljk`
  - 10秒区間を取得成功
  - H.264 + AAC のMP4を生成
- `https://youtu.be/ZhMakZuBU-o?list=RDZhMakZuBU-o`
  - 10秒区間を取得成功
  - Awakestのgooglevideo直リンクではHTTP 403だった動画でも取得成功
  - 別テストではitag 18の全編MP4（26,104,002 bytes）も取得成功
- GitHub Actions ArtifactをChatGPT側から取得し、動画ファイルを展開・確認できることも確認済み

1本目では一体型itag 18がyt-dlpの通常抽出結果に現れない場合がありましたが、本番Fetcherは映像・音声の別ストリームを選び、必要に応じてFFmpegでMP4へ結合できるため取得できました。

## Version 0.1

- Windows self-hosted runner
- 手動 `workflow_dispatch`
- YouTube URL入力
- 全編取得または開始・終了時刻による部分取得
- yt-dlp
- Deno + yt-dlp EJS challenge support
- FFmpeg
- H.264/AAC MP4を優先
- `--no-playlist`
- metadata / download log / manifest出力
- Artifact保持期間 1日
- Artifactアップロード後に取得動画と一時ツールをrunner作業領域から削除

## セキュリティ

このリポジトリは現在publicです。Self-hosted runnerをpublic repositoryに接続する場合、第三者由来のコードをRunnerで実行しないことが重要です。現在の本番動画取得Workflowは `workflow_dispatch` のみで起動し、`pull_request` や第三者のforkを実行トリガーにはしていません。

長時間の無人運用や将来的なPR自動実行を行う場合は、リポジトリをprivateにするか、self-hosted runner用の実行部分をprivate repositoryへ分離する構成を推奨します。

必要な権利・許可があるコンテンツのみを扱い、適用されるサービス規約や法令に従って利用してください。
