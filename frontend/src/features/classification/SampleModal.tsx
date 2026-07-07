import { useEffect, useMemo, useRef, useState } from "react";
import type { classification } from "../../../wailsjs/go/models";
import { ModalShell } from "../../shared/components/ModalShell";
import { CloseIcon } from "../../shared/icons/CloseIcon";
import { toBytes } from "../../shared/utils/base64";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { getPreview } from "../../shared/utils/thumbnailDefaults";
import { SampleEditPane } from "./SampleEditPane";
import type { SaveContext } from "./useClassificationEdit";

// 未保存編集中の prev/next tooltip (#93, spec §5.4)。title だけに出す — aria-label は
// 操作名 ("前の画像 (←)") のままにして SR が常にボタンの機能を読み上げるように。
const NAV_BLOCKED_TOOLTIP =
  "未保存の変更があります。保存またはキャンセルしてください";

export type SampleModalOpenSource = "preview" | "edit";

type SampleModalProps = {
  open: boolean;
  // 表示する POSIX path。閉じている間は null。
  imagePath: string | null;
  // ヘッダ表示名。filename はサブディレクトリ区切りを含みうる (`child/foo.png`) ので、
  // ここで path を parse せず呼び出し側が決めたラベルを受ける。
  filename: string | null;
  onClose: () => void;
  // footer の viewer セレクタ用 (#11)。active は既定選択のハイライトに使う。
  viewers: { id: string; name: string }[];
  activeViewerId: string;
  onOpenInViewer: (viewerId: string) => void;
  // prev/next (#94)。null = グループ端 (ディレクトリ跨ぎ / 端ループ禁止)。両方 null で
  // nav 全体を隠す。未保存編集中 (#93, spec §5.4) は dirty が上乗せで disable する。
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  // entry は現在の preview filename に対応する entry が無いとき null (filter race 中など) —
  // pane は空 placeholder を出す。openSource は初期 focus を振り分ける ("edit" → tag 入力)。
  entry: classification.Entry | null;
  knownTags: string[];
  openSource: SampleModalOpenSource;
  // 現在の folder (#110 C)。SampleEditPane の save wrapper が各 save の SaveContext.folder に
  // 刻み、saveEdit が live ref でなく編集が属する folder で gate できるようにする。
  folder: string;
  // manual モードは void、auto モード (#105) は Promise を await して in-flight save を
  // 直列化する (spec §5.3)。ctx は save を capture した folder を運ぶ (#110 C)。
  onSave: (
    next: classification.Entry,
    ctx: SaveContext,
  ) => void | Promise<void>;
  // SampleEditPane の auto (true) / manual (false) save モード (#105)。
  autoSave: boolean;
};

export function SampleModal({
  open,
  imagePath,
  filename,
  onClose,
  viewers,
  activeViewerId,
  onOpenInViewer,
  onPrev,
  onNext,
  entry,
  knownTags,
  openSource,
  folder,
  onSave,
  autoSave,
}: SampleModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">(
    "idle",
  );
  // 未保存中に prev/next を止めるため SampleEditPane から dirty を吸い上げる (#93 spec §5.4)。
  const [editDirty, setEditDirty] = useState(false);

  // ModalShell の初期 focus 振り分け。既定だと最初の focusable = 閉じるアイコンに当たり
  // child の autoFocus を上書きするので、ref を明示する (spec §5.2):
  //   "edit"    → tag 入力、"preview" → 閉じるボタン
  const tagInputRef = useRef<HTMLInputElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useMemo(
    () => (openSource === "edit" ? tagInputRef : closeBtnRef),
    [openSource],
  );

  // modal が閉じるか active *filename* が変わったとき dirty を reset。entry 自体でなく
  // entry?.filename で key するのは意図的: watcher reload は baseline 不変の新 entry オブ
  // ジェクトを渡し、SampleEditPane は in-pane 編集を保つ (lastBaselineRef で reset を短絡)。
  // ref churn ごとに親の editDirty を reset すると child と desync する (onDirtyChange は
  // dirty 変化時しか再発火しないので editDirty が false のまま固まる)。save 経路 (同一
  // filename + 新 baseline) は SampleEditPane の baselineChanged 分岐が扱う。
  useEffect(() => {
    setEditDirty(false);
  }, [open, entry?.filename]);

  useEffect(() => {
    if (!open || !imagePath) {
      setUrl(null);
      setState("idle");
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setUrl(null);
    setState("loading");
    getPreview(imagePath)
      .then((res) => {
        if (cancelled) return;
        const bytes = toBytes(res.data);
        const blob = new Blob([bytes], { type: res.mimeType });
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
        setState("ok");
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = errorMessage(e);
        logger.warn("classification", "sample modal load failed", {
          path: imagePath,
          err: msg,
        });
        setState("error");
      });
    return () => {
      cancelled = true;
      // close / path 変更で即 revoke。useGridThumbnail と違い consumer が 1 つで、
      // 並行 <img> の fetch が残る risk が無い (modal の <img> は同期的に破棄される)。
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [open, imagePath]);

  // dirty block 適用後の実効 nav (#93 §5.4)。null = 方向なし (グループ端) or dirty block。
  // どちらかは title 文言で区別する。
  const prevBlocked = editDirty && onPrev !== null;
  const nextBlocked = editDirty && onNext !== null;
  const effectivePrev = prevBlocked ? null : onPrev;
  const effectiveNext = nextBlocked ? null : onNext;

  // ←/→ で directory グループ内の prev/next (#94)。Esc / Tab は ModalShell が持つので
  // ここは arrow だけ。editable 要素に focus 中は抑止するが、TagInput の chip × は
  // <button> なので INPUT/TEXTAREA だけの guard だと chip × 上で preview が動く —
  // `.cls-tag-input` 祖先チェックで chip-input widget 全体を覆う。
  //
  // ←/→ は (editable guard の後) 方向の可否によらず常に preventDefault し、callback は
  // 非 null のときだけ呼ぶ。無条件 preventDefault が無いと dirty-block や group 端で
  // browser 既定 (背景スクロール等) に落ちて spec §5.4 の no-op 期待を破る。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest(".cls-tag-input"))
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        effectivePrev?.();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        effectiveNext?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, effectivePrev, effectiveNext]);

  // 少なくとも片方向が *利用可能* なときだけ nav 行を描画。dirty block はボタンを隠さず
  // disabled + tooltip にする。隠すのは single-entry group のみ。
  const navAvailable = onPrev !== null || onNext !== null;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      initialFocusRef={initialFocusRef}
      ariaLabel={
        filename ? `${filename} のプレビューと編集` : "画像プレビューと編集"
      }
      overlayClassName="sample-modal-overlay"
      dialogClassName="sample-modal"
    >
      <div className="sample-modal-header">
        <div className="sample-modal-title" title={filename ?? undefined}>
          {filename ?? ""}
          {editDirty ? (
            <span
              className="sample-modal-dirty-badge"
              title="未保存の変更があります"
              aria-label="未保存の変更があります"
            >
              ●
            </span>
          ) : null}
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          className="sample-modal-close"
          onClick={onClose}
          title="閉じる (Esc)"
          aria-label="プレビューを閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="sample-modal-content">
        <div className="sample-modal-body">
          {state === "loading" ? (
            <div className="sample-modal-loading">読み込み中…</div>
          ) : state === "error" ? (
            <div className="sample-modal-error">画像を読み込めませんでした</div>
          ) : url ? (
            <img
              className="sample-modal-img"
              src={url}
              alt={filename ?? ""}
              draggable={false}
            />
          ) : null}
          {navAvailable ? (
            <>
              <button
                type="button"
                className="sample-modal-nav sample-modal-nav-prev"
                onClick={() => effectivePrev?.()}
                disabled={effectivePrev === null}
                aria-label="前の画像 (←)"
                title={prevBlocked ? NAV_BLOCKED_TOOLTIP : "前の画像 (←)"}
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M10 4l-4 4 4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="sample-modal-nav sample-modal-nav-next"
                onClick={() => effectiveNext?.()}
                disabled={effectiveNext === null}
                aria-label="次の画像 (→)"
                title={nextBlocked ? NAV_BLOCKED_TOOLTIP : "次の画像 (→)"}
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M6 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </>
          ) : null}
        </div>
        <SampleEditPane
          entry={entry}
          knownTags={knownTags}
          tagInputRef={tagInputRef}
          folder={folder}
          onSave={onSave}
          onDirtyChange={setEditDirty}
          autoSave={autoSave}
        />
      </div>
      <div
        className="sample-modal-footer"
        role={viewers.length > 1 ? "group" : undefined}
        aria-label={viewers.length > 1 ? "ビューアを選んで開く" : undefined}
      >
        {viewers.length === 0 ? null : viewers.length === 1 ? (
          // 単一 viewer の fast path: 従来の "ビューアで開く" 文言を保つ。
          <button
            type="button"
            className="sample-modal-open-viewer"
            onClick={() => onOpenInViewer(viewers[0].id)}
          >
            ビューア「{viewers[0].name}」で開く
          </button>
        ) : (
          viewers.map((v) => {
            const isActive = v.id === activeViewerId;
            return (
              <button
                key={v.id}
                type="button"
                className={
                  isActive
                    ? "sample-modal-open-viewer sample-modal-open-viewer-active"
                    : "sample-modal-open-viewer"
                }
                onClick={() => onOpenInViewer(v.id)}
                title={v.name}
                aria-label={`ビューア「${v.name}」で開く${isActive ? " (現在アクティブ)" : ""}`}
              >
                {isActive ? "✓ " : ""}
                {v.name}
              </button>
            );
          })
        )}
      </div>
    </ModalShell>
  );
}
