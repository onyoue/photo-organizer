import { openUrl } from "@tauri-apps/plugin-opener";

interface Props {
  onDismiss: () => void;
  onOpenSettings: () => void;
}

const SETUP_URL =
  "https://github.com/onyoue/photo-organizer/blob/main/gallery-worker/SETUP.md";

/**
 * One-shot welcome / orientation dialog shown on the very first launch
 * (controlled by `AppSettings.welcome_seen` on the Rust side). The point
 * is to make it obvious that:
 *   - The local-folder features (selection, rating, posts) work without
 *     any setup.
 *   - The gallery-share feature is optional and needs a Cloudflare account.
 *   - Where to find the setup guide if/when they want to enable sharing.
 */
export function WelcomeDialog({ onDismiss, onOpenSettings }: Props) {
  return (
    <div className="settings-backdrop" onClick={onDismiss}>
      <div
        className="settings-dialog welcome-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Welcome"
      >
        <div className="settings-header">
          <span className="settings-title">Cullback へようこそ</span>
          <button
            type="button"
            className="settings-close"
            onClick={onDismiss}
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body welcome-body">
          <p>
            Cullback は撮影会後の RAW+JPG を素早く選別し、必要に応じてモデルへ
            ブラウザ経由でレビューしてもらうためのデスクトップアプリです。
          </p>

          <h3 className="welcome-section">いますぐ使える機能</h3>
          <ul className="welcome-list">
            <li>
              <strong>Open Folder</strong> から撮影会フォルダを開いて、
              バンドル単位（RAW+JPG+現像済み）でサムネイル表示
            </li>
            <li>
              <strong>レーティング・タグ・投稿管理</strong>を写真ごとに記録
              （ファイルフォルダ内のサイドカー JSON に保存）
            </li>
            <li>
              <strong>RAW 現像アプリ連携</strong>を 設定 → RAW developers から登録
            </li>
          </ul>

          <h3 className="welcome-section">ギャラリーシェア機能（任意セットアップ）</h3>
          <p>
            モデルにスマホで OK/NG/FAV をつけてもらってアプリに取り込む機能は、
            <strong> Cloudflare アカウントが必要</strong>です。
            無料枠（R2 ストレージ 10GB / Egress 無制限）の範囲内でほぼ完結します。
          </p>
          <p className="welcome-hint">
            セットアップはブラウザ＋ターミナルでの作業が10〜30分ほど。
            あとから 設定 → Gallery で有効化できます。
          </p>

          <div className="welcome-actions">
            <button
              type="button"
              onClick={() => void openUrl(SETUP_URL)}
              title="ブラウザで GitHub のセットアップ手順を開く"
            >
              📖 セットアップ手順を見る
            </button>
            <button
              type="button"
              onClick={() => {
                onDismiss();
                onOpenSettings();
              }}
              title="アプリの設定ダイアログを開く"
            >
              ⚙ 設定を開く
            </button>
          </div>
        </div>

        <div className="settings-actions">
          <button type="button" className="primary" onClick={onDismiss}>
            閉じる（次回から表示しない）
          </button>
        </div>
      </div>
    </div>
  );
}
