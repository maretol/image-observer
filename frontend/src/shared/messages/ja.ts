// UI message catalog (ja). Single source of truth for user-facing Japanese
// strings, so UI wording can be changed in one place (#83). This is the i18n
// precursor: locale switching (en etc.) is #16 — for now there is exactly one
// catalog and `t()` reads it directly.
//
// Structure: a FLAT, dot-separated key space (`<feature>.<context>.<use>`),
// `as const` so `MessageKey = keyof typeof ja` yields a literal union and tsc
// flags typos / removed keys at every call site. Values may contain
// `{placeholder}` tokens filled by `t(key, params)`.
//
// Scope (Phase 1, #83 案 A): shared dialogs + the settings dialog and its
// sections. Not yet migrated (Phase 2): KeybindingsTable (a self-contained data
// table) and the feature views (classification / viewer-grid / App). A few text
// blocks that interleave inline <code>/<strong> mid-sentence are intentionally
// left in place — a flat string catalog can't represent embedded markup; those
// need a richer formatter, deferred with the rest.
export const ja = {
  // --- common ---------------------------------------------------------------
  "common.ok": "OK",
  "common.cancel": "キャンセル",
  "common.close": "閉じる",
  "common.loading": "読み込み中…",
  "common.confirm.aria": "確認",

  // --- settings: dialog chrome ---------------------------------------------
  "settings.title": "設定",
  "settings.category.aria": "カテゴリ",
  "settings.category.settings": "設定",
  "settings.category.shortcuts": "ショートカット",
  "settings.loadError": "設定の読み込みに失敗しました",
  "settings.nav.aria": "設定セクション",
  "settings.reset": "既定値に戻す",
  "settings.shortcuts.title": "ショートカット",
  "settings.shortcuts.description": "現在のキーバインド一覧 (再バインドは未対応)。",

  // --- settings: section nav (label + description) --------------------------
  "settings.section.logging.label": "ロギング",
  "settings.section.logging.desc": "ログレベルと、不具合報告に使うログファイルの場所。",
  "settings.section.appearance.label": "外観",
  "settings.section.appearance.desc":
    "アプリ全体の表示倍率 (文字 / ボタン / 入力欄を一括スケール)。",
  "settings.section.viewer.label": "ビューア",
  "settings.section.viewer.desc": "画像表示の操作とパフォーマンス上限。",
  "settings.section.thumbnail.label": "サムネイル",
  "settings.section.thumbnail.desc": "一覧タブのサムネイル生成パラメータ。",
  "settings.section.list.label": "一覧タブ",
  "settings.section.list.desc": "分類ビューでの選択操作の挙動。",
  "settings.section.tagColors.label": "タグ色",
  "settings.section.tagColors.desc": "既知タグのバッジ色マッピング (settings.json で編集)。",

  // --- settings: logging section -------------------------------------------
  "settings.logging.level.label": "ログレベル",
  "settings.logging.level.hint":
    "現在: {hint}。DEBUG は高頻度イベントも記録するためトラブルシュート時のみ推奨。",
  "settings.logging.logLevel.debug.label": "DEBUG",
  "settings.logging.logLevel.debug.hint": "詳細 (高頻度イベント含む)",
  "settings.logging.logLevel.info.label": "INFO",
  "settings.logging.logLevel.info.hint": "標準 (推奨)",
  "settings.logging.logLevel.warn.label": "WARN",
  "settings.logging.logLevel.warn.hint": "警告以上のみ",
  "settings.logging.logLevel.error.label": "ERROR",
  "settings.logging.logLevel.error.hint": "エラーのみ",
  "settings.logging.file.label": "ログファイル",
  "settings.logging.file.hint": "不具合報告時はこのファイルを共有してください",
  "settings.logging.file.uninitialized": "(未初期化)",

  // --- settings: appearance section ----------------------------------------
  "settings.appearance.scale.label": "UI スケール",
  "settings.appearance.scale.hint.matched":
    "文字 / ボタン / 入力欄 / 画像表示を含むアプリ全体を均一に拡大縮小します。",
  "settings.appearance.scale.hint.custom":
    "現在 {percent}% (settings.json で個別指定中)。標準のタイル以外を使いたい場合は settings.json の uiScalePercent を編集してください (範囲外は読み込み時に既定値へ戻ります)。",
  "settings.appearance.scale.small": "小",
  "settings.appearance.scale.standard": "標準",
  "settings.appearance.scale.large": "大",
  "settings.appearance.scale.xlarge": "特大",

  // --- settings: viewer section --------------------------------------------
  "settings.viewer.wheel.label": "マウスホイールの動作",
  "settings.viewer.wheel.fieldHint":
    "どちらのモードでも、ホイールでズーム / パンするのは画像領域だけです。タブバー上では常にタブ列の横スクロールに使われ、ズームしません。Shift / Ctrl + ホイール モードでは画像領域の通常スクロールがパン (移動) になります。ドラッグでのパンは引き続き利用できます。",
  "settings.viewer.wheel.zoom.label": "ホイールで拡大縮小",
  "settings.viewer.wheel.zoom.hint": "従来通り (推奨)",
  "settings.viewer.wheel.shiftZoom.label": "Shift / Ctrl + ホイールで拡大縮小",
  "settings.viewer.wheel.shiftZoom.hint":
    "通常のホイールは画像を上下にスクロール、横方向は trackpad 等の deltaX に追従",
  "settings.viewer.maxPixels.label": "開ける画像サイズの上限",
  "settings.viewer.maxPixels.hint":
    "画像のピクセル数が上限を超える場合は警告して開きません。次回画像を開く操作から有効。",

  // --- settings: thumbnail section -----------------------------------------
  "settings.thumbnail.size.label": "表示サイズ",
  "settings.thumbnail.size.hint":
    "新しく読み込むサムネイルから反映されます。既に読み込まれた画像はキャッシュ生存中は旧サイズのまま (256px が既定)。",
  "settings.thumbnail.mode.label": "アスペクト処理",
  "settings.thumbnail.mode.hint": "新しく読み込むサムネイルから反映されます。",
  "settings.thumbnail.mode.letterbox.label": "レターボックス",
  "settings.thumbnail.mode.letterbox.hint": "縦横比を保ち余白を入れる (推奨)",
  "settings.thumbnail.mode.crop.label": "クロップ",
  "settings.thumbnail.mode.crop.hint": "枠いっぱいに切り出す (はみ出し部分は捨てる)",
  "settings.thumbnail.worker.label": "生成ワーカー数",
  "settings.thumbnail.worker.hint":
    "0 で自動 (CPU 数 / 2、最低 1)。変更はアプリ再起動後に反映されます。",
  "settings.thumbnail.worker.suffixAuto": "(自動)",
  "settings.thumbnail.worker.suffixManual": "本",

  // --- settings: list section ----------------------------------------------
  "settings.list.multiSelect.label": "複数選択 UI",
  "settings.list.multiSelect.fieldHint":
    "チェックボックスは Card 左上のチェックで操作、修飾キーは Ctrl+クリック (トグル) と Shift+クリック (範囲選択) で操作します",
  "settings.list.multiSelect.checkbox.label": "チェックボックス",
  "settings.list.multiSelect.checkbox.hint": "Card 左上のチェックで選択",
  "settings.list.multiSelect.modifier.label": "修飾キー",
  "settings.list.multiSelect.modifier.hint":
    "Ctrl+クリックでトグル / Shift+クリックで範囲選択",
  "settings.list.multiSelect.both.label": "両方",
  "settings.list.multiSelect.both.hint": "チェックボックス + Ctrl/Shift+クリック",
  "settings.list.watch.label": "フォルダ自動監視",
  "settings.list.watch.fieldHint":
    "自動: 外部で画像が追加 / 削除されたり _classification.json が書き換えられると、短い遅延の後に一覧へ反映されます。オフ: 自動更新を行わず、再読み込みボタンを押した時のみ最新化します",
  "settings.list.watch.auto.label": "自動",
  "settings.list.watch.auto.hint": "外部で追加 / 削除された画像と分類データの変更を自動反映",
  "settings.list.watch.off.label": "オフ",
  "settings.list.watch.off.hint": "再読み込みボタンを押した時だけ更新",
  "settings.list.autoSave.label": "タグ・note の保存方法",
  "settings.list.autoSave.fieldHint":
    "自動: 各入力からフォーカスが外れたとき / confidence を変更したときに保存。手動: 保存ボタンまたは Cmd/Ctrl+Enter で保存します",
  "settings.list.autoSave.auto.label": "自動 (フォーカス離脱時)",
  "settings.list.autoSave.auto.hint":
    "タグ・note の入力からフォーカスが外れたとき、または confidence を変更したときに即保存",
  "settings.list.autoSave.manual.label": "手動 (保存ボタン)",
  "settings.list.autoSave.manual.hint": "保存ボタンまたは Cmd/Ctrl+Enter で明示的に保存",

  // --- settings: tag colors view -------------------------------------------
  "settings.tagColors.summary.override": "現在のパレット ({count} 件の上書きを適用済み)。",
  "settings.tagColors.summary.default":
    "既定パレット使用中 (settings.json の tagColors に既定と異なる値の指定はありません)。",
  "settings.tagColors.override.pill": "上書き",
  "settings.tagColors.override.title":
    "settings.json の tagColors で既定とは違う色に上書きされています",

  // --- dialog: conflict (external edit detected) ---------------------------
  "dialog.conflict.title": "⚠ 外部編集を検出しました",
  "dialog.conflict.message":
    "このファイルを開いてからの間に、別のプロセス (AI ツールやテキストエディタ) が _classification.json を編集しました。 どうしますか?",
  "dialog.conflict.force": "強制上書き",
  "dialog.conflict.reload": "再読み込み (推奨)",

  // --- dialog: merge child sidecars ----------------------------------------
  "dialog.merge.aria": "子フォルダのサイドカーをマージ",
  "dialog.merge.heading": "子フォルダのサイドカーが見つかりました",
  "dialog.merge.count": "{nonEmpty} / {total} 件",
  "dialog.merge.skip": "無視して空の親サイドカーを作成",
  "dialog.merge.merge": "マージして親に取込",
} as const
