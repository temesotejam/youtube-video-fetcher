# youtube-video-fetcher

YouTube URL から動画を取得し、GitHub Actions Artifact として短時間だけ保存するための小さなFetcherです。

現在の構成は **GitHub を司令塔、Windows PC を交換可能な実行ノード**として使います。コード本体はGitHubに置き、PC側で恒久的に管理するのはGitHub Actions Runnerだけです。

## 現在の構成

```text
GitHub repository
      |
      | workflow_dispatch
      v
Windows self-hosted runner
      |
      | repositoryを自動checkout
      | Python / Deno / FFmpeg / yt-dlpをWorkflow側で準備
      v
YouTube
      |
      v
video.mp4 + metadata + log
      |
      v
GitHub Actions Artifact (1 day)
```

GitHub-hosted runner では、2026-08-30 のテスト時に2本とも YouTube から `Sign in to confirm you're not a bot` と判定されたため、通常回線を使えるself-hosted runnerへ切り替えました。

## PC側に常設するもの

- GitHub Actions Runner

Python、Deno、FFmpeg、yt-dlp、およびこのリポジトリのソースコードはWorkflow実行時に準備します。動画の出力ディレクトリはArtifactへのアップロード後に削除します。

Runnerの管理下にある `_work` ディレクトリには、Workflow実行中にリポジトリの作業コピーが展開されます。これは手動でcloneして管理する開発用コピーではありません。

## Windows Runner の初回登録

1. このリポジトリで **Settings → Actions → Runners → New self-hosted runner** を開きます。
2. OSは **Windows**、Architectureは **x64** を選びます。
3. GitHubに表示されるダウンロード・展開・`config.cmd` のコマンドをPowerShellで実行します。
4. Runner登録時に追加ラベルとして **`youtube-fetcher`** を付けます。
5. 最初の確認では `run.cmd` でRunnerを起動します。

Workflowは次のラベルを持つRunnerだけを使用します。

```text
self-hosted
windows
x64
youtube-fetcher
```

別PCへ移行する場合も、そのPCへRunnerを登録して同じ `youtube-fetcher` ラベルを付ければ、リポジトリ本体を手動コピーする必要はありません。

## 動画取得

1. Runnerをオンラインにします。
2. GitHubの **Actions** を開きます。
3. **Fetch YouTube video** を選びます。
4. **Run workflow** を押します。
5. `youtube_url` にYouTube URLを入力します。
6. 必要なら `start_time` と `end_time` を `00:03:20` のように指定します。
7. 実行後、Workflow runのArtifactsから `youtube-video-*` を取得します。

## Version 0.1

- Windows self-hosted runner
- 手動 `workflow_dispatch`
- YouTube URL入力
- 任意の開始・終了時刻による部分取得
- yt-dlp
- Deno + yt-dlp EJS challenge support
- FFmpeg
- MP4を優先
- `--no-playlist`
- metadata / download log / manifest出力
- Artifact保持期間 1日
- Artifactアップロード後に取得動画をrunnerの作業領域から削除

## セキュリティ

このリポジトリは現在publicです。Self-hosted runnerをpublic repositoryで使う場合は、第三者由来のコードをRunnerで実行しないことが重要です。そのため現在の動画取得Workflowは `workflow_dispatch` のみで起動し、`pull_request` や第三者のforkを実行トリガーにしていません。

将来、PRを自動実行するWorkflowを追加する場合は、self-hosted runner用の実行部分をprivate repositoryへ分離することを推奨します。

必要な権利・許可があるコンテンツのみを扱い、適用されるサービス規約や法令に従って利用してください。
